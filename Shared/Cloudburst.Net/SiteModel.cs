using System.Collections.Generic;
using Cloudburst.Geometry;

namespace Cloudburst
{
    public enum RoofDrainage { ToSewer = 0, ToGround = 1 }
    public enum SewerMode { None = 0, CombinedInitialLoss = 1, SeparateInitialLoss = 2, ConstantCapacity = 3 }
    public enum Moisture { Dry = 0, Moist = 1, Wet = 2 }
    public enum BoundaryType { Open = 0, Closed = 1 }

    /// <summary>Everything a host collects from the user's model, in metres. Host neutral.</summary>
    public sealed class SiteModel
    {
        /// <summary>Terrain surfaces; the highest triangle wins where they overlap. Later design meshes can be added with <see cref="DesignTerrain"/>.</summary>
        public List<TriangleMesh> Terrain { get; } = new List<TriangleMesh>();
        /// <summary>Design terrain that replaces existing heights where it covers the grid (IN-2).</summary>
        public List<TriangleMesh> DesignTerrain { get; } = new List<TriangleMesh>();
        public List<BuildingInput> Buildings { get; } = new List<BuildingInput>();
        public List<MaterialRegion> Regions { get; } = new List<MaterialRegion>();
        public List<WallLine> Walls { get; } = new List<WallLine>();
        /// <summary>Bridge decks to remove from the terrain (IN-4).</summary>
        public List<Polygon2> BridgeCuts { get; } = new List<Polygon2>();
        /// <summary>Terrain raster files (GeoTIFF e.g. DHM/Terræn 0.4 m, or Esri ASCII .asc) loaded by the engine (IN-1).</summary>
        public List<string> TerrainFiles { get; } = new List<string>();
        /// <summary>Pixel step when loading <see cref="TerrainFiles"/> (1 = full resolution).</summary>
        public int TerrainFileStep { get; set; } = 1;
        /// <summary>Optional analysis boundary. When null the terrain extent is used.</summary>
        public Polygon2 Boundary { get; set; }

        public bool HasTerrain => Terrain.Count > 0 || DesignTerrain.Count > 0 || TerrainFiles.Count > 0;

        public Bounds2 GetTerrainBounds()
        {
            var b = Bounds2.Empty;
            foreach (var m in Terrain) b = b.Union(m.GetBounds());
            foreach (var m in DesignTerrain) b = b.Union(m.GetBounds());
            if (Boundary != null) b = b.IsValid ? b.Intersect(Boundary.GetBounds()) : Boundary.GetBounds();
            return b;
        }
    }

    public sealed class BuildingInput
    {
        /// <summary>Solid or roof geometry. Its XY projection is the footprint; its max Z the roof level.</summary>
        public TriangleMesh Geometry { get; set; }
        /// <summary>Alternative to geometry: footprint polygon plus height above terrain.</summary>
        public Polygon2 Footprint { get; set; }
        public double HeightAboveTerrain { get; set; } = 8.0;
        public RoofDrainage Drainage { get; set; } = RoofDrainage.ToSewer;
        public string Name { get; set; }
        /// <summary>Façade threshold above terrain used for building flags (OUT-6), m.</summary>
        public double ThresholdHeight { get; set; } = 0.10;
    }

    public sealed class MaterialRegion
    {
        /// <summary>Region outline. Either Outline or Surface must be set.</summary>
        public Polygon2 Outline { get; set; }
        /// <summary>Region as triangles (e.g. Rhino mesh faces, Revit floor top face).</summary>
        public TriangleMesh Surface { get; set; }
        public string MaterialId { get; set; }
        /// <summary>Optional Danish JB soil class 1–11 override.</summary>
        public int? SoilClass { get; set; }
        public bool? Compacted { get; set; }
        public SewerMode? Sewer { get; set; }
    }

    public sealed class WallLine
    {
        public Polyline3 Line { get; set; }
        /// <summary>Height above terrain in metres. Negative values cut a channel (IN-3).</summary>
        public double Height { get; set; } = 0.10;
    }
}
