using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Cloudburst.Geometry;

namespace Cloudburst.Revit
{
    /// <summary>Reads Revit element geometry into Cloudburst meshes/polygons (feet → metres). Must run in API context.</summary>
    internal static class GeometryReader
    {
        public const double FtToM = 0.3048;
        public const double MToFt = 1.0 / 0.3048;

        public static Options FineOptions() => new Options { DetailLevel = ViewDetailLevel.Fine, ComputeReferences = false, IncludeNonVisibleObjects = false };

        /// <summary>Triangles of all solids/meshes of the element (instances resolved).
        /// <paramref name="minAbsNz"/> &gt; 0 keeps only faces/triangles that are not steep (|normal.Z| ≥ value), e.g. top/bottom faces.</summary>
        public static TriangleMesh ReadMesh(Element e, double minAbsNz = 0.0, string tag = null)
        {
            var b = new TriangleMesh.Builder();
            try
            {
                var geo = e.get_Geometry(FineOptions());
                if (geo != null) Collect(geo, b, minAbsNz, 0);
            }
            catch (Exception ex) { Logger.Write($"ReadMesh {e?.Id}: {ex.Message}"); }
            return b.IsEmpty ? null : b.Build(tag ?? SafeName(e));
        }

        /// <summary>All solids/meshes of several elements in one mesh (e.g. every wall of the model).</summary>
        public static TriangleMesh ReadMerged(IEnumerable<Element> elements, double minAbsNz = 0.0, string tag = null)
        {
            var b = new TriangleMesh.Builder();
            foreach (var e in elements)
            {
                try
                {
                    var geo = e.get_Geometry(FineOptions());
                    if (geo != null) Collect(geo, b, minAbsNz, 0);
                }
                catch (Exception ex) { Logger.Write($"ReadMerged {e?.Id}: {ex.Message}"); }
            }
            return b.IsEmpty ? null : b.Build(tag);
        }

        private static void Collect(GeometryElement geo, TriangleMesh.Builder b, double minAbsNz, int depth)
        {
            if (geo == null || depth > 6) return;
            foreach (var obj in geo)
            {
                try
                {
                    switch (obj)
                    {
                        case Solid s when s.Faces.Size > 0:
                            foreach (Face f in s.Faces) AddFace(f, b, minAbsNz);
                            break;
                        case Mesh m:
                            AddMesh(m, b, minAbsNz);
                            break;
                        case Face f:
                            AddFace(f, b, minAbsNz);
                            break;
                        case GeometryInstance gi:
                            Collect(gi.GetInstanceGeometry(), b, minAbsNz, depth + 1);
                            break;
                        case GeometryElement ge:
                            Collect(ge, b, minAbsNz, depth + 1);
                            break;
                    }
                }
                catch (Exception ex) { Logger.Write("Collect geometry: " + ex.Message); }
            }
        }

        private static void AddFace(Face f, TriangleMesh.Builder b, double minAbsNz)
        {
            if (minAbsNz > 0 && f is PlanarFace pf && Math.Abs(pf.FaceNormal.Z) < minAbsNz) return;
            Mesh m = null;
            try { m = f.Triangulate(0.5); } catch { }
            if (m != null) AddMesh(m, b, minAbsNz);
        }

        private static void AddMesh(Mesh m, TriangleMesh.Builder b, double minAbsNz)
        {
            int n = m.NumTriangles;
            for (int i = 0; i < n; i++)
            {
                var t = m.get_Triangle(i);
                XYZ p0 = t.get_Vertex(0), p1 = t.get_Vertex(1), p2 = t.get_Vertex(2);
                if (minAbsNz > 0)
                {
                    var nrm = (p1 - p0).CrossProduct(p2 - p0);
                    double len = nrm.GetLength();
                    if (len < 1e-12 || Math.Abs(nrm.Z) / len < minAbsNz) continue;
                }
                int a = b.AddVertex(p0.X * FtToM, p0.Y * FtToM, p0.Z * FtToM);
                int c = b.AddVertex(p1.X * FtToM, p1.Y * FtToM, p1.Z * FtToM);
                int d = b.AddVertex(p2.X * FtToM, p2.Y * FtToM, p2.Z * FtToM);
                b.AddTriangle(a, c, d);
            }
        }

        /// <summary>Material name of the largest upward-ish face (Face.MaterialElementId), or null.</summary>
        public static string TopFaceMaterialName(Element e)
        {
            try
            {
                var doc = e.Document;
                var geo = e.get_Geometry(FineOptions());
                Face best = null; double bestArea = 0;
                foreach (var f in Faces(geo, 0))
                {
                    try
                    {
                        if (f is PlanarFace pf && pf.FaceNormal.Z < 0.3) continue;
                        if (!(f is PlanarFace))
                        {
                            var bb = f.GetBoundingBox();
                            var uv = (bb.Min + bb.Max) * 0.5;
                            if (f.ComputeNormal(uv).Z < 0.3) continue;
                        }
                        if (f.Area > bestArea && f.MaterialElementId != ElementId.InvalidElementId) { best = f; bestArea = f.Area; }
                    }
                    catch { }
                }
                if (best != null && doc.GetElement(best.MaterialElementId) is Material mat) return mat.Name;
            }
            catch (Exception ex) { Logger.Write("TopFaceMaterialName: " + ex.Message); }
            return null;
        }

        private static IEnumerable<Face> Faces(GeometryElement geo, int depth)
        {
            if (geo == null || depth > 6) yield break;
            foreach (var obj in geo)
            {
                if (obj is Solid s) { foreach (Face f in s.Faces) yield return f; }
                else if (obj is GeometryInstance gi) { foreach (var f in Faces(gi.GetInstanceGeometry(), depth + 1)) yield return f; }
            }
        }

        /// <summary>Outer outline (largest loop) of the upward faces of a floor/roof/toposolid, metres.</summary>
        public static Polygon2 TopOutline(Element e)
        {
            Polygon2 best = null; double bestArea = 0;
            try
            {
                foreach (var f in Faces(e.get_Geometry(FineOptions()), 0))
                {
                    if (!(f is PlanarFace pf) || pf.FaceNormal.Z < 0.3) continue;
                    foreach (var loop in pf.GetEdgesAsCurveLoops())
                    {
                        var poly = LoopToPolygon(loop);
                        if (poly == null) continue;
                        double a = poly.Area();
                        if (a > bestArea) { best = poly; bestArea = a; }
                    }
                }
            }
            catch (Exception ex) { Logger.Write("TopOutline: " + ex.Message); }
            return best;
        }

        public static Polygon2 LoopToPolygon(IEnumerable<Curve> loop)
        {
            var xs = new List<double>(); var ys = new List<double>();
            foreach (var c in loop)
            {
                var pts = c.Tessellate();
                for (int i = 0; i < pts.Count - 1; i++) { xs.Add(pts[i].X * FtToM); ys.Add(pts[i].Y * FtToM); }
            }
            return xs.Count >= 3 ? new Polygon2(xs.ToArray(), ys.ToArray()) : null;
        }

        /// <summary>Tessellated curve in metres.</summary>
        public static Polyline3 CurveToPolyline(Curve c)
        {
            var pts = c.Tessellate();
            if (pts == null || pts.Count < 2) return null;
            return new Polyline3(pts.Select(p => p.X * FtToM).ToArray(), pts.Select(p => p.Y * FtToM).ToArray(), pts.Select(p => p.Z * FtToM).ToArray());
        }

        /// <summary>Chain loose polylines (e.g. picked model lines) into closed XY loops. Tolerance in metres.</summary>
        public static List<Polygon2> ChainLoops(List<Polyline3> lines, double tol = 0.05)
        {
            var result = new List<Polygon2>();
            var pool = lines.Where(l => l != null && l.Count >= 2).Select(l => Enumerable.Range(0, l.Count).Select(i => (l.X[i], l.Y[i])).ToList()).ToList();
            bool Near((double, double) a, (double, double) b) => Math.Abs(a.Item1 - b.Item1) <= tol && Math.Abs(a.Item2 - b.Item2) <= tol;
            while (pool.Count > 0)
            {
                var chain = pool[0]; pool.RemoveAt(0);
                bool grown = true;
                while (grown && !Near(chain[0], chain[chain.Count - 1]))
                {
                    grown = false;
                    for (int i = 0; i < pool.Count; i++)
                    {
                        var p = pool[i]; var end = chain[chain.Count - 1];
                        if (Near(end, p[0])) { chain.AddRange(p.Skip(1)); }
                        else if (Near(end, p[p.Count - 1])) { p.Reverse(); chain.AddRange(p.Skip(1)); }
                        else if (Near(chain[0], p[p.Count - 1])) { chain.InsertRange(0, p.Take(p.Count - 1)); }
                        else if (Near(chain[0], p[0])) { p.Reverse(); chain.InsertRange(0, p.Take(p.Count - 1)); }
                        else continue;
                        pool.RemoveAt(i); grown = true; break;
                    }
                }
                if (chain.Count >= 4 && Near(chain[0], chain[chain.Count - 1]))
                {
                    chain.RemoveAt(chain.Count - 1);
                    var poly = new Polygon2(chain.Select(c => c.Item1).ToArray(), chain.Select(c => c.Item2).ToArray());
                    if (poly.Area() > 0.01) result.Add(poly);
                }
            }
            return result;
        }

        public static string SafeName(Element e)
        {
            try { return e?.Name; } catch { return null; }
        }
    }
}
