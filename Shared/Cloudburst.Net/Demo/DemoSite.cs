using System;
using System.Collections.Generic;
using Cloudburst.Geometry;

namespace Cloudburst.Demo
{
    /// <summary>
    /// Synthetic 300 × 200 m urban block for demos and tests: a gently sloping site with a valley, a street with kerbs,
    /// a sunken plaza, a park with a pond and six buildings. Coordinates in metres with origin at (0,0).
    /// </summary>
    public static class DemoSite
    {
        public const double Width = 300, Height = 200;

        public static double TerrainZ(double x, double y)
        {
            double z = 10.0 - 0.009 * x - 0.004 * y;                            // general fall to the south-east
            z -= 1.2 * Math.Exp(-Math.Pow((y - 70 - 0.15 * x) / 22.0, 2));     // shallow valley (old stream)
            z -= 1.4 * Bump(x, y, 205, 135, 30);                                // park pond hollow
            z -= 0.9 * Bump(x, y, 95, 150, 20);                                 // sunken plaza
            z += 0.8 * Bump(x, y, 40, 30, 35);                                  // small hill
            z -= 0.45 * Bump(x, y, 150, 103, 12);                               // trapped low point in the street
            z -= 0.5 * Bump(x, y, 80, 55, 16);                                  // parking hollow
            z -= 0.6 * Bump(x, y, 265, 45, 22);                                 // meadow hollow
            if (y > 95 && y < 111) z -= 0.12;                                   // street carriageway
            z += 0.05 * Math.Sin(x * 0.21) * Math.Cos(y * 0.17);                // micro relief
            return z;
        }

        private static double Bump(double x, double y, double cx, double cy, double r)
        {
            double d2 = ((x - cx) * (x - cx) + (y - cy) * (y - cy)) / (r * r);
            return d2 > 6 ? 0 : Math.Exp(-d2);
        }

        public static TriangleMesh Terrain(double resolution = 2.0)
        {
            int nx = (int)(Width / resolution), ny = (int)(Height / resolution);
            var b = new TriangleMesh.Builder();
            for (int j = 0; j <= ny; j++)
                for (int i = 0; i <= nx; i++)
                {
                    double x = i * resolution, y = j * resolution;
                    b.AddVertex(x, y, TerrainZ(x, y));
                }
            for (int j = 0; j < ny; j++)
                for (int i = 0; i < nx; i++)
                {
                    int a = j * (nx + 1) + i;
                    b.AddQuad(a, a + 1, a + nx + 2, a + nx + 1);
                }
            return b.Build("Terrain");
        }

        public static Polygon2 Rect(double x0, double y0, double x1, double y1) => new Polygon2(new[] { x0, x1, x1, x0 }, new[] { y0, y0, y1, y1 });

        /// <summary>(footprint, height, name) of the demo buildings.</summary>
        public static IEnumerable<(Polygon2 footprint, double height, string name)> Buildings()
        {
            yield return (Rect(20, 120, 70, 175), 15, "Block A");
            yield return (Rect(120, 125, 160, 180), 12, "Block B");
            yield return (Rect(20, 20, 60, 75), 9, "School");
            yield return (Rect(100, 25, 140, 70), 18, "Tower");
            yield return (Rect(170, 20, 235, 60), 10, "Hall");
            yield return (Rect(255, 120, 290, 185), 14, "Block C");
        }

        /// <summary>(outline, material id) — later entries override earlier.</summary>
        public static IEnumerable<(Polygon2 outline, string materialId)> Surfaces()
        {
            yield return (Rect(0, 95, Width, 111), "asphalt");                 // street
            yield return (Rect(0, 89, Width, 95), "pavers");                   // south sidewalk
            yield return (Rect(0, 111, Width, 117), "pavers");                 // north sidewalk
            yield return (Rect(75, 130, 115, 170), "concrete");                // plaza
            yield return (Rect(180, 110, 245, 165), "park_lawn");              // park
            yield return (Rect(195, 125, 215, 145), "rain_garden");            // pond / rain garden
            yield return (Rect(60, 20, 95, 80), "asphalt");                    // parking
            yield return (Rect(240, 20, 300, 80), "meadow");                   // meadow
            yield return (Rect(0, 0, 20, 89), "shrubs");                       // planting
        }

        public static IEnumerable<Polyline3> Kerbs()
        {
            yield return new Polyline3(new[] { 0.0, Width }, new[] { 95.0, 95.0 });
            yield return new Polyline3(new[] { 0.0, Width }, new[] { 111.0, 111.0 });
        }

        /// <summary>Complete host-neutral site model of the demo.</summary>
        public static SiteModel Create(double offsetX = 0, double offsetY = 0)
        {
            var site = new SiteModel();
            var t = Terrain();
            if (offsetX != 0 || offsetY != 0)
                for (int i = 0; i < t.Vertices.Length; i += 3) { t.Vertices[i] += offsetX; t.Vertices[i + 1] += offsetY; }
            site.Terrain.Add(t);
            foreach (var (fp, h, name) in Buildings())
                site.Buildings.Add(new BuildingInput { Footprint = Shift(fp, offsetX, offsetY), HeightAboveTerrain = h, Name = name, Drainage = RoofDrainage.ToSewer });
            foreach (var (o, m) in Surfaces())
                site.Regions.Add(new MaterialRegion { Outline = Shift(o, offsetX, offsetY), MaterialId = m });
            foreach (var k in Kerbs())
            {
                for (int i = 0; i < k.Count; i++) { k.X[i] += offsetX; k.Y[i] += offsetY; }
                site.Walls.Add(new WallLine { Line = k, Height = 0.10 });
            }
            return site;
        }

        private static Polygon2 Shift(Polygon2 p, double dx, double dy)
        {
            var x = (double[])p.X.Clone(); var y = (double[])p.Y.Clone();
            for (int i = 0; i < x.Length; i++) { x[i] += dx; y[i] += dy; }
            return new Polygon2(x, y);
        }
    }
}
