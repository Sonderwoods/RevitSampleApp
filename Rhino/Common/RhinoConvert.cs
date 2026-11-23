using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using Cloudburst.Geometry;
using Cloudburst.Results;
using Rhino;
using Rhino.Geometry;

namespace CloudburstRhinoCommon
{
    /// <summary>
    /// Rhino geometry ⇄ Cloudburst (host-neutral, metres) conversions. Shared by the .rhp and the .gha
    /// (linked as source into both projects). <c>scale</c> is always "metres per model unit":
    /// multiply when collecting, divide when displaying/baking.
    /// </summary>
    public static class RhinoConvert
    {
        public static readonly Color FlowBlue = Color.FromArgb(0x1F, 0x78, 0xC8);

        /// <summary>Metres per model unit for the document (1 when no document).</summary>
        public static double UnitScale(RhinoDoc doc)
        {
            try
            {
                if (doc == null) return 1.0;
                double s = RhinoMath.UnitScale(doc.ModelUnitSystem, UnitSystem.Meters);
                return double.IsNaN(s) || s <= 0 ? 1.0 : s;
            }
            catch { return 1.0; }
        }

        public static Color ToColor(int argb) => Color.FromArgb(argb);

        // ------------------------------------------------------------------ Rhino → Cloudburst

        /// <summary>Meshing settings for terrain-like breps: dense enough for a ~1 m grid, bounded for big sites.</summary>
        public static MeshingParameters TerrainMeshing(BoundingBox bboxModel, double scale)
        {
            var mp = new MeshingParameters(0.5)
            {
                SimplePlanes = true,
                JaggedSeams = false,
                RefineGrid = true,
            };
            double diagM = bboxModel.IsValid ? bboxModel.Diagonal.Length * scale : 100;
            double maxEdgeM = Math.Max(2.0, diagM / 300.0);
            mp.MaximumEdgeLength = maxEdgeM / scale;
            mp.MinimumEdgeLength = 0.0001 / scale;
            return mp;
        }

        /// <summary>Mesh any surface-like geometry (Mesh, Brep, Extrusion, Surface, SubD). Returns null for others.</summary>
        public static Mesh ToRhinoMeshAny(GeometryBase g, MeshingParameters mp = null)
        {
            if (g == null) return null;
            mp ??= MeshingParameters.FastRenderMesh;
            switch (g)
            {
                case Mesh m: return m.DuplicateMesh();
                case Brep b: return JoinMeshes(Mesh.CreateFromBrep(b, mp));
                case Extrusion e: { var b = e.ToBrep(true); return b == null ? null : JoinMeshes(Mesh.CreateFromBrep(b, mp)); }
                case Surface s: { var b = s.ToBrep(); return b == null ? null : JoinMeshes(Mesh.CreateFromBrep(b, mp)); }
                case SubD sd:
                    {
                        var m = Mesh.CreateFromSubD(sd, 3);
                        if (m != null) return m;
                        var b = sd.ToBrep();
                        return b == null ? null : JoinMeshes(Mesh.CreateFromBrep(b, mp));
                    }
                default: return null;
            }
        }

        public static bool IsMeshable(GeometryBase g) => g is Mesh || g is Brep || g is Extrusion || g is Surface || g is SubD;

        private static Mesh JoinMeshes(Mesh[] parts)
        {
            if (parts == null || parts.Length == 0) return null;
            var m = new Mesh();
            foreach (var p in parts) if (p != null) m.Append(p);
            return m.Faces.Count == 0 ? null : m;
        }

        /// <summary>Rhino mesh (model units) → triangle soup (metres). Quads are split into two triangles.</summary>
        public static TriangleMesh ToTriangleMesh(Mesh m, double scale, string tag = null)
        {
            if (m == null || m.Faces.Count == 0) return null;
            var v = new double[m.Vertices.Count * 3];
            for (int i = 0; i < m.Vertices.Count; i++)
            {
                var p = m.Vertices.Point3dAt(i);
                v[3 * i] = p.X * scale; v[3 * i + 1] = p.Y * scale; v[3 * i + 2] = p.Z * scale;
            }
            var t = new List<int>(m.Faces.Count * 6);
            for (int f = 0; f < m.Faces.Count; f++)
            {
                var face = m.Faces[f];
                if (!face.IsValid()) continue;
                t.Add(face.A); t.Add(face.B); t.Add(face.C);
                if (face.IsQuad) { t.Add(face.A); t.Add(face.C); t.Add(face.D); }
            }
            return t.Count == 0 ? null : new TriangleMesh(v, t.ToArray(), tag);
        }

        public static TriangleMesh ToTriangleMesh(GeometryBase g, double scale, string tag = null, MeshingParameters mp = null)
            => ToTriangleMesh(ToRhinoMeshAny(g, mp), scale, tag);

        /// <summary>Sample a curve as points (model units). Polylines keep their vertices; other curves are divided.</summary>
        public static List<Point3d> SampleCurve(Curve c, double scale, double maxSegM = 1.0)
        {
            var pts = new List<Point3d>();
            if (c == null) return pts;
            if (c.TryGetPolyline(out var pl)) { pts.AddRange(pl); return pts; }
            double lenM = c.GetLength() * scale;
            int n = (int)Math.Max(8, Math.Min(4000, Math.Ceiling(lenM / Math.Max(0.05, maxSegM))));
            var ts = c.DivideByCount(n, true);
            if (ts == null) { pts.Add(c.PointAtStart); pts.Add(c.PointAtEnd); return pts; }
            foreach (var t in ts) pts.Add(c.PointAt(t));
            if (c.IsClosed && pts.Count > 0 && pts[0].DistanceTo(pts[pts.Count - 1]) > RhinoMath.ZeroTolerance) pts.Add(pts[0]);
            if (!c.IsClosed) { var end = c.PointAtEnd; if (pts.Count == 0 || pts[pts.Count - 1].DistanceTo(end) > RhinoMath.ZeroTolerance) pts.Add(end); }
            return pts;
        }

        /// <summary>Closed curve → XY polygon in metres. Nearly-closed curves are closed; open curves return null.</summary>
        public static Polygon2 ToPolygon(Curve c, double scale)
        {
            if (c == null) return null;
            if (!c.IsClosed)
            {
                double gap = c.PointAtStart.DistanceTo(c.PointAtEnd);
                if (gap > 0.01 * c.GetLength()) return null;
            }
            var pts = SampleCurve(c, scale, 0.5);
            if (pts.Count < 3) return null;
            var x = pts.Select(p => p.X * scale).ToArray();
            var y = pts.Select(p => p.Y * scale).ToArray();
            var poly = new Polygon2(x, y);
            return poly.Count >= 3 && poly.Area() > 1e-6 ? poly : null;
        }

        /// <summary>Curve → polyline in metres (keeps Z).</summary>
        public static Polyline3 ToPolyline3(Curve c, double scale)
        {
            var pts = SampleCurve(c, scale, 0.5);
            if (pts.Count < 2) return null;
            return new Polyline3(pts.Select(p => p.X * scale).ToArray(), pts.Select(p => p.Y * scale).ToArray(), pts.Select(p => p.Z * scale).ToArray());
        }

        /// <summary>Outer boundary loops of a hatch as curves (model units).</summary>
        public static IEnumerable<Curve> HatchOutlines(Hatch h)
        {
            Curve[] cs = null;
            try { cs = h?.Get3dCurves(true); } catch { }
            return cs ?? Array.Empty<Curve>();
        }

        // ------------------------------------------------------------------ Cloudburst → Rhino

        /// <summary>Coloured quad mesh (metres) → Rhino mesh with vertex colours (model units, double-precision vertices).</summary>
        public static Mesh ToRhinoMesh(ColoredMesh cm, double scale)
        {
            if (cm == null || cm.QuadCount == 0) return null;
            double inv = 1.0 / scale;
            var m = new Mesh();
            m.Vertices.UseDoublePrecisionVertices = true;
            var v = cm.Vertices;
            m.Vertices.Capacity = cm.VertexCount;
            for (int i = 0; i < cm.VertexCount; i++) m.Vertices.Add(v[3 * i] * inv, v[3 * i + 1] * inv, v[3 * i + 2] * inv);
            m.Faces.Capacity = cm.QuadCount;
            for (int q = 0; q < cm.QuadCount; q++) m.Faces.AddFace(cm.Quads[4 * q], cm.Quads[4 * q + 1], cm.Quads[4 * q + 2], cm.Quads[4 * q + 3]);
            if (cm.VertexColors != null && cm.VertexColors.Length == cm.VertexCount)
            {
                var cols = new Color[cm.VertexCount];
                for (int i = 0; i < cols.Length; i++) cols[i] = Color.FromArgb(cm.VertexColors[i] | unchecked((int)0xFF000000));
                m.VertexColors.SetColors(cols);
            }
            m.Normals.ComputeNormals();
            return m;
        }

        public static Mesh ToRhinoMesh(TriangleMesh tm, double scale)
        {
            if (tm == null || tm.TriangleCount == 0) return null;
            double inv = 1.0 / scale;
            var m = new Mesh();
            m.Vertices.UseDoublePrecisionVertices = true;
            for (int i = 0; i < tm.VertexCount; i++) m.Vertices.Add(tm.Vertices[3 * i] * inv, tm.Vertices[3 * i + 1] * inv, tm.Vertices[3 * i + 2] * inv);
            for (int t = 0; t < tm.TriangleCount; t++) m.Faces.AddFace(tm.Triangles[3 * t], tm.Triangles[3 * t + 1], tm.Triangles[3 * t + 2]);
            m.Normals.ComputeNormals();
            m.Compact();
            return m;
        }

        public static Polyline ToPolyline(Polyline3 p, double scale, double zLift = 0)
        {
            var pl = new Polyline(p.Count);
            double inv = 1.0 / scale;
            for (int i = 0; i < p.Count; i++)
            {
                double z = p.Z != null && i < p.Z.Length && !double.IsNaN(p.Z[i]) ? p.Z[i] : 0;
                pl.Add(p.X[i] * inv, p.Y[i] * inv, (z + zLift) * inv);
            }
            return pl;
        }

        public static Polyline ToPolyline(Polygon2 p, double scale, double z = 0)
        {
            var pl = new Polyline(p.Count + 1);
            double inv = 1.0 / scale;
            for (int i = 0; i < p.Count; i++) pl.Add(p.X[i] * inv, p.Y[i] * inv, z * inv);
            if (p.Count > 0) pl.Add(pl[0]);
            return pl;
        }

        /// <summary>Line weight in pixels for an upstream volume (m³): 1 px for tiny flows up to 5 px for big ones (log scale).</summary>
        public static int FlowThickness(double weightM3)
        {
            if (double.IsNaN(weightM3) || weightM3 <= 1) return 1;
            double t = Math.Log10(weightM3) / 3.0; // 10 m³ → 1.33 px … 1000 m³ → 5 px
            return (int)Math.Round(1 + 4 * Math.Max(0, Math.Min(1, t)));
        }

        /// <summary>Split a flow path into runs of constant thickness (model units), lifted slightly to stay above the terrain.</summary>
        public static List<(Polyline line, int thickness)> FlowSegments(Polyline3 p, double scale, double zLiftM = 0.15)
        {
            var result = new List<(Polyline, int)>();
            if (p == null || p.Count < 2) return result;
            var all = ToPolyline(p, scale, zLiftM);
            int ThickAt(int i) => FlowThickness(p.Weight != null && i < p.Weight.Length ? p.Weight[i] : 0);
            var cur = new Polyline { all[0] };
            int curT = ThickAt(1);
            for (int i = 1; i < all.Count; i++)
            {
                int t = ThickAt(i);
                if (t != curT && cur.Count >= 2)
                {
                    result.Add((cur, curT));
                    cur = new Polyline { all[i - 1] };
                    curT = t;
                }
                cur.Add(all[i]);
            }
            if (cur.Count >= 2) result.Add((cur, curT));
            return result;
        }
    }

    /// <summary>Loads cloudburst_core.dll from the plug-in folder before the first P/Invoke so it is found even when
    /// the managed assembly was loaded from a byte array (no Location) or from an unusual folder.</summary>
    public static class NativeLoader
    {
        private static IntPtr _handle;
        public static string LoadedFrom { get; private set; }

        public static bool Preload(IEnumerable<string> folders)
        {
            if (_handle != IntPtr.Zero) return true;
            string file = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "cloudburst_core.dll"
                        : RuntimeInformation.IsOSPlatform(OSPlatform.OSX) ? "libcloudburst_core.dylib" : "libcloudburst_core.so";
            foreach (var d in folders ?? Array.Empty<string>())
            {
                try
                {
                    if (string.IsNullOrEmpty(d)) continue;
                    var p = Path.Combine(d, file);
                    if (File.Exists(p) && NativeLibrary.TryLoad(p, out var h)) { _handle = h; LoadedFrom = p; return true; }
                }
                catch { }
            }
            return false;
        }
    }
}
