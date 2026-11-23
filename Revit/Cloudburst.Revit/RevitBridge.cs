using System;
using System.Collections.Concurrent;
using System.Threading.Tasks;
using Autodesk.Revit.UI;

namespace Cloudburst.Revit
{
    /// <summary>
    /// Async bridge into the Revit API context (the "Revit.Async" pattern): work items are queued from any thread
    /// (normally the WPF UI thread of the dockable pane) and drained by a single <see cref="ExternalEvent"/> handler the
    /// next time Revit is idle. Each work item completes its own <see cref="TaskCompletionSource{T}"/>.
    /// </summary>
    public sealed class RevitBridge : IExternalEventHandler
    {
        private interface IWorkItem { void Run(UIApplication app); void Fail(Exception ex); }

        private sealed class WorkItem<T> : IWorkItem
        {
            private readonly Func<UIApplication, T> _func;
            public readonly TaskCompletionSource<T> Tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
            public WorkItem(Func<UIApplication, T> func) { _func = func; }
            public void Run(UIApplication app)
            {
                try { Tcs.TrySetResult(_func(app)); }
                catch (Exception ex) { Tcs.TrySetException(ex); }
            }
            public void Fail(Exception ex) => Tcs.TrySetException(ex);
        }

        private readonly ConcurrentQueue<IWorkItem> _queue = new ConcurrentQueue<IWorkItem>();
        private ExternalEvent _event;
        private bool _executing;

        /// <summary>Must be called in a valid API context (IExternalApplication.OnStartup).</summary>
        public void Initialize() { _event = ExternalEvent.Create(this); }

        public string GetName() => "Cloudburst bridge";

        /// <summary>Queue a function to run in the Revit API context.</summary>
        public Task<T> RunAsync<T>(Func<UIApplication, T> func)
        {
            var item = new WorkItem<T>(func);
            _queue.Enqueue(item);
            Raise();
            return item.Tcs.Task;
        }

        public Task RunAsync(Action<UIApplication> action) => RunAsync<object>(app => { action(app); return null; });

        private void Raise()
        {
            try
            {
                if (_event == null) { FailAll(new InvalidOperationException("Cloudburst is not initialised (ExternalEvent missing).")); return; }
                if (_executing) return; // the running Execute loop will pick it up
                // Accepted or Pending are both fine: the queue drains on the next idle. Denied/TimedOut: retried on the next call.
                var r = _event.Raise();
                if (r == ExternalEventRequest.Denied) Logger.Write("ExternalEvent.Raise denied (Revit busy or event disposed); work stays queued.");
            }
            catch (Exception ex) { Logger.Write("Raise failed: " + ex.Message); }
        }

        public void Execute(UIApplication app)
        {
            _executing = true;
            try
            {
                while (_queue.TryDequeue(out var item))
                {
                    try { item.Run(app); }
                    catch (Exception ex) { item.Fail(ex); } // Run already catches; belt and braces
                }
            }
            catch (Exception ex) { Logger.Write("Bridge Execute: " + ex); }
            finally { _executing = false; }
            // Work queued between the last TryDequeue and _executing=false would be orphaned: raise again.
            if (!_queue.IsEmpty) Raise();
        }

        private void FailAll(Exception ex)
        {
            while (_queue.TryDequeue(out var item)) item.Fail(ex);
        }

        public void Dispose()
        {
            FailAll(new OperationCanceledException("Revit is shutting down."));
            try { _event?.Dispose(); } catch { }
            _event = null;
        }
    }
}
