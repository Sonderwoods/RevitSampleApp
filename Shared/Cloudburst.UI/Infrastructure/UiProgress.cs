using System;
using System.Diagnostics;
using System.Windows.Threading;

namespace Cloudburst.UI.Infrastructure
{
    /// <summary>
    /// IProgress that coalesces high-frequency reports from the solver thread into at most ~20 UI updates per second.
    /// Unlike Progress&lt;T&gt; it does not depend on a SynchronizationContext (some plugin hosts have none).
    /// </summary>
    public sealed class CoalescingProgress<T> : IProgress<T>
    {
        private readonly Dispatcher _dispatcher;
        private readonly Action<T> _apply;
        private readonly object _lock = new object();
        private readonly Stopwatch _clock = Stopwatch.StartNew();
        private T _latest;
        private bool _pending;
        private long _lastMs = -1000;

        public CoalescingProgress(Dispatcher dispatcher, Action<T> apply) { _dispatcher = dispatcher; _apply = apply; }

        public void Report(T value)
        {
            lock (_lock)
            {
                _latest = value;
                if (_pending) return;
                long now = _clock.ElapsedMilliseconds;
                if (now - _lastMs < 50) return;
                _lastMs = now;
                _pending = true;
            }
            try { _dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(Flush)); }
            catch (Exception) { lock (_lock) _pending = false; }
        }

        private void Flush()
        {
            T v;
            lock (_lock) { v = _latest; _pending = false; }
            try { _apply(v); } catch (Exception) { }
        }
    }
}
