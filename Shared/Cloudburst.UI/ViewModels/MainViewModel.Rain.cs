using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Cloudburst.Model;
using Cloudburst.UI.Infrastructure;

namespace Cloudburst.UI.ViewModels
{
    public sealed partial class MainViewModel
    {
        public ObservableCollection<RainOptionViewModel> RainOptions { get; } = new ObservableCollection<RainOptionViewModel>();
        public IReadOnlyList<SewerOption> SewerOptions { get; } = new[]
        {
            new SewerOption { Mode = 0, Title = "No sewer", Detail = "All rain stays on the surface" },
            new SewerOption { Mode = 1, Title = "Combined sewer · 34 mm", Detail = "Initial loss of 34 mm to the pipes" },
            new SewerOption { Mode = 2, Title = "Separate sewer · 29 mm", Detail = "Initial loss of 29 mm to the pipes" },
            new SewerOption { Mode = 3, Title = "Constant capacity", Detail = "Sewer drains a fixed intensity (mm/h)" },
        };

        public ICommand ImportCsvCommand { get; private set; }

        private RainOptionViewModel _selectedRain, _customOption;
        private double _climateFactor = 1.4, _customDepth = 70, _customDuration = 120, _customReturn = 100, _sewerCapacity = 10;
        private int _customShape, _rainVersion, _boundaryMode;
        private SewerOption _selectedSewer;

        private void InitRain()
        {
            try
            {
                var presets = RainEvent.Presets();
                for (int i = 0; i < presets.Count; i++)
                    RainOptions.Add(new RainOptionViewModel { Kind = RainKind.Preset, Title = presets[i].Name, Event = presets[i] });
            }
            catch (Exception ex) { if (EngineError == null) ShowError("Rain presets", ex); }

            _customOption = new RainOptionViewModel { Kind = RainKind.Custom, Title = "Custom", Glyph = "" };
            RegenerateCustom(select: false);
            RainOptions.Add(_customOption);

            if (Session != null)
            {
                var sc = Session.Scenario;
                _selectedSewer = SewerOptions.FirstOrDefault(o => o.Mode == sc.SewerMode) ?? SewerOptions[0];
                if (sc.SewerCapacityMmH > 0) _sewerCapacity = sc.SewerCapacityMmH;
                _boundaryMode = sc.Boundary;
                // default: T = 100 years (cloudburst)
                _selectedRain = RainOptions.FirstOrDefault(o => o.Kind == RainKind.Preset && o.Event?.ReturnPeriod >= 100) ?? RainOptions.FirstOrDefault();
                if (_selectedRain?.Event != null) { Session.Rain = _selectedRain.Event; _climateFactor = _selectedRain.Event.ClimateFactor; }
            }
            else _selectedSewer = SewerOptions[0];

            ImportCsvCommand = Cmd(ImportCsvAsync, null, "Import rain CSV");
        }

        public RainOptionViewModel SelectedRainOption
        {
            get => _selectedRain;
            set
            {
                if (value == null || !Set(ref _selectedRain, value)) return;
                try
                {
                    if (value.Kind == RainKind.Custom) RegenerateCustom(select: false);
                    if (Session != null && value.Event != null) Session.Rain = value.Event;
                    _climateFactor = value.Event?.ClimateFactor ?? _climateFactor;
                    Raise(nameof(ClimateFactor), nameof(IsCustomRain));
                    OnRainChanged();
                }
                catch (Exception ex) { ShowError("Select rain", ex); }
            }
        }

        public bool IsCustomRain => _selectedRain?.Kind == RainKind.Custom;
        public RainEvent CurrentRain => Session?.Rain;
        /// <summary>Bumped whenever the (mutable) rain changes so the hyetograph redraws.</summary>
        public int RainVersion { get => _rainVersion; private set => Set(ref _rainVersion, value); }

        public string RainSummary
        {
            get
            {
                var r = CurrentRain;
                if (r == null) return "";
                return $"{Fmt.N(r.DepthMm, "0")} mm × {Fmt.N(r.ClimateFactor, "0.0#")} = {Fmt.N(r.DesignDepthMm, "0")} mm over {Fmt.Minutes(r.DurationMin)}";
            }
        }

        public string ScenarioChip
        {
            get
            {
                var r = CurrentRain;
                string moist = _moisture == 0 ? "dry" : _moisture == 2 ? "wet" : "moist";
                string sewer = _selectedSewer?.Mode switch { 1 => "combined sewer", 2 => "separate sewer", 3 => $"sewer {Fmt.N(_sewerCapacity, "0")} mm/h", _ => "no sewer" };
                return r == null ? "" : $"{r.Name} · {Fmt.N(r.DesignDepthMm, "0")} mm · {sewer} · {moist} soil";
            }
        }

        public double ClimateFactor
        {
            get => _climateFactor;
            set
            {
                value = double.IsNaN(value) ? 1 : Math.Max(0.5, Math.Min(3, value));
                if (!Set(ref _climateFactor, value)) return;
                if (CurrentRain != null) CurrentRain.ClimateFactor = value;
                if (IsCustomRain) RegenerateCustom(select: true);
                foreach (var o in RainOptions) o.Refresh();
                OnRainChanged();
            }
        }

        // ---- custom event
        public double CustomDepthMm { get => _customDepth; set { if (Set(ref _customDepth, Math.Max(0, Math.Min(500, value)))) RegenerateCustom(select: IsCustomRain); } }
        public double CustomDurationMin { get => _customDuration; set { if (Set(ref _customDuration, Math.Max(5, Math.Min(2880, value)))) RegenerateCustom(select: IsCustomRain); } }
        public double CustomReturnPeriod { get => _customReturn; set { if (Set(ref _customReturn, Math.Max(1, Math.Min(1000, value)))) RegenerateCustom(select: IsCustomRain); } }
        /// <summary>0 CDS, 1 box.</summary>
        public int CustomShape { get => _customShape; set { if (Set(ref _customShape, value)) RegenerateCustom(select: IsCustomRain); } }

        private void RegenerateCustom(bool select)
        {
            try
            {
                double cf = _climateFactor;
                RainEvent ev = _customShape == 1
                    ? RainEvent.Box(Math.Max(1, _customDepth), _customDuration, cf, $"Custom box {_customDepth:0} mm")
                    : RainEvent.Cds(_customReturn, _customDuration, _customDepth, cf, $"Custom T = {_customReturn:0} CDS");
                _customOption.Event = ev;
                _customOption.Title = "Custom";
                _customOption.Refresh();
                if (select && Session != null)
                {
                    Session.Rain = ev;
                    OnRainChanged();
                }
            }
            catch (Exception ex) { if (EngineError == null) ShowError("Custom rain", ex); }
        }

        private async Task ImportCsvAsync()
        {
            var dlg = new Microsoft.Win32.OpenFileDialog
            {
                Title = "Import rain series",
                Filter = "Rain series (*.csv;*.txt)|*.csv;*.txt|All files (*.*)|*.*"
            };
            if (dlg.ShowDialog() != true) return;
            string path = dlg.FileName; double cf = _climateFactor;
            var ev = await Task.Run(() => RainEvent.FromCsv(path, cf));
            var opt = RainOptions.FirstOrDefault(o => o.Kind == RainKind.Csv);
            if (opt == null)
            {
                opt = new RainOptionViewModel { Kind = RainKind.Csv, Glyph = "" };
                RainOptions.Insert(Math.Max(0, RainOptions.Count - 1), opt);
            }
            opt.Title = ev.Name;
            opt.Event = ev;
            _selectedRain = null;
            SelectedRainOption = opt;
            Toast($"Imported “{ev.Name}”: {Fmt.N(ev.DepthMm, "0")} mm over {Fmt.Minutes(ev.DurationMin)}.", "Success");
        }

        // ---- sewer and boundary
        public SewerOption SelectedSewer
        {
            get => _selectedSewer;
            set
            {
                if (value == null || !Set(ref _selectedSewer, value)) return;
                EditScenario((ref Native.Scenario s) => { s.SewerMode = value.Mode; if (value.Mode == 3) s.SewerCapacityMmH = _sewerCapacity; });
                Raise(nameof(IsCapacitySewer), nameof(ScenarioChip));
                OnScenarioInputChanged();
            }
        }
        public bool IsCapacitySewer => _selectedSewer?.Mode == 3;

        public double SewerCapacityMmH
        {
            get => _sewerCapacity;
            set
            {
                if (!Set(ref _sewerCapacity, Math.Max(0, Math.Min(500, value)))) return;
                EditScenario((ref Native.Scenario s) => s.SewerCapacityMmH = _sewerCapacity);
                Raise(nameof(ScenarioChip));
                OnScenarioInputChanged();
            }
        }

        /// <summary>0 open (water leaves the site), 1 closed (walls at the edge).</summary>
        public int BoundaryMode
        {
            get => _boundaryMode;
            set
            {
                if (!Set(ref _boundaryMode, value == 1 ? 1 : 0)) return;
                EditScenario((ref Native.Scenario s) => s.Boundary = _boundaryMode);
                OnScenarioInputChanged();
            }
        }

        private void OnRainChanged()
        {
            RainVersion++;
            Raise(nameof(CurrentRain), nameof(RainSummary), nameof(ScenarioChip), nameof(RunLengthText));
            RefreshSteps();
            OnScenarioInputChanged();
        }

        /// <summary>Rain, sewer or moisture changed: results are out of date; rerun the instant model when Live is on.</summary>
        private void OnScenarioInputChanged()
        {
            Raise(nameof(ScenarioChip));
            MarkResultsStale();
            if (_liveInstant && HasGrid && !IsDynamicRunning && Session != null)
            {
                _liveTimer.Stop();
                _liveTimer.Start();
            }
        }
    }
}
