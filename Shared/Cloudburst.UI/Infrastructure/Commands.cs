using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Input;
using System.Windows.Threading;

namespace Cloudburst.UI.Infrastructure
{
    /// <summary>Synchronous command. Exceptions are routed to <see cref="CommandErrors.Handler"/> instead of escaping into the host.</summary>
    public sealed class RelayCommand : ICommand
    {
        private readonly Action<object> _execute;
        private readonly Func<object, bool> _canExecute;

        public RelayCommand(Action execute, Func<bool> canExecute = null)
            : this(_ => execute(), canExecute == null ? null : new Func<object, bool>(_ => canExecute())) { }

        public RelayCommand(Action<object> execute, Func<object, bool> canExecute = null)
        {
            _execute = execute ?? throw new ArgumentNullException(nameof(execute));
            _canExecute = canExecute;
        }

        public event EventHandler CanExecuteChanged
        {
            add => CommandManager.RequerySuggested += value;
            remove => CommandManager.RequerySuggested -= value;
        }

        public bool CanExecute(object parameter)
        {
            try { return _canExecute == null || _canExecute(parameter); }
            catch (Exception) { return false; }
        }

        public void Execute(object parameter)
        {
            try { _execute(parameter); }
            catch (Exception ex) { CommandErrors.Report(ex); }
        }
    }

    /// <summary>Async command: disabled while running, never throws (errors go to <see cref="CommandErrors.Handler"/>).</summary>
    public sealed class AsyncRelayCommand : ICommand
    {
        private readonly Func<object, Task> _execute;
        private readonly Func<object, bool> _canExecute;
        private int _running;

        public AsyncRelayCommand(Func<Task> execute, Func<bool> canExecute = null)
            : this(_ => execute(), canExecute == null ? null : new Func<object, bool>(_ => canExecute())) { }

        public AsyncRelayCommand(Func<object, Task> execute, Func<object, bool> canExecute = null)
        {
            _execute = execute ?? throw new ArgumentNullException(nameof(execute));
            _canExecute = canExecute;
        }

        public bool IsRunning => _running > 0;

        public event EventHandler CanExecuteChanged
        {
            add => CommandManager.RequerySuggested += value;
            remove => CommandManager.RequerySuggested -= value;
        }

        public bool CanExecute(object parameter)
        {
            if (_running > 0) return false;
            try { return _canExecute == null || _canExecute(parameter); }
            catch (Exception) { return false; }
        }

        public async void Execute(object parameter)
        {
            if (!CanExecute(parameter)) return;
            // Some plugin hosts run WPF without a synchronization context; make sure awaits come back to the UI thread.
            if (SynchronizationContext.Current == null && Dispatcher.FromThread(Thread.CurrentThread) is Dispatcher d)
                SynchronizationContext.SetSynchronizationContext(new DispatcherSynchronizationContext(d));
            Interlocked.Increment(ref _running);
            CommandManager.InvalidateRequerySuggested();
            try { await (_execute(parameter) ?? Task.CompletedTask); }
            catch (Exception ex) { CommandErrors.Report(ex); }
            finally
            {
                Interlocked.Decrement(ref _running);
                CommandManager.InvalidateRequerySuggested();
            }
        }
    }

    /// <summary>Last-resort error sink for commands (set by the panel's view model).</summary>
    public static class CommandErrors
    {
        [ThreadStatic] private static Action<Exception> _handler;
        public static Action<Exception> Handler { get => _handler; set => _handler = value; }

        public static void Report(Exception ex)
        {
            try { Handler?.Invoke(ex); } catch (Exception) { }
        }
    }
}
