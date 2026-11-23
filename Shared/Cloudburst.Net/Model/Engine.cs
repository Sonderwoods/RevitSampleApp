using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using Cloudburst.Geometry;
using Cloudburst.Grid;
using Cloudburst.Materials;
using Cloudburst.Native;

namespace Cloudburst.Model
{
    /// <summary>Results of the instant model (M1).</summary>
    public sealed class InstantResult
    {
        public SiteGrid Grid { get; internal set; }
        public Scenario Scenario { get; internal set; }
        /// <summary>Ponding depth per cell, m.</summary>
        public float[] Depth { get; internal set; }
        /// <summary>Flow volume passing each cell, m³.</summary>
        public float[] Accumulation { get; internal set; }
        public int[] Labels { get; internal set; }
        public Bluespot[] Bluespots { get; internal set; }
        /// <summary>Flow paths (metres), per-vertex Weight = upstream volume m³.</summary>
        public List<Polyline3> FlowPaths { get; internal set; }
        public InstantStats Stats { get; internal set; }
    }

    /// <summary>Results of the dynamic model (M2). Frames are fetched lazily from native memory.</summary>
    public sealed class DynamicResult : IDisposable
    {
        private IntPtr _h;
        public SiteGrid Grid { get; internal set; }
        public Scenario Scenario { get; internal set; }
        public RainEvent Rain { get; internal set; }
        public float[] HMax { get; internal set; }
        public float[] VMax { get; internal set; }
        /// <summary>h·(v+0.5), m²/s.</summary>
        public float[] Hazard { get; internal set; }
        /// <summary>h·v, m²/s (flag &gt; 0.5).</summary>
        public float[] HV { get; internal set; }
        /// <summary>Time of max depth, s (−1 never wet).</summary>
        public float[] TPeak { get; internal set; }
        public float[] HFinal { get; internal set; }
        public double[] FrameTimes { get; internal set; }
        public MassBalance Mass { get; internal set; }
        public int[] ProbeCells { get; internal set; }
        public float[][] ProbeDepth { get; internal set; }
        /// <summary>Probe sample times, s (engine samples every 60 s from t = 0).</summary>
        public double[] ProbeTimes => ProbeDepth == null || ProbeDepth.Length == 0 ? Array.Empty<double>() : Enumerable.Range(0, ProbeDepth[0].Length).Select(i => i * 60.0).ToArray();

        internal DynamicResult(IntPtr h) { _h = h; }
        public int FrameCount => FrameTimes?.Length ?? 0;

        public float[] GetFrame(int i)
        {
            var a = new float[Grid.Count];
            if (_h != IntPtr.Zero) NativeMethods.cb_dynamic_copy_frame(_h, Math.Max(0, Math.Min(FrameCount - 1, i)), a, a.Length);
            return a;
        }

        public void Dispose() { if (_h != IntPtr.Zero) { NativeMethods.cb_dynamic_free(_h); _h = IntPtr.Zero; } GC.SuppressFinalize(this); }
        ~DynamicResult() { if (_h != IntPtr.Zero) NativeMethods.cb_dynamic_free(_h); }
    }

    /// <summary>Entry point to the Rust engine. Thread-safe: every call works on its own handles.</summary>
    public static class Engine
    {
        public static string Version => NativeMethods.EnsureLoaded();

        /// <summary>Build the analysis grid. The palette is passed as JSON so user edits apply.</summary>
        public static SiteGrid BuildGrid(SiteModel site, MaterialPalette palette, GridSettings settings = null)
        {
            settings ??= new GridSettings();
            palette ??= MaterialPalette.LoadDefault();
            var s = NativeMethods.cb_site_new();
            try
            {
                foreach (var m in site.Terrain) AddMesh(s, m, 0);
                foreach (var m in site.DesignTerrain) AddMesh(s, m, 1);
                foreach (var f in site.TerrainFiles)
                    if (NativeMethods.cb_site_add_terrain_file(s, f, Math.Max(1, site.TerrainFileStep), 0) < 0)
                        throw new InvalidOperationException(NativeMethods.LastError());
                foreach (var b in site.Buildings)
                {
                    int drain = (int)b.Drainage;
                    int roof = -1;
                    if (b.Geometry != null && b.Geometry.TriangleCount > 0)
                        NativeMethods.cb_site_add_building_mesh(s, b.Geometry.Vertices, b.Geometry.Vertices.Length, b.Geometry.Triangles, b.Geometry.Triangles.Length, drain, roof);
                    else if (b.Footprint != null)
                        NativeMethods.cb_site_add_building_footprint(s, b.Footprint.X, b.Footprint.Y, b.Footprint.Count, b.HeightAboveTerrain, drain, roof);
                }
                foreach (var r in site.Regions)
                {
                    int mi = palette.IndexOf(r.MaterialId);
                    if (mi < 0) { var g = palette.Guess(r.MaterialId); mi = g != null ? palette.IndexOf(g.Id) : palette.DefaultIndex; }
                    int soil = r.SoilClass ?? 0, comp = r.Compacted.HasValue ? (r.Compacted.Value ? 1 : 2) : 0, sewer = r.Sewer.HasValue ? (int)r.Sewer.Value : -1;
                    if (r.Outline != null) NativeMethods.cb_site_add_region_polygon(s, r.Outline.X, r.Outline.Y, r.Outline.Count, mi, soil, comp, sewer);
                    if (r.Surface != null) NativeMethods.cb_site_add_region_mesh(s, r.Surface.Vertices, r.Surface.Vertices.Length, r.Surface.Triangles, r.Surface.Triangles.Length, mi, soil, comp, sewer);
                }
                foreach (var w in site.Walls) NativeMethods.cb_site_add_wall(s, w.Line.X, w.Line.Y, w.Line.Count, w.Height);
                foreach (var c in site.BridgeCuts) NativeMethods.cb_site_add_bridge_cut(s, c.X, c.Y, c.Count);
                if (site.Boundary != null) NativeMethods.cb_site_set_boundary(s, site.Boundary.X, site.Boundary.Y, site.Boundary.Count);

                var gs = new GridSettingsNative
                {
                    CellSize = settings.CellSize, BuildingMinHeight = settings.BuildingMinHeight, MaxCells = settings.MaxCells,
                    DefaultSoil = settings.DefaultSoilClass, DefaultMaterial = palette.IndexOf(settings.DefaultMaterialId ?? palette.DefaultMaterialId),
                    UseRoofHeight = settings.UseRoofHeight ? 1 : 0
                };
                var gh = NativeMethods.cb_grid_build(s, palette.ToJson(), ref gs);
                if (gh == IntPtr.Zero) throw new InvalidOperationException(NativeMethods.LastError());
                return new SiteGrid(gh, palette);
            }
            finally { NativeMethods.cb_site_free(s); }
        }

        private static void AddMesh(IntPtr s, TriangleMesh m, int design)
        {
            if (m == null || m.TriangleCount == 0) return;
            NativeMethods.cb_site_add_terrain(s, m.Vertices, m.Vertices.Length, m.Triangles, m.Triangles.Length, design);
        }

        public static InstantResult RunInstant(SiteGrid grid, Scenario scenario)
        {
            var h = NativeMethods.cb_instant_run(grid.Handle, ref scenario);
            if (h == IntPtr.Zero) throw new InvalidOperationException(NativeMethods.LastError());
            try
            {
                int n = grid.Count;
                var r = new InstantResult { Grid = grid, Scenario = scenario, Depth = new float[n], Accumulation = new float[n], Labels = new int[n] };
                NativeMethods.cb_instant_stats(h, out var st); r.Stats = st;
                NativeMethods.cb_instant_copy(h, 0, r.Depth, n);
                NativeMethods.cb_instant_copy(h, 1, r.Accumulation, n);
                NativeMethods.cb_instant_copy_labels(h, r.Labels, n);
                int nb = NativeMethods.cb_instant_copy_bluespots(h, null, 0);
                r.Bluespots = new Bluespot[nb];
                if (nb > 0) NativeMethods.cb_instant_copy_bluespots(h, r.Bluespots, nb);
                int np = NativeMethods.cb_instant_path_count(h);
                r.FlowPaths = new List<Polyline3>(np);
                for (int p = 0; p < np; p++)
                {
                    int len = NativeMethods.cb_instant_copy_path(h, p, null, 0); // returns doubles count/4
                    var buf = new double[len * 4];
                    int pts = NativeMethods.cb_instant_copy_path(h, p, buf, buf.Length);
                    var x = new double[pts]; var y = new double[pts]; var z = new double[pts]; var w = new double[pts];
                    for (int k = 0; k < pts; k++) { x[k] = buf[4 * k]; y[k] = buf[4 * k + 1]; z[k] = buf[4 * k + 2]; w[k] = buf[4 * k + 3]; }
                    r.FlowPaths.Add(new Polyline3(x, y, z) { Weight = w });
                }
                return r;
            }
            finally { NativeMethods.cb_instant_free(h); }
        }

        /// <summary>Runs the dynamic model synchronously; call from a worker thread (Task.Run).</summary>
        public static DynamicResult RunDynamic(SiteGrid grid, Scenario scenario, RainEvent rain, IProgress<Progress> progress = null,
                                               CancellationToken cancel = default, IList<int> probeCells = null)
        {
            scenario.ClimateFactor = rain.ClimateFactor;
            var probes = probeCells?.Where(c => c >= 0 && c < grid.Count).ToArray() ?? Array.Empty<int>();
            ProgressCallback cb = (ref Progress p, IntPtr _) => { progress?.Report(p); return cancel.IsCancellationRequested ? 0 : 1; };
            IntPtr h;
            try { h = NativeMethods.cb_dynamic_run(grid.Handle, ref scenario, rain.IntensityMmH, rain.IntensityMmH.Length, rain.StepS, probes, probes.Length, cb, IntPtr.Zero); }
            finally { GC.KeepAlive(cb); }
            if (h == IntPtr.Zero) throw new InvalidOperationException(NativeMethods.LastError());
            int n = grid.Count;
            var r = new DynamicResult(h) { Grid = grid, Scenario = scenario, Rain = rain };
            float[] Get(int which) { var a = new float[n]; NativeMethods.cb_dynamic_copy(h, which, a, n); return a; }
            r.HMax = Get(0); r.VMax = Get(1); r.Hazard = Get(2); r.HV = Get(3); r.TPeak = Get(4); r.HFinal = Get(5);
            NativeMethods.cb_dynamic_mass(h, out var mb); r.Mass = mb;
            int fc = NativeMethods.cb_dynamic_frame_count(h);
            r.FrameTimes = Enumerable.Range(0, fc).Select(i => NativeMethods.cb_dynamic_frame_time(h, i)).ToArray();
            r.ProbeCells = probes;
            int pc = NativeMethods.cb_dynamic_probe_count(h);
            r.ProbeDepth = new float[pc][];
            for (int i = 0; i < pc; i++)
            {
                int len = NativeMethods.cb_dynamic_copy_probe(h, i, null, 0);
                r.ProbeDepth[i] = new float[len];
                NativeMethods.cb_dynamic_copy_probe(h, i, r.ProbeDepth[i], len);
            }
            return r;
        }

        /// <summary>Load a GeoTIFF / ASCII grid as a triangle mesh in metres (e.g. to bake DHM terrain into the CAD model).</summary>
        public static TriangleMesh LoadTerrainRaster(string path, int step = 1)
        {
            var m = NativeMethods.cb_raster_to_mesh(path, step);
            if (m == IntPtr.Zero) throw new InvalidOperationException(NativeMethods.LastError());
            try
            {
                int nv = NativeMethods.cb_mesh_copy(m, 0, null, null, 0), nt = NativeMethods.cb_mesh_copy(m, 1, null, null, 0);
                var v = new double[nv]; var t = new int[nt];
                NativeMethods.cb_mesh_copy(m, 0, v, null, nv); NativeMethods.cb_mesh_copy(m, 1, null, t, nt);
                return new TriangleMesh(v, t, System.IO.Path.GetFileNameWithoutExtension(path));
            }
            finally { NativeMethods.cb_mesh_free(m); }
        }

        /// <summary>Export a per-cell array (e.g. HMax) as an Esri ASCII grid (.asc) georeferenced to the grid (OUT-10).</summary>
        public static void ExportAscii(SiteGrid grid, float[] values, string path)
        {
            if (NativeMethods.cb_grid_export_ascii(grid.Handle, values, values.Length, path) == 0) throw new InvalidOperationException(NativeMethods.LastError());
        }

        public static RetentionResult Retention(SiteGrid grid, RetentionInput input)
        {
            if (NativeMethods.cb_grid_retention(grid.Handle, ref input, out var r) == 0) throw new InvalidOperationException(NativeMethods.LastError());
            return r;
        }

        public static RetentionResult Retention(double totalAreaM2, double reducedAreaM2, RetentionInput input)
        {
            NativeMethods.cb_retention(totalAreaM2, reducedAreaM2, ref input, out var r);
            return r;
        }
    }
}
