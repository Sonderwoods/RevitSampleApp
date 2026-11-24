using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Cloudburst.Results;

namespace Cloudburst.Revit
{
    /// <summary>
    /// Writes a <see cref="ResultVisual"/> into the document as a handful of DirectShapes:
    /// one per ramp class (merged rectangles, TessellatedShapeBuilder), up to three for flow paths (by weight), and
    /// optional TextNotes in plan views. Must run inside an open transaction (API context).
    /// </summary>
    internal static class PreviewWriter
    {
        private const double M = GeometryReader.MToFt;

        /// <summary>Merged axis-aligned rectangle in metres.</summary>
        internal struct Rect
        {
            public double X0, X1, Y0, Y1, ZSum; public int N, Cls;
            public double Z => ZSum / Math.Max(1, N);
        }

        public static List<ElementId> Write(Document doc, View view, ResultVisual v, bool bake, Action<string> log)
        {
            var created = new List<ElementId>();
            if (v == null) return created;
            string dataId = bake ? RevitUtil.DataBake : RevitUtil.DataPreview;
            string title = string.IsNullOrWhiteSpace(v.Title) ? (v.Ramp?.Title ?? "Result") : v.Title;
            string rampTitle = v.Ramp?.Title ?? title;
            string stamp = bake ? $" ({DateTime.Now:yyyy-MM-dd HH:mm})" : "";
            string comment = (bake ? "Cloudburst result " + DateTime.Now.ToString("yyyy-MM-dd HH:mm") + ". " : "Cloudburst preview. ") + (v.Caption ?? "");
            var solid = RevitUtil.SolidFillPatternId(doc);
            int transparency = 15;

            // ---------- coloured mesh ----------
            var mesh = v.Mesh;
            if (mesh != null && mesh.QuadCount > 0)
            {
                bool aggressive = mesh.QuadCount > 60000;
                var rects = MergeRows(mesh, v.Ramp, aggressive ? 0.25 : 0.08);
                if (aggressive || rects.Count > 25000) rects = MergeColumns(rects, aggressive ? 0.35 : 0.12);
                log?.Invoke($"Preview: {mesh.QuadCount:N0} cells → {rects.Count:N0} faces");
                int total = rects.Count;
                foreach (var grp in rects.GroupBy(r => r.Cls).OrderBy(g => g.Key))
                {
                    try
                    {
                        int cls = grp.Key;
                        int argb = ClassColor(v, mesh, cls);
                        var color = RevitUtil.ToColor(argb);
                        string label = v.Ramp != null && cls >= 0 && cls < v.Ramp.Labels.Length ? v.Ramp.Labels[cls]
                            : v.Legend?.FirstOrDefault(li => li != null && (li.Argb & 0xFFFFFF) == (argb & 0xFFFFFF))?.Label ?? $"class {cls}";
                        var matId = RevitUtil.EnsureMaterial(doc, $"Cloudburst {rampTitle} {label}", color, transparency, solid);
                        var geom = BuildFaces(grp.ToList(), matId, total <= 4000);
                        if (geom == null || geom.Count == 0) continue;
                        var ds = RevitUtil.NewDirectShape(doc, dataId, $"Cloudburst {title} - {label}{stamp}");
                        ds.SetShape(geom);
                        RevitUtil.SetComment(ds, comment);
                        created.Add(ds.Id);
                        RevitUtil.TryOverride(view, ds.Id, RevitUtil.SurfaceOverride(color, solid, transparency));
                    }
                    catch (Exception ex) { log?.Invoke($"Class {grp.Key} failed: {ex.Message}"); }
                }
            }

            // ---------- flow paths ----------
            try { created.AddRange(WriteFlowPaths(doc, view, v, dataId, title + stamp, comment)); }
            catch (Exception ex) { log?.Invoke("Flow paths failed: " + ex.Message); }

            // ---------- labels (plan views only) ----------
            try
            {
                if (view is ViewPlan && !view.IsTemplate && v.Labels != null && v.Labels.Count > 0)
                {
                    var typeId = doc.GetDefaultElementTypeId(ElementTypeGroup.TextNoteType);
                    if (typeId != ElementId.InvalidElementId)
                        foreach (var l in v.Labels.Take(25))
                        {
                            try
                            {
                                var tn = TextNote.Create(doc, view.Id, new XYZ(l.X * M, l.Y * M, 0), l.Text ?? "", typeId);
                                created.Add(tn.Id);
                            }
                            catch { }
                        }
                }
            }
            catch (Exception ex) { log?.Invoke("Labels failed: " + ex.Message); }
            return created;
        }

        private static int ClassColor(ResultVisual v, ColoredMesh mesh, int cls)
        {
            if (v.Ramp != null && cls >= 0 && cls < v.Ramp.Colors.Length) return v.Ramp.Colors[cls];
            // fall back to the first quad's vertex colour of that class
            for (int q = 0; q < mesh.QuadCount; q++)
                if (QuadClass(mesh, v.Ramp, q) == cls && mesh.VertexColors.Length > mesh.Quads[4 * q]) return mesh.VertexColors[mesh.Quads[4 * q]];
            return unchecked((int)0xFF4FA8E0);
        }

        private static int QuadClass(ColoredMesh mesh, ColorRamp ramp, int q)
        {
            if (mesh.QuadClass != null && q < mesh.QuadClass.Length) return mesh.QuadClass[q];
            if (ramp != null && mesh.VertexColors != null)
            {
                int vi = mesh.Quads[4 * q];
                if (vi < mesh.VertexColors.Length)
                {
                    int i = Array.IndexOf(ramp.Colors, mesh.VertexColors[vi]);
                    if (i >= 0) return i;
                }
            }
            return 0;
        }

        /// <summary>Merge each grid row's run of same-class quads into one rectangle (quads must touch along x and have similar z).</summary>
        internal static List<Rect> MergeRows(ColoredMesh mesh, ColorRamp ramp, double zTol)
        {
            var result = new List<Rect>(Math.Max(16, mesh.QuadCount / 4));
            var open = new Dictionary<int, Rect>();
            var vs = mesh.Vertices;
            const double eps = 1e-4;
            for (int q = 0; q < mesh.QuadCount; q++)
            {
                double x0 = double.MaxValue, x1 = double.MinValue, y0 = double.MaxValue, y1 = double.MinValue, z = 0;
                bool ok = true;
                for (int c = 0; c < 4; c++)
                {
                    int vi = mesh.Quads[4 * q + c];
                    if (vi < 0 || 3 * vi + 2 >= vs.Length) { ok = false; break; }
                    double x = vs[3 * vi], y = vs[3 * vi + 1];
                    x0 = Math.Min(x0, x); x1 = Math.Max(x1, x); y0 = Math.Min(y0, y); y1 = Math.Max(y1, y); z += vs[3 * vi + 2];
                }
                if (!ok || x1 - x0 < 1e-3 || y1 - y0 < 1e-3 || double.IsNaN(z)) continue;
                z *= 0.25;
                int cls = QuadClass(mesh, ramp, q);
                if (open.TryGetValue(cls, out var r) && Math.Abs(r.Y0 - y0) < eps && Math.Abs(r.Y1 - y1) < eps && Math.Abs(r.X1 - x0) < eps && Math.Abs(r.Z - z) <= zTol)
                {
                    r.X1 = x1; r.ZSum += z; r.N++;
                    open[cls] = r;
                }
                else
                {
                    if (open.TryGetValue(cls, out var done)) result.Add(done);
                    open[cls] = new Rect { X0 = x0, X1 = x1, Y0 = y0, Y1 = y1, ZSum = z, N = 1, Cls = cls };
                }
            }
            result.AddRange(open.Values);
            return result;
        }

        /// <summary>Second pass: stack identical row runs of consecutive rows.</summary>
        internal static List<Rect> MergeColumns(List<Rect> rects, double zTol)
        {
            const double eps = 1e-4;
            var sorted = rects.OrderBy(r => r.Cls).ThenBy(r => Math.Round(r.X0, 3)).ThenBy(r => Math.Round(r.X1, 3)).ThenBy(r => r.Y0).ToList();
            var result = new List<Rect>(sorted.Count / 2 + 1);
            Rect cur = default; bool has = false;
            foreach (var r in sorted)
            {
                if (has && r.Cls == cur.Cls && Math.Abs(r.X0 - cur.X0) < eps && Math.Abs(r.X1 - cur.X1) < eps && Math.Abs(r.Y0 - cur.Y1) < eps && Math.Abs(r.Z - cur.Z) <= zTol)
                {
                    cur.Y1 = r.Y1; cur.ZSum += r.ZSum; cur.N += r.N;
                }
                else
                {
                    if (has) result.Add(cur);
                    cur = r; has = true;
                }
            }
            if (has) result.Add(cur);
            return result;
        }

        /// <summary>Rectangles → geometry via TessellatedShapeBuilder (AnyGeometry→Mesh fallback for small sets, Mesh for large ones).</summary>
        internal static IList<GeometryObject> BuildFaces(List<Rect> rects, ElementId materialId, bool tryAnyGeometry)
        {
            IList<GeometryObject> Build(TessellatedShapeBuilderTarget target)
            {
                var b = new TessellatedShapeBuilder { Target = target, Fallback = TessellatedShapeBuilderFallback.Mesh };
                const int chunk = 4000;
                for (int start = 0; start < rects.Count; start += chunk)
                {
                    b.OpenConnectedFaceSet(false);
                    for (int i = start; i < Math.Min(rects.Count, start + chunk); i++)
                    {
                        var r = rects[i]; double z = r.Z * M;
                        var pts = new List<XYZ>
                        {
                            new XYZ(r.X0 * M, r.Y0 * M, z), new XYZ(r.X1 * M, r.Y0 * M, z),
                            new XYZ(r.X1 * M, r.Y1 * M, z), new XYZ(r.X0 * M, r.Y1 * M, z)
                        };
                        b.AddFace(new TessellatedFace(pts, materialId ?? ElementId.InvalidElementId));
                    }
                    b.CloseConnectedFaceSet();
                }
                b.Build();
                var res = b.GetBuildResult();
                return res != null && res.AreObjectsAvailable ? res.GetGeometricalObjects() : null;
            }

            if (tryAnyGeometry)
            {
                try { var g = Build(TessellatedShapeBuilderTarget.AnyGeometry); if (g != null && g.Count > 0) return g; }
                catch (Exception ex) { Logger.Write("TSB AnyGeometry failed, retrying as mesh: " + ex.Message); }
            }
            return Build(TessellatedShapeBuilderTarget.Mesh);
        }

        private static IEnumerable<ElementId> WriteFlowPaths(Document doc, View view, ResultVisual v, string dataId, string title, string comment)
        {
            var ids = new List<ElementId>();
            if (v.FlowPaths == null || v.FlowPaths.Count == 0) return ids;
            double tol = doc.Application.ShortCurveTolerance * 1.5;
            double wmax = 0;
            foreach (var p in v.FlowPaths)
                if (p?.Weight != null) foreach (var w in p.Weight) if (!double.IsNaN(w)) wmax = Math.Max(wmax, w);
            var bins = new[] { new List<GeometryObject>(), new List<GeometryObject>(), new List<GeometryObject>() };
            const double lift = 0.15;
            foreach (var p in v.FlowPaths)
            {
                if (p == null || p.Count < 2) continue;
                // walk the polyline, emitting segments once they are long enough (skips tiny steps)
                int last = 0;
                for (int i = 1; i < p.Count; i++)
                {
                    var a = Pt(p, last, lift); var b = Pt(p, i, lift);
                    if (a == null || b == null) { last = i; continue; }
                    if (a.DistanceTo(b) < tol) continue;
                    double w = p.Weight != null && last < p.Weight.Length ? p.Weight[last] : 0;
                    double f = wmax > 0 ? w / wmax : 0;
                    int bin = f < 0.1 ? 0 : f < 0.4 ? 1 : 2;
                    try { bins[bin].Add(Line.CreateBound(a, b)); } catch { }
                    last = i;
                    if (bins[0].Count + bins[1].Count + bins[2].Count > 20000) break;
                }
            }
            var colors = new[] { new Color(0x55, 0xB5, 0xE6), new Color(0x1F, 0x78, 0xC8), new Color(0x08, 0x30, 0x6B) };
            var weights = new[] { 3, 6, 10 };
            var names = new[] { "minor", "medium", "major" };
            for (int k = 0; k < 3; k++)
            {
                if (bins[k].Count == 0) continue;
                try
                {
                    var ds = RevitUtil.NewDirectShape(doc, dataId, $"Cloudburst flow paths - {names[k]} {title}");
                    ds.SetShape(bins[k]);
                    RevitUtil.SetComment(ds, comment);
                    ids.Add(ds.Id);
                    RevitUtil.TryOverride(view, ds.Id, RevitUtil.LineOverride(colors[k], weights[k]));
                }
                catch (Exception ex) { Logger.Write("Flow path shape: " + ex.Message); }
            }
            return ids;
        }

        private static XYZ Pt(Cloudburst.Geometry.Polyline3 p, int i, double lift)
        {
            double x = p.X[i], y = p.Y[i], z = p.Z != null && i < p.Z.Length ? p.Z[i] : 0;
            if (double.IsNaN(x) || double.IsNaN(y)) return null;
            if (double.IsNaN(z)) z = 0;
            return new XYZ(x * M, y * M, (z + lift) * M);
        }

        /// <summary>Delete preview elements: the tracked ids plus any DirectShape tagged as Cloudburst preview.</summary>
        public static int DeletePreview(Document doc, IEnumerable<ElementId> tracked)
        {
            var ids = new List<ElementId>();
            if (tracked != null) ids.AddRange(tracked);
            try
            {
                ids.AddRange(new FilteredElementCollector(doc).OfClass(typeof(DirectShape)).Where(e => RevitUtil.IsCloudburstShape(e, RevitUtil.DataPreview)).Select(e => e.Id));
            }
            catch { }
            var valid = RevitUtil.ValidIds(doc, ids);
            if (valid.Count == 0) return 0;
            try { doc.Delete(valid); }
            catch
            {
                foreach (var id in valid) { try { doc.Delete(id); } catch { } }
            }
            return valid.Count;
        }
    }
}
