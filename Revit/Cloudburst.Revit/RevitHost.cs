using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Selection;
using Cloudburst.Geometry;
using Cloudburst.Hosting;
using Cloudburst.Materials;
using Cloudburst.Results;
using RevitCancel = Autodesk.Revit.Exceptions.OperationCanceledException;

namespace Cloudburst.Revit
{
    /// <summary>
    /// <see cref="ICloudburstHost"/> for Revit 2026. Every Revit API call runs through <see cref="RevitBridge"/> (ExternalEvent).
    /// Units: Revit internal feet ↔ Cloudburst metres (×0.3048), internal coordinates.
    /// TODO: optional shared-coordinates (survey point) transform for real-world sites.
    /// </summary>
    public sealed class RevitHost : ICloudburstHost, ICloudburstAutoSite
    {
        /// <summary>One remembered pick: a Revit element or an in-memory object (demo site).</summary>
        private sealed class Pick
        {
            public ElementId Id;
            public object Memory;          // TriangleMesh / BuildingInput / MaterialRegion / WallLine / Polygon2
            public string MaterialId;      // Surfaces; Buildings: roof material (null = default roof)
            public double WallHeight = 0.10;
            public string Kind;            // for summaries ("Floor", "Toposolid", ...)
        }

        private readonly RevitBridge _bridge;
        private readonly object _gate = new object();
        private readonly Dictionary<PickRole, List<Pick>> _picks = new Dictionary<PickRole, List<Pick>>();
        private readonly Dictionary<PickRole, PickSummary> _summaries = new Dictionary<PickRole, PickSummary>();
        private readonly List<(double X, double Y, double Z)> _probes = new List<(double, double, double)>();
        private readonly List<ElementId> _previewIds = new List<ElementId>();
        private string _previewDocKey;
        private MaterialPalette _palette;

        public RevitHost(RevitBridge bridge) { _bridge = bridge ?? throw new ArgumentNullException(nameof(bridge)); }

        public string HostName => "Revit 2026";

        /// <summary>Raised (on whatever thread logs) for every log line; the UI may subscribe via the concrete type.</summary>
        public event Action<string> Logged;

        /// <summary>Probe points picked with <see cref="PickRole.Probes"/> (metres).</summary>
        public IReadOnlyList<(double X, double Y, double Z)> Probes { get { lock (_gate) return _probes.ToList(); } }

        public MaterialPalette Palette
        {
            get
            {
                if (_palette == null) { try { _palette = MaterialPalette.LoadDefault(); } catch (Exception ex) { Log("Palette: " + ex.Message); } }
                return _palette;
            }
            set => _palette = value;
        }

        // =====================================================================================================  picking
        public Task<PickSummary> PickAsync(PickRole role, string materialId = null, double wallHeight = 0.10) =>
            _bridge.RunAsync(app => PickCore(app, role, materialId, wallHeight));

        private PickSummary PickCore(UIApplication app, PickRole role, string materialId, double wallHeight)
        {
            var uidoc = app.ActiveUIDocument;
            RevitUtil.Require(uidoc?.Document);
            var doc = uidoc.Document;
            if (role == PickRole.Probes) return PickProbes(uidoc);

            var filter = new RoleFilter(role);
            List<Element> elements;
            // preselection: use the current selection if it holds valid elements for this role
            var pre = uidoc.Selection.GetElementIds().Select(id => doc.GetElement(id)).Where(e => e != null && filter.AllowElement(e)).ToList();
            if (pre.Count > 0)
            {
                elements = pre;
                try { uidoc.Selection.SetElementIds(new List<ElementId>()); } catch { } // don't reuse it for the next role
            }
            else
            {
                try
                {
                    var refs = uidoc.Selection.PickObjects(ObjectType.Element, filter, Prompt(role, materialId));
                    elements = refs.Select(r => doc.GetElement(r)).Where(e => e != null).ToList();
                }
                catch (RevitCancel) { return GetSummary(role); }
                catch (OperationCanceledException) { return GetSummary(role); }
            }
            if (elements.Count == 0) return GetSummary(role);

            var picks = elements.Select(e => new Pick
            {
                Id = e.Id,
                Kind = KindOf(e),
                WallHeight = wallHeight,
                MaterialId = role == PickRole.Surfaces ? (materialId ?? GuessMaterial(e)) : null
            }).ToList();

            lock (_gate)
            {
                if (role == PickRole.Surfaces)
                {
                    // surfaces accumulate; re-picking an element replaces its material
                    var list = Get(role);
                    var ids = new HashSet<ElementId>(picks.Select(p => p.Id));
                    list.RemoveAll(p => p.Id != null && ids.Contains(p.Id));
                    list.AddRange(picks);
                }
                else _picks[role] = picks;
                _summaries[role] = Summarize(role);
            }
            Log($"{role}: {GetSummary(role).Description}");
            return GetSummary(role);
        }

        private PickSummary PickProbes(UIDocument uidoc)
        {
            var doc = uidoc.Document;
            EnsureWorkPlane(uidoc);
            var pts = new List<(double, double, double)>();
            while (true)
            {
                try
                {
                    var p = uidoc.Selection.PickPoint(ObjectSnapTypes.Endpoints | ObjectSnapTypes.Intersections | ObjectSnapTypes.Nearest,
                        $"Cloudburst: click probe point {pts.Count + 1} (Esc to finish)");
                    pts.Add((p.X * GeometryReader.FtToM, p.Y * GeometryReader.FtToM, p.Z * GeometryReader.FtToM));
                }
                catch (RevitCancel) { break; }
                catch (OperationCanceledException) { break; }
                catch (Autodesk.Revit.Exceptions.InvalidOperationException ex)
                {
                    throw new InvalidOperationException("Probe points need a work plane: open a plan view and try again. (" + ex.Message + ")");
                }
            }
            lock (_gate)
            {
                if (pts.Count > 0) { _probes.Clear(); _probes.AddRange(pts); }
                _summaries[PickRole.Probes] = _probes.Count == 0 ? PickSummary.Empty(PickRole.Probes)
                    : new PickSummary { Role = PickRole.Probes, Count = _probes.Count, Description = $"{_probes.Count} probe point{(_probes.Count == 1 ? "" : "s")}" };
            }
            return GetSummary(PickRole.Probes);
        }

        /// <summary>PickPoint needs an active work plane; 3D/section views often have none. Set one at the lowest level.</summary>
        private static void EnsureWorkPlane(UIDocument uidoc)
        {
            var view = uidoc.ActiveView;
            try
            {
                if (view == null || view is ViewPlan || view.SketchPlane != null) return;
                var doc = uidoc.Document;
                var level = new FilteredElementCollector(doc).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => Math.Abs(l.Elevation)).FirstOrDefault();
                using (var t = new Transaction(doc, "Cloudburst work plane"))
                {
                    RevitUtil.QuietFailures(t);
                    t.Start();
                    var plane = Plane.CreateByNormalAndOrigin(XYZ.BasisZ, new XYZ(0, 0, level?.Elevation ?? 0));
                    view.SketchPlane = SketchPlane.Create(doc, plane);
                    t.Commit();
                }
            }
            catch (Exception ex) { Logger.Write("EnsureWorkPlane: " + ex.Message); }
        }

        private static string Prompt(PickRole role, string materialId)
        {
            switch (role)
            {
                case PickRole.Terrain: return "Cloudburst: select terrain (Toposolid, topography, floors, imported mesh) – Finish when done";
                case PickRole.DesignTerrain: return "Cloudburst: select design terrain – Finish when done";
                case PickRole.Buildings: return "Cloudburst: select buildings (walls, roofs, masses, families) – Finish when done";
                case PickRole.Surfaces: return $"Cloudburst: select surfaces (floors, toposolid sub-divisions, roofs){(materialId != null ? " as " + materialId : "")} – Finish when done";
                case PickRole.Walls: return "Cloudburst: select kerbs/low walls (model lines or walls) – Finish when done";
                case PickRole.BridgeCuts: return "Cloudburst: select bridge deck outlines (closed model lines or floors) – Finish when done";
                case PickRole.Boundary: return "Cloudburst: select the analysis boundary (closed model lines or a floor) – Finish when done";
                default: return "Cloudburst: select elements";
            }
        }

        private static string KindOf(Element e)
        {
            try
            {
                switch (e)
                {
                    case Toposolid _: return "Toposolid";
                    case Floor _: return "Floor";
                    case Wall _: return "Wall";
                    case RoofBase _: return "Roof";
                    case DirectShape _: return "DirectShape";
                    case ImportInstance _: return "Import";
                    case CurveElement _: return "Line";
                    case FamilyInstance _: return e.Category?.Name ?? "Family";
                }
                return e.Category?.Name ?? e.GetType().Name;
            }
            catch { return "Element"; }
        }

        /// <summary>Top face material → type name → element name → category, matched against the palette; else the default
        /// (or null with <paramref name="orDefault"/> = false, and then the category is not used either).</summary>
        private string GuessMaterial(Element e, bool orDefault = true)
        {
            var pal = Palette;
            if (pal == null) return null;
            var candidates = new List<string>();
            try { candidates.Add(GeometryReader.TopFaceMaterialName(e)); } catch { }
            try { candidates.Add(e.Document.GetElement(e.GetTypeId())?.Name); } catch { }
            try { candidates.Add(e.Name); } catch { }
            if (orDefault) { try { candidates.Add(e.Category?.Name); } catch { } }
            foreach (var c in candidates.Where(c => !string.IsNullOrWhiteSpace(c)))
            {
                var m = pal.Guess(c);
                if (m != null) return m.Id;
            }
            return orDefault ? pal.Default?.Id : null;
        }

        private List<Pick> Get(PickRole role)
        {
            if (!_picks.TryGetValue(role, out var l)) _picks[role] = l = new List<Pick>();
            return l;
        }

        private PickSummary Summarize(PickRole role)
        {
            var list = Get(role);
            if (list.Count == 0) return PickSummary.Empty(role);
            var s = new PickSummary { Role = role, Count = list.Count };
            var kinds = list.GroupBy(p => p.Kind ?? "Element").Select(g => $"{g.Count()} {Plural(g.Key, g.Count())}");
            s.Description = string.Join(", ", kinds);
            if (role == PickRole.Surfaces)
            {
                foreach (var g in list.GroupBy(p => p.MaterialId ?? "default")) s.Materials[g.Key] = g.Count();
                s.Description += " · " + string.Join(", ", s.Materials.Select(kv => $"{MaterialName(kv.Key)} ×{kv.Value}"));
            }
            if (role == PickRole.Walls)
            {
                var h = list.Select(p => p.Memory is WallLine wl ? wl.Height : p.WallHeight).Distinct().ToList();
                if (h.Count == 1) s.Description += $" · h = {h[0]:0.00} m";
            }
            return s;
        }

        private string MaterialName(string id) { try { return Palette?.Get(id)?.Name ?? id; } catch { return id; } }

        private static string Plural(string k, int n) => n == 1 || k.EndsWith("s") ? k : k + "s";

        public void Clear(PickRole role)
        {
            lock (_gate)
            {
                if (role == PickRole.Probes) _probes.Clear();
                _picks.Remove(role);
                _summaries[role] = PickSummary.Empty(role);
            }
        }

        public PickSummary GetSummary(PickRole role)
        {
            lock (_gate) return _summaries.TryGetValue(role, out var s) ? s : PickSummary.Empty(role);
        }

        // =====================================================================================================  auto-detect
        public string AutoSiteLabel => "Use the Revit model";

        public string AutoSiteHint => "Toposolids become the terrain, roofs, floors and walls the buildings. Surface materials are read from the Revit materials of the toposolids, their sub-divisions and the roofs.";

        public Task<string> DetectSiteAsync() => _bridge.RunAsync(DetectCore);

        /// <summary>
        /// Reads the site from the element categories instead of asking the user to pick every role:
        /// terrain = toposolids (not sub-divisions) and legacy topography; buildings = roofs, floors and walls;
        /// surfaces = toposolids and their sub-divisions with the material of their top face.
        /// Uses what is visible in the active 3D or plan view (so phases, design options, hidden elements and section
        /// boxes are respected), otherwise the whole model.
        /// </summary>
        private string DetectCore(UIApplication app)
        {
            var uidoc = app.ActiveUIDocument;
            RevitUtil.Require(uidoc?.Document);
            var doc = uidoc.Document;
            var view = uidoc.ActiveView;
            bool byView = view != null && !view.IsTemplate && (view is View3D || view is ViewPlan);

            List<Element> Of(BuiltInCategory cat)
            {
                try
                {
                    var c = byView ? new FilteredElementCollector(doc, view.Id) : new FilteredElementCollector(doc);
                    return c.OfCategory(cat).WhereElementIsNotElementType().ToElements()
                        .Where(e => e != null && !RevitUtil.IsCloudburstShape(e, RevitUtil.DataPreview) && !RevitUtil.IsCloudburstShape(e, RevitUtil.DataBake)).ToList();
                }
                catch (Exception ex) { Logger.Write($"Detect {cat}: {ex.Message}"); return new List<Element>(); }
            }
            bool IsSubdivision(Element e)
            {
                try { return e is Toposolid t && t.HostTopoId != null && t.HostTopoId != ElementId.InvalidElementId; } catch { return false; }
            }

            var topo = Of(BuiltInCategory.OST_Toposolid);
            var terrain = topo.Where(e => !IsSubdivision(e)).ToList();
            terrain.AddRange(Of(BuiltInCategory.OST_Topography));
            var subdivisions = topo.Where(IsSubdivision).ToList();
            var roofs = Of(BuiltInCategory.OST_Roofs);
            var floors = Of(BuiltInCategory.OST_Floors);
            var walls = Of(BuiltInCategory.OST_Walls).Where(e => e is Wall).ToList();

            if (terrain.Count == 0)
            {
                Log(byView ? $"No toposolid or topography is visible in the view “{view.Name}”." : "The model has no toposolid or topography.");
                return null;
            }

            var buildings = new List<Pick>();
            buildings.AddRange(roofs.Select(e => new Pick { Id = e.Id, Kind = "Roof", MaterialId = GuessMaterial(e, false) }));
            buildings.AddRange(floors.Select(e => new Pick { Id = e.Id, Kind = "Floor", MaterialId = GuessMaterial(e, false) }));
            buildings.AddRange(walls.Select(e => new Pick { Id = e.Id, Kind = "Wall" }));

            // base terrain first, sub-divisions after it so they win where they cover
            var surfaces = new List<Pick>();
            surfaces.AddRange(terrain.Select(e => new Pick { Id = e.Id, Kind = KindOf(e), MaterialId = GuessMaterial(e) }));
            surfaces.AddRange(subdivisions.Select(e => new Pick { Id = e.Id, Kind = "Sub-division", MaterialId = GuessMaterial(e) }));

            lock (_gate)
            {
                _picks[PickRole.Terrain] = terrain.Select(e => new Pick { Id = e.Id, Kind = KindOf(e) }).ToList();
                _picks[PickRole.Buildings] = buildings;
                _picks[PickRole.Surfaces] = surfaces;
                foreach (var role in new[] { PickRole.Terrain, PickRole.Buildings, PickRole.Surfaces })
                    _summaries[role] = Summarize(role);
            }

            string scope = byView ? $"view “{view.Name}”" : "whole model";
            string found = $"{terrain.Count} terrain, {roofs.Count} roofs, {floors.Count} floors, {walls.Count} walls, {subdivisions.Count} sub-divisions ({scope})";
            Log("Site read from the Revit model: " + found + ".");
            return found;
        }

        // =====================================================================================================  collect
        public Task<SiteModel> CollectSiteAsync() => _bridge.RunAsync(CollectCore);

        private SiteModel CollectCore(UIApplication app)
        {
            Dictionary<PickRole, List<Pick>> snapshot;
            lock (_gate) snapshot = _picks.ToDictionary(kv => kv.Key, kv => kv.Value.ToList());
            var doc = app.ActiveUIDocument?.Document;
            var site = new SiteModel();
            int missing = 0;

            Element El(Pick p)
            {
                if (p.Id == null || doc == null) return null;
                var e = doc.GetElement(p.Id);
                if (e == null) missing++;
                return e;
            }
            List<Pick> Of(PickRole r) => snapshot.TryGetValue(r, out var l) ? l : new List<Pick>();

            foreach (var (role, target) in new[] { (PickRole.Terrain, site.Terrain), (PickRole.DesignTerrain, site.DesignTerrain) })
                foreach (var p in Of(role))
                {
                    if (p.Memory is TriangleMesh mm) { target.Add(mm); continue; }
                    var e = El(p); if (e == null) continue;
                    var mesh = GeometryReader.ReadMesh(e, 0.3, "Terrain");
                    if (mesh != null) target.Add(mesh); else Log($"No terrain geometry in {KindOf(e)} {e.Id}");
                }

            var wallElements = new List<Element>();
            foreach (var p in Of(PickRole.Buildings))
            {
                if (p.Memory is BuildingInput bi) { site.Buildings.Add(bi); continue; }
                var e = El(p); if (e == null) continue;
                if (e is Wall) { wallElements.Add(e); continue; } // all walls together: they only outline the buildings
                var mesh = GeometryReader.ReadMesh(e, 0.0);
                if (mesh != null) site.Buildings.Add(new BuildingInput { Geometry = mesh, Name = GeometryReader.SafeName(e) ?? KindOf(e), RoofMaterialId = p.MaterialId });
            }
            if (wallElements.Count > 0)
            {
                var mesh = GeometryReader.ReadMerged(wallElements, 0.0, "Walls");
                if (mesh != null) site.Buildings.Add(new BuildingInput { Geometry = mesh, Name = $"{wallElements.Count} walls" });
            }

            foreach (var p in Of(PickRole.Surfaces))
            {
                if (p.Memory is MaterialRegion mr) { site.Regions.Add(mr); continue; }
                var e = El(p); if (e == null) continue;
                var mesh = GeometryReader.ReadMesh(e, 0.3);
                if (mesh != null) site.Regions.Add(new MaterialRegion { Surface = mesh, MaterialId = p.MaterialId ?? Palette?.Default?.Id });
                else
                {
                    var outline = GeometryReader.TopOutline(e);
                    if (outline != null) site.Regions.Add(new MaterialRegion { Outline = outline, MaterialId = p.MaterialId ?? Palette?.Default?.Id });
                }
            }

            foreach (var p in Of(PickRole.Walls))
            {
                if (p.Memory is WallLine wl) { site.Walls.Add(wl); continue; }
                var e = El(p); if (e == null) continue;
                foreach (var line in CurvesOf(e))
                    site.Walls.Add(new WallLine { Line = line, Height = p.WallHeight });
            }

            site.BridgeCuts.AddRange(Polygons(Of(PickRole.BridgeCuts), El));
            var boundary = Polygons(Of(PickRole.Boundary), El).OrderByDescending(pg => pg.Area()).FirstOrDefault();
            site.Boundary = boundary;

            if (missing > 0) Log($"{missing} picked element(s) no longer exist in the active document and were skipped.");
            Log($"Collected site: {site.Terrain.Count} terrain, {site.Buildings.Count} buildings, {site.Regions.Count} surfaces, {site.Walls.Count} wall lines, {site.BridgeCuts.Count} bridge cuts{(site.Boundary != null ? ", boundary" : "")}.");
            return site;
        }

        private static IEnumerable<Polyline3> CurvesOf(Element e)
        {
            var result = new List<Polyline3>();
            try
            {
                Curve c = null;
                if (e is CurveElement ce) c = ce.GeometryCurve;
                else if (e.Location is LocationCurve lc) c = lc.Curve;
                var pl = c != null ? GeometryReader.CurveToPolyline(c) : null;
                if (pl != null) result.Add(pl);
            }
            catch (Exception ex) { Logger.Write("CurvesOf: " + ex.Message); }
            return result;
        }

        private static List<Polygon2> Polygons(List<Pick> picks, Func<Pick, Element> el)
        {
            var result = new List<Polygon2>();
            var loose = new List<Polyline3>();
            foreach (var p in picks)
            {
                if (p.Memory is Polygon2 pg) { result.Add(pg); continue; }
                var e = el(p); if (e == null) continue;
                if (e is CurveElement) loose.AddRange(CurvesOf(e));
                else { var o = GeometryReader.TopOutline(e); if (o != null) result.Add(o); }
            }
            if (loose.Count > 0) result.AddRange(GeometryReader.ChainLoops(loose));
            return result;
        }

        // =====================================================================================================  results
        public Task ShowAsync(ResultVisual visual) => _bridge.RunAsync(app => { ShowCore(app, visual, false); });

        public Task BakeAsync(ResultVisual visual) => _bridge.RunAsync(app => { ShowCore(app, visual, true); });

        public Task ClearPreviewAsync() => _bridge.RunAsync(ClearCore);

        private void ShowCore(UIApplication app, ResultVisual visual, bool bake)
        {
            var uidoc = app.ActiveUIDocument;
            RevitUtil.Require(uidoc?.Document);
            var doc = uidoc.Document;
            if (!DirectShape.IsSupportedDocument(doc)) throw new InvalidOperationException("This document does not support DirectShapes.");
            var sw = System.Diagnostics.Stopwatch.StartNew();
            using (var t = new Transaction(doc, bake ? "Cloudburst bake" : "Cloudburst preview"))
            {
                RevitUtil.QuietFailures(t);
                t.Start();
                try
                {
                    if (!bake) DeleteTrackedPreview(doc);
                    var ids = PreviewWriter.Write(doc, uidoc.ActiveView, visual, bake, Log);
                    var status = t.Commit();
                    if (status != TransactionStatus.Committed) throw new InvalidOperationException($"Revit rejected the {(bake ? "bake" : "preview")} transaction ({status}).");
                    if (!bake)
                        lock (_gate) { _previewIds.Clear(); _previewIds.AddRange(ids); _previewDocKey = DocKey(doc); }
                    Log($"{(bake ? "Baked" : "Preview")}: {ids.Count} element(s) in {sw.ElapsedMilliseconds} ms.");
                }
                catch
                {
                    if (t.HasStarted() && !t.HasEnded()) t.RollBack();
                    throw;
                }
            }
        }

        private void ClearCore(UIApplication app)
        {
            var doc = app.ActiveUIDocument?.Document;
            if (doc == null || doc.IsReadOnly || doc.IsFamilyDocument) return;
            using (var t = new Transaction(doc, "Cloudburst clear preview"))
            {
                RevitUtil.QuietFailures(t);
                t.Start();
                try
                {
                    int n = DeleteTrackedPreview(doc);
                    if (n == 0) { t.RollBack(); return; }
                    t.Commit();
                    Log($"Preview cleared ({n} element(s)).");
                }
                catch
                {
                    if (t.HasStarted() && !t.HasEnded()) t.RollBack();
                    throw;
                }
            }
        }

        /// <summary>Inside an open transaction.</summary>
        private int DeleteTrackedPreview(Document doc)
        {
            List<ElementId> tracked;
            lock (_gate)
            {
                tracked = _previewDocKey == DocKey(doc) ? _previewIds.ToList() : new List<ElementId>();
                if (_previewDocKey == DocKey(doc)) _previewIds.Clear();
            }
            return PreviewWriter.DeletePreview(doc, tracked);
        }

        private static string DocKey(Document doc)
        {
            try { return string.IsNullOrEmpty(doc.PathName) ? "unsaved:" + doc.Title : doc.PathName; } catch { return "?"; }
        }

        // =====================================================================================================  demo
        public Task<bool> CreateDemoSiteAsync(SiteModel demo) => _bridge.RunAsync(app => CreateDemoSiteCore(app, demo));

        /// <summary>Synchronous version for callers already in API context (ribbon command).</summary>
        public bool CreateDemoSiteCore(UIApplication app, SiteModel demo)
        {
            var uidoc = app.ActiveUIDocument;
            RevitUtil.Require(uidoc?.Document);
            var r = DemoBuilder.Build(uidoc, demo ?? Cloudburst.Demo.DemoSite.Create(), Palette, Log);
            var site = r.Site;
            lock (_gate)
            {
                _picks[PickRole.Terrain] = site.Terrain.Select(m => new Pick { Memory = m, Kind = r.ToposolidCreated ? "Demo terrain (Toposolid)" : "Demo terrain" }).ToList();
                _picks[PickRole.DesignTerrain] = site.DesignTerrain.Select(m => new Pick { Memory = m, Kind = "Demo design terrain" }).ToList();
                _picks[PickRole.Buildings] = site.Buildings.Select(b => new Pick { Memory = b, Kind = "Demo building" }).ToList();
                _picks[PickRole.Surfaces] = site.Regions.Select(g => new Pick { Memory = g, MaterialId = g.MaterialId, Kind = "Demo region" }).ToList();
                _picks[PickRole.Walls] = site.Walls.Select(w => new Pick { Memory = w, WallHeight = w.Height, Kind = "Demo kerb" }).ToList();
                _picks[PickRole.BridgeCuts] = site.BridgeCuts.Select(c => new Pick { Memory = c, Kind = "Demo bridge cut" }).ToList();
                _picks[PickRole.Boundary] = site.Boundary != null ? new List<Pick> { new Pick { Memory = site.Boundary, Kind = "Demo boundary" } } : new List<Pick>();
                foreach (var role in new[] { PickRole.Terrain, PickRole.DesignTerrain, PickRole.Buildings, PickRole.Surfaces, PickRole.Walls, PickRole.BridgeCuts, PickRole.Boundary })
                    _summaries[role] = Summarize(role);
                if (site.Terrain.Count > 0)
                    _summaries[PickRole.Terrain].Description += $" · {site.Terrain.Sum(m => m.TriangleCount) / 1000.0:0.#} k triangles";
            }
            Log($"Demo site created ({r.ElementCount} elements) and registered as the current picks.");
            return true;
        }

        // ===================================================================================================== log
        public void Log(string message)
        {
            Logger.Write(message);
            try { Logged?.Invoke(message); } catch { }
        }
    }
}
