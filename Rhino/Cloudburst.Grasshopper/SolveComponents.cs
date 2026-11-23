using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Cloudburst.Grid;
using Cloudburst.Model;
using Cloudburst.Native;
using Cloudburst.Results;
using CloudburstRhinoCommon;
using Grasshopper;
using Grasshopper.Kernel;
using Grasshopper.Kernel.Data;
using Grasshopper.Kernel.Types;
using Rhino;
using Rhino.Geometry;

namespace CloudburstGH
{
    internal static class SolveUtil
    {
        public static Scenario MakeScenario(RainEvent rain, int sewer, int moisture)
        {
            var sc = Scenario.Default;
            sc.RainDepthMm = rain.DepthMm;
            sc.ClimateFactor = rain.ClimateFactor;
            sc.SewerMode = Math.Max(0, Math.Min(3, sewer));
            sc.Moisture = Math.Max(0, Math.Min(2, moisture));
            return sc;
        }


        public static float[] DepthOf(object result, out SiteGrid grid, out string name)
        {
            grid = null; name = null;
            var dyn = Gh.As<DynamicResult>(result);
            if (dyn != null) { grid = dyn.Grid; name = "Dynamic"; return dyn.HMax; }
            var ins = Gh.As<InstantResult>(result);
            if (ins != null) { grid = ins.Grid; name = "Instant"; return ins.Depth; }
            return null;
        }
    }

    // ---------------------------------------------------------------------- Solve instant (M1)

    public sealed class SolveInstantComponent : CloudburstComponent
    {
        private static readonly Dictionary<string, InstantResult> Cache = new Dictionary<string, InstantResult>();
        private static readonly LinkedList<string> CacheOrder = new LinkedList<string>();

        public SolveInstantComponent() : base("Solve Instant", "Instant", "Instant bluespot model (M1): where water ponds, how deep, where it flows. Fast enough to drive with sliders.", "4 Solve", Glyph.Instant) { }
        public override Guid ComponentGuid => new Guid("E1C84A27-3F95-4B60-AD17-9B2E6C0F48D3");

        protected override void RegisterInputParams(GH_InputParamManager p)
        {
            p.AddGenericParameter("Grid", "G", "Analysis grid", GH_ParamAccess.item);
            p.AddGenericParameter("Rain", "R", "Rain event", GH_ParamAccess.item);
            AddSewerMoistureInputs(p);
            p.AddNumberParameter("Min depth", "Min", "Smallest depth drawn / counted, m", GH_ParamAccess.item, 0.01);
        }

        protected override void RegisterOutputParams(GH_OutputParamManager p)
        {
            p.AddGenericParameter("Result", "Res", "Instant result (for Result Layer / Compare)", GH_ParamAccess.item);
            p.AddMeshParameter("Depth", "D", "Ponding depth mesh coloured by depth class", GH_ParamAccess.item);
            p.AddCurveParameter("Flow paths", "F", "Main flow paths", GH_ParamAccess.list);
            p.AddPointParameter("Bluespots", "Pt", "Bluespot centres at water level (largest volume first)", GH_ParamAccess.list);
            p.AddNumberParameter("Volume", "V", "Stored volume per bluespot, m³", GH_ParamAccess.list);
            p.AddNumberParameter("Max depth", "Dmax", "Max depth per bluespot, m", GH_ParamAccess.list);
            p.AddNumberParameter("Area", "A", "Wet area per bluespot, m²", GH_ParamAccess.list);
            p.AddNumberParameter("Spill rain", "Spill", "Rain depth at which the bluespot fills and spills, mm", GH_ParamAccess.list);
            p.AddTextParameter("Stats", "S", "Summary", GH_ParamAccess.item);
        }

        protected override void Solve(IGH_DataAccess da)
        {
            object og = null, orain = null; int sewer = 1, moisture = 1; double minDepth = 0.01;
            if (!da.GetData(0, ref og) || !da.GetData(1, ref orain)) return;
            da.GetData(2, ref sewer); da.GetData(3, ref moisture); da.GetData(4, ref minDepth);
            var grid = Gh.As<SiteGrid>(og); var rain = Gh.As<RainEvent>(orain);
            if (grid == null) { AddRuntimeMessage(GH_RuntimeMessageLevel.Error, "Grid must come from Build Grid."); return; }
            if (rain == null) { AddRuntimeMessage(GH_RuntimeMessageLevel.Error, "Rain must come from Rain Event."); return; }

            var sc = SolveUtil.MakeScenario(rain, sewer, moisture);
            sc.MinDepth = Math.Max(0, minDepth);
            string key = $"{RuntimeHelpers.GetHashCode(grid)}|{grid.ContentHash}|{sc.RainDepthMm}|{sc.ClimateFactor}|{sc.SewerMode}|{sc.Moisture}|{sc.MinDepth}";
            InstantResult r;
            lock (Cache)
            {
                if (!Cache.TryGetValue(key, out r))
                {
                    r = Engine.RunInstant(grid, sc);
                    Cache[key] = r; CacheOrder.AddLast(key);
                    while (CacheOrder.Count > 4) { Cache.Remove(CacheOrder.First.Value); CacheOrder.RemoveFirst(); }
                }
            }

            double s = Gh.Scale;
            var vis = VisualFactory.FromInstant(r, ResultLayer.Depth, rain);
            var mesh = RhinoConvert.ToRhinoMesh(vis.Mesh, s);
            PreviewMesh(mesh);

            var curves = new List<Curve>();
            foreach (var fp in r.FlowPaths ?? new List<Cloudburst.Geometry.Polyline3>())
            {
                if (fp == null || fp.Count < 2) continue;
                curves.Add(new PolylineCurve(RhinoConvert.ToPolyline(fp, s, 0.15)));
                foreach (var seg in RhinoConvert.FlowSegments(fp, s)) PreviewLine(seg.line, seg.thickness);
            }
            foreach (var l in vis.Labels.Take(15)) PreviewDot(new Point3d(l.X / s, l.Y / s, l.Z / s), l.Text);

            var spots = (r.Bluespots ?? Array.Empty<Bluespot>()).Where(b => b.VolumeM3 > 0 && b.MaxDepthM >= sc.MinDepth).OrderByDescending(b => b.VolumeM3).ToList();
            var st = r.Stats;
            var sb = new StringBuilder();
            sb.AppendLine($"{rain.Name}: {rain.DesignDepthMm:0} mm design depth");
            sb.AppendLine($"Rain volume      {st.RainVolumeM3,10:N0} m³");
            sb.AppendLine($"Effective runoff {st.EffectiveVolumeM3,10:N0} m³");
            sb.AppendLine($"Stored in spots  {st.StoredVolumeM3,10:N0} m³");
            sb.AppendLine($"Leaves the site  {st.OutflowVolumeM3,10:N0} m³");
            sb.AppendLine($"Flooded area     {st.FloodedAreaM2,10:N0} m²  (> 10 cm: {st.AreaOver10CmM2:N0} m²)");
            sb.AppendLine($"Max depth        {st.MaxDepthM,10:0.00} m");
            sb.AppendLine($"Bluespots {st.BluespotCount} ({st.SpillingCount} spilling) · {st.ElapsedMs:0} ms");
            sb.Append(vis.Caption);

            Message = $"{st.StoredVolumeM3:N0} m³ · {st.ElapsedMs:0} ms";
            da.SetData(0, new InstantResultGoo(r, rain));
            da.SetData(1, mesh);
            da.SetDataList(2, curves);
            da.SetDataList(3, spots.Select(b => new Point3d(b.X / s, b.Y / s, b.LevelZ / s)));
            da.SetDataList(4, spots.Select(b => b.VolumeM3));
            da.SetDataList(5, spots.Select(b => b.MaxDepthM));
            da.SetDataList(6, spots.Select(b => b.WetAreaM2));
            da.SetDataList(7, spots.Select(b => b.SpillRainMm));
            da.SetData(8, sb.ToString());
        }
    }

    // ---------------------------------------------------------------------- Solve dynamic (M2), asynchronous

    public sealed class SolveDynamicComponent : CloudburstComponent
    {
        private CancellationTokenSource _cts;
        private string _runningKey, _resultKey, _errorKey, _error;
        private DynamicResult _result;
        private Mesh _resultMesh; private double _resultMeshScale;
        private volatile float _progress;
        private long _lastPingTicks;

        public SolveDynamicComponent() : base("Solve Dynamic", "Dynamic", "Dynamic 2D surface-flow model (M2). Runs in the background: the canvas stays responsive, progress shows under the component, inputs changes cancel the run.", "4 Solve", Glyph.Dynamic) { }
        public override Guid ComponentGuid => new Guid("5B07D3E9-8A2C-4F61-9E34-C1D86A0B72F5");

        protected override void RegisterInputParams(GH_InputParamManager p)
        {
            p.AddGenericParameter("Grid", "G", "Analysis grid", GH_ParamAccess.item);
            p.AddGenericParameter("Rain", "R", "Rain event", GH_ParamAccess.item);
            p.AddBooleanParameter("Run", "Run", "Start the simulation (use a toggle)", GH_ParamAccess.item, false);
            p.AddNumberParameter("After rain", "After", "Minutes simulated after the rain stops", GH_ParamAccess.item, 60);
            p.AddPointParameter("Probes", "Pr", "Points to record depth time series at", GH_ParamAccess.list);
            AddSewerMoistureInputs(p);
            p[4].Optional = true;
        }

        protected override void RegisterOutputParams(GH_OutputParamManager p)
        {
            p.AddGenericParameter("Result", "Res", "Dynamic result (for Result Layer / Compare)", GH_ParamAccess.item);
            p.AddMeshParameter("Max depth", "D", "Max water depth mesh", GH_ParamAccess.item);
            p.AddTextParameter("Mass balance", "MB", "Volumes in and out", GH_ParamAccess.item);
            p.AddNumberParameter("Probe depth", "PD", "Depth series per probe (one branch per probe), m", GH_ParamAccess.tree);
            p.AddNumberParameter("Probe time", "PT", "Sample times for the probe series, minutes", GH_ParamAccess.list);
        }

        protected override void Solve(IGH_DataAccess da)
        {
            object og = null, orain = null; bool run = false; double after = 60; var probes = new List<Point3d>(); int sewer = 1, moisture = 1;
            if (!da.GetData(0, ref og) || !da.GetData(1, ref orain)) { Cancel(); Message = null; return; }
            da.GetData(2, ref run); da.GetData(3, ref after); da.GetDataList(4, probes); da.GetData(5, ref sewer); da.GetData(6, ref moisture);
            var grid = Gh.As<SiteGrid>(og); var rain = Gh.As<RainEvent>(orain);
            if (grid == null || rain == null) { Cancel(); AddRuntimeMessage(GH_RuntimeMessageLevel.Error, "Connect a Grid (Build Grid) and a Rain (Rain Event)."); return; }

            double s = Gh.Scale;
            var cells = new List<int>();
            int outside = 0;
            foreach (var p in probes) { int k = grid.CellAt(p.X * s, p.Y * s); if (k >= 0) cells.Add(k); else outside++; }
            if (outside > 0) AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, $"{outside} probe point(s) outside the grid were ignored.");

            string key = $"{RuntimeHelpers.GetHashCode(grid)}|{grid.ContentHash}|{rain.Name}|{rain.DepthMm}|{rain.ClimateFactor}|{rain.IntensityMmH.Length}|{rain.StepS}|{after}|{sewer}|{moisture}|{string.Join(",", cells)}";

            if (_result != null && _resultKey == key) { Output(da, s); return; }
            if (_runningKey == key && _cts != null)
            {
                Message = $"Running {_progress * 100:0}%";
                AddRuntimeMessage(GH_RuntimeMessageLevel.Remark, "Simulation running in the background…");
                return;
            }
            Cancel();
            if (_error != null && _errorKey == key) { AddRuntimeMessage(GH_RuntimeMessageLevel.Error, _error); Message = "Failed"; return; }
            if (!run) { Message = "Set Run = true"; return; }

            var sc = SolveUtil.MakeScenario(rain, sewer, moisture);
            sc.AfterRainMin = Math.Max(0, after);
            Start(grid, rain, sc, cells, key);
            Message = "Running 0%";
            AddRuntimeMessage(GH_RuntimeMessageLevel.Remark, "Simulation started in the background…");
        }

        private void Start(SiteGrid grid, RainEvent rain, Scenario sc, List<int> cells, string key)
        {
            var cts = new CancellationTokenSource();
            _cts = cts; _runningKey = key; _progress = 0; _error = null; _errorKey = null;
            var token = cts.Token;
            var sink = new ProgressSink(p =>
            {
                _progress = (float)Math.Max(0, Math.Min(1, p.Fraction));
                long now = DateTime.UtcNow.Ticks;
                if (now - Interlocked.Read(ref _lastPingTicks) < TimeSpan.TicksPerMillisecond * 400) return;
                Interlocked.Exchange(ref _lastPingTicks, now);
                try
                {
                    RhinoApp.InvokeOnUiThread(new Action(() =>
                    {
                        if (token.IsCancellationRequested || _runningKey != key) return;
                        Message = $"Running {_progress * 100:0}%";
                        try { Instances.RedrawCanvas(); } catch { }
                    }));
                }
                catch { }
            });

            Task.Run(() => Engine.RunDynamic(grid, sc, rain, sink, token, cells), token).ContinueWith(t =>
            {
                try
                {
                    RhinoApp.InvokeOnUiThread(new Action(() =>
                    {
                        try
                        {
                            bool stale = token.IsCancellationRequested || _runningKey != key;
                            if (stale)
                            {
                                if (t.Status == TaskStatus.RanToCompletion) try { t.Result?.Dispose(); } catch { }
                                return;
                            }
                            _runningKey = null; _cts = null;
                            if (t.IsFaulted) { _error = t.Exception?.GetBaseException().Message ?? "Simulation failed"; _errorKey = key; }
                            else if (t.IsCanceled) { }
                            else { _result = t.Result; _resultKey = key; _resultMesh = null; }
                            var doc = OnPingDocument();
                            doc?.ScheduleSolution(5, d => ExpireSolution(false));
                        }
                        catch { }
                    }));
                }
                catch { }
            }, TaskScheduler.Default);
        }

        private void Cancel()
        {
            try { _cts?.Cancel(); } catch { }
            _cts = null; _runningKey = null;
        }

        private void Output(IGH_DataAccess da, double s)
        {
            var r = _result;
            if (_resultMesh == null || _resultMeshScale != s)
            {
                _resultMesh = RhinoConvert.ToRhinoMesh(VisualFactory.FromDynamic(r, ResultLayer.Depth).Mesh, s);
                _resultMeshScale = s;
            }
            PreviewMesh(_resultMesh);

            var mb = r.Mass;
            var sb = new StringBuilder();
            sb.AppendLine($"Rain             {mb.RainM3,10:N0} m³");
            if (mb.InitialWaterM3 > 0) sb.AppendLine($"Initial water    {mb.InitialWaterM3,10:N0} m³");
            sb.AppendLine($"Initial loss     {mb.InitialLossM3,10:N0} m³");
            sb.AppendLine($"Infiltrated      {mb.InfiltratedM3,10:N0} m³");
            sb.AppendLine($"Sewer            {mb.SewerM3,10:N0} m³");
            sb.AppendLine($"Left the site    {mb.BoundaryOutM3,10:N0} m³");
            sb.AppendLine($"Stored at end    {mb.StoredM3,10:N0} m³");
            sb.AppendLine($"Balance error    {mb.ErrorFraction * 100,10:0.00} %");
            sb.AppendLine($"Simulated {TimeSpan.FromSeconds(mb.SimulatedS):h\\:mm} h in {mb.ElapsedS:0.0} s ({mb.Steps:N0} steps){(mb.Cancelled != 0 ? " – CANCELLED" : "")}");
            sb.Append(VisualFactory.Caption(r.Rain, r.Scenario, r.Grid, "Dynamic model (M2)"));

            var tree = new DataTree<double>();
            int maxLen = 0;
            if (r.ProbeDepth != null)
                for (int i = 0; i < r.ProbeDepth.Length; i++)
                {
                    var series = r.ProbeDepth[i] ?? Array.Empty<float>();
                    maxLen = Math.Max(maxLen, series.Length);
                    tree.AddRange(series.Select(v => (double)v), new GH_Path(i));
                }

            float hmax = r.HMax.Length > 0 ? r.HMax.Max() : 0;
            Message = $"Done · max {hmax:0.00} m";
            da.SetData(0, new DynamicResultGoo(r));
            da.SetData(1, _resultMesh);
            da.SetData(2, sb.ToString());
            da.SetDataTree(3, tree);
            da.SetDataList(4, Enumerable.Range(0, maxLen).Select(i => (double)i)); // engine samples probes every 60 s
        }

        public override void RemovedFromDocument(GH_Document document)
        {
            Cancel();
            base.RemovedFromDocument(document);
        }

        public override void DocumentContextChanged(GH_Document document, GH_DocumentContext context)
        {
            if (context == GH_DocumentContext.Close || context == GH_DocumentContext.Unloaded) Cancel();
            base.DocumentContextChanged(document, context);
        }

        private sealed class ProgressSink : IProgress<Progress>
        {
            private readonly Action<Progress> _a;
            public ProgressSink(Action<Progress> a) { _a = a; }
            public void Report(Progress value) { try { _a(value); } catch { } }
        }
    }

    // ---------------------------------------------------------------------- Result layer

    public sealed class ResultLayerComponent : CloudburstComponent
    {
        public ResultLayerComponent() : base("Result Layer", "Layer", "Coloured result map: Depth, DepthAtTime, Velocity, Hazard, TimeToPeak or FlowAccumulation, with legend and caption.", "5 Results", Glyph.Layer) { }
        public override Guid ComponentGuid => new Guid("A3E95C61-0F2B-4D87-B7C4-6E18D2F0935A");

        protected override void RegisterInputParams(GH_InputParamManager p)
        {
            p.AddGenericParameter("Result", "Res", "Instant or dynamic result", GH_ParamAccess.item);
            p.AddTextParameter("Layer", "L", "Depth, DepthAtTime, Velocity, Hazard, TimeToPeak, FlowAccumulation (or index 0–5)", GH_ParamAccess.item, "Depth");
            p.AddIntegerParameter("Frame", "F", "Frame index for DepthAtTime (-1 = last)", GH_ParamAccess.item, -1);
        }

        protected override void RegisterOutputParams(GH_OutputParamManager p)
        {
            p.AddMeshParameter("Mesh", "M", "Coloured result mesh", GH_ParamAccess.item);
            p.AddTextParameter("Legend", "LL", "Legend labels", GH_ParamAccess.list);
            p.AddColourParameter("Colours", "LC", "Legend colours", GH_ParamAccess.list);
            p.AddTextParameter("Title", "T", "Map title", GH_ParamAccess.item);
            p.AddTextParameter("Caption", "C", "Assumptions caption – show it with every map", GH_ParamAccess.item);
            p.AddCurveParameter("Flow paths", "F", "Flow paths (instant results)", GH_ParamAccess.list);
            p.AddIntegerParameter("Frames", "N", "Number of frames (dynamic results)", GH_ParamAccess.item);
        }

        protected override void Solve(IGH_DataAccess da)
        {
            IGH_Goo goo = null; string layerText = "Depth"; int frame = -1;
            if (!da.GetData(0, ref goo)) return;
            da.GetData(1, ref layerText); da.GetData(2, ref frame);

            ResultLayer layer;
            if (int.TryParse(layerText?.Trim(), out int li)) layer = (ResultLayer)Math.Max(0, Math.Min(5, li));
            else if (!Enum.TryParse(layerText?.Replace(" ", ""), true, out layer)) { AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, $"Unknown layer '{layerText}', using Depth."); layer = ResultLayer.Depth; }

            ResultVisual v; int frames = 0;
            var dyn = Gh.As<DynamicResult>(goo);
            var ins = Gh.As<InstantResult>(goo);
            if (dyn != null)
            {
                if (layer == ResultLayer.FlowAccumulation) { AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, "Flow accumulation comes from instant results; showing max depth."); layer = ResultLayer.Depth; }
                v = VisualFactory.FromDynamic(dyn, layer, frame);
                frames = dyn.FrameCount;
            }
            else if (ins != null)
            {
                if (layer != ResultLayer.Depth && layer != ResultLayer.FlowAccumulation) { AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, $"{layer} needs a dynamic result; showing depth."); layer = ResultLayer.Depth; }
                v = VisualFactory.FromInstant(ins, layer, (goo as InstantResultGoo)?.Rain);
            }
            else { AddRuntimeMessage(GH_RuntimeMessageLevel.Error, "Connect a result from Solve Instant or Solve Dynamic."); return; }

            double s = Gh.Scale;
            var mesh = RhinoConvert.ToRhinoMesh(v.Mesh, s);
            PreviewMesh(mesh);
            var curves = new List<Curve>();
            if (dyn == null && v.FlowPaths != null)
                foreach (var fp in v.FlowPaths)
                {
                    if (fp == null || fp.Count < 2) continue;
                    curves.Add(new PolylineCurve(RhinoConvert.ToPolyline(fp, s, 0.15)));
                    if (layer == ResultLayer.FlowAccumulation) foreach (var seg in RhinoConvert.FlowSegments(fp, s)) PreviewLine(seg.line, seg.thickness);
                }

            Message = v.Title;
            da.SetData(0, mesh);
            da.SetDataList(1, v.Legend.Select(l => l.Label));
            da.SetDataList(2, v.Legend.Select(l => Color.FromArgb(l.Argb)));
            da.SetData(3, v.Title);
            da.SetData(4, v.Caption);
            da.SetDataList(5, curves);
            da.SetData(6, frames);
        }
    }

    // ---------------------------------------------------------------------- Compare

    public sealed class CompareComponent : CloudburstComponent
    {
        public CompareComponent() : base("Compare Options", "Compare", "Difference in max depth between two results (B − A): where the design makes it wetter or drier.", "6 Compare", Glyph.Compare) { }
        public override Guid ComponentGuid => new Guid("7F2C68B4-D0E3-4A19-8B5E-34A9C1F7E026");

        protected override void RegisterInputParams(GH_InputParamManager p)
        {
            p.AddGenericParameter("A", "A", "Baseline result (instant or dynamic)", GH_ParamAccess.item);
            p.AddGenericParameter("B", "B", "Option result (instant or dynamic)", GH_ParamAccess.item);
            p.AddTextParameter("Name A", "NA", "Name of A", GH_ParamAccess.item, "Existing");
            p.AddTextParameter("Name B", "NB", "Name of B", GH_ParamAccess.item, "Proposal");
        }

        protected override void RegisterOutputParams(GH_OutputParamManager p)
        {
            p.AddMeshParameter("Difference", "D", "Change in max depth (green drier, red wetter)", GH_ParamAccess.item);
            p.AddNumberParameter("Volume A", "VA", "Flooded volume A, m³", GH_ParamAccess.item);
            p.AddNumberParameter("Volume B", "VB", "Flooded volume B, m³", GH_ParamAccess.item);
            p.AddNumberParameter("Change", "dV", "Volume change B − A, m³", GH_ParamAccess.item);
            p.AddNumberParameter("Area > 10 cm A", "AA", "Area deeper than 10 cm in A, m²", GH_ParamAccess.item);
            p.AddNumberParameter("Area > 10 cm B", "AB", "Area deeper than 10 cm in B, m²", GH_ParamAccess.item);
            p.AddTextParameter("Summary", "S", "Comparison summary and caption", GH_ParamAccess.item);
        }

        protected override void Solve(IGH_DataAccess da)
        {
            IGH_Goo a = null, b = null; string na = "Existing", nb = "Proposal";
            if (!da.GetData(0, ref a) || !da.GetData(1, ref b)) return;
            da.GetData(2, ref na); da.GetData(3, ref nb);
            var dA = SolveUtil.DepthOf(a, out var gA, out var mA);
            var dB = SolveUtil.DepthOf(b, out var gB, out var mB);
            if (dA == null || dB == null) { AddRuntimeMessage(GH_RuntimeMessageLevel.Error, "A and B must be results from Solve Instant or Solve Dynamic."); return; }
            if (Math.Abs(gA.CellSize - gB.CellSize) > 1e-6) AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, "The grids have different cell sizes; B is sampled at A's cells.");
            if (mA != mB) AddRuntimeMessage(GH_RuntimeMessageLevel.Remark, $"Comparing a {mA.ToLowerInvariant()} result with a {mB.ToLowerInvariant()} result.");

            var c = new Comparison(gA, dA, na, gB, dB, nb, $"{nb} vs {na} ({mA} / {mB}) · SCREENING MODEL – not for compliance");
            var v = VisualFactory.FromComparison(c);
            var mesh = RhinoConvert.ToRhinoMesh(v.Mesh, Gh.Scale);
            PreviewMesh(mesh);

            string sign = c.VolumeChange >= 0 ? "+" : "−";
            Message = $"{sign}{Math.Abs(c.VolumeChange):N0} m³";
            da.SetData(0, mesh);
            da.SetData(1, c.FloodedVolumeA);
            da.SetData(2, c.FloodedVolumeB);
            da.SetData(3, c.VolumeChange);
            da.SetData(4, c.AreaOver10CmA);
            da.SetData(5, c.AreaOver10CmB);
            da.SetData(6, $"{na}: {c.FloodedVolumeA:N0} m³, {c.AreaOver10CmA:N0} m² > 10 cm\n{nb}: {c.FloodedVolumeB:N0} m³, {c.AreaOver10CmB:N0} m² > 10 cm\nChange: {sign}{Math.Abs(c.VolumeChange):N0} m³\n{c.Caption}");
        }
    }

    // ---------------------------------------------------------------------- Retention

    public sealed class RetentionComponent : CloudburstComponent
    {
        public RetentionComponent() : base("Retention", "Retention", "Required retention volume for a throttled outflow (Danish rational / box method) from the grid's reduced area.", "4 Solve", Glyph.Retention) { }
        public override Guid ComponentGuid => new Guid("D96E1B02-4C7A-4E35-A8F1-5B30E2C69D7B");
        public override GH_Exposure Exposure => GH_Exposure.secondary;

        protected override void RegisterInputParams(GH_InputParamManager p)
        {
            p.AddGenericParameter("Grid", "G", "Analysis grid", GH_ParamAccess.item);
            p.AddNumberParameter("Return period", "T", "Return period, years", GH_ParamAccess.item, 10);
            p.AddNumberParameter("Climate factor", "CF", "Climate factor", GH_ParamAccess.item, 1.3);
            p.AddNumberParameter("Discharge", "Q", "Allowed discharge, l/s per ha", GH_ParamAccess.item, 1.0);
            p.AddNumberParameter("Safety", "SF", "Safety factor", GH_ParamAccess.item, 1.2);
        }

        protected override void RegisterOutputParams(GH_OutputParamManager p)
        {
            p.AddNumberParameter("Reduced area", "Ared", "Reduced (impermeable-equivalent) area, m²", GH_ParamAccess.item);
            p.AddNumberParameter("Peak flow", "Qp", "Rational-method peak flow, l/s", GH_ParamAccess.item);
            p.AddNumberParameter("Required volume", "V", "Required retention volume, m³", GH_ParamAccess.item);
            p.AddTextParameter("Info", "I", "Summary", GH_ParamAccess.item);
        }

        protected override void Solve(IGH_DataAccess da)
        {
            object og = null; double T = 10, cf = 1.3, q = 1.0, sf = 1.2;
            if (!da.GetData(0, ref og)) return;
            da.GetData(1, ref T); da.GetData(2, ref cf); da.GetData(3, ref q); da.GetData(4, ref sf);
            var grid = Gh.As<SiteGrid>(og);
            if (grid == null) { AddRuntimeMessage(GH_RuntimeMessageLevel.Error, "Grid must come from Build Grid."); return; }
            var r = Engine.Retention(grid, new RetentionInput { ReturnPeriod = Math.Max(1, T), ClimateFactor = Math.Max(0.5, cf), DischargeLSHa = Math.Max(0, q), SafetyFactor = Math.Max(1, sf), RationalDurationMin = 10 });
            Message = $"{r.RequiredStorageM3:N0} m³";
            da.SetData(0, r.ReducedAreaM2);
            da.SetData(1, r.PeakFlowLS);
            da.SetData(2, r.RequiredStorageM3);
            da.SetData(3, $"Total area {r.TotalAreaM2:N0} m², reduced {r.ReducedAreaM2:N0} m² (mean C {r.MeanC:0.00})\nPeak flow {r.PeakFlowLS:N0} l/s, allowed outflow {r.OutflowLS:N1} l/s\nRequired storage {r.RequiredStorageM3:N0} m³ (critical duration {r.CriticalDurationMin:0} min)\nT = {T:0} years × CF {cf:0.0#} × safety {sf:0.0#}");
        }
    }
}
