using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Cloudburst.Demo;
using Cloudburst.Geometry;
using Cloudburst.Hosting;
using Cloudburst.Results;

namespace Cloudburst.Standalone
{
    /// <summary>
    /// Host used outside Rhino/Revit: every "pick" selects the matching part of the built-in demo site,
    /// previews go to a 2D map (<see cref="VisualShown"/>).
    /// </summary>
    public sealed class FakeHost : ICloudburstHost
    {
        private readonly SiteModel _demo = DemoSite.Create();
        private readonly Dictionary<PickRole, int> _counts = new Dictionary<PickRole, int>();
        private readonly List<TriangleMesh> _terrain = new List<TriangleMesh>();
        private readonly List<BuildingInput> _buildings = new List<BuildingInput>();
        private readonly List<WallLine> _walls = new List<WallLine>();
        private readonly List<Polygon2> _bridges = new List<Polygon2>();
        private readonly List<MaterialRegion> _regions = new List<MaterialRegion>();
        private Polygon2 _boundary;
        private int _surfaceCursor;

        public string HostName => "Standalone";

        public event Action<ResultVisual> VisualShown;
        public event Action<string> Logged;

        public async Task<PickSummary> PickAsync(PickRole role, string materialId = null, double wallHeight = 0.10)
        {
            await Task.Delay(200); // feels like a pick
            switch (role)
            {
                case PickRole.Terrain:
                    _terrain.Clear(); _terrain.AddRange(_demo.Terrain); break;
                case PickRole.Buildings:
                    _buildings.Clear(); _buildings.AddRange(_demo.Buildings); break;
                case PickRole.Walls:
                    _walls.Clear();
                    _walls.AddRange(_demo.Walls.Select(w => new WallLine { Line = w.Line, Height = wallHeight }));
                    break;
                case PickRole.BridgeCuts:
                    _bridges.Clear(); _bridges.Add(DemoSite.Rect(140, 95, 160, 111)); break;
                case PickRole.Boundary:
                    _boundary = DemoSite.Rect(5, 5, DemoSite.Width - 5, DemoSite.Height - 5); break;
                case PickRole.DesignTerrain:
                    Log("Design terrain is not available in the standalone preview.");
                    break;
                case PickRole.Surfaces:
                    var src = _demo.Regions;
                    if (materialId == null)
                    {
                        _regions.Clear();
                        _regions.AddRange(src.Select(r => new MaterialRegion { Outline = r.Outline, MaterialId = r.MaterialId }));
                    }
                    else if (src.Count > 0)
                    {
                        // assign the next demo region to the chosen material
                        var r = src[_surfaceCursor++ % src.Count];
                        _regions.RemoveAll(x => ReferenceEquals(x.Outline, r.Outline));
                        _regions.Add(new MaterialRegion { Outline = r.Outline, MaterialId = materialId });
                    }
                    break;
            }
            return GetSummary(role);
        }

        public void Clear(PickRole role)
        {
            switch (role)
            {
                case PickRole.Terrain: _terrain.Clear(); break;
                case PickRole.Buildings: _buildings.Clear(); break;
                case PickRole.Walls: _walls.Clear(); break;
                case PickRole.BridgeCuts: _bridges.Clear(); break;
                case PickRole.Boundary: _boundary = null; break;
                case PickRole.Surfaces: _regions.Clear(); break;
            }
        }

        public PickSummary GetSummary(PickRole role)
        {
            switch (role)
            {
                case PickRole.Terrain:
                    return new PickSummary { Role = role, Count = _terrain.Count, Description = _terrain.Count == 0 ? "" : $"{_terrain.Count} mesh, {_terrain.Sum(t => t.TriangleCount) / 1000} k triangles" };
                case PickRole.Buildings:
                    return new PickSummary { Role = role, Count = _buildings.Count, Description = $"{_buildings.Count} footprints with heights" };
                case PickRole.Walls:
                    return new PickSummary { Role = role, Count = _walls.Count, Description = _walls.Count == 0 ? "" : $"{_walls.Count} kerb lines @ {_walls[0].Height * 100:0} cm" };
                case PickRole.BridgeCuts:
                    return new PickSummary { Role = role, Count = _bridges.Count, Description = $"{_bridges.Count} deck outline" };
                case PickRole.Boundary:
                    return new PickSummary { Role = role, Count = _boundary != null ? 1 : 0, Description = "Inset rectangle" };
                case PickRole.Surfaces:
                    return new PickSummary
                    {
                        Role = role, Count = _regions.Count, Description = $"{_regions.Count} regions",
                        Materials = _regions.GroupBy(r => r.MaterialId).ToDictionary(g => g.Key, g => g.Count())
                    };
                default:
                    return PickSummary.Empty(role);
            }
        }

        public Task<SiteModel> CollectSiteAsync()
        {
            var s = new SiteModel();
            s.Terrain.AddRange(_terrain);
            s.Buildings.AddRange(_buildings);
            s.Walls.AddRange(_walls);
            s.BridgeCuts.AddRange(_bridges);
            s.Regions.AddRange(_regions);
            s.Boundary = _boundary;
            return Task.FromResult(s);
        }

        public Task ShowAsync(ResultVisual visual)
        {
            VisualShown?.Invoke(visual);
            return Task.CompletedTask;
        }

        public Task ClearPreviewAsync()
        {
            VisualShown?.Invoke(null);
            return Task.CompletedTask;
        }

        public Task BakeAsync(ResultVisual visual)
        {
            Log($"Baked “{visual?.Title}” (simulated in the standalone preview).");
            return Task.CompletedTask;
        }

        public async Task<bool> CreateDemoSiteAsync(SiteModel demo)
        {
            await Task.Delay(150);
            demo ??= _demo;
            _terrain.Clear(); _terrain.AddRange(demo.Terrain);
            _buildings.Clear(); _buildings.AddRange(demo.Buildings);
            _walls.Clear(); _walls.AddRange(demo.Walls);
            _bridges.Clear(); _bridges.AddRange(demo.BridgeCuts);
            _regions.Clear(); _regions.AddRange(demo.Regions);
            _boundary = demo.Boundary;
            return true;
        }

        public void Log(string message)
        {
            System.Diagnostics.Debug.WriteLine(message);
            Logged?.Invoke(message);
        }
    }
}
