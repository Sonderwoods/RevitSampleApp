using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Data;
using System.Windows.Input;
using Cloudburst.Hosting;
using Cloudburst.Materials;

namespace Cloudburst.UI.ViewModels
{
    public sealed partial class MainViewModel
    {
        public ObservableCollection<MaterialItemViewModel> Materials { get; } = new ObservableCollection<MaterialItemViewModel>();
        /// <summary>Grouped + filtered view for the palette list (separate from the default view used by combo boxes).</summary>
        public ListCollectionView MaterialsView { get; private set; }
        public ObservableCollection<AssignedMaterialRow> AssignedMaterials { get; } = new ObservableCollection<AssignedMaterialRow>();

        public IReadOnlyList<SoilClassItem> SoilClasses { get; } = new[]
        {
            new SoilClassItem { Number = 1, Name = "Coarse sand" }, new SoilClassItem { Number = 2, Name = "Fine sand" },
            new SoilClassItem { Number = 3, Name = "Coarse clayey sand" }, new SoilClassItem { Number = 4, Name = "Fine clayey sand" },
            new SoilClassItem { Number = 5, Name = "Coarse sandy clay" }, new SoilClassItem { Number = 6, Name = "Fine sandy clay" },
            new SoilClassItem { Number = 7, Name = "Clay" }, new SoilClassItem { Number = 8, Name = "Heavy clay" },
            new SoilClassItem { Number = 9, Name = "Very heavy clay" }, new SoilClassItem { Number = 10, Name = "Silt" },
            new SoilClassItem { Number = 11, Name = "Humus" },
        };

        public ICommand AssignMaterialCommand { get; private set; }
        public ICommand AutoAssignCommand { get; private set; }
        public ICommand ClearSurfacesCommand { get; private set; }
        public ICommand ResetPaletteCommand { get; private set; }

        private string _materialSearch = "";
        private MaterialItemViewModel _selectedMaterial, _defaultMaterial;
        private SoilClassItem _selectedSoil;
        private int _moisture = 1, _assignedTotal;
        private string _assignedSummary = "No surfaces assigned yet – unassigned cells use the default material.";

        private void InitSurfaces()
        {
            LoadMaterials();
            _selectedSoil = SoilClasses.FirstOrDefault(s => s.Number == (Session?.GridSettings.DefaultSoilClass ?? 6)) ?? SoilClasses[5];
            if (Session != null) _moisture = Session.Scenario.Moisture;

            AssignMaterialCommand = Cmd(AssignAsync, () => SelectedMaterial != null && !IsDynamicRunning, "Assign material");
            AutoAssignCommand = Cmd(AutoAssignAsync, () => !IsDynamicRunning, "Auto-assign");
            ClearSurfacesCommand = SyncCmd(() =>
            {
                Host.Clear(PickRole.Surfaces);
                RefreshAssigned(SafeSummary(PickRole.Surfaces));
                MarkGridStale();
            }, () => AssignedTotal > 0 && !IsDynamicRunning, "Clear surfaces");
            ResetPaletteCommand = SyncCmd(() =>
            {
                if (Session == null) return;
                Session.Palette = MaterialPalette.LoadDefault();
                LoadMaterials();
                MarkGridStale();
                Toast("Palette reset to the shipped defaults.", "Success");
            }, null, "Reset palette");
        }

        private void LoadMaterials()
        {
            string selId = _selectedMaterial?.Id, defId = _defaultMaterial?.Id;
            Materials.Clear();
            if (Session?.Palette == null) return;
            int i = 0;
            foreach (var m in Session.Palette.Materials) Materials.Add(new MaterialItemViewModel(m, i++, OnPaletteEdited));
            var view = new ListCollectionView(Materials);
            view.GroupDescriptions.Add(new PropertyGroupDescription(nameof(MaterialItemViewModel.CategoryLabel)));
            view.SortDescriptions.Add(new SortDescription(nameof(MaterialItemViewModel.CategoryOrder), ListSortDirection.Ascending));
            view.SortDescriptions.Add(new SortDescription(nameof(MaterialItemViewModel.Order), ListSortDirection.Ascending));
            view.Filter = FilterMaterial;
            MaterialsView = view;
            Raise(nameof(MaterialsView));
            _selectedMaterial = Materials.FirstOrDefault(m => m.Id == selId);
            Raise(nameof(SelectedMaterial), nameof(HasSelectedMaterial));
            var defaultId = defId ?? Session.GridSettings.DefaultMaterialId ?? Session.Palette.DefaultMaterialId;
            _defaultMaterial = Materials.FirstOrDefault(m => string.Equals(m.Id, defaultId, StringComparison.OrdinalIgnoreCase)) ?? Materials.FirstOrDefault();
            Raise(nameof(DefaultMaterial));
        }

        private bool FilterMaterial(object o)
        {
            if (string.IsNullOrWhiteSpace(_materialSearch)) return true;
            if (!(o is MaterialItemViewModel m)) return false;
            var q = _materialSearch.Trim();
            return (m.Name?.IndexOf(q, StringComparison.OrdinalIgnoreCase) ?? -1) >= 0
                || (m.CategoryLabel?.IndexOf(q, StringComparison.OrdinalIgnoreCase) ?? -1) >= 0
                || (m.M.Keywords?.Any(k => k.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0) ?? false);
        }

        public string MaterialSearch
        {
            get => _materialSearch;
            set
            {
                if (!Set(ref _materialSearch, value ?? "")) return;
                try { MaterialsView?.Refresh(); } catch (Exception) { }
            }
        }

        public MaterialItemViewModel SelectedMaterial
        {
            get => _selectedMaterial;
            set { if (Set(ref _selectedMaterial, value)) { Raise(nameof(HasSelectedMaterial)); Requery(); } }
        }
        public bool HasSelectedMaterial => _selectedMaterial != null;

        public MaterialItemViewModel DefaultMaterial
        {
            get => _defaultMaterial;
            set
            {
                if (value == null || !Set(ref _defaultMaterial, value)) return;
                if (Session != null) Session.GridSettings.DefaultMaterialId = value.Id;
                MarkGridStale();
            }
        }

        public SoilClassItem SelectedSoil
        {
            get => _selectedSoil;
            set
            {
                if (value == null || !Set(ref _selectedSoil, value)) return;
                if (Session != null) Session.GridSettings.DefaultSoilClass = value.Number;
                MarkGridStale();
            }
        }

        /// <summary>0 dry, 1 moist, 2 wet.</summary>
        public int Moisture
        {
            get => _moisture;
            set
            {
                value = Math.Max(0, Math.Min(2, value));
                if (!Set(ref _moisture, value)) return;
                EditScenario((ref Native.Scenario s) => s.Moisture = value);
                OnScenarioInputChanged();
            }
        }

        public int AssignedTotal { get => _assignedTotal; private set { if (Set(ref _assignedTotal, value)) { RefreshSteps(); Requery(); } } }
        public string AssignedSummary { get => _assignedSummary; private set => Set(ref _assignedSummary, value); }

        private void OnPaletteEdited()
        {
            MarkGridStale();
            Toast("Material values changed – rebuild the grid to apply them.", "Info");
        }

        private async Task AssignAsync()
        {
            var m = SelectedMaterial;
            if (m == null) return;
            using (Busy($"Select surfaces for “{m.Name}” in {HostName}…"))
            {
                Toast($"Select surfaces for “{m.Name}” in {HostName}.", "Info");
                var s = await OnUi(() => Host.PickAsync(PickRole.Surfaces, m.Id));
                RefreshAssigned(s ?? SafeSummary(PickRole.Surfaces));
                MarkGridStale();
                Toast($"{m.Name} assigned. {AssignedSummary}", "Success");
            }
        }

        private async Task AutoAssignAsync()
        {
            using (Busy($"Select objects to classify by name in {HostName}…"))
            {
                Toast("Select surfaces – materials are guessed from layer, material and object names.", "Info");
                var s = await OnUi(() => Host.PickAsync(PickRole.Surfaces, null));
                RefreshAssigned(s ?? SafeSummary(PickRole.Surfaces));
                MarkGridStale();
                Toast($"Auto-assigned. {AssignedSummary}", "Success");
            }
        }

        private void RefreshAssigned(PickSummary s)
        {
            AssignedMaterials.Clear();
            int total = 0;
            if (s?.Materials != null)
            {
                foreach (var kv in s.Materials.OrderByDescending(k => k.Value))
                {
                    var mat = Session?.Palette?.Get(kv.Key) ?? Session?.Palette?.Guess(kv.Key);
                    AssignedMaterials.Add(new AssignedMaterialRow
                    {
                        Name = mat?.Name ?? kv.Key,
                        Count = kv.Value,
                        Brush = mat != null ? Brushy.FromArgb(mat.Argb) : Brushy.Hex("#888888")
                    });
                    total += kv.Value;
                }
            }
            if (total == 0 && s != null) total = s.Count;
            AssignedTotal = total;
            AssignedSummary = total == 0
                ? "No surfaces assigned yet – unassigned cells use the default material."
                : $"{total} object{(total == 1 ? "" : "s")} in {AssignedMaterials.Count} material{(AssignedMaterials.Count == 1 ? "" : "s")}";
        }
    }
}
