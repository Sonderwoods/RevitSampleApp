using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Threading;
using Cloudburst.Demo;
using Cloudburst.Geometry;
using Cloudburst.Grid;
using Cloudburst.Hosting;
using Cloudburst.Materials;
using Cloudburst.Model;
using Cloudburst.Native;
using Cloudburst.Results;
using Cloudburst.UI.Infrastructure;

namespace Cloudburst.UI.ViewModels
{
    public enum ResultSource { None, Instant, Dynamic }

    /// <summary>
    /// View model of the whole Cloudburst panel. Wraps one <see cref="CloudburstSession"/> and the CAD host.
    /// Every entry point is guarded: errors become a status toast, never an exception into the host.
    /// Engine work runs on the thread pool, serialised by one gate; host calls are always issued on the UI thread.
    /// </summary>
    public sealed partial class MainViewModel : ObservableObject, IDisposable
    {
        private const string DefaultCaption = "SCREENING MODEL – indicative results, not for compliance. Check inputs and assumptions.";

        private readonly Dispatcher _ui;
        private readonly SemaphoreSlim _engine = new SemaphoreSlim(1, 1);
        private readonly SemaphoreSlim _hostGate = new SemaphoreSlim(1, 1);
        private readonly DispatcherTimer _liveTimer, _playTimer, _statusTimer, _retentionTimer;
        private CancellationTokenSource _dynCts;
        private Task _dynTask;
        private bool _disposed;
        private int _busyCount;
        private readonly bool[] _visited = new bool[6];

        public ICloudburstHost Host { get; }
        public CloudburstSession Session { get; }

        public MainViewModel(ICloudburstHost host, Dispatcher dispatcher)
        {
            Host = host ?? throw new ArgumentNullException(nameof(host));
            _ui = dispatcher ?? Dispatcher.CurrentDispatcher;
            CommandErrors.Handler = ex => ShowError(null, ex);

            _liveTimer = new DispatcherTimer(DispatcherPriority.Background, _ui) { Interval = TimeSpan.FromMilliseconds(300) };
            _liveTimer.Tick += (s, e) => { _liveTimer.Stop(); Forget(() => RunInstantCoreAsync(live: true), "Live update"); };
            _playTimer = new DispatcherTimer(DispatcherPriority.Background, _ui) { Interval = TimeSpan.FromMilliseconds(650) };
            _playTimer.Tick += (s, e) => PlayTick();
            _statusTimer = new DispatcherTimer(DispatcherPriority.Background, _ui) { Interval = TimeSpan.FromSeconds(7) };
            _statusTimer.Tick += (s, e) => { _statusTimer.Stop(); if (StatusKind == "Info" || StatusKind == "Success") HasStatus = false; };
            _retentionTimer = new DispatcherTimer(DispatcherPriority.Background, _ui) { Interval = TimeSpan.FromMilliseconds(400) };
            _retentionTimer.Tick += (s, e) => { _retentionTimer.Stop(); if (HasGrid && HasRetention) Forget(ComputeRetentionAsync, "Retention"); };

            try
            {
                Session = new CloudburstSession();
                Session.Message += OnSessionMessage;
            }
            catch (Exception ex)
            {
                EngineError = "The Cloudburst engine (cloudburst_core.dll) could not be loaded. " + Unwrap(ex).Message;
            }

            try { HostName = host.HostName; } catch (Exception) { HostName = "CAD host"; }
            try { InitHostEvents(); } catch (Exception) { }

            BuildSteps();
            BuildCommands();
            InitSite();
            InitSamples();
            InitSurfaces();
            InitRain();
            InitSimulate();
            InitResults();
            InitCompare();

            if (EngineError != null) Toast(EngineError, "Error");
            else _ = CheckEngineAsync();
        }

        private async Task CheckEngineAsync()
        {
            try
            {
                var v = await Task.Run(() => Engine.Version);
                EngineVersion = string.IsNullOrEmpty(v) ? "" : "engine " + v;
                Toast($"Ready · {HostName}", "Info");
            }
            catch (Exception ex)
            {
                EngineError = "The Cloudburst engine could not be loaded. " + Unwrap(ex).Message;
                Toast(EngineError, "Error");
            }
        }

        // =====================================================================================
        // Header, steps, status
        // =====================================================================================
        private string _engineVersion, _engineError;
        public string HostName { get; }
        public string EngineVersion { get => _engineVersion; private set => Set(ref _engineVersion, value); }
        public string EngineError { get => _engineError; private set { if (Set(ref _engineError, value)) Raise(nameof(EngineOk)); } }
        public bool EngineOk => _engineError == null && Session != null;

        public ObservableCollection<StepViewModel> Steps { get; } = new ObservableCollection<StepViewModel>();
        private int _currentStepIndex;
        public int CurrentStepIndex
        {
            get => _currentStepIndex;
            set
            {
                value = Math.Max(0, Math.Min(Steps.Count - 1, value));
                if (!Set(ref _currentStepIndex, value)) return;
                _visited[value] = true;
                Raise(nameof(CurrentStep), nameof(NextStepTitle), nameof(HasNextStep));
                RefreshSteps();
            }
        }
        public StepViewModel CurrentStep => Steps.Count > 0 ? Steps[_currentStepIndex] : null;
        public bool HasNextStep => _currentStepIndex < Steps.Count - 1;
        public string NextStepTitle => HasNextStep ? $"Continue to {Steps[_currentStepIndex + 1].Title}" : "";

        public ICommand NextStepCommand { get; private set; }
        public ICommand GoToStepCommand { get; private set; }
        public ICommand DismissStatusCommand { get; private set; }

        private void BuildSteps()
        {
            var defs = new (string title, string desc)[]
            {
                ("Site", "Pick terrain, buildings and kerbs, then build the analysis grid."),
                ("Surfaces", "Assign surface materials. They drive runoff, roughness and infiltration."),
                ("Rain", "Choose the design rain, climate factor and sewer assumption."),
                ("Simulate", "Instant bluespots in under a second, or a full 2D dynamic run."),
                ("Results", "Explore depth, velocity and hazard maps in the model."),
                ("Compare", "Save options, compare them and size retention."),
            };
            for (int i = 0; i < defs.Length; i++)
                Steps.Add(new StepViewModel { Index = i, Title = defs[i].title, Description = defs[i].desc, IsFirst = i == 0, IsLast = i == defs.Length - 1 });
            _visited[0] = true;
        }

        private void RefreshSteps()
        {
            if (Steps.Count < 6) return;
            Steps[0].IsDone = HasGrid && !GridStale;
            Steps[1].IsDone = AssignedTotal > 0;
            Steps[2].IsDone = _visited[2] && Session?.Rain != null;
            Steps[3].IsDone = HasInstant || HasDynamic;
            Steps[4].IsDone = _visited[4] && HasResults;
            Steps[5].IsDone = SavedOptions.Count > 0 || HasRetention;
        }

        // ---- status / toast
        private string _statusText = "Ready", _statusKind = "Info", _busyText;
        private bool _hasStatus, _isBusy;
        public string StatusText { get => _statusText; private set => Set(ref _statusText, value); }
        /// <summary>Info, Success, Warning, Error.</summary>
        public string StatusKind { get => _statusKind; private set => Set(ref _statusKind, value); }
        public bool HasStatus { get => _hasStatus; private set => Set(ref _hasStatus, value); }
        public bool IsBusy { get => _isBusy; private set => Set(ref _isBusy, value); }
        public string BusyText { get => _busyText; private set => Set(ref _busyText, value); }

        public void Toast(string text, string kind = "Info")
        {
            if (!_ui.CheckAccess()) { try { _ui.BeginInvoke(new Action(() => Toast(text, kind))); } catch (Exception) { } return; }
            StatusText = text; StatusKind = kind; HasStatus = true;
            _statusTimer.Stop();
            if (kind == "Info" || kind == "Success") _statusTimer.Start();
        }

        public void ShowError(string what, Exception ex)
        {
            var e = Unwrap(ex);
            string msg = (what != null ? what + " failed: " : "") + e.Message;
            Toast(msg, "Error");
            Log("Cloudburst error: " + (what ?? "") + " " + ex);
        }

        private static Exception Unwrap(Exception ex)
        {
            while ((ex is AggregateException || ex is TypeInitializationException || ex is System.Reflection.TargetInvocationException) && ex.InnerException != null) ex = ex.InnerException;
            return ex;
        }

        private void Log(string message)
        {
            if (!_ui.CheckAccess()) { try { _ui.BeginInvoke(new Action(() => Log(message))); } catch (Exception) { } return; }
            try { Host.Log(message); } catch (Exception) { }
        }

        private void OnSessionMessage(string m) => Log("Cloudburst: " + m);

        private IDisposable Busy(string text)
        {
            _busyCount++;
            BusyText = text; IsBusy = true;
            return new Releaser(() =>
            {
                _busyCount = Math.Max(0, _busyCount - 1);
                if (_busyCount == 0) { IsBusy = false; BusyText = null; }
            });
        }

        private sealed class Releaser : IDisposable
        {
            private Action _a;
            public Releaser(Action a) { _a = a; }
            public void Dispose() { var a = Interlocked.Exchange(ref _a, null); try { a?.Invoke(); } catch (Exception) { } }
        }

        // =====================================================================================
        // Plumbing: commands, engine gate, host marshalling
        // =====================================================================================
        private AsyncRelayCommand Cmd(Func<Task> body, Func<bool> can = null, string what = null) =>
            new AsyncRelayCommand(async () =>
            {
                try { await body(); }
                catch (OperationCanceledException) { }
                catch (Exception ex) { ShowError(what, ex); }
            }, () => EngineOk && (can == null || can()));

        private AsyncRelayCommand Cmd(Func<object, Task> body, Func<object, bool> can = null, string what = null) =>
            new AsyncRelayCommand(async p =>
            {
                try { await body(p); }
                catch (OperationCanceledException) { }
                catch (Exception ex) { ShowError(what, ex); }
            }, p => EngineOk && (can == null || can(p)));

        private RelayCommand SyncCmd(Action body, Func<bool> can = null, string what = null) =>
            new RelayCommand(() => { try { body(); } catch (Exception ex) { ShowError(what, ex); } }, can);

        private async void Forget(Func<Task> f, string what)
        {
            try { await f(); }
            catch (OperationCanceledException) { }
            catch (Exception ex) { ShowError(what, ex); }
        }

        /// <summary>Run engine work on the thread pool, one job at a time.</summary>
        private async Task<T> RunEngine<T>(Func<T> f)
        {
            await _engine.WaitAsync();
            try { return await Task.Run(f); }
            finally { _engine.Release(); }
        }

        private Task<T> OnUi<T>(Func<Task<T>> f)
        {
            if (_ui.CheckAccess()) return f() ?? Task.FromResult(default(T));
            return _ui.InvokeAsync(() => f() ?? Task.FromResult(default(T))).Task.Unwrap();
        }

        private Task OnUi(Func<Task> f)
        {
            if (_ui.CheckAccess()) return f() ?? Task.CompletedTask;
            return _ui.InvokeAsync(() => f() ?? Task.CompletedTask).Task.Unwrap();
        }

        private static void Requery() { try { CommandManager.InvalidateRequerySuggested(); } catch (Exception) { } }

        private delegate void ScenarioEdit(ref Scenario s);
        private void EditScenario(ScenarioEdit edit)
        {
            if (Session == null) return;
            var s = Session.Scenario;
            edit(ref s);
            Session.Scenario = s;
        }

        private void BuildCommands()
        {
            NextStepCommand = SyncCmd(() => CurrentStepIndex++, () => HasNextStep);
            GoToStepCommand = new RelayCommand(p => { try { CurrentStepIndex = Convert.ToInt32(p); } catch (Exception) { } });
            DismissStatusCommand = new RelayCommand(() => HasStatus = false);
        }

        // =====================================================================================
        // Lifetime
        // =====================================================================================
        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            try
            {
                _liveTimer.Stop(); _playTimer.Stop(); _statusTimer.Stop(); _retentionTimer.Stop();
                try { _dynCts?.Cancel(); } catch (Exception) { }
                if (Session != null)
                {
                    Session.Message -= OnSessionMessage;
                    var t = _dynTask;
                    if (t != null && !t.IsCompleted) t.ContinueWith(_ => { try { Session.Dispose(); } catch (Exception) { } }, TaskScheduler.Default);
                    else Session.Dispose();
                }
            }
            catch (Exception) { }
        }
    }
}
