using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using Cloudburst;
using Cloudburst.Geometry;
using Cloudburst.Grid;
using Cloudburst.Materials;
using Cloudburst.Model;
using Cloudburst.Results;
using CloudburstRhinoCommon;
using Grasshopper.Kernel;
using Grasshopper.Kernel.Types;
using Rhino.Geometry;

namespace CloudburstGH
{
    internal static class PaletteCache
    {
        private static MaterialPalette _default;
        private static string _path; private static DateTime _stamp; private static MaterialPalette _file;

        /// <summary>Palette from a JSON file (cached by path + timestamp) or the built-in default.</summary>
        public static MaterialPalette Get(string path, Action<string> warn = null)
        {
            if (!string.IsNullOrWhiteSpace(path))
            {
                try
                {
                    var stamp = File.GetLastWriteTimeUtc(path);
                    if (_file == null || _path != path || _stamp != stamp) { _file = MaterialPalette.Load(path); _path = path; _stamp = stamp; }
                    return _file;
                }
                catch (Exception ex) { warn?.Invoke($"Palette file could not be read ({ex.Message}); using the built-in palette."); }
            }
            return _default ??= MaterialPalette.LoadDefault();
        }
    }

    // ---------------------------------------------------------------------- Palette

    public sealed class PaletteComponent : CloudburstComponent
    {
        public PaletteComponent() : base("Material Palette", "Palette", "The surface material palette: ids, names, colours, runoff coefficients and roughness.", "2 Materials", Glyph.Palette) { }
        public override Guid ComponentGuid => new Guid("2F6A3C18-9B4D-4E71-8A05-D3C27E916B40");

        protected override void RegisterInputParams(GH_InputParamManager p)
        {
            p.AddTextParameter("Palette file", "P", "Optional palette JSON file (default: built-in palette)", GH_ParamAccess.item);
            p[0].Optional = true;
        }

        protected override void RegisterOutputParams(GH_OutputParamManager p)
        {
            p.AddTextParameter("Id", "Id", "Material ids", GH_ParamAccess.list);
            p.AddTextParameter("Name", "N", "Material names", GH_ParamAccess.list);
            p.AddColourParameter("Colour", "Col", "Display colours", GH_ParamAccess.list);
            p.AddNumberParameter("C cloudburst", "C", "Cloudburst runoff coefficient (sandy soil)", GH_ParamAccess.list);
            p.AddNumberParameter("C cloudburst clay", "Cc", "Cloudburst runoff coefficient (clay soil)", GH_ParamAccess.list);
            p.AddNumberParameter("Manning n", "n", "Manning roughness, s/m^(1/3)", GH_ParamAccess.list);
        }

        protected override void Solve(IGH_DataAccess da)
        {
            string path = null; da.GetData(0, ref path);
            var pal = PaletteCache.Get(path, w => AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, w));
            var ms = pal.Materials;
            da.SetDataList(0, ms.Select(m => m.Id));
            da.SetDataList(1, ms.Select(m => m.Name));
            da.SetDataList(2, ms.Select(m => Color.FromArgb(m.Argb | unchecked((int)0xFF000000))));
            da.SetDataList(3, ms.Select(m => m.CCloudburstSand));
            da.SetDataList(4, ms.Select(m => m.CCloudburstClay));
            da.SetDataList(5, ms.Select(m => m.ManningN));
            Message = $"{ms.Count} materials";
        }
    }

    // ---------------------------------------------------------------------- Material region

    public sealed class MaterialRegionComponent : CloudburstComponent
    {
        public MaterialRegionComponent() : base("Material Region", "Region", "Assign a surface material (and optional JB soil class) to a closed curve, surface or mesh.", "2 Materials", Glyph.Region) { }
        public override Guid ComponentGuid => new Guid("8D41B2E7-6C3A-4F95-B1E8-0A7D52C9F364");

        protected override void RegisterInputParams(GH_InputParamManager p)
        {
            p.AddGeometryParameter("Geometry", "G", "Closed curve, brep/surface or mesh outlining the area", GH_ParamAccess.item);
            p.AddTextParameter("Material", "M", "Material id or name (see Palette); free text is guessed, e.g. 'asfalt', 'green roof'", GH_ParamAccess.item, "asphalt");
            p.AddIntegerParameter("Soil class", "S", "Optional Danish JB soil class 1–11", GH_ParamAccess.item);
            p[2].Optional = true;
        }

        protected override void RegisterOutputParams(GH_OutputParamManager p)
        {
            p.AddGenericParameter("Region", "R", "Material region (connect to Build Grid → Regions)", GH_ParamAccess.list);
        }

        protected override void Solve(IGH_DataAccess da)
        {
            IGH_GeometricGoo goo = null; string mat = null; int soil = 0;
            if (!da.GetData(0, ref goo)) return;
            da.GetData(1, ref mat);
            bool hasSoil = da.GetData(2, ref soil);
            var pal = PaletteCache.Get(null);
            string id = null;
            int idx = pal.IndexOf(mat);
            if (idx >= 0) id = pal.Materials[idx].Id;
            else
            {
                var g = pal.Guess(mat);
                if (g != null) { id = g.Id; AddRuntimeMessage(GH_RuntimeMessageLevel.Remark, $"'{mat}' interpreted as {g.Name}"); }
                else { id = mat; AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, $"Unknown material '{mat}': the palette default ({pal.Default.Name}) will be used unless a custom palette defines it."); }
            }
            int? soilClass = hasSoil && soil >= 1 && soil <= 11 ? soil : (int?)null;
            if (hasSoil && soilClass == null) AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, "Soil class must be 1–11; ignored.");

            double s = Gh.Scale;
            var geo = Gh.Geometry(goo);
            var regions = new List<MaterialRegionGoo>();
            if (geo is Curve c)
            {
                var poly = RhinoConvert.ToPolygon(c, s);
                if (poly == null) { AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, "Curve must be closed."); return; }
                regions.Add(new MaterialRegionGoo(new MaterialRegion { Outline = poly, MaterialId = id, SoilClass = soilClass }));
            }
            else if (geo is Hatch h)
            {
                foreach (var hc in RhinoConvert.HatchOutlines(h))
                {
                    var poly = RhinoConvert.ToPolygon(hc, s);
                    if (poly != null) regions.Add(new MaterialRegionGoo(new MaterialRegion { Outline = poly, MaterialId = id, SoilClass = soilClass }));
                }
            }
            else if (geo != null && RhinoConvert.IsMeshable(geo))
            {
                var tm = RhinoConvert.ToTriangleMesh(geo, s, id, MeshingParameters.FastRenderMesh);
                if (tm != null) regions.Add(new MaterialRegionGoo(new MaterialRegion { Surface = tm, MaterialId = id, SoilClass = soilClass }));
            }
            else { AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, "Use a closed curve, surface, brep or mesh."); return; }

            var m = pal.Get(id);
            Message = m?.Name ?? id;
            da.SetDataList(0, regions);
        }
    }

    // ---------------------------------------------------------------------- Build grid

    public sealed class BuildGridComponent : CloudburstComponent
    {
        public BuildGridComponent() : base("Build Grid", "Grid", "Rasterise terrain, buildings, material regions, kerbs and cut-outs into the analysis grid (metres; model units are converted).", "1 Grid", Glyph.Grid) { }
        public override Guid ComponentGuid => new Guid("4A9C0E6B-1D72-4B38-9F2A-E58B3D17C0A5");

        protected override void RegisterInputParams(GH_InputParamManager p)
        {
            p.AddGeometryParameter("Terrain", "T", "Terrain meshes / surfaces / breps", GH_ParamAccess.list);
            p.AddGeometryParameter("Design terrain", "DT", "Design terrain that replaces existing heights where it covers", GH_ParamAccess.list);
            p.AddGeometryParameter("Buildings", "B", "Closed breps/extrusions/meshes, or closed footprint curves (8 m high)", GH_ParamAccess.list);
            p.AddGenericParameter("Regions", "R", "Material regions from the Material Region component", GH_ParamAccess.list);
            p.AddCurveParameter("Walls", "W", "Kerb / wall / channel curves", GH_ParamAccess.list);
            p.AddNumberParameter("Kerb height", "H", "Wall height in metres (negative = channel). One value, or one per wall", GH_ParamAccess.list, 0.10);
            p.AddCurveParameter("Bridge cuts", "BC", "Closed outlines of bridge decks to remove", GH_ParamAccess.list);
            p.AddCurveParameter("Boundary", "Bnd", "Optional closed analysis boundary", GH_ParamAccess.item);
            p.AddNumberParameter("Cell size", "Cs", "Grid cell size in metres", GH_ParamAccess.item, 1.0);
            p.AddIntegerParameter("Default soil", "Soil", "Default Danish JB soil class 1–11", GH_ParamAccess.item, 6);
            p.AddTextParameter("Palette file", "P", "Optional palette JSON file", GH_ParamAccess.item);
            foreach (int i in new[] { 1, 2, 3, 4, 5, 6, 7, 10 }) p[i].Optional = true;
        }

        protected override void RegisterOutputParams(GH_OutputParamManager p)
        {
            p.AddGenericParameter("Grid", "G", "Cloudburst analysis grid", GH_ParamAccess.item);
            p.AddTextParameter("Info", "I", "Grid summary and warnings", GH_ParamAccess.item);
            p.AddMeshParameter("Preview", "M", "Terrain coloured by surface material", GH_ParamAccess.item);
        }

        protected override void Solve(IGH_DataAccess da)
        {
            double s = Gh.Scale;
            var terrain = new List<IGH_GeometricGoo>(); var design = new List<IGH_GeometricGoo>(); var buildings = new List<IGH_GeometricGoo>();
            var regions = new List<IGH_Goo>(); var walls = new List<Curve>(); var heights = new List<double>(); var cuts = new List<Curve>();
            Curve boundary = null; double cell = 1.0; int soil = 6; string palPath = null;
            if (!da.GetDataList(0, terrain)) return;
            da.GetDataList(1, design); da.GetDataList(2, buildings); da.GetDataList(3, regions); da.GetDataList(4, walls);
            da.GetDataList(5, heights); da.GetDataList(6, cuts); da.GetData(7, ref boundary); da.GetData(8, ref cell); da.GetData(9, ref soil); da.GetData(10, ref palPath);

            if (cell <= 0.05) { AddRuntimeMessage(GH_RuntimeMessageLevel.Error, "Cell size must be > 0.05 m."); return; }
            soil = Math.Max(1, Math.Min(11, soil));
            var site = new SiteModel();
            int skipped = 0;

            foreach (var (list, target) in new[] { (terrain, site.Terrain), (design, site.DesignTerrain) })
                foreach (var g in list)
                {
                    var geo = Gh.Geometry(g);
                    if (geo == null || !RhinoConvert.IsMeshable(geo)) { skipped++; continue; }
                    var tm = RhinoConvert.ToTriangleMesh(geo, s, null, RhinoConvert.TerrainMeshing(geo.GetBoundingBox(true), s));
                    if (tm != null) target.Add(tm); else skipped++;
                }
            if (!site.HasTerrain) { AddRuntimeMessage(GH_RuntimeMessageLevel.Error, "No usable terrain (meshes, surfaces or breps)."); return; }

            foreach (var g in buildings)
            {
                var geo = Gh.Geometry(g);
                if (geo is Curve c)
                {
                    var fp = RhinoConvert.ToPolygon(c, s);
                    if (fp != null) site.Buildings.Add(new BuildingInput { Footprint = fp, HeightAboveTerrain = 8.0 }); else skipped++;
                }
                else if (geo != null && RhinoConvert.IsMeshable(geo))
                {
                    var tm = RhinoConvert.ToTriangleMesh(geo, s, null, MeshingParameters.FastRenderMesh);
                    if (tm != null) site.Buildings.Add(new BuildingInput { Geometry = tm }); else skipped++;
                }
                else if (geo != null) skipped++;
            }

            foreach (var r in regions)
            {
                var reg = Gh.As<MaterialRegion>(r);
                if (reg != null) site.Regions.Add(reg);
                else if (r != null) { skipped++; AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, "Regions accepts output of the Material Region component only."); }
            }

            for (int i = 0; i < walls.Count; i++)
            {
                var pl = RhinoConvert.ToPolyline3(walls[i], s);
                if (pl == null) { skipped++; continue; }
                double h = heights.Count == 0 ? 0.10 : heights.Count == walls.Count ? heights[i] : heights[Math.Min(i, heights.Count - 1)];
                site.Walls.Add(new WallLine { Line = pl, Height = h });
            }

            foreach (var c in cuts) { var p = RhinoConvert.ToPolygon(c, s); if (p != null) site.BridgeCuts.Add(p); else skipped++; }
            if (boundary != null)
            {
                site.Boundary = RhinoConvert.ToPolygon(boundary, s);
                if (site.Boundary == null) AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, "Boundary must be a closed curve; ignored.");
            }

            var palette = PaletteCache.Get(palPath, w => AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, w));
            var settings = new GridSettings { CellSize = cell, DefaultSoilClass = soil };
            var b = site.GetTerrainBounds();
            if (b.IsValid && b.Width * b.Height / (cell * cell) > settings.MaxCells)
                AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, $"Site is {b.Width:0} × {b.Height:0} m: more than {settings.MaxCells / 1e6:0.#} M cells at {cell} m. The engine will coarsen or clip – consider a larger cell size or a boundary.");

            var grid = Engine.BuildGrid(site, palette, settings);

            var sb = new StringBuilder();
            sb.AppendLine("Grid " + grid);
            sb.AppendLine($"Terrain: {site.Terrain.Count + site.DesignTerrain.Count} meshes, {site.Terrain.Sum(t => t.TriangleCount) + site.DesignTerrain.Sum(t => t.TriangleCount):N0} triangles");
            sb.AppendLine($"{Gh.Plural(site.Buildings.Count, "building")}, {Gh.Plural(site.Regions.Count, "region")}, {Gh.Plural(site.Walls.Count, "wall")}, {Gh.Plural(site.BridgeCuts.Count, "bridge cut")}");
            int active = grid.Active.Count(a => a != 0);
            sb.AppendLine($"Active cells: {active:N0} ({active * grid.CellArea / 10000:0.##} ha)");
            var mats = grid.Material.Where((m, k) => grid.Active[k] != 0 && grid.Building[k] < 0).GroupBy(m => m).OrderByDescending(gr => gr.Count()).Take(6);
            foreach (var gr in mats) sb.AppendLine($"  {grid.Palette.Materials[Math.Min(gr.Key, grid.Palette.Materials.Count - 1)].Name}: {gr.Count() * grid.CellArea:N0} m²");
            if (skipped > 0) { sb.AppendLine($"Skipped inputs: {skipped}"); AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, $"{skipped} inputs could not be used."); }
            foreach (var w in grid.Warnings) { sb.AppendLine("⚠ " + w); AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, w); }

            Mesh preview = null;
            if (grid.Count <= 1_500_000)
            {
                preview = RhinoConvert.ToRhinoMesh(VisualFactory.MaterialMesh(grid), s);
                PreviewMesh(preview);
            }
            else AddRuntimeMessage(GH_RuntimeMessageLevel.Remark, "Grid too large for a material preview mesh.");

            Message = $"{grid.Nx}×{grid.Ny} @ {grid.CellSize:0.##} m";
            da.SetData(0, new SiteGridGoo(grid));
            da.SetData(1, sb.ToString().TrimEnd());
            da.SetData(2, preview);
        }
    }

    // ---------------------------------------------------------------------- Rain event

    public sealed class RainEventComponent : CloudburstComponent
    {
        public RainEventComponent() : base("Rain Event", "Rain", "Design rain: a preset (0 T10, 1 T100 cloudburst, 2 2011 Copenhagen test, 3 box 83 mm/4 h) or a custom CDS/box event.", "3 Rain", Glyph.Rain) { }
        public override Guid ComponentGuid => new Guid("C7B30F95-24E1-4D6A-8C49-7F1E0A3B5D28");

        protected override void RegisterInputParams(GH_InputParamManager p)
        {
            p.AddIntegerParameter("Preset", "P", "0 T10, 1 T100 (cloudburst), 2 2011 test, 3 box 83 mm / 4 h. Ignored when Depth or Duration is set", GH_ParamAccess.item, 1);
            p.AddNumberParameter("Depth", "D", "Custom rain depth, mm (CDS: 0 = from the IDF curve)", GH_ParamAccess.item);
            p.AddNumberParameter("Duration", "Dur", "Custom duration, minutes", GH_ParamAccess.item);
            p.AddIntegerParameter("Shape", "S", "Custom shape: 0 CDS (Chicago), 1 box", GH_ParamAccess.item, 0);
            p.AddNumberParameter("Return period", "T", "Return period, years (CDS)", GH_ParamAccess.item, 100);
            p.AddNumberParameter("Climate factor", "CF", "Climate factor (default by return period: 1.2 / 1.3 / 1.4)", GH_ParamAccess.item);
            p[1].Optional = true; p[2].Optional = true; p[5].Optional = true;
        }

        protected override void RegisterOutputParams(GH_OutputParamManager p)
        {
            p.AddGenericParameter("Rain", "R", "Rain event", GH_ParamAccess.item);
            p.AddTextParameter("Info", "I", "Description", GH_ParamAccess.item);
            p.AddNumberParameter("Time", "t", "Step start times, minutes", GH_ParamAccess.list);
            p.AddNumberParameter("Intensity", "i", "Design intensity incl. climate factor, mm/h", GH_ParamAccess.list);
        }

        protected override void Solve(IGH_DataAccess da)
        {
            int preset = 1, shape = 0; double depth = 0, dur = 0, T = 100, cf = 0;
            da.GetData(0, ref preset);
            bool hasDepth = da.GetData(1, ref depth), hasDur = da.GetData(2, ref dur);
            da.GetData(3, ref shape); da.GetData(4, ref T);
            bool hasCf = da.GetData(5, ref cf) && cf > 0;

            RainEvent rain;
            if (hasDepth || hasDur)
            {
                if (hasDur && dur <= 0) { AddRuntimeMessage(GH_RuntimeMessageLevel.Error, "Duration must be > 0."); return; }
                if (!hasDur) dur = shape == 1 ? 120 : 240;
                if (shape == 1)
                {
                    if (!hasDepth || depth <= 0) { AddRuntimeMessage(GH_RuntimeMessageLevel.Error, "A box rain needs a depth in mm."); return; }
                    rain = RainEvent.Box(depth, dur, hasCf ? cf : 1.0);
                }
                else rain = RainEvent.Cds(Math.Max(1, T), dur, hasDepth ? Math.Max(0, depth) : 0, hasCf ? cf : (double?)null);
            }
            else
            {
                var presets = RainEvent.Presets();
                rain = presets[Math.Max(0, Math.Min(presets.Count - 1, preset))];
                if (preset < 0 || preset >= presets.Count) AddRuntimeMessage(GH_RuntimeMessageLevel.Warning, $"Preset must be 0–{presets.Count - 1}.");
                if (hasCf) rain.ClimateFactor = cf;
            }

            Message = rain.Name;
            da.SetData(0, new RainEventGoo(rain));
            da.SetData(1, $"{rain.Name}\n{rain.Description}\nDesign depth {rain.DesignDepthMm:0} mm, peak {rain.PeakMmH:0} mm/h");
            da.SetDataList(2, Enumerable.Range(0, rain.IntensityMmH.Length).Select(i => i * rain.StepS / 60.0));
            da.SetDataList(3, rain.IntensityMmH.Select(v => v * rain.ClimateFactor));
        }
    }
}
