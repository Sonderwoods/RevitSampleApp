using System;
using System.Collections.Generic;
using Cloudburst.Geometry;

namespace Cloudburst.Revit
{
    /// <summary>Nearest-vertex height lookup over terrain meshes (metres). Good enough for draping demo lines and footing buildings.</summary>
    internal sealed class TerrainSampler
    {
        private readonly Dictionary<(int, int), List<(double x, double y, double z)>> _bins = new Dictionary<(int, int), List<(double, double, double)>>();
        private readonly double _cell;
        public double MinZ { get; } = double.MaxValue;
        public double MaxZ { get; } = double.MinValue;
        public bool IsEmpty => _bins.Count == 0;

        public TerrainSampler(IEnumerable<TriangleMesh> meshes, double cell = 4.0)
        {
            _cell = cell;
            foreach (var m in meshes)
            {
                if (m == null) continue;
                var v = m.Vertices;
                for (int i = 0; i + 2 < v.Length; i += 3)
                {
                    var key = Key(v[i], v[i + 1]);
                    if (!_bins.TryGetValue(key, out var list)) _bins[key] = list = new List<(double, double, double)>();
                    list.Add((v[i], v[i + 1], v[i + 2]));
                    MinZ = Math.Min(MinZ, v[i + 2]); MaxZ = Math.Max(MaxZ, v[i + 2]);
                }
            }
            if (IsEmpty) { MinZ = 0; MaxZ = 0; }
        }

        private (int, int) Key(double x, double y) => ((int)Math.Floor(x / _cell), (int)Math.Floor(y / _cell));

        public double Z(double x, double y)
        {
            if (IsEmpty) return 0;
            var (ix, iy) = Key(x, y);
            for (int r = 1; r <= 4; r++)
            {
                double best = double.MaxValue, z = MinZ; bool found = false;
                for (int dx = -r; dx <= r; dx++)
                    for (int dy = -r; dy <= r; dy++)
                        if (_bins.TryGetValue((ix + dx, iy + dy), out var list))
                            foreach (var p in list)
                            {
                                double d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
                                if (d < best) { best = d; z = p.z; found = true; }
                            }
                if (found) return z;
            }
            return MinZ;
        }

        /// <summary>Min/max terrain height over the polygon's bounding box (sampled).</summary>
        public (double min, double max) Range(Polygon2 poly)
        {
            var b = poly.GetBounds();
            double mn = double.MaxValue, mx = double.MinValue;
            int n = 8;
            for (int i = 0; i <= n; i++)
                for (int j = 0; j <= n; j++)
                {
                    double z = Z(b.MinX + b.Width * i / n, b.MinY + b.Height * j / n);
                    mn = Math.Min(mn, z); mx = Math.Max(mx, z);
                }
            return (mn, mx);
        }
    }
}
