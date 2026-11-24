using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Cloudburst.Results;
using Cloudburst.UI.Infrastructure;

namespace Cloudburst.UI.ViewModels
{
    public sealed partial class MainViewModel
    {
        public ObservableCollection<SavedOptionViewModel> SavedOptions { get; } = new ObservableCollection<SavedOptionViewModel>();
        public IReadOnlyList<double> ReturnPeriods { get; } = new double[] { 2, 5, 10, 20, 50, 100 };

        public ICommand SaveOptionCommand { get; private set; }
        public ICommand RemoveOptionCommand { get; private set; }
        public ICommand CompareCommand { get; private set; }
        public ICommand RetentionCommand { get; private set; }

        private string _optionName = "Option A";
        private SavedOptionViewModel _compareA, _compareB;
        private bool _hasComparison, _hasRetention;
        private string _cmpTitle, _cmpVolumeText, _cmpVolumeTone, _cmpVolumeNote, _cmpAreaText, _cmpAreaTone, _cmpAreaNote;
        private double _retT = 10, _retCf = 1.3, _retDischarge = 1.0, _retSafety = 1.2;
        private string _retStorage = "–", _retReducedArea = "–", _retMeanC = "–", _retPeak = "–", _retOutflow = "–", _retCritical = "–", _retTotalArea = "–";

        private void InitCompare()
        {
            if (Session != null)
            {
                var ri = Session.RetentionInput;
                _retT = ri.ReturnPeriod > 0 ? ri.ReturnPeriod : 10;
                _retCf = ri.ClimateFactor > 0 ? ri.ClimateFactor : 1.3;
                _retDischarge = ri.DischargeLSHa > 0 ? ri.DischargeLSHa : 1.0;
                _retSafety = ri.SafetyFactor > 0 ? ri.SafetyFactor : 1.2;
                ApplyRetentionInput();
            }
            SaveOptionCommand = SyncCmd(SaveOption, () => HasResults && !IsDynamicRunning, "Save option");
            RemoveOptionCommand = new RelayCommand(p =>
            {
                try
                {
                    if (!(p is SavedOptionViewModel o)) return;
                    Session?.Options.Remove(o.Option);
                    SavedOptions.Remove(o);
                    if (_compareA == o) CompareA = null;
                    if (_compareB == o) CompareB = null;
                    RefreshSteps();
                }
                catch (Exception ex) { ShowError("Remove option", ex); }
            });
            CompareCommand = Cmd(CompareAsync, () => _compareA != null && _compareB != null && _compareA != _compareB && !IsDynamicRunning, "Compare");
            RetentionCommand = Cmd(ComputeRetentionAsync, () => HasGrid && !IsDynamicRunning, "Retention");
        }

        public string OptionName { get => _optionName; set => Set(ref _optionName, value); }

        private void SaveOption()
        {
            if (Session == null) return;
            var name = string.IsNullOrWhiteSpace(_optionName) ? null : _optionName.Trim();
            var o = Session.SaveOption(name);
            if (o == null) { Toast("Run a model first – there is no result to save.", "Warning"); return; }
            var vm = new SavedOptionViewModel { Option = o, Letter = ((char)('A' + (SavedOptions.Count % 26))).ToString() };
            SavedOptions.Add(vm);
            if (_compareA == null) CompareA = vm;
            else if (_compareB == null || SavedOptions.Count > 2) CompareB = vm;
            OptionName = $"Option {(char)('A' + (SavedOptions.Count % 26))}";
            RefreshSteps();
            Toast($"Saved “{o.Name}” ({o.Model}, {Fmt.Smart(o.FloodedVolumeM3)} m³).", "Success");
        }

        public SavedOptionViewModel CompareA { get => _compareA; set { if (Set(ref _compareA, value)) Requery(); } }
        public SavedOptionViewModel CompareB { get => _compareB; set { if (Set(ref _compareB, value)) Requery(); } }

        public bool HasComparison { get => _hasComparison; private set => Set(ref _hasComparison, value); }
        public string CmpTitle { get => _cmpTitle; private set => Set(ref _cmpTitle, value); }
        public string CmpVolumeText { get => _cmpVolumeText; private set => Set(ref _cmpVolumeText, value); }
        public string CmpVolumeTone { get => _cmpVolumeTone; private set => Set(ref _cmpVolumeTone, value); }
        public string CmpVolumeNote { get => _cmpVolumeNote; private set => Set(ref _cmpVolumeNote, value); }
        public string CmpAreaText { get => _cmpAreaText; private set => Set(ref _cmpAreaText, value); }
        public string CmpAreaTone { get => _cmpAreaTone; private set => Set(ref _cmpAreaTone, value); }
        public string CmpAreaNote { get => _cmpAreaNote; private set => Set(ref _cmpAreaNote, value); }

        private async Task CompareAsync()
        {
            var a = _compareA; var b = _compareB;
            if (a == null || b == null || Session == null) return;
            StopPlayback();
            using (Busy("Comparing options…"))
            {
                var (c, v) = await RunEngine(() =>
                {
                    var cmp = Session.Compare(a.Option, b.Option);
                    return (cmp, VisualFactory.FromComparison(cmp));
                });
                _showSeq++;
                await ShowVisualCoreAsync(v);
                double dv = c.VolumeChange, da = c.AreaOver10CmB - c.AreaOver10CmA;
                CmpTitle = $"{b.Name} vs {a.Name}";
                CmpVolumeText = Fmt.Signed(dv, Math.Abs(dv) >= 100 ? "#,0" : "0.#");
                CmpVolumeTone = dv < -0.5 ? "Good" : dv > 0.5 ? "Danger" : "";
                CmpVolumeNote = $"{Fmt.Smart(c.FloodedVolumeA)} → {Fmt.Smart(c.FloodedVolumeB)} m³";
                CmpAreaText = Fmt.Signed(da, Math.Abs(da) >= 100 ? "#,0" : "0.#");
                CmpAreaTone = da < -0.5 ? "Good" : da > 0.5 ? "Danger" : "";
                CmpAreaNote = $"{Fmt.Smart(c.AreaOver10CmA)} → {Fmt.Smart(c.AreaOver10CmB)} m²";
                HasComparison = true;
                Toast($"Showing {CmpTitle}: green is drier, red is wetter.", "Success");
            }
        }

        // ---- retention (indicative)
        public double RetReturnPeriod { get => _retT; set { if (Set(ref _retT, Math.Max(1, Math.Min(1000, value)))) OnRetentionInput(); } }
        public double RetClimateFactor { get => _retCf; set { if (Set(ref _retCf, double.IsNaN(value) ? 1 : Math.Max(0.5, Math.Min(3, value)))) OnRetentionInput(); } }
        public double RetDischarge { get => _retDischarge; set { if (Set(ref _retDischarge, double.IsNaN(value) ? 1 : Math.Max(0, Math.Min(10000, value)))) OnRetentionInput(); } }
        public double RetSafety { get => _retSafety; set { if (Set(ref _retSafety, double.IsNaN(value) ? 1.2 : Math.Max(1, Math.Min(3, value)))) OnRetentionInput(); } }

        public bool HasRetention { get => _hasRetention; private set { if (Set(ref _hasRetention, value)) RefreshSteps(); } }
        public string RetStorage { get => _retStorage; private set => Set(ref _retStorage, value); }
        public string RetReducedArea { get => _retReducedArea; private set => Set(ref _retReducedArea, value); }
        public string RetMeanC { get => _retMeanC; private set => Set(ref _retMeanC, value); }
        public string RetPeak { get => _retPeak; private set => Set(ref _retPeak, value); }
        public string RetOutflow { get => _retOutflow; private set => Set(ref _retOutflow, value); }
        public string RetCritical { get => _retCritical; private set => Set(ref _retCritical, value); }
        public string RetTotalArea { get => _retTotalArea; private set => Set(ref _retTotalArea, value); }

        private void ApplyRetentionInput()
        {
            if (Session == null) return;
            var ri = Session.RetentionInput;
            ri.ReturnPeriod = _retT; ri.ClimateFactor = _retCf; ri.DischargeLSHa = _retDischarge; ri.SafetyFactor = _retSafety;
            Session.RetentionInput = ri;
        }

        private void OnRetentionInput()
        {
            ApplyRetentionInput();
            _retentionTimer.Stop();
            _retentionTimer.Start();
        }

        private async Task ComputeRetentionAsync()
        {
            if (Session?.Grid == null) { Toast("Build the grid first (step 1).", "Warning"); return; }
            ApplyRetentionInput();
            var r = await RunEngine(() => Session.Retention());
            RetStorage = Fmt.N0(r.RequiredStorageM3);
            RetReducedArea = Fmt.N0(r.ReducedAreaM2);
            RetTotalArea = Fmt.N0(r.TotalAreaM2);
            RetMeanC = Fmt.N(r.MeanC, "0.00");
            RetPeak = Fmt.N0(r.PeakFlowLS);
            RetOutflow = Fmt.N(r.OutflowLS, r.OutflowLS < 10 ? "0.0" : "#,0");
            RetCritical = Fmt.Minutes(r.CriticalDurationMin);
            HasRetention = true;
        }
    }
}
