using System;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Input;
using Cloudburst.Demo;
using Cloudburst.Geometry;
using Cloudburst.Grid;
using Cloudburst.Hosting;
using Cloudburst.Model;
using Cloudburst.UI.Infrastructure;

namespace Cloudburst.UI.ViewModels
{
    public sealed partial class MainViewModel
    {
        public ObservableCollection<PickItemViewModel> PickItems { get; } = new ObservableCollection<PickItemViewModel>();
        public ObservableCollection<TerrainFileViewModel> TerrainFiles { get; } = new ObservableCollection<TerrainFileViewModel>();
        public ObservableCollection<string> GridWarnings { get; } = new ObservableCollection<string>();

        public ICommand LoadDemoCommand { get; private set; }
        public ICommand BuildGridCommand { get; private set; }
        public ICommand ImportTerrainFilesCommand { get; private set; }

        private double _cellSize = 1.0, _buildingMinHeight = 5.0;
        private bool _hasGrid, _gridStale;
        private string _cellEstimateText = "Pick terrain or import a DHM to estimate the grid size", _cellEstimateTone = "";
        private string _gridCellsText, _gridAreaText, _gridBuildText, _gridDimsText;
        private int _terrainFileStep = 1;
        private Bounds2 _hostTerrainBounds = Bounds2.Empty, _fileBounds = Bounds2.Empty;
        private Bounds2? _boundaryBounds;

        private void InitSite()
        {
            void Add(PickRole role, string title, string hint, string glyph, bool optional = false, bool height = false)
            {
                var item = new PickItemViewModel { Role = role, Title = title, Hint = hint, Glyph = glyph, IsOptional = optional, ShowsHeight = height };
                item.PickCommand = Cmd(() => PickAsync(item), () => !IsDynamicRunning, "Pick " + title.ToLowerInvariant());
                item.ClearCommand = SyncCmd(() => ClearPick(item), () => item.HasItems && !IsDynamicRunning);
                PickItems.Add(item);
            }
            Add(PickRole.Terrain, "Existing terrain", "Meshes, surfaces or toposolids", "");
            Add(PickRole.DesignTerrain, "Design terrain", "Replaces existing heights where it covers", "", optional: true);
            Add(PickRole.Buildings, "Buildings", "Solids, masses, roofs or extrusions", "");
            Add(PickRole.Walls, "Kerbs & walls", "Curves; negative height = channel", "", optional: true, height: true);
            Add(PickRole.BridgeCuts, "Bridge cut-outs", "Deck outlines to cut from the terrain", "", optional: true);
            Add(PickRole.Boundary, "Analysis boundary", "Closed curve · default is the terrain extent", "", optional: true);

            if (Session != null)
            {
                _cellSize = Session.GridSettings.CellSize;
                _buildingMinHeight = Session.GridSettings.BuildingMinHeight;
            }

            LoadDemoCommand = Cmd(LoadDemoAsync, () => !IsDynamicRunning, "Load demo site");
            BuildGridCommand = Cmd(BuildGridAsync, () => !IsDynamicRunning && HasTerrainSource, "Build grid");
            ImportTerrainFilesCommand = Cmd(ImportTerrainFilesAsync, () => !IsDynamicRunning, "Import DHM terrain");
        }

        public PickItemViewModel WallsItem => PickItems.FirstOrDefault(p => p.Role == PickRole.Walls);
        private PickItemViewModel Item(PickRole r) => PickItems.FirstOrDefault(p => p.Role == r);

        public bool HasTerrainSource => (Item(PickRole.Terrain)?.HasItems ?? false) || (Item(PickRole.DesignTerrain)?.HasItems ?? false) || TerrainFiles.Count > 0;

        // ---- grid settings
        public double CellSize
        {
            get => _cellSize;
            set
            {
                value = double.IsNaN(value) ? 1 : Math.Round(Math.Max(0.25, Math.Min(5, value)) * 4) / 4;
                if (!Set(ref _cellSize, value)) return;
                if (Session != null) Session.GridSettings.CellSize = value;
                Raise(nameof(CellSizeText));
                MarkGridStale();
                UpdateCellEstimate();
            }
        }
        public string CellSizeText => $"{Fmt.N(_cellSize, "0.00")} m";

        public double BuildingMinHeight
        {
            get => _buildingMinHeight;
            set
            {
                value = double.IsNaN(value) ? 5 : Math.Max(0, Math.Min(100, value));
                if (!Set(ref _buildingMinHeight, value)) return;
                if (Session != null) Session.GridSettings.BuildingMinHeight = value;
                MarkGridStale();
            }
        }

        /// <summary>Pixel step when reading DHM rasters (1 = full resolution).</summary>
        public int TerrainFileStep { get => _terrainFileStep; set { if (Set(ref _terrainFileStep, Math.Max(1, Math.Min(16, value)))) MarkGridStale(); } }

        public string CellEstimateText { get => _cellEstimateText; private set => Set(ref _cellEstimateText, value); }
        public string CellEstimateTone { get => _cellEstimateTone; private set => Set(ref _cellEstimateTone, value); }

        public bool HasGrid { get => _hasGrid; private set { if (Set(ref _hasGrid, value)) { RefreshSteps(); Requery(); } } }
        public bool GridStale { get => _gridStale; private set { if (Set(ref _gridStale, value)) RefreshSteps(); } }
        public string GridCellsText { get => _gridCellsText; private set => Set(ref _gridCellsText, value); }
        public string GridAreaText { get => _gridAreaText; private set => Set(ref _gridAreaText, value); }
        public string GridBuildText { get => _gridBuildText; private set => Set(ref _gridBuildText, value); }
        public string GridDimsText { get => _gridDimsText; private set => Set(ref _gridDimsText, value); }

        private void MarkGridStale()
        {
            if (HasGrid) GridStale = true;
            MarkResultsStale();
        }

        private void UpdateCellEstimate()
        {
            try
            {
                var b = _hostTerrainBounds.Union(_fileBounds);
                if (_boundaryBounds.HasValue && _boundaryBounds.Value.IsValid) b = b.IsValid ? b.Intersect(_boundaryBounds.Value) : _boundaryBounds.Value;
                if (!b.IsValid || b.Width <= 0 || b.Height <= 0)
                {
                    CellEstimateText = "Pick terrain or import a DHM to estimate the grid size";
                    CellEstimateTone = "";
                    return;
                }
                double cs = _cellSize;
                long nx = (long)Math.Ceiling(b.Width / cs), ny = (long)Math.Ceiling(b.Height / cs);
                long cells = nx * ny;
                int max = Session?.GridSettings.MaxCells ?? 2_000_000;
                string size = $"{Fmt.N0(b.Width)} × {Fmt.N0(b.Height)} m";
                if (cells > max)
                {
                    CellEstimateText = $"≈ {Fmt.N0(cells)} cells ({size}) – over the {Fmt.N0(max)} limit, use a larger cell size";
                    CellEstimateTone = "Danger";
                }
                else if (cells > 600_000)
                {
                    CellEstimateText = $"≈ {Fmt.N0(cells)} cells ({size}) – dynamic runs will take a while";
                    CellEstimateTone = "Warn";
                }
                else
                {
                    CellEstimateText = $"≈ {Fmt.N0(cells)} cells · {size}";
                    CellEstimateTone = "Good";
                }
            }
            catch (Exception) { }
        }

        // ---- picks
        private PickSummary SafeSummary(PickRole role)
        {
            try { return Host.GetSummary(role) ?? PickSummary.Empty(role); }
            catch (Exception) { return PickSummary.Empty(role); }
        }

        /// <summary>Re-read every pick summary from the host (call after the user changed the selection outside the panel).</summary>
        public void RefreshPicks()
        {
            if (!_ui.CheckAccess()) { try { _ui.BeginInvoke(new Action(RefreshPicks)); } catch (Exception) { } return; }
            try
            {
                foreach (var p in PickItems) p.Apply(SafeSummary(p.Role));
                RefreshAssigned(SafeSummary(PickRole.Surfaces));
                Raise(nameof(HasTerrainSource));
                RefreshSteps();
                Requery();
            }
            catch (Exception ex) { ShowError("Refresh", ex); }
        }

        private async Task PickAsync(PickItemViewModel item)
        {
            using (Busy($"Select {item.Title.ToLowerInvariant()} in {HostName}…"))
            {
                Toast($"Select {item.Title.ToLowerInvariant()} in {HostName}, then confirm.", "Info");
                double h = item.ShowsHeight ? item.HeightCm / 100.0 : 0.10;
                var s = await OnUi(() => Host.PickAsync(item.Role, null, h));
                item.Apply(s ?? SafeSummary(item.Role));
                Raise(nameof(HasTerrainSource));
                MarkGridStale();
                RefreshSteps();
                Requery();
                Toast(item.HasItems ? $"{item.Title}: {item.SubText}" : $"{item.Title}: nothing selected", item.HasItems ? "Success" : "Warning");
                if (item.Role == PickRole.Terrain || item.Role == PickRole.DesignTerrain || item.Role == PickRole.Boundary)
                    await UpdateBoundsFromHostAsync();
            }
        }

        private void ClearPick(PickItemViewModel item)
        {
            try { Host.Clear(item.Role); } catch (Exception ex) { ShowError("Clear", ex); }
            item.Apply(SafeSummary(item.Role));
            Raise(nameof(HasTerrainSource));
            if (item.Role == PickRole.Boundary) _boundaryBounds = null;
            if (item.Role == PickRole.Terrain || item.Role == PickRole.DesignTerrain) _hostTerrainBounds = Bounds2.Empty;
            UpdateCellEstimate();
            MarkGridStale();
            Requery();
        }

        /// <summary>Best effort: ask the host for the site to learn its extent for the cell-count estimate.</summary>
        private async Task UpdateBoundsFromHostAsync()
        {
            try
            {
                var site = await OnUi(() => Host.CollectSiteAsync());
                if (site != null) RememberBounds(site);
            }
            catch (Exception) { /* estimate only */ }
            UpdateCellEstimate();
        }

        private void RememberBounds(SiteModel site)
        {
            var b = Bounds2.Empty;
            foreach (var m in site.Terrain) if (m != null) b = b.Union(m.GetBounds());
            foreach (var m in site.DesignTerrain) if (m != null) b = b.Union(m.GetBounds());
            _hostTerrainBounds = b;
            _boundaryBounds = site.Boundary?.GetBounds();
        }

        // ---- DHM rasters
        private async Task ImportTerrainFilesAsync()
        {
            var dlg = new Microsoft.Win32.OpenFileDialog
            {
                Title = "Import DHM terrain",
                Filter = "Terrain rasters (*.tif;*.tiff;*.asc)|*.tif;*.tiff;*.asc|GeoTIFF (*.tif;*.tiff)|*.tif;*.tiff|Esri ASCII grid (*.asc)|*.asc|All files (*.*)|*.*",
                Multiselect = true
            };
            if (dlg.ShowDialog() != true) return;
            int added = 0;
            foreach (var path in dlg.FileNames)
            {
                if (TerrainFiles.Any(f => string.Equals(f.Path, path, StringComparison.OrdinalIgnoreCase))) continue;
                var vm = new TerrainFileViewModel { Path = path };
                vm.RemoveCommand = SyncCmd(() => { TerrainFiles.Remove(vm); OnTerrainFilesChanged(); });
                TerrainFiles.Add(vm);
                added++;
            }
            OnTerrainFilesChanged();
            if (added > 0) Toast($"{added} terrain raster{(added == 1 ? "" : "s")} added. Build the grid to use {(added == 1 ? "it" : "them")}.", "Success");
            await UpdateFileBoundsAsync();
        }

        private void OnTerrainFilesChanged()
        {
            Raise(nameof(HasTerrainSource), nameof(HasTerrainFiles));
            MarkGridStale();
            RefreshSteps();
            Requery();
            if (TerrainFiles.Count == 0) { _fileBounds = Bounds2.Empty; UpdateCellEstimate(); }
            else Forget(UpdateFileBoundsAsync, "Read DHM extent");
        }

        public bool HasTerrainFiles => TerrainFiles.Count > 0;

        private async Task UpdateFileBoundsAsync()
        {
            var paths = TerrainFiles.Select(f => f.Path).ToList();
            try
            {
                // coarse read (every 32nd pixel) – only the extent is needed
                _fileBounds = await RunEngine(() =>
                {
                    var b = Bounds2.Empty;
                    foreach (var p in paths)
                    {
                        try { b = b.Union(Engine.LoadTerrainRaster(p, 32).GetBounds()); } catch (Exception) { }
                    }
                    return b;
                });
            }
            catch (Exception) { }
            UpdateCellEstimate();
        }

        // ---- demo + grid
        private Task BuildGridAsync() => BuildGridCoreAsync();

        /// <param name="quiet">Rebuild before a run: don't switch to the material map.</param>
        private async Task BuildGridCoreAsync(bool quiet = false)
        {
            if (Session == null) return;
            if (IsDynamicRunning) { Toast("Wait for the dynamic run to finish (or cancel it) before rebuilding the grid.", "Warning"); return; }
            StopPlayback();
            using (Busy($"Collecting the site from {HostName}…"))
            {
                var site = await OnUi(() => Host.CollectSiteAsync());
                if (site == null) throw new InvalidOperationException($"{HostName} returned no site.");
                RememberBounds(site);
                foreach (var f in TerrainFiles) if (!site.TerrainFiles.Contains(f.Path)) site.TerrainFiles.Add(f.Path);
                site.TerrainFileStep = TerrainFileStep;
                if (!site.HasTerrain)
                {
                    Toast("No terrain yet – pick terrain or import a DHM raster first.", "Warning");
                    return;
                }
                UpdateCellEstimate();
                BusyText = "Building the analysis grid…";
                var sw = Stopwatch.StartNew();
                var g = await RunEngine(() => Session.BuildGrid(site));
                sw.Stop();
                OnGridBuilt(g, sw.Elapsed.TotalMilliseconds, quiet);
            }
            _modelDirty = false;
            if (quiet) return;
            SelectLayer(UiLayer.Materials, show: false);
            await ShowSelectedLayerAsync();
        }

        private void OnGridBuilt(SiteGrid g, double ms, bool quiet = false)
        {
            HasGrid = true;
            GridStale = false;
            GridCellsText = Fmt.N0(g.Count);
            GridAreaText = Fmt.N(g.AreaM2 / 1e6, g.AreaM2 < 1e5 ? "0.000" : "0.00");
            GridBuildText = Fmt.N0(ms);
            GridDimsText = $"{g.Nx} × {g.Ny} cells @ {Fmt.N(g.CellSize, "0.##")} m";
            GridWarnings.Clear();
            foreach (var w in g.Warnings) if (!string.IsNullOrWhiteSpace(w)) GridWarnings.Add(w.Trim());
            if (!_hostTerrainBounds.IsValid && !_fileBounds.IsValid) _hostTerrainBounds = new Bounds2(g.X0, g.Y0, g.MaxX, g.MaxY);
            ResetResults();
            if (!quiet) Toast($"Grid ready: {GridDimsText} in {GridBuildText} ms.", "Success");
            RefreshSteps();
            Requery();
        }
    }
}
