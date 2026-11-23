using System;
using System.Collections.Generic;

namespace Cloudburst.Geometry
{
    /// <summary>Plain triangle soup in metres (world XY, Z up). Hosts convert their native geometry into this.</summary>
    public sealed class TriangleMesh
    {
        /// <summary>Packed x,y,z triplets.</summary>
        public double[] Vertices { get; }
        /// <summary>Packed vertex index triplets.</summary>
        public int[] Triangles { get; }
        /// <summary>Optional source label (layer, material or element name) used for auto material mapping.</summary>
        public string Tag { get; set; }

        public TriangleMesh(double[] vertices, int[] triangles, string tag = null)
        {
            Vertices = vertices ?? throw new ArgumentNullException(nameof(vertices));
            Triangles = triangles ?? throw new ArgumentNullException(nameof(triangles));
            Tag = tag;
        }

        public int VertexCount => Vertices.Length / 3;
        public int TriangleCount => Triangles.Length / 3;

        public Bounds2 GetBounds()
        {
            var b = Bounds2.Empty;
            for (int i = 0; i < Vertices.Length; i += 3) b = b.Include(Vertices[i], Vertices[i + 1]);
            return b;
        }

        /// <summary>Convenience builder used by hosts.</summary>
        public sealed class Builder
        {
            private readonly List<double> _v = new List<double>();
            private readonly List<int> _t = new List<int>();
            public int AddVertex(double x, double y, double z) { _v.Add(x); _v.Add(y); _v.Add(z); return _v.Count / 3 - 1; }
            public void AddTriangle(int a, int b, int c) { _t.Add(a); _t.Add(b); _t.Add(c); }
            public void AddQuad(int a, int b, int c, int d) { AddTriangle(a, b, c); AddTriangle(a, c, d); }
            public bool IsEmpty => _t.Count == 0;
            public TriangleMesh Build(string tag = null) => new TriangleMesh(_v.ToArray(), _t.ToArray(), tag);
        }
    }

    /// <summary>Closed planar polygon in metres (XY only). Do not repeat the first point.</summary>
    public sealed class Polygon2
    {
        public double[] X { get; }
        public double[] Y { get; }
        public Polygon2(double[] x, double[] y)
        {
            if (x == null || y == null || x.Length != y.Length) throw new ArgumentException("Polygon arrays must have equal length.");
            int n = x.Length;
            if (n > 1 && Math.Abs(x[0] - x[n - 1]) < 1e-9 && Math.Abs(y[0] - y[n - 1]) < 1e-9) { Array.Resize(ref x, n - 1); Array.Resize(ref y, n - 1); }
            X = x; Y = y;
        }
        public int Count => X.Length;
        public Bounds2 GetBounds() { var b = Bounds2.Empty; for (int i = 0; i < X.Length; i++) b = b.Include(X[i], Y[i]); return b; }
        public double Area()
        {
            double a = 0; for (int i = 0, j = X.Length - 1; i < X.Length; j = i++) a += (X[j] + X[i]) * (Y[j] - Y[i]);
            return Math.Abs(a) * 0.5;
        }
        public bool Contains(double px, double py)
        {
            bool inside = false;
            for (int i = 0, j = X.Length - 1; i < X.Length; j = i++)
                if (((Y[i] > py) != (Y[j] > py)) && (px < (X[j] - X[i]) * (py - Y[i]) / (Y[j] - Y[i]) + X[i])) inside = !inside;
            return inside;
        }
    }

    /// <summary>Open polyline in metres. Z optional (NaN when unknown).</summary>
    public sealed class Polyline3
    {
        public double[] X { get; }
        public double[] Y { get; }
        public double[] Z { get; }
        /// <summary>Optional per-vertex weight (e.g. upstream volume m³).</summary>
        public double[] Weight { get; set; }
        public Polyline3(double[] x, double[] y, double[] z = null)
        {
            X = x; Y = y; Z = z ?? new double[x.Length];
        }
        public int Count => X.Length;
        public double Length()
        {
            double l = 0; for (int i = 1; i < X.Length; i++) l += Math.Sqrt(Sq(X[i] - X[i - 1]) + Sq(Y[i] - Y[i - 1]));
            return l;
        }
        private static double Sq(double v) => v * v;
    }

    public readonly struct Bounds2
    {
        public readonly double MinX, MinY, MaxX, MaxY;
        public Bounds2(double minX, double minY, double maxX, double maxY) { MinX = minX; MinY = minY; MaxX = maxX; MaxY = maxY; }
        public static Bounds2 Empty => new Bounds2(double.PositiveInfinity, double.PositiveInfinity, double.NegativeInfinity, double.NegativeInfinity);
        public bool IsValid => MaxX >= MinX && MaxY >= MinY;
        public double Width => MaxX - MinX;
        public double Height => MaxY - MinY;
        public Bounds2 Include(double x, double y) => new Bounds2(Math.Min(MinX, x), Math.Min(MinY, y), Math.Max(MaxX, x), Math.Max(MaxY, y));
        public Bounds2 Union(Bounds2 o) => !o.IsValid ? this : !IsValid ? o : new Bounds2(Math.Min(MinX, o.MinX), Math.Min(MinY, o.MinY), Math.Max(MaxX, o.MaxX), Math.Max(MaxY, o.MaxY));
        public Bounds2 Intersect(Bounds2 o) => new Bounds2(Math.Max(MinX, o.MinX), Math.Max(MinY, o.MinY), Math.Min(MaxX, o.MaxX), Math.Min(MaxY, o.MaxY));
        public override string ToString() => $"[{MinX:0.##},{MinY:0.##} – {MaxX:0.##},{MaxY:0.##}]";
    }

    public struct Point3
    {
        public double X, Y, Z;
        public Point3(double x, double y, double z) { X = x; Y = y; Z = z; }
    }
}
