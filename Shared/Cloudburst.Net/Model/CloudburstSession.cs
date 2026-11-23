using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Cloudburst.Grid;
using Cloudburst.Materials;
using Cloudburst.Native;
using Cloudburst.Results;

namespace Cloudburst.Model
{
    /// <summary>A named result kept for option comparison (OUT-7).</summary>
    public sealed class SavedOption
    {
        public string Name { get; set; }
        public SiteGrid Grid { get; set; }
        public float[] Depth { get; set; }
        public double FloodedVolumeM3 { get; set; }
        public double AreaOver10CmM2 { get; set; }
        public string Model { get; set; }
        public DateTime Created { get; set; } = DateTime.Now;
        public override string ToString() => $"{Name} ({Model}, {FloodedVolumeM3:0} m³)";
    }

    /// <summary>
    /// Host-neutral orchestration of one analysis: palette, settings, grid, instant/dynamic results, saved options.
    /// The shared UI binds to this; Grasshopper uses <see cref="Engine"/> directly.
    /// </summary>
    public sealed class CloudburstSession : IDisposable
    {
        public MaterialPalette Palette { get; set; } = MaterialPalette.LoadDefault();
        public GridSettings GridSettings { get; } = new GridSettings();
        public Scenario Scenario = Scenario.Default;
        public RainEvent Rain { get; set; } = RainEvent.Presets()[1];
        public RetentionInput RetentionInput = new RetentionInput { ReturnPeriod = 10, ClimateFactor = 1.3, DischargeLSHa = 1.0, SafetyFactor = 1.2, RationalDurationMin = 10 };

        public SiteGrid Grid { get; private set; }
        public InstantResult Instant { get; private set; }
        public DynamicResult Dynamic { get; private set; }
        public List<SavedOption> Options { get; } = new List<SavedOption>();

        private readonly Dictionary<string, InstantResult> _instantCache = new Dictionary<string, InstantResult>();

        public event Action<string> Message;

        public SiteGrid BuildGrid(SiteModel site)
        {
            var g = Engine.BuildGrid(site, Palette, GridSettings);
            Instant = null;
            Dynamic?.Dispose(); Dynamic = null;
            _instantCache.Clear();
            var old = Grid; Grid = g;
            // keep old grids alive if referenced by saved options
            if (old != null && Options.All(o => !ReferenceEquals(o.Grid, old))) old.Dispose();
            foreach (var w in g.Warnings) Message?.Invoke(w);
            return g;
        }

        /// <summary>Instant model with the current rain's design depth. Cached by grid hash + scenario.</summary>
        public InstantResult RunInstant()
        {
            if (Grid == null) throw new InvalidOperationException("Build the grid first.");
            var sc = Scenario;
            sc.RainDepthMm = Rain.DepthMm;
            sc.ClimateFactor = Rain.ClimateFactor;
            string key = $"{Grid.ContentHash}|{sc.RainDepthMm}|{sc.ClimateFactor}|{sc.SewerMode}|{sc.Moisture}|{sc.InfiltrationScale}|{sc.MinDepth}";
            if (!_instantCache.TryGetValue(key, out var r))
            {
                r = Engine.RunInstant(Grid, sc);
                if (_instantCache.Count > 16) _instantCache.Clear();
                _instantCache[key] = r;
            }
            Instant = r;
            return r;
        }

        public Task<DynamicResult> RunDynamicAsync(IProgress<Progress> progress, CancellationToken ct, IList<int> probes = null)
        {
            if (Grid == null) throw new InvalidOperationException("Build the grid first.");
            var g = Grid; var sc = Scenario; var rain = Rain;
            return Task.Run(() =>
            {
                var r = Engine.RunDynamic(g, sc, rain, progress, ct, probes);
                Dynamic?.Dispose();
                Dynamic = r;
                return r;
            }, ct);
        }

        public RetentionResult Retention() => Grid == null ? default : Engine.Retention(Grid, RetentionInput);

        /// <summary>Save the latest dynamic (preferred) or instant result as an option.</summary>
        public SavedOption SaveOption(string name = null)
        {
            if (Grid == null) return null;
            float[] d; string model;
            if (Dynamic != null && ReferenceEquals(Dynamic.Grid, Grid)) { d = (float[])Dynamic.HMax.Clone(); model = "Dynamic"; }
            else if (Instant != null) { d = (float[])Instant.Depth.Clone(); model = "Instant"; }
            else return null;
            double a = Grid.CellArea;
            var o = new SavedOption
            {
                Name = name ?? $"Option {(char)('A' + Options.Count)}", Grid = Grid, Depth = d, Model = model,
                FloodedVolumeM3 = d.Sum(x => (double)x) * a, AreaOver10CmM2 = d.Count(x => x >= 0.1f) * a
            };
            Options.Add(o);
            return o;
        }

        public Comparison Compare(SavedOption a, SavedOption b) => new Comparison(a.Grid, a.Depth, a.Name, b.Grid, b.Depth, b.Name);

        public ResultVisual Visual(ResultLayer layer, int frame = -1)
        {
            if (layer == ResultLayer.Materials && Grid != null)
            {
                var m = VisualFactory.MaterialMesh(Grid);
                return new ResultVisual { Layer = layer, Mesh = m, Title = "Surface materials", Caption = "Material map · SCREENING MODEL",
                    Legend = Palette.Materials.Where((x, i) => Grid.Material.Contains((ushort)i)).Select(x => new LegendItem(x.Name, x.Argb)).ToList() };
            }
            if (layer == ResultLayer.Depth || layer == ResultLayer.FlowAccumulation)
            {
                if (Dynamic != null && layer == ResultLayer.Depth && ReferenceEquals(Dynamic.Grid, Grid)) return VisualFactory.FromDynamic(Dynamic, layer);
                if (Instant != null) return VisualFactory.FromInstant(Instant, layer, Rain);
            }
            if (Dynamic != null) return VisualFactory.FromDynamic(Dynamic, layer, frame);
            if (Instant != null) return VisualFactory.FromInstant(Instant, ResultLayer.Depth, Rain);
            return null;
        }

        public void Dispose()
        {
            Dynamic?.Dispose();
            Grid?.Dispose();
            foreach (var o in Options) o.Grid?.Dispose();
        }
    }
}
