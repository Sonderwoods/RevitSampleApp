using System;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Threading;
using Cloudburst.Hosting;

namespace Cloudburst.UI.ViewModels
{
    /// <summary>Reacting to the CAD model: re-read moved/edited objects, show the selection's material, material view.</summary>
    public sealed partial class MainViewModel
    {
        private ICloudburstHostEvents _events;
        private DispatcherTimer _geometryTimer;
        private bool _modelDirty;

        /// <summary>True when the host can report changes/selection and colour objects by material.</summary>
        public bool HasHostEvents => _events != null;

        private void InitHostEvents()
        {
            _events = Host as ICloudburstHostEvents;
            if (_events == null) return;
            _geometryTimer = new DispatcherTimer(DispatcherPriority.Background, _ui) { Interval = TimeSpan.FromMilliseconds(700) };
            _geometryTimer.Tick += (s, e) => { _geometryTimer.Stop(); Forget(LiveGeometryUpdateAsync, "Live update"); };
            _events.ModelChanged += (s, e) => _ui.BeginInvoke(new Action(OnHostModelChanged));
            _events.SelectionChanged += (s, info) => _ui.BeginInvoke(new Action(() => OnHostSelection(info)));
            Raise(nameof(HasHostEvents));
        }

        private void OnHostModelChanged()
        {
            if (_disposed) return;
            _modelDirty = true;
            try { RefreshPicks(); } catch (Exception) { }
            if (!HasGrid) return;
            MarkGridStale();
            if (LiveInstant && !IsDynamicRunning) { _geometryTimer.Stop(); _geometryTimer.Start(); }
        }

        /// <summary>Live mode: a picked object moved → rebuild the grid from the model and rerun the instant model.</summary>
        private async Task LiveGeometryUpdateAsync()
        {
            if (_disposed || !HasGrid || IsDynamicRunning || !_modelDirty) return;
            await RebuildFromModelAsync();
            await RunInstantCoreAsync(live: true);
        }

        /// <summary>Re-read every picked object from the CAD model and rebuild the grid (used before each explicit run).</summary>
        private async Task RebuildFromModelAsync()
        {
            if (Session == null || IsDynamicRunning) return;
            await BuildGridCoreAsync(quiet: true);
            _modelDirty = false;
        }

        // ---------------------------------------------------------------- selection → material

        private string _selectionText;
        private bool _hasSelectionInfo;
        public string SelectionText { get => _selectionText; private set => Set(ref _selectionText, value); }
        public bool HasSelectionInfo { get => _hasSelectionInfo; private set => Set(ref _hasSelectionInfo, value); }

        private void OnHostSelection(SelectionInfo info)
        {
            if (_disposed) return;
            if (info == null || info.Count == 0) { HasSelectionInfo = false; return; }
            string Name(string id) => Session?.Palette?.Get(id)?.Name ?? id;
            var parts = new System.Collections.Generic.List<string>();
            if (info.Materials.Count > 0)
                parts.Add(string.Join(", ", info.Materials.OrderByDescending(kv => kv.Value).Select(kv => info.Materials.Count == 1 ? Name(kv.Key) : $"{Name(kv.Key)} ({kv.Value})")));
            else parts.Add("no material assigned");
            if (info.Roles.Count > 0) parts.Add("picked as " + string.Join(", ", info.Roles.Keys.Select(r => r.ToString().ToLowerInvariant())));
            else parts.Add("not picked yet");
            SelectionText = $"{info.Count} selected · {string.Join(" · ", parts)}";
            HasSelectionInfo = true;
            // reveal the material in the palette when the selection has exactly one
            if (info.Materials.Count == 1)
            {
                var id = info.Materials.Keys.First();
                var item = Materials.FirstOrDefault(m => string.Equals(m.M.Id, id, StringComparison.OrdinalIgnoreCase));
                if (item != null) SelectedMaterial = item;
            }
        }

        // ---------------------------------------------------------------- material view

        private bool _materialOverlay;
        public bool MaterialOverlay
        {
            get => _materialOverlay;
            set
            {
                if (!Set(ref _materialOverlay, value) || _events == null) return;
                var ev = _events; bool on = value;
                Forget(() => OnUi(() => ev.ShowMaterialOverlayAsync(on)), "Material view");
            }
        }
    }
}
