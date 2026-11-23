using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using Cloudburst;
using Cloudburst.Grid;
using Cloudburst.Model;
using CloudburstRhinoCommon;
using Grasshopper.Kernel;
using Grasshopper.Kernel.Types;
using Rhino;
using Rhino.Geometry;

namespace CloudburstGH
{
    public sealed class CloudburstInfo : GH_AssemblyInfo
    {
        public override string Name => "Cloudburst";
        public override string Description => "Cloudburst / rainwater flood screening: grid, materials, rain, instant (bluespot) and dynamic models, result layers, comparison and retention.";
        public override Guid Id => new Guid("B7E3C1A4-58D2-4F0E-9A6B-2C8D4E1F7A39");
        public override string AuthorName => "Cloudburst";
        public override string AuthorContact => "";
        public override string Version => "0.1.0";
        public override Bitmap Icon => Icons.Get(Glyph.Drop);
    }

    /// <summary>Preloads cloudburst_core.dll from the .gha folder (and every GH library folder) before any component runs.</summary>
    public sealed class CloudburstPriority : GH_AssemblyPriority
    {
        public override GH_LoadingInstruction PriorityLoad()
        {
            try
            {
                var dirs = new List<string>();
                try { dirs.Add(Path.GetDirectoryName(typeof(CloudburstPriority).Assembly.Location)); } catch { }
                try { dirs.Add(Path.GetDirectoryName(typeof(Engine).Assembly.Location)); } catch { }
                try { dirs.AddRange(Grasshopper.Folders.AssemblyFolders.Select(f => f.Folder)); } catch { }
                try { dirs.Add(Grasshopper.Folders.DefaultAssemblyFolder); } catch { }
                NativeLoader.Preload(dirs.Where(d => !string.IsNullOrEmpty(d)).Distinct());
            }
            catch { }
            return GH_LoadingInstruction.Proceed;
        }
    }

    // ====================================================================== Goo

    /// <summary>Reference wrapper for Cloudburst objects (no copy on duplicate: they are immutable results).</summary>
    public abstract class CbGoo<T> : GH_Goo<T> where T : class
    {
        protected CbGoo() { }
        protected CbGoo(T v) { Value = v; }
        public override bool IsValid => Value != null;
        public override string TypeDescription => "Cloudburst " + TypeName;
        public override string ToString() => Value == null ? "Null " + TypeName : Describe(Value);
        protected virtual string Describe(T v) => v.ToString();
        public override object ScriptVariable() => Value;
    }

    public sealed class SiteGridGoo : CbGoo<SiteGrid>
    {
        public SiteGridGoo() { }
        public SiteGridGoo(SiteGrid v) : base(v) { }
        public override string TypeName => "Grid";
        public override IGH_Goo Duplicate() => new SiteGridGoo(Value);
        protected override string Describe(SiteGrid v) => "Grid " + v;
    }

    /// <summary>Instant result plus the rain that produced it (for captions).</summary>
    public sealed class InstantResultGoo : CbGoo<InstantResult>
    {
        public RainEvent Rain { get; set; }
        public InstantResultGoo() { }
        public InstantResultGoo(InstantResult v, RainEvent rain) : base(v) { Rain = rain; }
        public override string TypeName => "Instant result";
        public override IGH_Goo Duplicate() => new InstantResultGoo(Value, Rain);
        protected override string Describe(InstantResult v) => $"Instant result: {v.Stats.BluespotCount} bluespots, {v.Stats.StoredVolumeM3:0} m³ stored";
    }

    public sealed class DynamicResultGoo : CbGoo<DynamicResult>
    {
        public DynamicResultGoo() { }
        public DynamicResultGoo(DynamicResult v) : base(v) { }
        public override string TypeName => "Dynamic result";
        public override IGH_Goo Duplicate() => new DynamicResultGoo(Value);
        protected override string Describe(DynamicResult v) => $"Dynamic result: {v.FrameCount} frames, max {(v.HMax.Length > 0 ? v.HMax.Max() : 0):0.00} m";
    }

    public sealed class RainEventGoo : CbGoo<RainEvent>
    {
        public RainEventGoo() { }
        public RainEventGoo(RainEvent v) : base(v) { }
        public override string TypeName => "Rain";
        public override IGH_Goo Duplicate() => new RainEventGoo(Value);
        protected override string Describe(RainEvent v) => $"{v.Name}: {v.DesignDepthMm:0} mm design depth";
    }

    public sealed class MaterialRegionGoo : CbGoo<MaterialRegion>
    {
        public MaterialRegionGoo() { }
        public MaterialRegionGoo(MaterialRegion v) : base(v) { }
        public override string TypeName => "Material region";
        public override IGH_Goo Duplicate() => new MaterialRegionGoo(Value);
        protected override string Describe(MaterialRegion v) => $"Region ({v.MaterialId}{(v.SoilClass.HasValue ? ", JB-" + v.SoilClass : "")})";
    }

    // ====================================================================== helpers

    internal static class Gh
    {
        public static double Scale => RhinoConvert.UnitScale(RhinoDoc.ActiveDoc);

        /// <summary>Unwrap goo / object wrappers to a Cloudburst type.</summary>
        public static T As<T>(object o) where T : class
        {
            for (int depth = 0; depth < 4 && o != null; depth++)
            {
                if (o is T t) return t;
                if (o is GH_Goo<T> g) return g.Value;
                if (o is GH_ObjectWrapper w) { o = w.Value; continue; }
                if (o is IGH_Goo goo) { o = goo.ScriptVariable(); if (o is IGH_Goo) return null; continue; }
                return null;
            }
            return null;
        }

        /// <summary>Any Grasshopper geometry (goo, struct, wrapper) as RhinoCommon geometry.</summary>
        public static GeometryBase Geometry(object o)
        {
            if (o == null) return null;
            if (o is GeometryBase gb) return gb;
            try
            {
                if (o is IGH_Goo goo)
                {
                    var sv = goo.ScriptVariable();
                    if (sv is GeometryBase g2) return g2;
                    o = sv;
                }
                switch (o)
                {
                    case Rectangle3d r: return r.ToNurbsCurve();
                    case Circle c: return new ArcCurve(c);
                    case Polyline p: return new PolylineCurve(p);
                    case Box b: return b.ToBrep();
                    case Point3d pt: return new Rhino.Geometry.Point(pt);
                }
                return GH_Convert.ToGeometryBase(o);
            }
            catch { return null; }
        }

        public static string Plural(int n, string word) => $"{n} {word}{(n == 1 ? "" : "s")}";
    }

    // ====================================================================== icons

    public enum Glyph { Drop, Palette, Region, Grid, Rain, Instant, Dynamic, Layer, Compare, Retention }

    /// <summary>24×24 icons drawn in code: a water drop in a per-component blue with a small white glyph.</summary>
    internal static class Icons
    {
        private static readonly Dictionary<Glyph, Bitmap> Cache = new Dictionary<Glyph, Bitmap>();

        private static (Color top, Color bottom) Tint(Glyph g)
        {
            switch (g)
            {
                case Glyph.Palette: case Glyph.Region: return (Color.FromArgb(120, 205, 235), Color.FromArgb(22, 120, 170));
                case Glyph.Grid: return (Color.FromArgb(150, 200, 240), Color.FromArgb(40, 90, 160));
                case Glyph.Rain: return (Color.FromArgb(170, 220, 250), Color.FromArgb(50, 140, 210));
                case Glyph.Instant: case Glyph.Dynamic: case Glyph.Retention: return (Color.FromArgb(90, 170, 235), Color.FromArgb(13, 79, 160));
                case Glyph.Layer: case Glyph.Compare: return (Color.FromArgb(70, 130, 210), Color.FromArgb(8, 48, 107));
                default: return (Color.FromArgb(110, 185, 240), Color.FromArgb(31, 120, 200));
            }
        }

        public static Bitmap Get(Glyph g)
        {
            lock (Cache)
            {
                if (Cache.TryGetValue(g, out var b)) return b;
                try { b = Draw(g); } catch { b = new Bitmap(24, 24); }
                Cache[g] = b;
                return b;
            }
        }

        private static Bitmap Draw(Glyph glyph)
        {
            var bmp = new Bitmap(24, 24);
            using (var gr = Graphics.FromImage(bmp))
            {
                gr.SmoothingMode = SmoothingMode.AntiAlias;
                gr.Clear(Color.Transparent);
                using (var drop = DropPath())
                {
                    var (top, bottom) = Tint(glyph);
                    using (var br = new LinearGradientBrush(new RectangleF(0, 1, 24, 23), top, bottom, 90f)) gr.FillPath(br, drop);
                    using (var pen = new Pen(Color.FromArgb(200, 8, 40, 90), 1f)) gr.DrawPath(pen, drop);
                }
                using (var hl = new SolidBrush(Color.FromArgb(110, 255, 255, 255))) gr.FillEllipse(hl, 7.5f, 9.5f, 3f, 4.5f);
                using (var pen = new Pen(Color.White, 1.4f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                using (var fill = new SolidBrush(Color.White))
                    DrawGlyph(gr, glyph, pen, fill);
            }
            return bmp;
        }

        /// <summary>Drop: apex at (12, 1.5), round belly centred (12, 15) radius 7.5.</summary>
        private static GraphicsPath DropPath()
        {
            const float cx = 12f, cy = 15f, r = 7.5f, ax = 12f, ay = 1.5f;
            double d = cy - ay;
            double a = Math.Acos(r / d) * 180 / Math.PI;     // angle between "up" and the tangent point, seen from the centre
            float start = (float)(270 + a), sweep = (float)(360 - 2 * a);
            var p = new GraphicsPath();
            double rad = start * Math.PI / 180;
            p.AddLine(ax, ay, (float)(cx + r * Math.Cos(rad)), (float)(cy + r * Math.Sin(rad)));
            p.AddArc(cx - r, cy - r, 2 * r, 2 * r, start, sweep);
            p.CloseFigure();
            return p;
        }

        private static void DrawGlyph(Graphics g, Glyph glyph, Pen pen, Brush fill)
        {
            switch (glyph)
            {
                case Glyph.Palette:
                    g.FillEllipse(fill, 8f, 11.5f, 3.2f, 3.2f); g.FillEllipse(fill, 12.8f, 11.5f, 3.2f, 3.2f); g.FillEllipse(fill, 10.4f, 15.6f, 3.2f, 3.2f);
                    break;
                case Glyph.Region:
                    g.DrawPolygon(pen, new[] { new PointF(8, 13), new PointF(13, 10.5f), new PointF(16.5f, 14), new PointF(14, 19), new PointF(9, 18) });
                    break;
                case Glyph.Grid:
                    for (int i = 0; i < 3; i++)
                    {
                        float o = 9.5f + i * 2.5f;
                        g.DrawLine(pen, o, 11, o, 19); g.DrawLine(pen, 8, o + 1.5f, 16, o + 1.5f);
                    }
                    break;
                case Glyph.Rain:
                    g.DrawLine(pen, 9.5f, 11, 8, 15); g.DrawLine(pen, 13, 11, 11.5f, 15); g.DrawLine(pen, 16.5f, 11, 15, 15);
                    g.DrawLine(pen, 11, 15.5f, 9.5f, 19.5f); g.DrawLine(pen, 14.5f, 15.5f, 13, 19.5f);
                    break;
                case Glyph.Instant:
                    g.FillPolygon(fill, new[] { new PointF(13.5f, 9.5f), new PointF(8.5f, 15.5f), new PointF(11.8f, 15.5f), new PointF(10.5f, 20.5f), new PointF(15.5f, 13.8f), new PointF(12.2f, 13.8f) });
                    break;
                case Glyph.Dynamic:
                    g.FillPolygon(fill, new[] { new PointF(10, 11), new PointF(16.5f, 15), new PointF(10, 19) });
                    break;
                case Glyph.Layer:
                    g.DrawPolygon(pen, new[] { new PointF(12, 10.5f), new PointF(17, 13), new PointF(12, 15.5f), new PointF(7, 13) });
                    g.DrawLines(pen, new[] { new PointF(7, 16), new PointF(12, 18.5f), new PointF(17, 16) });
                    break;
                case Glyph.Compare:
                    g.DrawPolygon(pen, new[] { new PointF(12, 10), new PointF(17, 19), new PointF(7, 19) });
                    break;
                case Glyph.Retention:
                    g.DrawLines(pen, new[] { new PointF(8, 11), new PointF(8, 19), new PointF(16, 19), new PointF(16, 11) });
                    g.FillRectangle(fill, 9.2f, 15f, 5.6f, 3f);
                    break;
                default:
                    break;
            }
        }
    }

    // ====================================================================== base component

    /// <summary>
    /// Base for all Cloudburst components: category, icon, crash-proof solve and a lightweight custom preview
    /// (vertex-coloured meshes, weighted blue flow lines, points, dots). Preview items are rebuilt per solution.
    /// </summary>
    public abstract class CloudburstComponent : GH_Component
    {
        public const string CategoryName = "Cloudburst";
        private readonly Glyph _glyph;

        private readonly List<Mesh> _pvMeshes = new List<Mesh>();
        private readonly List<(Polyline line, int thickness)> _pvLines = new List<(Polyline, int)>();
        private readonly List<Point3d> _pvPoints = new List<Point3d>();
        private readonly List<(Point3d at, string text)> _pvDots = new List<(Point3d, string)>();
        private BoundingBox _pvBox = BoundingBox.Empty;

        protected CloudburstComponent(string name, string nick, string description, string subCategory, Glyph glyph)
            : base(name, nick, description, CategoryName, subCategory) { _glyph = glyph; }

        protected override Bitmap Icon => Icons.Get(_glyph);
        public override GH_Exposure Exposure => GH_Exposure.primary;

        protected abstract void Solve(IGH_DataAccess da);

        protected static void AddSewerMoistureInputs(GH_InputParamManager p)
        {
            p.AddIntegerParameter("Sewer", "Sw", "0 none, 1 combined (34 mm initial loss), 2 separate (29 mm), 3 constant capacity", GH_ParamAccess.item, 1);
            p.AddIntegerParameter("Moisture", "Mo", "Antecedent soil moisture: 0 dry, 1 moist, 2 wet", GH_ParamAccess.item, 1);
        }

        protected override void BeforeSolveInstance()
        {
            ClearPreview();
            base.BeforeSolveInstance();
        }

        protected sealed override void SolveInstance(IGH_DataAccess da)
        {
            try { Solve(da); }
            catch (DllNotFoundException ex)
            {
                AddRuntimeMessage(GH_RuntimeMessageLevel.Error, "The Cloudburst engine (cloudburst_core.dll) was not found. Keep it next to Cloudburst.Grasshopper.gha and Cloudburst.Net.dll. " + ex.Message);
            }
            catch (Exception ex)
            {
                AddRuntimeMessage(GH_RuntimeMessageLevel.Error, ex.GetBaseException().Message);
            }
        }

        // ---------------------------------------------------------------- preview

        protected void ClearPreview()
        {
            _pvMeshes.Clear(); _pvLines.Clear(); _pvPoints.Clear(); _pvDots.Clear(); _pvBox = BoundingBox.Empty;
        }

        protected void PreviewMesh(Mesh m) { if (m == null) return; _pvMeshes.Add(m); _pvBox.Union(m.GetBoundingBox(false)); }
        protected void PreviewLine(Polyline p, int thickness) { if (p == null || p.Count < 2) return; _pvLines.Add((p, thickness)); _pvBox.Union(p.BoundingBox); }
        protected void PreviewPoint(Point3d p) { _pvPoints.Add(p); _pvBox.Union(p); }
        protected void PreviewDot(Point3d p, string text) { _pvDots.Add((p, text)); _pvBox.Union(p); }

        public override BoundingBox ClippingBox
        {
            get
            {
                var b = base.ClippingBox;
                if (_pvBox.IsValid) b.Union(_pvBox);
                return b;
            }
        }

        public override bool IsPreviewCapable => true;

        public override void DrawViewportMeshes(IGH_PreviewArgs args)
        {
            try { foreach (var m in _pvMeshes) args.Display.DrawMeshFalseColors(m); } catch { }
        }

        public override void DrawViewportWires(IGH_PreviewArgs args)
        {
            try
            {
                foreach (var (line, t) in _pvLines) args.Display.DrawPolyline(line, RhinoConvert.FlowBlue, t);
                foreach (var p in _pvPoints) args.Display.DrawPoint(p, Rhino.Display.PointStyle.RoundSimple, 4, Color.FromArgb(8, 48, 107));
                foreach (var (at, text) in _pvDots) args.Display.DrawDot(at, text, Color.FromArgb(8, 48, 107), Color.White);
            }
            catch { }
        }
    }
}
