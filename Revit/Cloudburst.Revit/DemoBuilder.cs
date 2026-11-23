using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Cloudburst.Geometry;
using Cloudburst.Materials;

namespace Cloudburst.Revit
{
    /// <summary>Creates the demo site as Revit elements: Toposolid terrain, DirectShape buildings, draped material outlines and kerbs.</summary>
    internal static class DemoBuilder
    {
        private const double M = GeometryReader.MToFt;

        public sealed class Result
        {
            public SiteModel Site;          // shifted to the project origin (metres)
            public bool ToposolidCreated;
            public int ElementCount;
            public View3D View;
        }

        public static Result Build(UIDocument uidoc, SiteModel demo, MaterialPalette palette, Action<string> log)
        {
            var doc = uidoc.Document;
            RevitUtil.Require(doc);
            if (demo == null || !demo.HasTerrain) throw new ArgumentException("The demo site has no terrain.");

            // centre the demo on the project origin (internal coordinates). TODO: optional shared-coordinates placement.
            var b = demo.GetTerrainBounds();
            double ox = b.IsValid ? -(b.MinX + b.MaxX) * 0.5 : 0, oy = b.IsValid ? -(b.MinY + b.MaxY) * 0.5 : 0;
            var site = Shift(demo, ox, oy);
            var sampler = new TerrainSampler(site.Terrain.Concat(site.DesignTerrain), 4.0);
            var result = new Result { Site = site };

            using (var t = new Transaction(doc, "Cloudburst demo site"))
            {
                RevitUtil.QuietFailures(t);
                t.Start();
                try
                {
                    DeleteOldDemo(doc);
                    var view = Find3DView(doc, uidoc.ActiveView);
                    result.View = view;
                    var solid = RevitUtil.SolidFillPatternId(doc);

                    // ---- terrain ----
                    ElementId topoId = ElementId.InvalidElementId;
                    try { topoId = CreateToposolid(doc, site, log); result.ToposolidCreated = topoId != ElementId.InvalidElementId; }
                    catch (Exception ex) { log?.Invoke("Toposolid.Create failed, using a DirectShape terrain: " + ex.Message); }
                    if (topoId == ElementId.InvalidElementId)
                    {
                        try
                        {
                            var ds = TerrainShape(doc, site.Terrain[0]);
                            if (ds != null) { topoId = ds.Id; RevitUtil.TryOverride(view, ds.Id, RevitUtil.SurfaceOverride(new Color(0xB8, 0xC9, 0x9A), solid, 0)); }
                        }
                        catch (Exception ex) { log?.Invoke("Terrain DirectShape failed: " + ex.Message); }
                    }
                    if (topoId != ElementId.InvalidElementId) result.ElementCount++;

                    // ---- buildings ----
                    var grey = new Color(0xC8, 0xC8, 0xC8);
                    foreach (var bi in site.Buildings)
                    {
                        try
                        {
                            if (bi.Footprint == null || bi.Footprint.Count < 3) continue;
                            var (zmin, zmax) = sampler.Range(bi.Footprint);
                            double z0 = zmin - 0.5, z1 = zmax + bi.HeightAboveTerrain;
                            var loop = CurveLoop.Create(LoopCurves(bi.Footprint, z0));
                            if (!loop.IsCounterclockwise(XYZ.BasisZ)) loop.Flip();
                            var solidGeo = GeometryCreationUtilities.CreateExtrusionGeometry(new List<CurveLoop> { loop }, XYZ.BasisZ, (z1 - z0) * M);
                            var ds = RevitUtil.NewDirectShape(doc, RevitUtil.DataDemo, "Cloudburst demo " + (bi.Name ?? "building"));
                            ds.SetShape(new List<GeometryObject> { solidGeo });
                            RevitUtil.SetComment(ds, RevitUtil.DemoComment);
                            RevitUtil.TryOverride(view, ds.Id, RevitUtil.SurfaceOverride(grey, solid, 0));
                            result.ElementCount++;
                        }
                        catch (Exception ex) { log?.Invoke($"Building {bi.Name}: {ex.Message}"); }
                    }

                    // ---- surface regions: draped outlines, one DirectShape per material ----
                    foreach (var grp in site.Regions.Where(r => r.Outline != null).GroupBy(r => r.MaterialId ?? "default"))
                    {
                        try
                        {
                            var lines = new List<GeometryObject>();
                            foreach (var r in grp) lines.AddRange(DrapedLoop(r.Outline, sampler, 0.10, doc));
                            if (lines.Count == 0) continue;
                            var mat = palette?.Get(grp.Key);
                            var ds = RevitUtil.NewDirectShape(doc, RevitUtil.DataDemo, "Cloudburst demo surface " + (mat?.Name ?? grp.Key));
                            ds.SetShape(lines);
                            RevitUtil.SetComment(ds, RevitUtil.DemoComment + " – " + grp.Key);
                            RevitUtil.TryOverride(view, ds.Id, RevitUtil.LineOverride(RevitUtil.ToColor(mat?.Argb ?? unchecked((int)0xFF888888)), 5));
                            result.ElementCount++;
                        }
                        catch (Exception ex) { log?.Invoke($"Surface {grp.Key}: {ex.Message}"); }
                    }

                    // ---- kerbs ----
                    try
                    {
                        var kerbLines = new List<GeometryObject>();
                        foreach (var w in site.Walls)
                            if (w.Line != null && w.Line.Count >= 2) kerbLines.AddRange(DrapedPolyline(w.Line, sampler, 0.12, doc));
                        if (kerbLines.Count > 0)
                        {
                            var ds = RevitUtil.NewDirectShape(doc, RevitUtil.DataDemo, "Cloudburst demo kerbs");
                            ds.SetShape(kerbLines);
                            RevitUtil.SetComment(ds, RevitUtil.DemoComment);
                            RevitUtil.TryOverride(view, ds.Id, RevitUtil.LineOverride(new Color(0x40, 0x40, 0x40), 6));
                            result.ElementCount++;
                        }
                    }
                    catch (Exception ex) { log?.Invoke("Kerbs: " + ex.Message); }

                    // nicer default look for the demo
                    try
                    {
                        if (view != null && !view.IsTemplate && (view.DisplayStyle == DisplayStyle.Wireframe || view.DisplayStyle == DisplayStyle.HLR))
                            view.DisplayStyle = DisplayStyle.ShadingWithEdges;
                    }
                    catch { }

                    if (t.Commit() != TransactionStatus.Committed) throw new InvalidOperationException("Revit did not accept the demo site transaction.");
                }
                catch
                {
                    if (t.HasStarted() && !t.HasEnded()) t.RollBack();
                    throw;
                }
            }

            // ---- show it ----
            try
            {
                if (result.View != null)
                {
                    if (uidoc.ActiveView == null || uidoc.ActiveView.Id != result.View.Id) uidoc.ActiveView = result.View;
                    var bb = site.GetTerrainBounds();
                    var uiv = uidoc.GetOpenUIViews().FirstOrDefault(u => u.ViewId == result.View.Id);
                    if (uiv != null && bb.IsValid)
                        uiv.ZoomAndCenterRectangle(new XYZ(bb.MinX * M, bb.MinY * M, sampler.MinZ * M), new XYZ(bb.MaxX * M, bb.MaxY * M, (sampler.MaxZ + 20) * M));
                }
            }
            catch (Exception ex) { log?.Invoke("Zoom: " + ex.Message); }
            return result;
        }

        private static void DeleteOldDemo(Document doc)
        {
            var ids = new List<ElementId>();
            try
            {
                ids.AddRange(new FilteredElementCollector(doc).OfClass(typeof(DirectShape)).Where(e => RevitUtil.IsCloudburstShape(e, RevitUtil.DataDemo)).Select(e => e.Id));
                ids.AddRange(new FilteredElementCollector(doc).OfClass(typeof(Toposolid)).Where(e => RevitUtil.GetComment(e) == RevitUtil.DemoComment).Select(e => e.Id));
            }
            catch { }
            var valid = RevitUtil.ValidIds(doc, ids);
            if (valid.Count > 0) { try { doc.Delete(valid); } catch (Exception ex) { Logger.Write("Delete old demo: " + ex.Message); } }
        }

        private static ElementId CreateToposolid(Document doc, SiteModel site, Action<string> log)
        {
            var typeId = new FilteredElementCollector(doc).OfClass(typeof(ToposolidType)).FirstElementId();
            if (typeId == null || typeId == ElementId.InvalidElementId) throw new InvalidOperationException("No Toposolid type in this project.");
            var level = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => Math.Abs(l.Elevation)).FirstOrDefault();
            if (level == null) level = Level.Create(doc, 0);

            // decimate the terrain to ~4 m (keep the vertex closest to each bin centre)
            var mesh = site.Terrain[0];
            var bounds = mesh.GetBounds();
            double spacing = 4.0;
            while ((bounds.Width / spacing + 1) * (bounds.Height / spacing + 1) > 12000) spacing *= 1.5;
            var bins = new Dictionary<(int, int), (double d, double x, double y, double z)>();
            var v = mesh.Vertices;
            for (int i = 0; i + 2 < v.Length; i += 3)
            {
                double fx = (v[i] - bounds.MinX) / spacing, fy = (v[i + 1] - bounds.MinY) / spacing;
                int ix = (int)Math.Round(fx), iy = (int)Math.Round(fy);
                double d = (fx - ix) * (fx - ix) + (fy - iy) * (fy - iy);
                if (!bins.TryGetValue((ix, iy), out var cur) || d < cur.d) bins[(ix, iy)] = (d, v[i], v[i + 1], v[i + 2]);
            }
            var pts = bins.Values.Select(p => new XYZ(p.x * M, p.y * M, p.z * M)).ToList();
            if (pts.Count < 3) throw new InvalidOperationException("Too few terrain points.");
            log?.Invoke($"Creating Toposolid from {pts.Count} points ({spacing:0.#} m grid) on level '{level.Name}'.");
            var topo = Toposolid.Create(doc, pts, typeId, level.Id);
            if (topo == null) return ElementId.InvalidElementId;
            RevitUtil.SetComment(topo, RevitUtil.DemoComment);
            return topo.Id;
        }

        private static DirectShape TerrainShape(Document doc, TriangleMesh mesh)
        {
            var b = new TessellatedShapeBuilder { Target = TessellatedShapeBuilderTarget.Mesh, Fallback = TessellatedShapeBuilderFallback.Mesh };
            b.OpenConnectedFaceSet(false);
            var v = mesh.Vertices; var t = mesh.Triangles;
            XYZ P(int k) => new XYZ(v[3 * k] * M, v[3 * k + 1] * M, v[3 * k + 2] * M);
            for (int i = 0; i + 2 < t.Length; i += 3)
            {
                try { b.AddFace(new TessellatedFace(new List<XYZ> { P(t[i]), P(t[i + 1]), P(t[i + 2]) }, ElementId.InvalidElementId)); } catch { }
            }
            b.CloseConnectedFaceSet();
            b.Build();
            var res = b.GetBuildResult();
            if (res == null || !res.AreObjectsAvailable) return null;
            var ds = RevitUtil.NewDirectShape(doc, RevitUtil.DataDemo, "Cloudburst demo terrain");
            ds.SetShape(res.GetGeometricalObjects());
            RevitUtil.SetComment(ds, RevitUtil.DemoComment);
            return ds;
        }

        private static List<Curve> LoopCurves(Polygon2 p, double z)
        {
            var curves = new List<Curve>();
            for (int i = 0; i < p.Count; i++)
            {
                int j = (i + 1) % p.Count;
                var a = new XYZ(p.X[i] * M, p.Y[i] * M, z * M); var c = new XYZ(p.X[j] * M, p.Y[j] * M, z * M);
                if (a.DistanceTo(c) > 0.01) curves.Add(Line.CreateBound(a, c));
            }
            return curves;
        }

        private static IEnumerable<GeometryObject> DrapedLoop(Polygon2 p, TerrainSampler s, double lift, Document doc)
        {
            var xs = p.X.Concat(new[] { p.X[0] }).ToArray(); var ys = p.Y.Concat(new[] { p.Y[0] }).ToArray();
            return DrapedPolyline(new Polyline3(xs, ys), s, lift, doc);
        }

        /// <summary>Polyline split into ≤ 4 m pieces that follow the terrain.</summary>
        private static IEnumerable<GeometryObject> DrapedPolyline(Polyline3 pl, TerrainSampler s, double lift, Document doc)
        {
            var list = new List<GeometryObject>();
            double tol = doc.Application.ShortCurveTolerance * 1.5;
            for (int i = 0; i + 1 < pl.Count; i++)
            {
                double x0 = pl.X[i], y0 = pl.Y[i], x1 = pl.X[i + 1], y1 = pl.Y[i + 1];
                double len = Math.Sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
                int n = Math.Max(1, (int)Math.Ceiling(len / 4.0));
                XYZ prev = null;
                for (int k = 0; k <= n; k++)
                {
                    double x = x0 + (x1 - x0) * k / n, y = y0 + (y1 - y0) * k / n;
                    var pt = new XYZ(x * M, y * M, (s.Z(x, y) + lift) * M);
                    if (prev != null && prev.DistanceTo(pt) > tol) { try { list.Add(Line.CreateBound(prev, pt)); } catch { } }
                    prev = pt;
                }
            }
            return list;
        }

        private static View3D Find3DView(Document doc, View active)
        {
            if (active is View3D a && !a.IsTemplate && !a.IsPerspective) return a;
            var views = new FilteredElementCollector(doc).OfClass(typeof(View3D)).Cast<View3D>().Where(v => !v.IsTemplate && !v.IsPerspective).ToList();
            var v3 = views.FirstOrDefault(v => v.Name == "{3D}") ?? views.FirstOrDefault(v => v.Name.StartsWith("{3D")) ?? views.FirstOrDefault();
            if (v3 != null) return v3;
            var vft = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().FirstOrDefault(x => x.ViewFamily == ViewFamily.ThreeDimensional);
            if (vft == null) return null;
            var created = View3D.CreateIsometric(doc, vft.Id);
            try { created.Name = "Cloudburst 3D"; } catch { }
            return created;
        }

        // ------------------------------------------------------------------ shifting
        private static SiteModel Shift(SiteModel s, double dx, double dy)
        {
            var r = new SiteModel();
            foreach (var m in s.Terrain) r.Terrain.Add(ShiftMesh(m, dx, dy));
            foreach (var m in s.DesignTerrain) r.DesignTerrain.Add(ShiftMesh(m, dx, dy));
            foreach (var bi in s.Buildings)
                r.Buildings.Add(new BuildingInput
                {
                    Geometry = ShiftMesh(bi.Geometry, dx, dy), Footprint = ShiftPoly(bi.Footprint, dx, dy), HeightAboveTerrain = bi.HeightAboveTerrain,
                    Drainage = bi.Drainage, Name = bi.Name, ThresholdHeight = bi.ThresholdHeight
                });
            foreach (var g in s.Regions)
                r.Regions.Add(new MaterialRegion { Outline = ShiftPoly(g.Outline, dx, dy), Surface = ShiftMesh(g.Surface, dx, dy), MaterialId = g.MaterialId, SoilClass = g.SoilClass, Compacted = g.Compacted, Sewer = g.Sewer });
            foreach (var w in s.Walls)
                if (w.Line != null)
                    r.Walls.Add(new WallLine { Height = w.Height, Line = new Polyline3(w.Line.X.Select(x => x + dx).ToArray(), w.Line.Y.Select(y => y + dy).ToArray(), (double[])w.Line.Z?.Clone()) { Weight = w.Line.Weight } });
            foreach (var c in s.BridgeCuts) r.BridgeCuts.Add(ShiftPoly(c, dx, dy));
            r.Boundary = ShiftPoly(s.Boundary, dx, dy);
            return r;
        }

        private static TriangleMesh ShiftMesh(TriangleMesh m, double dx, double dy)
        {
            if (m == null) return null;
            var v = (double[])m.Vertices.Clone();
            for (int i = 0; i + 2 < v.Length; i += 3) { v[i] += dx; v[i + 1] += dy; }
            return new TriangleMesh(v, (int[])m.Triangles.Clone(), m.Tag);
        }

        private static Polygon2 ShiftPoly(Polygon2 p, double dx, double dy) =>
            p == null ? null : new Polygon2(p.X.Select(x => x + dx).ToArray(), p.Y.Select(y => y + dy).ToArray());
    }
}
