using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using System.Windows.Media;
using Cloudburst.Model;
using Cloudburst.Results;
using Cloudburst.UI.Infrastructure;

namespace Cloudburst.UI.ViewModels
{
    public sealed partial class MainViewModel
    {
        public ObservableCollection<LayerOptionViewModel> Layers { get; } = new ObservableCollection<LayerOptionViewModel>();
        public ObservableCollection<LegendRow> Legend { get; } = new ObservableCollection<LegendRow>();
        public ObservableCollection<MassSegment> MassSegments { get; } = new ObservableCollection<MassSegment>();
        public ObservableCollection<BluespotRow> Bluespots { get; } = new ObservableCollection<BluespotRow>();

        public ICommand PlayPauseCommand { get; private set; }
        public ICommand ShowMaxCommand { get; private set; }
        public ICommand BakeCommand { get; private set; }
        public ICommand ClearPreviewCommand { get; private set; }
        public ICommand ExportAscCommand { get; private set; }

        private ResultSource _source = ResultSource.None;
        private UiLayer _selectedLayer = UiLayer.Depth;
        private ResultVisual _currentVisual;
        private string _visualTitle, _legendTitle;
        private bool _resultsStale, _isPlaying, _showingFrame, _hasMass, _framePumpBusy;
        private int _frameIndex, _frameMax, _pendingFrame = -1, _showSeq;
        private double _dynVolume, _dynArea, _dynMaxDepth;
        private string _statVolume = "–", _statArea = "–", _statAreaTone = "", _statMaxDepth = "–", _statBluespots = "–", _statBluespotsNote, _statRain = "–", _statRainNote, _statModel, _statVolumeNote;
        private string _massErrorText, _massTotalText;

        private void InitResults()
        {
            void Add(UiLayer l, string title, string glyph, bool dyn) => Layers.Add(new LayerOptionViewModel(l, title, glyph, dyn, OnLayerChosen));
            Add(UiLayer.Depth, "Depth", "", false);
            Add(UiLayer.Velocity, "Velocity", "", true);
            Add(UiLayer.Hazard, "Hazard", "", true);
            Add(UiLayer.TimeToPeak, "Time to peak", "", true);
            Add(UiLayer.FlowPaths, "Flow paths", "", false);
            Add(UiLayer.Materials, "Materials", "", false);
            Layers[0].SetSelectedSilently(true);
            RefreshLayers();

            PlayPauseCommand = SyncCmd(TogglePlay, () => HasFrames && IsResultsInteractive);
            ShowMaxCommand = Cmd(async () => { StopPlayback(); ShowingFrame = false; SelectLayer(UiLayer.Depth, show: false); await ShowSelectedLayerAsync(); },
                                 () => HasFrames && IsResultsInteractive, "Show max depth");
            BakeCommand = Cmd(BakeAsync, () => CurrentVisual != null && IsResultsInteractive, "Bake");
            ClearPreviewCommand = Cmd(async () =>
            {
                StopPlayback();
                await HostCall(() => Host.ClearPreviewAsync());
                CurrentVisual = null;
                Legend.Clear();
                Toast("Preview cleared.", "Info");
            }, null, "Clear preview");
            ExportAscCommand = Cmd(ExportAscAsync, () => HasResults && IsResultsInteractive && SelectedLayer != UiLayer.Materials, "Export .asc");
        }

        // ---- state
        public ResultSource ActiveSource => _source;
        public bool SourceIsInstant { get => _source == ResultSource.Instant; set { if (value && HasInstant) { SetSource(ResultSource.Instant); Forget(ShowSelectedLayerAsync, "Show result"); } } }
        public bool SourceIsDynamic { get => _source == ResultSource.Dynamic; set { if (value && HasDynamic) { SetSource(ResultSource.Dynamic); Forget(ShowSelectedLayerAsync, "Show result"); } } }
        public bool ShowSourceToggle => HasInstant && HasDynamic;

        private void SetSource(ResultSource s)
        {
            if (s == ResultSource.Instant && !HasInstant) s = HasDynamic ? ResultSource.Dynamic : ResultSource.None;
            if (s == ResultSource.Dynamic && !HasDynamic) s = HasInstant ? ResultSource.Instant : ResultSource.None;
            _source = s;
            if (s != ResultSource.Dynamic) { StopPlayback(); ShowingFrame = false; }
            if (s == ResultSource.Instant && (SelectedLayerOption?.DynamicOnly ?? false)) SelectLayer(UiLayer.Depth, show: false);
            Raise(nameof(ActiveSource), nameof(SourceIsInstant), nameof(SourceIsDynamic), nameof(ShowSourceToggle), nameof(HasFrames), nameof(IsDynamicSource));
            RefreshLayers();
            UpdateStats();
        }

        public bool IsDynamicSource => _source == ResultSource.Dynamic && HasDynamic;
        public bool IsResultsInteractive => !IsDynamicRunning;
        public bool ResultsStale { get => _resultsStale; private set => Set(ref _resultsStale, value); }

        private void MarkResultsStale() { if (HasResults) ResultsStale = true; }

        public UiLayer SelectedLayer => _selectedLayer;
        public LayerOptionViewModel SelectedLayerOption => Layers.FirstOrDefault(l => l.Layer == _selectedLayer);

        public ResultVisual CurrentVisual
        {
            get => _currentVisual;
            private set
            {
                if (!Set(ref _currentVisual, value)) return;
                Raise(nameof(Caption), nameof(HasVisual));
                Requery();
            }
        }
        public bool HasVisual => _currentVisual != null;
        public string Caption => string.IsNullOrWhiteSpace(_currentVisual?.Caption) ? DefaultCaption : _currentVisual.Caption;
        public string VisualTitle { get => _visualTitle; private set => Set(ref _visualTitle, value); }
        public string LegendTitle { get => _legendTitle; private set => Set(ref _legendTitle, value); }

        private void RefreshLayers()
        {
            bool grid = HasGrid, inst = HasInstant, dyn = HasDynamic;
            foreach (var l in Layers)
                l.IsAvailable = l.Layer switch
                {
                    UiLayer.Materials => grid,
                    UiLayer.FlowPaths => grid && (inst || dyn),
                    UiLayer.Depth => inst || dyn,
                    _ => dyn
                };
        }

        private void OnLayerChosen(LayerOptionViewModel opt)
        {
            try
            {
                SelectLayer(opt.Layer, show: false);
                if (opt.DynamicOnly && _source != ResultSource.Dynamic && HasDynamic) SetSource(ResultSource.Dynamic);
                if (opt.Layer != UiLayer.Depth) ShowingFrame = false;
                StopPlayback();
                Forget(ShowSelectedLayerAsync, "Show " + opt.Title.ToLowerInvariant());
            }
            catch (Exception ex) { ShowError("Layer", ex); }
        }

        private void SelectLayer(UiLayer layer, bool show)
        {
            _selectedLayer = layer;
            foreach (var l in Layers) l.SetSelectedSilently(l.Layer == layer);
            Raise(nameof(SelectedLayer), nameof(SelectedLayerOption));
            Requery();
            if (show) Forget(ShowSelectedLayerAsync, "Show layer");
        }

        // ---- showing visuals
        private Task HostCall(Func<Task> f) => OnUi(f);

        /// <summary>Build the selected layer's visual off the UI thread and show it in the host.</summary>
        private async Task ShowSelectedLayerAsync()
        {
            if (Session == null || _disposed) return;
            var layer = _selectedLayer;
            if (layer == UiLayer.Materials)
            {
                if (Session.Grid == null) return;
                await ShowVisualAsync(() => Session.Visual(ResultLayer.Materials));
                return;
            }
            if (layer == UiLayer.FlowPaths)
            {
                if (Session.Grid == null) return;
                if (Session.Instant == null || !ReferenceEquals(Session.Instant.Grid, Session.Grid))
                {
                    var r = await RunEngine(() => Session.RunInstant());
                    OnInstantResult(r);
                }
                var inst = Session.Instant; var rain = Session.Rain;
                await ShowVisualAsync(() => VisualFactory.FromInstant(inst, ResultLayer.FlowAccumulation, rain));
                return;
            }
            if (_source == ResultSource.Dynamic && Session.Dynamic != null)
            {
                var d = Session.Dynamic;
                if (layer == UiLayer.Depth && _showingFrame) { RequestFrame(_frameIndex); return; }
                var rl = layer switch
                {
                    UiLayer.Velocity => ResultLayer.Velocity,
                    UiLayer.Hazard => ResultLayer.Hazard,
                    UiLayer.TimeToPeak => ResultLayer.TimeToPeak,
                    _ => ResultLayer.Depth
                };
                await ShowVisualAsync(() => VisualFactory.FromDynamic(d, rl));
                return;
            }
            if (Session.Instant != null)
            {
                var inst = Session.Instant; var rain = Session.Rain;
                await ShowVisualAsync(() => VisualFactory.FromInstant(inst, ResultLayer.Depth, rain));
            }
        }

        private async Task ShowVisualAsync(Func<ResultVisual> make)
        {
            int seq = ++_showSeq;
            var v = await RunEngine(make);
            if (seq != _showSeq || _disposed) return; // superseded by a newer request
            await ShowVisualCoreAsync(v);
        }

        /// <summary>Serialised host call: the next ShowAsync starts only after the previous one finished.</summary>
        private async Task ShowVisualCoreAsync(ResultVisual v)
        {
            await _hostGate.WaitAsync();
            try
            {
                if (_disposed) return;
                CurrentVisual = v;
                UpdateLegend(v);
                if (v != null)
                {
                    var show = HostCall(() => Host.ShowAsync(v));
                    var done = await Task.WhenAny(show, Task.Delay(TimeSpan.FromSeconds(45)));
                    if (done != show)
                    {
                        Toast($"{HostName} is taking long to draw the preview – it will appear when the host is ready.", "Warning");
                        _ = show.ContinueWith(t => { var _ = t.Exception; }, TaskScheduler.Default);
                    }
                    else await show; // propagate host errors
                }
            }
            finally { _hostGate.Release(); }
        }

        private void UpdateLegend(ResultVisual v)
        {
            Legend.Clear();
            VisualTitle = v?.Title;
            LegendTitle = v?.Ramp != null ? $"{v.Ramp.Title}{(string.IsNullOrEmpty(v.Ramp.Unit) ? "" : $" ({v.Ramp.Unit})")}" : v?.Title;
            if (v?.Legend == null) return;
            foreach (var li in v.Legend)
            {
                if (((uint)li.Argb >> 24) == 0) { Legend.Add(new LegendRow { Brush = Brushes.Transparent, Label = li.Label }); continue; }
                Legend.Add(new LegendRow { Brush = Brushy.FromArgb(li.Argb), Label = li.Label });
            }
        }

        // ---- time slider / playback
        public bool HasFrames => _source == ResultSource.Dynamic && HasDynamic && _frameMax > 0;
        public int FrameMax => _frameMax;
        public int FrameIndex
        {
            get => _frameIndex;
            set
            {
                value = Math.Max(0, Math.Min(_frameMax, value));
                if (!Set(ref _frameIndex, value)) return;
                Raise(nameof(FrameTimeText));
                if (!HasFrames) return;
                ShowingFrame = true;
                if (_selectedLayer != UiLayer.Depth) SelectLayer(UiLayer.Depth, show: false);
                RequestFrame(value);
            }
        }

        public bool ShowingFrame { get => _showingFrame; private set { if (Set(ref _showingFrame, value)) Raise(nameof(FrameTimeText)); } }
        public bool IsPlaying { get => _isPlaying; private set => Set(ref _isPlaying, value); }

        public string FrameTimeText
        {
            get
            {
                var d = Session?.Dynamic;
                if (d == null || d.FrameCount == 0) return "";
                double t = d.FrameTimes[Math.Max(0, Math.Min(d.FrameCount - 1, _frameIndex))];
                double end = d.FrameTimes[d.FrameCount - 1];
                return _showingFrame ? $"t = {Fmt.Clock(t)} / {Fmt.Clock(end)}" : $"Max over {Fmt.Clock(end)}";
            }
        }

        private void RequestFrame(int frame)
        {
            _pendingFrame = frame;
            if (!_framePumpBusy) Forget(PumpFramesAsync, "Show frame");
        }

        /// <summary>Latest-wins frame pump: never more than one host ShowAsync in flight.</summary>
        private async Task PumpFramesAsync()
        {
            _framePumpBusy = true;
            try
            {
                while (_pendingFrame >= 0 && !_disposed)
                {
                    int f = _pendingFrame; _pendingFrame = -1;
                    var d = Session?.Dynamic;
                    if (d == null || IsDynamicRunning) break;
                    _showSeq++; // cancel any queued layer show
                    var v = await RunEngine(() => VisualFactory.FromDynamic(d, ResultLayer.DepthAtTime, f));
                    await ShowVisualCoreAsync(v);
                }
            }
            finally { _framePumpBusy = false; _pendingFrame = -1; }
        }

        private void TogglePlay()
        {
            if (IsPlaying) { StopPlayback(); return; }
            if (!HasFrames) return;
            if (_frameIndex >= _frameMax || !_showingFrame) FrameIndex = 0;
            ShowingFrame = true;
            IsPlaying = true;
            _playTimer.Start();
        }

        private void PlayTick()
        {
            try
            {
                if (!IsPlaying) { _playTimer.Stop(); return; }
                if (_framePumpBusy) return; // wait for the host to finish drawing
                if (_frameIndex >= _frameMax) { StopPlayback(); return; }
                FrameIndex = _frameIndex + 1;
            }
            catch (Exception ex) { StopPlayback(); ShowError("Playback", ex); }
        }

        private void StopPlayback()
        {
            _playTimer.Stop();
            IsPlaying = false;
        }

        // ---- stats
        public string StatModel { get => _statModel; private set => Set(ref _statModel, value); }
        public string StatVolume { get => _statVolume; private set => Set(ref _statVolume, value); }
        public string StatVolumeNote { get => _statVolumeNote; private set => Set(ref _statVolumeNote, value); }
        public string StatArea { get => _statArea; private set => Set(ref _statArea, value); }
        public string StatAreaTone { get => _statAreaTone; private set => Set(ref _statAreaTone, value); }
        public string StatMaxDepth { get => _statMaxDepth; private set => Set(ref _statMaxDepth, value); }
        public string StatBluespots { get => _statBluespots; private set => Set(ref _statBluespots, value); }
        public string StatBluespotsNote { get => _statBluespotsNote; private set => Set(ref _statBluespotsNote, value); }
        public string StatRain { get => _statRain; private set => Set(ref _statRain, value); }
        public string StatRainNote { get => _statRainNote; private set => Set(ref _statRainNote, value); }
        public bool HasMass { get => _hasMass; private set => Set(ref _hasMass, value); }
        public string MassErrorText { get => _massErrorText; private set => Set(ref _massErrorText, value); }
        public string MassTotalText { get => _massTotalText; private set => Set(ref _massTotalText, value); }
        public bool HasBluespots => Bluespots.Count > 0;

        private void ComputeDynamicStats(DynamicResult r)
        {
            double a = r.Grid.CellArea, vol = 0, area = 0, max = 0;
            var h = r.HMax;
            for (int k = 0; k < h.Length; k++)
            {
                double d = h[k];
                if (d <= 0 || double.IsNaN(d)) continue;
                vol += d * a;
                if (d >= 0.1) area += a;
                if (d > max) max = d;
            }
            _dynVolume = vol; _dynArea = area; _dynMaxDepth = max;
        }

        private void UpdateStats()
        {
            var inst = Session?.Instant;
            var dyn = Session?.Dynamic;
            if (_source == ResultSource.Dynamic && dyn != null)
            {
                StatModel = "Dynamic model (M2) · maximum over the run";
                StatVolume = Fmt.Smart(_dynVolume); StatVolumeNote = "Σ max depth × cell area";
                StatArea = Fmt.Smart(_dynArea);
                StatAreaTone = _dynArea > 0 ? "Danger" : "Good";
                StatMaxDepth = Fmt.N(_dynMaxDepth, "0.00");
                var m = dyn.Mass;
                StatRain = Fmt.Smart(m.RainM3); StatRainNote = $"{Fmt.N(dyn.Rain?.DesignDepthMm ?? 0, "0")} mm design depth";
                UpdateMass(m);
            }
            else if (inst != null)
            {
                var s = inst.Stats;
                StatModel = "Instant model (M1) · bluespots at the end of the rain";
                StatVolume = Fmt.Smart(s.StoredVolumeM3); StatVolumeNote = "Water ponding in bluespots";
                StatArea = Fmt.Smart(s.AreaOver10CmM2);
                StatAreaTone = s.AreaOver10CmM2 > 0 ? "Danger" : "Good";
                StatMaxDepth = Fmt.N(s.MaxDepthM, "0.00");
                StatRain = Fmt.Smart(s.RainVolumeM3); StatRainNote = $"{Fmt.Smart(s.EffectiveVolumeM3)} m³ effective runoff";
                HasMass = false; MassSegments.Clear();
            }
            else
            {
                StatModel = null; StatVolume = StatArea = StatMaxDepth = StatRain = "–"; StatAreaTone = ""; StatVolumeNote = StatRainNote = null;
                HasMass = false; MassSegments.Clear();
            }
            if (inst != null)
            {
                StatBluespots = Fmt.N0(inst.Stats.BluespotCount);
                StatBluespotsNote = $"{inst.Stats.SpillingCount} spilling";
            }
            else { StatBluespots = "–"; StatBluespotsNote = "run the instant model"; }
        }

        private void UpdateMass(Native.MassBalance m)
        {
            MassSegments.Clear();
            double total = m.RainM3 + m.InitialWaterM3;
            if (total <= 0) { HasMass = false; return; }
            void Seg(string label, double v, string hex)
            {
                MassSegments.Add(new MassSegment
                {
                    Label = label, Value = Math.Max(0, v), Brush = Brushy.Hex(hex),
                    ValueText = Fmt.Smart(v) + " m³", PercentText = Fmt.N(v / total * 100, "0.0") + " %"
                });
            }
            Seg("Initial loss", m.InitialLossM3, "#A78BFA");
            Seg("Infiltration", m.InfiltratedM3, "#34D399");
            Seg("Sewer", m.SewerM3, "#F59E0B");
            Seg("Boundary out", m.BoundaryOutM3, "#94A3B8");
            Seg("Stored on surface", m.StoredM3, "#38BDF8");
            MassTotalText = $"{Fmt.Smart(total)} m³ in (rain{(m.InitialWaterM3 > 0 ? " + initial water" : "")})";
            MassErrorText = $"{Fmt.N(m.ErrorFraction * 100, "0.000")} %";
            HasMass = true;
        }

        private void UpdateBluespots(InstantResult r)
        {
            Bluespots.Clear();
            if (r?.Bluespots != null)
            {
                int rank = 1;
                foreach (var b in r.Bluespots.Where(b => b.VolumeM3 > 0.05).OrderByDescending(b => b.VolumeM3).Take(10))
                {
                    Bluespots.Add(new BluespotRow
                    {
                        Rank = rank++,
                        Volume = Fmt.Smart(b.VolumeM3),
                        Depth = Fmt.N(b.MaxDepthM * 100, "0"),
                        Area = Fmt.Smart(b.WetAreaM2 > 0 ? b.WetAreaM2 : b.AreaM2),
                        SpillRain = b.SpillRainMm > 0 && b.SpillRainMm < 1e6 ? Fmt.N(b.SpillRainMm, "0") : "–",
                        Spills = b.Spills == 1,
                        Deep = b.MaxDepthM >= 0.1
                    });
                }
            }
            Raise(nameof(HasBluespots));
        }

        private void ResetResults()
        {
            StopPlayback();
            _showSeq++;
            HasInstant = false; HasDynamic = false;
            _source = ResultSource.None;
            _frameMax = 0; _frameIndex = 0; ShowingFrame = false;
            Bluespots.Clear(); Raise(nameof(HasBluespots));
            MassSegments.Clear(); HasMass = false;
            InstantSummary = "Not run yet"; DynamicSummary = "Not run yet";
            DynamicPercent = 0; Raise(nameof(DynamicPercentText));
            ResultsStale = false;
            Raise(nameof(ActiveSource), nameof(SourceIsInstant), nameof(SourceIsDynamic), nameof(ShowSourceToggle), nameof(HasFrames), nameof(FrameMax), nameof(FrameIndex), nameof(IsDynamicSource));
            RefreshLayers();
            UpdateStats();
        }

        // ---- bake / export
        private async Task BakeAsync()
        {
            var v = CurrentVisual;
            if (v == null) return;
            using (Busy($"Baking “{v.Title}” into the model…"))
            {
                await HostCall(() => Host.BakeAsync(v));
                Toast($"Baked “{v.Title}” into the {HostName} model.", "Success");
            }
        }

        private async Task ExportAscAsync()
        {
            if (Session?.Grid == null) return;
            var layer = _selectedLayer;
            var inst = Session.Instant; var dyn = Session.Dynamic;
            bool useDyn = _source == ResultSource.Dynamic && dyn != null && layer != UiLayer.FlowPaths;
            if (!useDyn && inst == null) { Toast("Run a model first.", "Warning"); return; }
            int frame = _frameIndex; bool atFrame = _showingFrame && layer == UiLayer.Depth;
            string name = useDyn
                ? layer switch { UiLayer.Velocity => "velocity_max", UiLayer.Hazard => "hazard", UiLayer.TimeToPeak => "time_to_peak_min", _ => atFrame ? $"depth_frame{frame:000}" : "depth_max" }
                : layer == UiLayer.FlowPaths ? "flow_accumulation" : "bluespot_depth";
            var dlg = new Microsoft.Win32.SaveFileDialog
            {
                Title = "Export result as Esri ASCII grid",
                Filter = "Esri ASCII grid (*.asc)|*.asc",
                FileName = $"cloudburst_{name}.asc",
                DefaultExt = ".asc"
            };
            if (dlg.ShowDialog() != true) return;
            string path = dlg.FileName;
            using (Busy("Exporting grid…"))
            {
                await RunEngine(() =>
                {
                    float[] values;
                    if (useDyn)
                        values = layer switch
                        {
                            UiLayer.Velocity => dyn.VMax,
                            UiLayer.Hazard => dyn.Hazard,
                            UiLayer.TimeToPeak => dyn.TPeak.Select(x => x < 0 ? float.NaN : x / 60f).ToArray(),
                            _ => atFrame ? dyn.GetFrame(frame) : dyn.HMax
                        };
                    else values = layer == UiLayer.FlowPaths ? inst.Accumulation : inst.Depth;
                    var grid = useDyn ? dyn.Grid : inst.Grid;
                    Engine.ExportAscii(grid, values, path);
                    return true;
                });
                Toast($"Exported {System.IO.Path.GetFileName(path)}.", "Success");
            }
        }
    }
}
