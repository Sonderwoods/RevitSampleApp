using System;
using System.Collections.Generic;
using System.Linq;
using Cloudburst.Geometry;
using Cloudburst.Grid;
using Cloudburst.Model;
using Cloudburst.Native;

namespace Cloudburst.Results
{
    public enum ResultLayer
    {
        /// <summary>Instant: bluespot depth. Dynamic: max depth.</summary>
        Depth,
        /// <summary>Dynamic: depth at the selected frame.</summary>
        DepthAtTime,
        Velocity,
        Hazard,
        TimeToPeak,
        FlowAccumulation,
        Difference,
        Materials,
        Elevation
    }

    public sealed class LegendItem
    {
        public string Label { get; set; }
        public int Argb { get; set; }
        public LegendItem(string label, int argb) { Label = label; Argb = argb; }
        public string Hex => $"#{Argb & 0xFFFFFF:X6}";
    }

    /// <summary>Classed colour ramp (value → ARGB). Values below the first threshold are not drawn.</summary>
    public sealed class ColorRamp
    {
        public string Title { get; }
        public string Unit { get; }
        public double[] Breaks { get; }
        public int[] Colors { get; }
        public string[] Labels { get; }

        public ColorRamp(string title, string unit, double[] breaks, int[] colors, string[] labels)
        { Title = title; Unit = unit; Breaks = breaks; Colors = colors; Labels = labels; }

        /// <summary>Colour class index (−1 = below first break, not drawn).</summary>
        public int ClassOf(double v)
        {
            if (double.IsNaN(v) || v < Breaks[0]) return -1;
            for (int i = Breaks.Length - 1; i >= 0; i--) if (v >= Breaks[i]) return i;
            return -1;
        }

        public IEnumerable<LegendItem> Legend() => Labels.Select((l, i) => new LegendItem(l, Colors[i]));

        private static int C(uint argb) => unchecked((int)argb);

        /// <summary>OUT-1 classes, 10 cm threshold highlighted by the jump from light to strong blue.</summary>
        public static ColorRamp Depth(double minDepth = 0.01) => new ColorRamp("Water depth", "m",
            new[] { minDepth, 0.10, 0.20, 0.30, 0.50 },
            new[] { C(0xFFB9E3F7), C(0xFF4FA8E0), C(0xFF1F78C8), C(0xFF0D4FA0), C(0xFF08306B) },
            new[] { $"{minDepth * 100:0}–10 cm", "10–20 cm  ▲ 10 cm target", "20–30 cm", "30–50 cm", "> 50 cm" });

        public static ColorRamp Velocity() => new ColorRamp("Max velocity", "m/s",
            new[] { 0.05, 0.25, 0.5, 1.0, 2.0 },
            new[] { C(0xFFFFF3B0), C(0xFFFFD166), C(0xFFF4A259), C(0xFFE76F51), C(0xFF9B2226) },
            new[] { "0.05–0.25", "0.25–0.5", "0.5–1", "1–2", "> 2 m/s" });

        /// <summary>Hazard rating h·(v+0.5) (EA classes).</summary>
        public static ColorRamp Hazard() => new ColorRamp("Hazard h·(v+0.5)", "m²/s",
            new[] { 0.005, 0.5, 0.75, 1.25, 2.0 },
            new[] { C(0xFFDDEFC4), C(0xFFFFE08A), C(0xFFF6A04D), C(0xFFE04F39), C(0xFF7B1E7A) },
            new[] { "Very low", "Low (< 0.75)", "Moderate", "Significant", "Extreme" });

        public static ColorRamp TimeToPeak() => new ColorRamp("Time to peak", "min",
            new double[] { 0, 30, 60, 120, 240 },
            new[] { C(0xFF7B1E7A), C(0xFFC2389B), C(0xFFF07F6E), C(0xFFFFB866), C(0xFFFFF0B3) },
            new[] { "< 30 min", "30–60", "1–2 h", "2–4 h", "> 4 h" });

        public static ColorRamp Flow(double max) => new ColorRamp("Upstream volume", "m³",
            new double[] { 2, 10, 50, 250, 1000 },
            new[] { C(0xFF9ED8F0), C(0xFF55B5E6), C(0xFF2B8FD6), C(0xFF1460B0), C(0xFF0A2F7A) },
            new[] { "2–10 m³", "10–50", "50–250", "250–1000", "> 1000 m³" });

        public static ColorRamp Difference() => new ColorRamp("Change in max depth (B − A)", "m",
            new[] { -10, -0.10, -0.02, 0.02, 0.10 },
            new[] { C(0xFF1A9850), C(0xFF91CF60), C(0x00000000), C(0xFFFC8D59), C(0xFFD73027) },
            new[] { "< −10 cm (drier)", "−10 – −2 cm", "±2 cm", "+2 – +10 cm", "> +10 cm (wetter)" });
    }

    /// <summary>Quad mesh with one colour per quad (4 unshared vertices per quad), metres.</summary>
    public sealed class ColoredMesh
    {
        /// <summary>Packed x,y,z.</summary>
        public double[] Vertices { get; set; } = Array.Empty<double>();
        /// <summary>4 vertex indices per quad.</summary>
        public int[] Quads { get; set; } = Array.Empty<int>();
        /// <summary>ARGB per vertex.</summary>
        public int[] VertexColors { get; set; } = Array.Empty<int>();
        /// <summary>Ramp class per quad (for hosts that colour by material, e.g. Revit).</summary>
        public int[] QuadClass { get; set; } = Array.Empty<int>();
        public int QuadCount => Quads.Length / 4;
        public int VertexCount => Vertices.Length / 3;
    }

    public sealed class LabelDot
    {
        public double X, Y, Z;
        public string Text;
        public LabelDot(double x, double y, double z, string text) { X = x; Y = y; Z = z; Text = text; }
    }

    /// <summary>Everything a host needs to draw one result layer.</summary>
    public sealed class ResultVisual
    {
        public string Title { get; set; }
        public ResultLayer Layer { get; set; }
        public ColoredMesh Mesh { get; set; }
        public ColorRamp Ramp { get; set; }
        public List<LegendItem> Legend { get; set; } = new List<LegendItem>();
        /// <summary>Flow paths (metres); Weight = upstream m³. Hosts draw thicker lines for larger weights.</summary>
        public List<Polyline3> FlowPaths { get; set; } = new List<Polyline3>();
        public List<LabelDot> Labels { get; set; } = new List<LabelDot>();
        /// <summary>OUT-9 assumptions caption — show it with every map.</summary>
        public string Caption { get; set; }
    }

    public static class VisualFactory
    {
        /// <summary>Lift above the terrain so results do not z-fight, m.</summary>
        public static double ZOffset { get; set; } = 0.05;

        /// <summary>Do not draw results on building footprints (roof sheet flow is not ponding).</summary>
        public static bool SkipBuildings { get; set; } = true;

        /// <summary>Minimum depth drawn for dynamic depth maps (thin rain-on-grid films are hidden), m.</summary>
        public static double DynamicMinDepth { get; set; } = 0.03;

        /// <summary>Classed quad mesh for a per-cell value array. Cells under the ramp's first break are skipped.
        /// The quad sits on the water surface (terrain + depth) when <paramref name="depth"/> is given.</summary>
        public static ColoredMesh BuildMesh(SiteGrid g, float[] values, ColorRamp ramp, float[] depth = null, Func<int, bool> include = null)
            => BuildMesh(g, values, ramp, depth, include, ZOffset, SkipBuildings);

        public static ColoredMesh BuildMesh(SiteGrid g, float[] values, ColorRamp ramp, float[] depth, Func<int, bool> include, double zOffset, bool skipBuildings)
        {
            var verts = new List<double>(); var quads = new List<int>(); var cols = new List<int>(); var cls = new List<int>();
            double dx = g.CellSize;
            for (int j = 0; j < g.Ny; j++)
                for (int i = 0; i < g.Nx; i++)
                {
                    int k = j * g.Nx + i;
                    if (g.Active[k] == 0 || (include != null && !include(k))) continue;
                    if (skipBuildings && g.Building[k] >= 0) continue;
                    int c = ramp.ClassOf(values[k]);
                    if (c < 0) continue;
                    int argb = ramp.Colors[c];
                    if (((uint)argb >> 24) == 0) continue;
                    double z = g.Z[k] + (depth != null ? depth[k] : 0) + zOffset;
                    double x0 = g.X0 + i * dx, y0 = g.Y0 + j * dx;
                    int b = verts.Count / 3;
                    verts.AddRange(new[] { x0, y0, z, x0 + dx, y0, z, x0 + dx, y0 + dx, z, x0, y0 + dx, z });
                    quads.AddRange(new[] { b, b + 1, b + 2, b + 3 });
                    cols.AddRange(new[] { argb, argb, argb, argb });
                    cls.Add(c);
                }
            return new ColoredMesh { Vertices = verts.ToArray(), Quads = quads.ToArray(), VertexColors = cols.ToArray(), QuadClass = cls.ToArray() };
        }

        public static string Caption(RainEvent rain, Scenario sc, SiteGrid g, string model)
        {
            string sewer = sc.SewerMode switch
            {
                1 => "sewer: 34 mm initial loss (combined)",
                2 => "sewer: 29 mm initial loss (separate)",
                3 => $"sewer: {sc.SewerCapacityMmH:0} mm/h capacity",
                _ => "no sewer"
            };
            string moisture = sc.Moisture switch { 0 => "dry", 2 => "wet", _ => "moist" };
            string rainText = rain != null ? $"{rain.Name}, {rain.DepthMm:0} mm × CF {rain.ClimateFactor:0.0#} = {rain.DesignDepthMm:0} mm" : $"{sc.RainDepthMm:0} mm × CF {sc.ClimateFactor:0.0#}";
            return $"{model} · {rainText} · {sewer} · {moisture} soil · cell {g.CellSize:0.##} m · SCREENING MODEL – not for compliance";
        }

        public static ResultVisual FromInstant(InstantResult r, ResultLayer layer = ResultLayer.Depth, RainEvent rain = null)
        {
            var g = r.Grid; var sc = r.Scenario;
            var v = new ResultVisual { Layer = layer, Caption = Caption(rain, sc, g, "Instant model (M1)") };
            if (layer == ResultLayer.FlowAccumulation)
            {
                v.Ramp = ColorRamp.Flow(r.Accumulation.Max());
                v.Title = "Flow paths";
                v.Mesh = BuildMesh(g, r.Accumulation, v.Ramp, null, k => r.Labels[k] < 0 && g.Building[k] < 0);
            }
            else
            {
                v.Ramp = ColorRamp.Depth(Math.Max(0.005, sc.MinDepth));
                v.Title = "Bluespots – ponding depth";
                v.Mesh = BuildMesh(g, r.Depth, v.Ramp, null);
                // draw quads at the water level, not on the bed
                LiftToWater(v.Mesh, g, r.Depth);
            }
            v.Legend = v.Ramp.Legend().ToList();
            v.FlowPaths = r.FlowPaths;
            foreach (var b in r.Bluespots.Where(b => b.VolumeM3 >= 1 && b.MaxDepthM >= Math.Max(0.05, sc.MinDepth)).OrderByDescending(b => b.VolumeM3).Take(40))
                v.Labels.Add(new LabelDot(b.X, b.Y, b.LevelZ + 0.3, $"{b.VolumeM3:0} m³ · {b.MaxDepthM * 100:0} cm{(b.Spills == 1 ? " · spills" : "")}"));
            return v;
        }

        public static ResultVisual FromDynamic(DynamicResult r, ResultLayer layer = ResultLayer.Depth, int frame = -1)
        {
            var g = r.Grid;
            var v = new ResultVisual { Layer = layer, Caption = Caption(r.Rain, r.Scenario, g, "Dynamic model (M2)") };
            float[] values; float[] depth = null; Func<int, bool> include = null;
            switch (layer)
            {
                case ResultLayer.DepthAtTime:
                    values = r.GetFrame(frame < 0 ? r.FrameCount - 1 : frame); depth = values; v.Ramp = ColorRamp.Depth(DynamicMinDepth);
                    double t = r.FrameCount > 0 ? r.FrameTimes[Math.Max(0, Math.Min(r.FrameCount - 1, frame < 0 ? r.FrameCount - 1 : frame))] : 0;
                    v.Title = $"Depth at t = {TimeSpan.FromSeconds(t):h\\:mm}"; break;
                case ResultLayer.Velocity:
                    values = r.VMax; depth = r.HMax; v.Ramp = ColorRamp.Velocity(); v.Title = "Max velocity"; include = k => r.HMax[k] > 0.02f; break;
                case ResultLayer.Hazard:
                    values = r.Hazard; depth = r.HMax; v.Ramp = ColorRamp.Hazard(); v.Title = "Hazard h·(v+0.5)"; include = k => r.HMax[k] > 0.02f; break;
                case ResultLayer.TimeToPeak:
                    values = r.TPeak.Select(x => x < 0 ? float.NaN : x / 60f).ToArray(); depth = r.HMax; v.Ramp = ColorRamp.TimeToPeak(); v.Title = "Time to peak"; include = k => r.HMax[k] > 0.05f; break;
                default:
                    values = r.HMax; depth = r.HMax; v.Ramp = ColorRamp.Depth(DynamicMinDepth); v.Title = "Max water depth"; break;
            }
            v.Mesh = BuildMesh(g, values, v.Ramp, null, include);
            if (depth != null) LiftToWater(v.Mesh, g, depth);
            v.Legend = v.Ramp.Legend().ToList();
            return v;
        }

        public static ResultVisual FromComparison(Comparison c)
        {
            var v = new ResultVisual { Layer = ResultLayer.Difference, Ramp = ColorRamp.Difference(), Title = $"{c.NameB} vs {c.NameA}", Caption = c.Caption };
            v.Mesh = BuildMesh(c.Grid, c.Diff, v.Ramp, null, k => Math.Abs(c.Diff[k]) >= 0.02f);
            v.Legend = v.Ramp.Legend().ToList();
            return v;
        }

        private static void LiftToWater(ColoredMesh m, SiteGrid g, float[] depth)
        {
            var verts = m.Vertices; double dx = g.CellSize;
            for (int q = 0; q < m.QuadCount; q++)
            {
                int b = m.Quads[4 * q];
                double cx = verts[3 * b] + dx * 0.5, cy = verts[3 * b + 1] + dx * 0.5;
                int k = g.CellAt(cx, cy); if (k < 0) continue;
                double z = g.Z[k] + depth[k] + ZOffset;
                for (int c = 0; c < 4; c++) verts[3 * (b + c) + 2] = z;
            }
        }

        /// <summary>Terrain preview mesh coloured by material (shared vertices, every <paramref name="stride"/> cells).</summary>
        public static ColoredMesh MaterialMesh(SiteGrid g)
        {
            var colors = g.Palette.Materials.Select(m => m.Argb).ToArray();
            var vals = new float[g.Count];
            var ramp = new ColorRamp("Materials", "", Enumerable.Range(0, colors.Length).Select(i => (double)i).ToArray(), colors, g.Palette.Materials.Select(m => m.Name).ToArray());
            for (int k = 0; k < g.Count; k++) vals[k] = g.Building[k] >= 0 ? float.NaN : g.Material[k];
            return BuildMesh(g, vals, ramp, null, null, 0.02, false);
        }
    }

    /// <summary>OUT-7 option comparison.</summary>
    public sealed class Comparison
    {
        public SiteGrid Grid { get; }
        public float[] Diff { get; }
        public string NameA { get; }
        public string NameB { get; }
        public double FloodedVolumeA { get; }
        public double FloodedVolumeB { get; }
        public double AreaOver10CmA { get; }
        public double AreaOver10CmB { get; }
        public string Caption { get; }
        public double VolumeChange => FloodedVolumeB - FloodedVolumeA;

        /// <summary>Compare two depth maps on the same grid (cell sizes/extents must match; otherwise B is sampled at A's cells).</summary>
        public Comparison(SiteGrid gridA, float[] depthA, string nameA, SiteGrid gridB, float[] depthB, string nameB, string caption = null)
        {
            Grid = gridA; NameA = nameA; NameB = nameB; Caption = caption ?? "Option comparison · SCREENING MODEL";
            Diff = new float[gridA.Count];
            double a = gridA.CellArea;
            for (int j = 0; j < gridA.Ny; j++)
                for (int i = 0; i < gridA.Nx; i++)
                {
                    int k = j * gridA.Nx + i;
                    int kb = ReferenceEquals(gridA, gridB) || (gridA.Nx == gridB.Nx && gridA.Ny == gridB.Ny) ? k : gridB.CellAt(gridA.CenterX(i), gridA.CenterY(j));
                    float db = kb >= 0 ? depthB[kb] : 0, da = depthA[k];
                    Diff[k] = db - da;
                    FloodedVolumeA += da * a; FloodedVolumeB += db * a;
                    if (da >= 0.1f) AreaOver10CmA += a;
                    if (db >= 0.1f) AreaOver10CmB += a;
                }
        }
    }
}
