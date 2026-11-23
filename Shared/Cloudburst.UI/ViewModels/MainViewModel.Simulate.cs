using System;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Input;
using Cloudburst.Model;
using Cloudburst.Native;
using Cloudburst.UI.Infrastructure;

namespace Cloudburst.UI.ViewModels
{
    public sealed partial class MainViewModel
    {
        public ICommand RunInstantCommand { get; private set; }
        public ICommand RunDynamicCommand { get; private set; }
        public ICommand CancelDynamicCommand { get; private set; }

        private bool _liveInstant = true, _isDynamicRunning, _hasInstant, _hasDynamic;
        private double _afterRainMin = 120, _dynPercent;
        private string _instantSummary = "Not run yet", _dynamicSummary = "Not run yet";
        private string _dynSimText = "–", _dynElapsedText = "–", _dynEtaText = "–", _dynMaxDepthText = "–", _dynDtText = "";

        private void InitSimulate()
        {
            if (Session != null)
            {
                var a = Session.Scenario.AfterRainMin;
                _afterRainMin = a > 0 ? a : 120;
                EditScenario((ref Scenario s) => s.AfterRainMin = _afterRainMin);
            }
            RunInstantCommand = Cmd(() => RunInstantCoreAsync(live: false), () => HasGrid && !IsDynamicRunning, "Instant model");
            RunDynamicCommand = Cmd(RunDynamicAsync, () => HasGrid && !IsDynamicRunning, "Dynamic model");
            CancelDynamicCommand = new RelayCommand(() =>
            {
                try { _dynCts?.Cancel(); Toast("Cancelling the dynamic run…", "Info"); } catch (Exception) { }
            }, () => IsDynamicRunning);
        }

        public bool LiveInstant
        {
            get => _liveInstant;
            set
            {
                if (!Set(ref _liveInstant, value)) return;
                if (value && HasGrid && !HasInstant) OnScenarioInputChanged();
            }
        }

        public bool IsDynamicRunning
        {
            get => _isDynamicRunning;
            private set { if (Set(ref _isDynamicRunning, value)) { Raise(nameof(IsResultsInteractive)); Requery(); } }
        }

        public bool HasInstant { get => _hasInstant; private set { if (Set(ref _hasInstant, value)) { Raise(nameof(HasResults)); RefreshSteps(); Requery(); } } }
        public bool HasDynamic { get => _hasDynamic; private set { if (Set(ref _hasDynamic, value)) { Raise(nameof(HasResults)); RefreshSteps(); Requery(); } } }
        public bool HasResults => _hasInstant || _hasDynamic;

        public string InstantSummary { get => _instantSummary; private set => Set(ref _instantSummary, value); }
        public string DynamicSummary { get => _dynamicSummary; private set => Set(ref _dynamicSummary, value); }
        public double DynamicPercent { get => _dynPercent; private set => Set(ref _dynPercent, value); }
        public string DynamicPercentText => $"{_dynPercent:0}%";
        public string DynSimText { get => _dynSimText; private set => Set(ref _dynSimText, value); }
        public string DynElapsedText { get => _dynElapsedText; private set => Set(ref _dynElapsedText, value); }
        public string DynEtaText { get => _dynEtaText; private set => Set(ref _dynEtaText, value); }
        public string DynMaxDepthText { get => _dynMaxDepthText; private set => Set(ref _dynMaxDepthText, value); }
        public string DynDtText { get => _dynDtText; private set => Set(ref _dynDtText, value); }

        public double AfterRainMin
        {
            get => _afterRainMin;
            set
            {
                value = double.IsNaN(value) ? 120 : Math.Max(0, Math.Min(2880, value));
                if (!Set(ref _afterRainMin, value)) return;
                EditScenario((ref Scenario s) => s.AfterRainMin = value);
                Raise(nameof(RunLengthText));
                MarkResultsStale();
            }
        }

        private double RainDurationS
        {
            get
            {
                var r = CurrentRain;
                if (r == null) return 0;
                return r.IntensityMmH != null && r.IntensityMmH.Length > 0 ? r.IntensityMmH.Length * r.StepS : r.DurationMin * 60;
            }
        }

        public string RunLengthText => $"{Fmt.Minutes(RainDurationS / 60)} rain + {Fmt.Minutes(_afterRainMin)} after = {Fmt.Minutes(RainDurationS / 60 + _afterRainMin)} simulated";

        // ---- instant
        private async Task RunInstantCoreAsync(bool live)
        {
            if (Session == null || _disposed) return;
            if (Session.Grid == null) { if (!live) Toast("Build the grid first (step 1).", "Warning"); return; }
            if (IsDynamicRunning) return;
            using (Busy(live ? "Updating bluespots…" : "Running the instant model…"))
            {
                var r = await RunEngine(() => Session.RunInstant());
                OnInstantResult(r);
                if (!live)
                {
                    SetSource(ResultSource.Instant);
                    if (SelectedLayerOption?.DynamicOnly == true || SelectedLayer == UiLayer.Materials) SelectLayer(UiLayer.Depth, show: false);
                    CurrentStepIndex = 4;
                    Toast($"Instant model: {r.Stats.BluespotCount} bluespots, {Fmt.Smart(r.Stats.StoredVolumeM3)} m³ ponding ({Fmt.N0(r.Stats.ElapsedMs)} ms).", "Success");
                }
                else
                {
                    if (ActiveSource != ResultSource.Dynamic || !HasDynamic) SetSource(ResultSource.Instant);
                    if (ActiveSource == ResultSource.Instant && (SelectedLayerOption?.DynamicOnly == true || SelectedLayer == UiLayer.Materials)) SelectLayer(UiLayer.Depth, show: false);
                }
                await ShowSelectedLayerAsync();
            }
        }

        private void OnInstantResult(InstantResult r)
        {
            HasInstant = true;
            var st = r.Stats;
            InstantSummary = $"{st.BluespotCount} bluespots · {Fmt.Smart(st.StoredVolumeM3)} m³ ponding · max {Fmt.N(st.MaxDepthM * 100, "0")} cm · {Fmt.N0(st.ElapsedMs)} ms";
            UpdateBluespots(r);
            ResultsStale = false;
            RefreshLayers();
            UpdateStats();
        }

        // ---- dynamic
        private async Task RunDynamicAsync()
        {
            if (Session?.Grid == null) { Toast("Build the grid first (step 1).", "Warning"); return; }
            StopPlayback();
            _liveTimer.Stop();
            var cts = new CancellationTokenSource();
            _dynCts = cts;
            IsDynamicRunning = true;
            DynamicPercent = 0; Raise(nameof(DynamicPercentText));
            DynSimText = "0:00"; DynElapsedText = "0 s"; DynEtaText = "estimating…"; DynMaxDepthText = "0.00 m"; DynDtText = "";
            DynamicSummary = "Running…";
            double totalS = RainDurationS + _afterRainMin * 60;
            var sw = Stopwatch.StartNew();
            var progress = new CoalescingProgress<Progress>(_ui, p => OnDynProgress(p, totalS, sw.Elapsed.TotalSeconds));
            DynamicResult r = null;
            bool cancelled = false;
            Toast("Dynamic run started – the panel stays usable, you can cancel any time.", "Info");
            await _engine.WaitAsync();
            try
            {
                var task = Session.RunDynamicAsync(progress, cts.Token);
                _dynTask = task;
                try { r = await task; }
                catch (Exception) when (cts.IsCancellationRequested) { cancelled = true; }
                if (r != null) await Task.Run(() => ComputeDynamicStats(r));
            }
            finally
            {
                _engine.Release();
                IsDynamicRunning = false;
                _dynTask = null;
                sw.Stop();
            }

            if (r == null)
            {
                DynamicSummary = cancelled ? "Cancelled" : "Failed";
                DynEtaText = "–";
                Toast(cancelled ? "Dynamic run cancelled." : "Dynamic run produced no result.", "Warning");
                return;
            }

            bool partial = r.Mass.Cancelled != 0;
            DynamicPercent = partial ? _dynPercent : 100; Raise(nameof(DynamicPercentText));
            DynEtaText = "done";
            DynElapsedText = Fmt.Duration(sw.Elapsed.TotalSeconds);
            DynamicSummary = $"{Fmt.Minutes(r.Mass.SimulatedS / 60)} simulated in {Fmt.Duration(r.Mass.ElapsedS > 0 ? r.Mass.ElapsedS : sw.Elapsed.TotalSeconds)} · mass error {Fmt.N(r.Mass.ErrorFraction * 100, "0.000")} %{(partial ? " · stopped early" : "")}";
            HasDynamic = true;
            ResultsStale = false;
            _frameMax = Math.Max(0, r.FrameCount - 1);
            _frameIndex = _frameMax;
            Raise(nameof(FrameMax), nameof(FrameIndex), nameof(FrameTimeText), nameof(HasFrames));
            ShowingFrame = false;
            SetSource(ResultSource.Dynamic);
            if (SelectedLayer == UiLayer.Materials || SelectedLayer == UiLayer.FlowPaths) SelectLayer(UiLayer.Depth, show: false);
            RefreshLayers();
            UpdateStats();
            CurrentStepIndex = 4;
            Toast(partial ? "Dynamic run stopped early – showing the partial result." : $"Dynamic run finished: max depth {Fmt.N(_dynMaxDepth, "0.00")} m.", partial ? "Warning" : "Success");
            await ShowSelectedLayerAsync();
        }

        private void OnDynProgress(Progress p, double totalS, double elapsedS)
        {
            if (!IsDynamicRunning) return;
            double f = Math.Max(0, Math.Min(1, p.Fraction));
            DynamicPercent = f * 100; Raise(nameof(DynamicPercentText));
            double total = f > 0.01 && p.TimeS > 0 ? p.TimeS / f : totalS;
            DynSimText = $"{Fmt.Clock(p.TimeS)} / {Fmt.Clock(total)}";
            double el = p.ElapsedS > 0 ? p.ElapsedS : elapsedS;
            DynElapsedText = Fmt.Duration(el);
            DynEtaText = f > 0.02 ? "≈ " + Fmt.Duration(el / f * (1 - f)) : "estimating…";
            DynMaxDepthText = $"{Fmt.N(p.HMaxM, "0.00")} m";
            DynDtText = p.DtS > 0 ? $"Δt {Fmt.N(p.DtS, "0.00")} s · {Fmt.Smart(p.VolumeM3)} m³ on surface" : "";
        }
    }
}
