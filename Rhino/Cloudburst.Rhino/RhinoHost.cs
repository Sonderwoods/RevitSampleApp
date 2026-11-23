using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using Cloudburst;
using Cloudburst.Demo;
using Cloudburst.Geometry;
using Cloudburst.Hosting;
using Cloudburst.Materials;
using Cloudburst.Results;
using CloudburstRhinoCommon;
using Rhino;
using Rhino.Commands;
using Rhino.DocObjects;
using Rhino.Geometry;
using Rhino.Input;
using Rhino.Input.Custom;

namespace CloudburstRhino
{
    /// <summary>
    /// Rhino 8 implementation of <see cref="ICloudburstHost"/>. Everything crossing the interface is metres (world XY, Z up);
    /// this class converts to and from the document's model units. All document access happens on Rhino's UI thread.
    /// No method throws: errors are logged to the command line and a safe fallback is returned.
    /// </summary>
    public sealed class RhinoHost : ICloudburstHost
    {
        public const string KeyRole = "cloudburst.role";
        public const string KeyMaterial = "cloudburst.material";
        public const string KeyHeight = "cloudburst.height";

        private readonly Dictionary<PickRole, List<Guid>> _picks = Enum.GetValues(typeof(PickRole)).Cast<PickRole>().ToDictionary(r => r, r => new List<Guid>());
        private readonly Dictionary<Guid, string> _material = new Dictionary<Guid, string>();
        private readonly Dictionary<Guid, double> _height = new Dictionary<Guid, double>();
        private readonly ResultConduit _conduit = new ResultConduit();

        public string HostName => "Rhino 8";

        /// <summary>Palette used for material guessing (the UI may replace it with the project palette).</summary>
        public MaterialPalette Palette { get; set; }

        /// <summary>Height (m) used for buildings given as closed footprint curves.</summary>
        public double DefaultBuildingHeight { get; set; } = 8.0;

        /// <summary>The visual currently previewed (null when none).</summary>
        public ResultVisual CurrentVisual { get; private set; }

        public RhinoHost()
        {
            try { Palette = MaterialPalette.LoadDefault(); } catch (Exception ex) { Log("palette could not be loaded: " + ex.Message); }
        }

        private static RhinoDoc Doc => RhinoDoc.ActiveDoc;
        private static double Scale(RhinoDoc doc) => RhinoConvert.UnitScale(doc);

        // ================================================================== threading helpers

        private Task<T> RunOnUi<T>(Func<T> work, Func<T> fallback, string what, bool forcePost = false)
        {
            if (!forcePost && !RhinoApp.InvokeRequired)
            {
                try { return Task.FromResult(work()); }
                catch (Exception ex) { Fail(what, ex); return Task.FromResult(SafeFallback(fallback)); }
            }
            var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
            try
            {
                RhinoApp.InvokeOnUiThread(new Action(() =>
                {
                    try { tcs.TrySetResult(work()); }
                    catch (Exception ex) { Fail(what, ex); tcs.TrySetResult(SafeFallback(fallback)); }
                }));
            }
            catch (Exception ex) { Fail(what, ex); tcs.TrySetResult(SafeFallback(fallback)); }
            return tcs.Task;
        }

        private static T SafeFallback<T>(Func<T> f) { try { return f != null ? f() : default; } catch { return default; } }

        private Task RunOnUi(Action work, string what) => RunOnUi(() => { work(); return true; }, () => false, what);

        private void Fail(string what, Exception ex) => Log($"{what} failed: {ex.Message}");

        public void Log(string message)
        {
            try
            {
                if (RhinoApp.InvokeRequired) RhinoApp.InvokeOnUiThread(new Action(() => RhinoApp.WriteLine("Cloudburst: " + message)));
                else RhinoApp.WriteLine("Cloudburst: " + message);
            }
            catch { }
        }

        // ================================================================== picking

        public Task<PickSummary> PickAsync(PickRole role, string materialId = null, double wallHeight = 0.10)
            // Posted to the UI thread so the WPF click handler returns before Rhino's nested get loop starts.
            => RunOnUi(() => PickCore(role, materialId, wallHeight), () => SummaryCore(role), "Pick " + role, forcePost: true);

        private PickSummary PickCore(PickRole role, string materialId, double wallHeight)
        {
            var doc = Doc;
            if (doc == null) return PickSummary.Empty(role);
            if (Command.InCommand())
            {
                Log("finish or cancel the running Rhino command first, then pick again.");
                return SummaryCore(role);
            }
            materialId = NormalizeMaterial(materialId);

            try { RhinoApp.SetFocusToMainWindow(doc); } catch { }

            var go = new GetObject();
            go.SetCommandPrompt(Prompt(role, materialId, wallHeight));
            go.GroupSelect = true;
            go.SubObjectSelect = false;
            go.EnablePreSelect(true, true);
            go.DeselectAllBeforePostSelect = false;
            go.AcceptNothing(true);
            ConfigureFilter(go, role);

            var res = role == PickRole.Boundary ? go.Get() : go.GetMultiple(1, 0);
            if (res != GetResult.Object || go.ObjectCount == 0)
            {
                doc.Objects.UnselectAll();
                doc.Views.Redraw();
                return SummaryCore(role);
            }

            var ids = new List<Guid>();
            for (int i = 0; i < go.ObjectCount; i++)
            {
                var id = go.Object(i).ObjectId;
                if (id != Guid.Empty && !ids.Contains(id)) ids.Add(id);
            }

            var list = _picks[role];
            if (role != PickRole.Surfaces)
            {
                foreach (var old in list) RemoveRoleTag(doc, old, role);
                list.Clear();
            }
            uint undo = 0;
            try { undo = doc.BeginUndoRecord("Cloudburst pick " + role); } catch { }
            try
            {
                foreach (var id in ids)
                {
                    if (!list.Contains(id)) list.Add(id);
                    var obj = doc.Objects.FindId(id);
                    if (obj == null) continue;
                    string mat = null; double? h = null;
                    if (role == PickRole.Surfaces) { mat = materialId ?? GuessMaterial(doc, obj); _material[id] = mat; }
                    if (role == PickRole.Walls) { h = wallHeight; _height[id] = wallHeight; }
                    TagObject(doc, obj, role, mat, h);
                }
            }
            finally { if (undo != 0) try { doc.EndUndoRecord(undo); } catch { } }

            doc.Objects.UnselectAll();
            doc.Views.Redraw();
            var s = SummaryCore(role);
            Log($"{role}: {s.Description}");
            return s;
        }

        private string Prompt(PickRole role, string materialId, double wallHeight)
        {
            switch (role)
            {
                case PickRole.Terrain: return "Select terrain meshes or surfaces";
                case PickRole.DesignTerrain: return "Select design terrain meshes or surfaces";
                case PickRole.Buildings: return "Select buildings (closed polysurfaces, extrusions, meshes or closed footprint curves)";
                case PickRole.Surfaces:
                    var m = materialId != null ? Palette?.Get(materialId) : null;
                    return m != null ? $"Select {m.Name} areas (closed curves, hatches, surfaces or meshes)"
                                     : "Select surface areas (closed curves, hatches, surfaces or meshes) - material is guessed from layer and name";
                case PickRole.Walls: return wallHeight >= 0 ? $"Select kerb / wall curves ({wallHeight * 100:0} cm high)" : $"Select channel curves ({-wallHeight * 100:0} cm deep)";
                case PickRole.BridgeCuts: return "Select bridge deck outlines (closed curves)";
                case PickRole.Boundary: return "Select the analysis boundary (closed curve)";
                case PickRole.Probes: return "Select probe points";
                default: return "Select objects";
            }
        }

        private static void ConfigureFilter(GetObject go, PickRole role)
        {
            const ObjectType solids = ObjectType.Mesh | ObjectType.Brep | ObjectType.Surface | ObjectType.PolysrfFilter | ObjectType.Extrusion | ObjectType.SubD;
            switch (role)
            {
                case PickRole.Terrain:
                case PickRole.DesignTerrain:
                    go.GeometryFilter = solids; break;
                case PickRole.Buildings:
                    go.GeometryFilter = solids | ObjectType.Curve;
                    go.SetCustomGeometryFilter((o, g, ci) => !(g is Curve c) || c.IsClosed);
                    break;
                case PickRole.Surfaces:
                    go.GeometryFilter = solids | ObjectType.Curve | ObjectType.Hatch;
                    go.SetCustomGeometryFilter((o, g, ci) => !(g is Curve c) || c.IsClosed);
                    break;
                case PickRole.Walls:
                    go.GeometryFilter = ObjectType.Curve; break;
                case PickRole.BridgeCuts:
                case PickRole.Boundary:
                    go.GeometryFilter = ObjectType.Curve;
                    go.SetCustomGeometryFilter((o, g, ci) => g is Curve c && c.IsClosed);
                    break;
                case PickRole.Probes:
                    go.GeometryFilter = ObjectType.Point; break;
            }
        }

        public void Clear(PickRole role)
        {
            try
            {
                var doc = Doc;
                foreach (var id in _picks[role].ToList())
                {
                    if (doc != null && !RhinoApp.InvokeRequired) RemoveRoleTag(doc, id, role);
                    if (role == PickRole.Surfaces) _material.Remove(id);
                    if (role == PickRole.Walls) _height.Remove(id);
                }
                _picks[role].Clear();
            }
            catch (Exception ex) { Fail("Clear " + role, ex); }
        }

        /// <summary>Forget everything (document closed / new document).</summary>
        public void ResetAll()
        {
            foreach (var l in _picks.Values) l.Clear();
            _material.Clear(); _height.Clear();
            try { _conduit.Enabled = false; _conduit.Clear(); } catch { }
            CurrentVisual = null;
        }

        public PickSummary GetSummary(PickRole role)
        {
            try { return SummaryCore(role); }
            catch (Exception ex) { Fail("Summary", ex); return PickSummary.Empty(role); }
        }

        private PickSummary SummaryCore(PickRole role)
        {
            var doc = Doc;
            var objs = LiveObjects(doc, role);
            if (objs.Count == 0) return PickSummary.Empty(role);
            var s = new PickSummary { Role = role, Count = objs.Count };
            var kinds = new Dictionary<string, int>();
            long faces = 0;
            foreach (var o in objs)
            {
                string k = KindName(o.Geometry);
                kinds[k] = kinds.TryGetValue(k, out var n) ? n + 1 : 1;
                if (o.Geometry is Mesh m) faces += m.Faces.Count;
                if (role == PickRole.Surfaces)
                {
                    var mat = _material.TryGetValue(o.Id, out var mm) && mm != null ? mm : GuessMaterial(doc, o);
                    s.Materials[mat] = s.Materials.TryGetValue(mat, out var c) ? c + 1 : 1;
                }
            }
            var parts = kinds.OrderByDescending(kv => kv.Value).Select(kv => $"{kv.Value} {Plural(kv.Key, kv.Value)}").ToList();
            if (faces > 0) parts.Add(faces >= 10000 ? $"{faces / 1000:0} k faces" : $"{faces} faces");
            if (role == PickRole.Surfaces && s.Materials.Count > 0) parts.Add($"{s.Materials.Count} material{(s.Materials.Count == 1 ? "" : "s")}");
            if (role == PickRole.Walls)
            {
                var hs = objs.Select(o => _height.TryGetValue(o.Id, out var h) ? h : 0.10).Distinct().ToList();
                parts.Add(hs.Count == 1 ? $"{hs[0] * 100:0} cm" : "mixed heights");
            }
            s.Description = string.Join(", ", parts);
            return s;
        }

        private static string KindName(GeometryBase g)
        {
            switch (g)
            {
                case Mesh _: return "mesh";
                case Extrusion _: return "extrusion";
                case Brep b: return b.Faces.Count == 1 ? "surface" : "polysurface";
                case Surface _: return "surface";
                case SubD _: return "SubD";
                case Hatch _: return "hatch";
                case Curve _: return "curve";
                case Rhino.Geometry.Point _: return "point";
                default: return "object";
            }
        }

        private static string Plural(string k, int n) => n == 1 ? k : k == "mesh" ? "meshes" : k == "SubD" ? "SubDs" : k == "hatch" ? "hatches" : k + "s";

        private List<RhinoObject> LiveObjects(RhinoDoc doc, PickRole role)
        {
            var result = new List<RhinoObject>();
            if (doc == null) return result;
            var list = _picks[role];
            for (int i = list.Count - 1; i >= 0; i--)
            {
                var o = doc.Objects.FindId(list[i]);
                if (o == null || o.IsDeleted) { list.RemoveAt(i); continue; }
                result.Insert(0, o);
            }
            return result;
        }

        // ------------------------------------------------------------------ materials & persistence

        private string NormalizeMaterial(string materialId)
        {
            if (string.IsNullOrWhiteSpace(materialId) || Palette == null) return string.IsNullOrWhiteSpace(materialId) ? null : materialId;
            int i = Palette.IndexOf(materialId);
            if (i >= 0) return Palette.Materials[i].Id;
            return Palette.Guess(materialId)?.Id ?? materialId;
        }

        /// <summary>User text → object name → layer path → render material → palette default.</summary>
        public string GuessMaterial(RhinoDoc doc, RhinoObject o)
        {
            var pal = Palette;
            if (pal == null) return "unknown";
            var candidates = new List<string>();
            try { candidates.Add(o.Attributes.GetUserString(KeyMaterial)); } catch { }
            try { candidates.Add(o.Attributes.Name); } catch { }
            try { var li = o.Attributes.LayerIndex; if (doc != null && li >= 0 && li < doc.Layers.Count) candidates.Add(doc.Layers[li].FullPath); } catch { }
            try { candidates.Add(o.RenderMaterial?.Name); } catch { }
            foreach (var c in candidates)
            {
                if (string.IsNullOrWhiteSpace(c)) continue;
                int i = pal.IndexOf(c.Trim());
                if (i >= 0) return pal.Materials[i].Id;
                var g = pal.Guess(c);
                if (g != null) return g.Id;
            }
            return pal.Default?.Id ?? pal.DefaultMaterialId;
        }

        private static void TagObject(RhinoDoc doc, RhinoObject obj, PickRole role, string material, double? height)
        {
            try
            {
                var attr = obj.Attributes.Duplicate();
                var roles = ParseRoles(attr.GetUserString(KeyRole));
                roles.Add(role);
                attr.SetUserString(KeyRole, string.Join(",", roles.Select(r => r.ToString())));
                if (material != null) attr.SetUserString(KeyMaterial, material);
                if (height.HasValue) attr.SetUserString(KeyHeight, height.Value.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
                doc.Objects.ModifyAttributes(obj, attr, true);
            }
            catch { /* locked/reference objects: keep the in-memory pick */ }
        }

        private static void RemoveRoleTag(RhinoDoc doc, Guid id, PickRole role)
        {
            try
            {
                var obj = doc.Objects.FindId(id);
                if (obj == null) return;
                var attr = obj.Attributes.Duplicate();
                var roles = ParseRoles(attr.GetUserString(KeyRole));
                if (!roles.Remove(role)) return;
                attr.SetUserString(KeyRole, roles.Count == 0 ? null : string.Join(",", roles.Select(r => r.ToString())));
                doc.Objects.ModifyAttributes(obj, attr, true);
            }
            catch { }
        }

        private static HashSet<PickRole> ParseRoles(string s)
        {
            var set = new HashSet<PickRole>();
            if (string.IsNullOrWhiteSpace(s)) return set;
            foreach (var p in s.Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries))
                if (Enum.TryParse<PickRole>(p.Trim(), true, out var r)) set.Add(r);
            return set;
        }

        /// <summary>Re-register picks stored as user text when a saved document is opened.</summary>
        public void RestoreFromDocument(RhinoDoc doc)
        {
            try
            {
                if (doc == null) return;
                int n = 0;
                foreach (var o in doc.Objects)
                {
                    string r = null;
                    try { r = o.Attributes.GetUserString(KeyRole); } catch { }
                    if (string.IsNullOrEmpty(r)) continue;
                    foreach (var role in ParseRoles(r))
                    {
                        if (!_picks[role].Contains(o.Id)) _picks[role].Add(o.Id);
                        if (role == PickRole.Surfaces) _material[o.Id] = o.Attributes.GetUserString(KeyMaterial) is string m && m.Length > 0 ? m : null;
                        if (role == PickRole.Walls && double.TryParse(o.Attributes.GetUserString(KeyHeight), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var h)) _height[o.Id] = h;
                    }
                    n++;
                }
                if (n > 0) Log($"restored {n} picked objects from the document.");
            }
            catch (Exception ex) { Fail("Restore picks", ex); }
        }

        // ================================================================== collect

        public Task<SiteModel> CollectSiteAsync() => RunOnUi(CollectCore, () => new SiteModel(), "Collect site");

        private SiteModel CollectCore()
        {
            var site = new SiteModel();
            var doc = Doc;
            if (doc == null) return site;
            double s = Scale(doc);
            int failed = 0;

            void Each(PickRole role, Action<RhinoObject> f)
            {
                foreach (var o in LiveObjects(doc, role))
                {
                    try { f(o); }
                    catch (Exception ex) { failed++; Log($"skipped {role} object {o.Id}: {ex.Message}"); }
                }
            }

            // terrain
            foreach (var role in new[] { PickRole.Terrain, PickRole.DesignTerrain })
                Each(role, o =>
                {
                    var mp = RhinoConvert.TerrainMeshing(o.Geometry.GetBoundingBox(true), s);
                    var tm = RhinoConvert.ToTriangleMesh(o.Geometry, s, LayerName(doc, o), mp);
                    if (tm == null) { Log($"{role}: could not mesh {o.ObjectType} {o.Id}"); return; }
                    (role == PickRole.Terrain ? site.Terrain : site.DesignTerrain).Add(tm);
                });

            // buildings
            Each(PickRole.Buildings, o =>
            {
                string name = string.IsNullOrEmpty(o.Attributes.Name) ? LayerName(doc, o) : o.Attributes.Name;
                if (o.Geometry is Curve c)
                {
                    var fp = RhinoConvert.ToPolygon(c, s);
                    if (fp == null) return;
                    double h = DefaultBuildingHeight;
                    if (double.TryParse(o.Attributes.GetUserString(KeyHeight), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var uh) && uh > 0) h = uh;
                    site.Buildings.Add(new BuildingInput { Footprint = fp, HeightAboveTerrain = h, Name = name });
                }
                else
                {
                    var tm = RhinoConvert.ToTriangleMesh(o.Geometry, s, name, MeshingParameters.FastRenderMesh);
                    if (tm != null) site.Buildings.Add(new BuildingInput { Geometry = tm, Name = name });
                }
            });

            // material regions
            Each(PickRole.Surfaces, o =>
            {
                string mat = _material.TryGetValue(o.Id, out var m) && m != null ? m : GuessMaterial(doc, o);
                switch (o.Geometry)
                {
                    case Curve c:
                        var poly = RhinoConvert.ToPolygon(c, s);
                        if (poly != null) site.Regions.Add(new MaterialRegion { Outline = poly, MaterialId = mat });
                        break;
                    case Hatch h:
                        foreach (var hc in RhinoConvert.HatchOutlines(h))
                        {
                            var hp = RhinoConvert.ToPolygon(hc, s);
                            if (hp != null) site.Regions.Add(new MaterialRegion { Outline = hp, MaterialId = mat });
                        }
                        break;
                    default:
                        var tm = RhinoConvert.ToTriangleMesh(o.Geometry, s, mat, MeshingParameters.FastRenderMesh);
                        if (tm != null) site.Regions.Add(new MaterialRegion { Surface = tm, MaterialId = mat });
                        break;
                }
            });

            // walls / kerbs / channels
            Each(PickRole.Walls, o =>
            {
                if (!(o.Geometry is Curve c)) return;
                var pl = RhinoConvert.ToPolyline3(c, s);
                if (pl == null) return;
                double h = _height.TryGetValue(o.Id, out var hh) ? hh : 0.10;
                site.Walls.Add(new WallLine { Line = pl, Height = h });
            });

            Each(PickRole.BridgeCuts, o =>
            {
                var p = RhinoConvert.ToPolygon(o.Geometry as Curve, s);
                if (p != null) site.BridgeCuts.Add(p);
            });

            Polygon2 best = null;
            Each(PickRole.Boundary, o =>
            {
                var p = RhinoConvert.ToPolygon(o.Geometry as Curve, s);
                if (p != null && (best == null || p.Area() > best.Area())) best = p;
            });
            site.Boundary = best;

            Log($"collected {site.Terrain.Count + site.DesignTerrain.Count} terrain, {site.Buildings.Count} buildings, {site.Regions.Count} regions, {site.Walls.Count} walls" + (failed > 0 ? $" ({failed} skipped)" : "") + ".");
            return site;
        }

        private static string LayerName(RhinoDoc doc, RhinoObject o)
        {
            try { var li = o.Attributes.LayerIndex; return li >= 0 && li < doc.Layers.Count ? doc.Layers[li].FullPath : null; } catch { return null; }
        }

        /// <summary>Probe points in metres (world XY, Z up). Not part of <see cref="SiteModel"/>.</summary>
        public List<Point3> GetProbePoints()
        {
            var pts = new List<Point3>();
            try
            {
                var doc = Doc;
                double s = Scale(doc);
                foreach (var o in LiveObjects(doc, PickRole.Probes))
                    if (o.Geometry is Rhino.Geometry.Point p) pts.Add(new Point3(p.Location.X * s, p.Location.Y * s, p.Location.Z * s));
            }
            catch (Exception ex) { Fail("Probe points", ex); }
            return pts;
        }

        public IReadOnlyList<Point3> ProbePoints => GetProbePoints();

        // ================================================================== preview

        public Task ShowAsync(ResultVisual visual) => RunOnUi(() =>
        {
            var doc = Doc;
            if (doc == null) return;
            if (visual == null) { HidePreview(doc); return; }
            _conduit.SetVisual(visual, Scale(doc));
            _conduit.Enabled = true;
            CurrentVisual = visual;
            doc.Views.Redraw();
        }, "Show result");

        public Task ClearPreviewAsync() => RunOnUi(() => HidePreview(Doc), "Clear preview");

        private void HidePreview(RhinoDoc doc)
        {
            _conduit.Enabled = false;
            _conduit.Clear();
            CurrentVisual = null;
            doc?.Views.Redraw();
        }

        // ================================================================== bake

        public Task BakeAsync(ResultVisual visual) => RunOnUi(() => BakeCore(visual ?? CurrentVisual), "Bake");

        private void BakeCore(ResultVisual visual)
        {
            var doc = Doc;
            if (doc == null || visual == null) { Log("nothing to bake."); return; }
            double s = Scale(doc);
            uint undo = doc.BeginUndoRecord("Cloudburst bake");
            try
            {
                string title = SafeLayerName(visual.Title ?? visual.Layer.ToString());
                string basePath = "Cloudburst::" + UniqueChild(doc, "Cloudburst", title);
                int baseLayer = LayerUtil.Ensure(doc, basePath, Color.FromArgb(0x1F, 0x78, 0xC8));
                int n = 0;

                var mesh = RhinoConvert.ToRhinoMesh(visual.Mesh, s);
                if (mesh != null)
                {
                    var a = new ObjectAttributes { LayerIndex = baseLayer, Name = visual.Title };
                    if (!string.IsNullOrEmpty(visual.Caption)) a.SetUserString("cloudburst.caption", visual.Caption);
                    if (doc.Objects.AddMesh(mesh, a) != Guid.Empty) n++;
                }

                if (visual.FlowPaths != null && visual.FlowPaths.Count > 0)
                {
                    int fl = LayerUtil.Ensure(doc, basePath + "::Flow paths", RhinoConvert.FlowBlue);
                    foreach (var fp in visual.FlowPaths)
                    {
                        if (fp == null || fp.Count < 2) continue;
                        var pl = RhinoConvert.ToPolyline(fp, s, 0.15);
                        double w = fp.Weight != null && fp.Weight.Length > 0 ? fp.Weight.Max() : 0;
                        var a = new ObjectAttributes { LayerIndex = fl, PlotWeightSource = ObjectPlotWeightSource.PlotWeightFromObject, PlotWeight = 0.13 + 0.12 * (RhinoConvert.FlowThickness(w) - 1) };
                        a.SetUserString("cloudburst.upstream_m3", w.ToString("0.#", System.Globalization.CultureInfo.InvariantCulture));
                        if (doc.Objects.AddPolyline(pl, a) != Guid.Empty) n++;
                    }
                }

                if (visual.Labels != null && visual.Labels.Count > 0)
                {
                    int ll = LayerUtil.Ensure(doc, basePath + "::Labels", Color.FromArgb(0x08, 0x30, 0x6B));
                    foreach (var l in visual.Labels)
                    {
                        var dot = new TextDot(l.Text, new Point3d(l.X / s, l.Y / s, l.Z / s)) { FontHeight = 12 };
                        if (doc.Objects.AddTextDot(dot, new ObjectAttributes { LayerIndex = ll }) != Guid.Empty) n++;
                    }
                }

                n += BakeLegend(doc, visual, basePath, s);
                doc.Views.Redraw();
                Log($"baked {n} objects to layer {basePath}.");
            }
            finally { doc.EndUndoRecord(undo); }
        }

        /// <summary>Legend as coloured chips + text next to the result, so a baked result reads on its own.</summary>
        private static int BakeLegend(RhinoDoc doc, ResultVisual v, string basePath, double s)
        {
            if (v.Legend == null || v.Legend.Count == 0 || v.Mesh == null || v.Mesh.VertexCount == 0) return 0;
            try
            {
                double maxX = double.MinValue, maxY = double.MinValue, minY = double.MaxValue, maxZ = double.MinValue, minX = double.MaxValue;
                for (int i = 0; i < v.Mesh.VertexCount; i++)
                {
                    maxX = Math.Max(maxX, v.Mesh.Vertices[3 * i]); minX = Math.Min(minX, v.Mesh.Vertices[3 * i]);
                    maxY = Math.Max(maxY, v.Mesh.Vertices[3 * i + 1]); minY = Math.Min(minY, v.Mesh.Vertices[3 * i + 1]);
                    maxZ = Math.Max(maxZ, v.Mesh.Vertices[3 * i + 2]);
                }
                double size = Math.Max(1.0, Math.Max(maxX - minX, maxY - minY) * 0.03); // chip size, m
                double x0 = maxX + size * 2, y = maxY, z = maxZ;
                int layer = LayerUtil.Ensure(doc, basePath + "::Legend", Color.FromArgb(40, 40, 40));
                var attr = new ObjectAttributes { LayerIndex = layer };
                int n = 0;
                var plane = Plane.WorldXY;

                Guid AddText(string text, double x, double yy, double h)
                {
                    plane.Origin = new Point3d(x / s, yy / s, z / s);
                    var te = TextEntity.Create(text, plane, doc.DimStyles.Current, false, 0, 0);
                    if (te == null) return Guid.Empty;
                    te.TextHeight = h / s;
                    return doc.Objects.AddText(te, attr);
                }

                if (AddText(v.Title ?? "Result", x0, y, size * 0.9) != Guid.Empty) n++;
                y -= size * 1.8;
                foreach (var item in v.Legend)
                {
                    if (((uint)item.Argb >> 24) == 0) { y -= size * 1.4; continue; }
                    var chip = new Mesh();
                    chip.Vertices.Add(x0 / s, (y - size) / s, z / s);
                    chip.Vertices.Add((x0 + size) / s, (y - size) / s, z / s);
                    chip.Vertices.Add((x0 + size) / s, y / s, z / s);
                    chip.Vertices.Add(x0 / s, y / s, z / s);
                    chip.Faces.AddFace(0, 1, 2, 3);
                    var col = Color.FromArgb(item.Argb | unchecked((int)0xFF000000));
                    chip.VertexColors.SetColors(new[] { col, col, col, col });
                    chip.Normals.ComputeNormals();
                    if (doc.Objects.AddMesh(chip, attr) != Guid.Empty) n++;
                    if (AddText(item.Label, x0 + size * 1.5, y - size * 0.15, size * 0.7) != Guid.Empty) n++;
                    y -= size * 1.4;
                }
                if (!string.IsNullOrEmpty(v.Caption) && AddText(v.Caption, x0, y - size * 0.5, size * 0.45) != Guid.Empty) n++;
                return n;
            }
            catch { return 0; }
        }

        private static string SafeLayerName(string s)
        {
            if (string.IsNullOrWhiteSpace(s)) return "Result";
            var chars = s.Select(ch => ch == ':' ? '.' : ch == '/' || ch == '\\' || ch == '"' || ch == '{' || ch == '}' || ch == '[' || ch == ']' || ch == '(' || ch == ')' || ch == ';' || char.IsControl(ch) ? ' ' : ch).ToArray();
            var name = new string(chars).Trim();
            if (name.Length == 0) name = "Result";
            try { if (!Rhino.DocObjects.ModelComponent.IsValidComponentName(name)) name = "Result"; } catch { }
            return name;
        }

        private static string UniqueChild(RhinoDoc doc, string parent, string name)
        {
            string candidate = name;
            for (int i = 2; i < 1000; i++)
            {
                if (doc.Layers.FindByFullPath(parent + "::" + candidate, -1) < 0) return candidate;
                candidate = $"{name} {i}";
            }
            return name + " " + DateTime.Now.ToString("HHmmss");
        }

        // ================================================================== demo

        public Task<bool> CreateDemoSiteAsync(SiteModel demo) => RunOnUi(() => CreateDemoCore(demo ?? DemoSite.Create()), () => false, "Create demo site");

        private bool CreateDemoCore(SiteModel demo)
        {
            var doc = Doc;
            if (doc == null || demo == null || !demo.HasTerrain) return false;
            double s = Scale(doc);
            const string root = "Cloudburst Demo";
            uint undo = doc.BeginUndoRecord("Cloudburst demo site");
            try
            {
                LayerUtil.PurgeObjects(doc, root);
                foreach (var r in _picks.Keys.ToList()) _picks[r].Clear();
                _material.Clear(); _height.Clear();

                LayerUtil.Ensure(doc, root, Color.FromArgb(0x1F, 0x78, 0xC8));
                int lTerrain = LayerUtil.Ensure(doc, root + "::Terrain", Color.FromArgb(0xB5, 0xB8, 0xA6));
                int lBuild = LayerUtil.Ensure(doc, root + "::Buildings", Color.FromArgb(0xE4, 0xE1, 0xDA));
                int lKerb = LayerUtil.Ensure(doc, root + "::Kerbs", Color.FromArgb(0x55, 0x55, 0x55));

                // terrain
                var terrainMeshes = new List<Mesh>();
                foreach (var t in demo.Terrain)
                {
                    var m = RhinoConvert.ToRhinoMesh(t, s);
                    if (m == null) continue;
                    terrainMeshes.Add(m);
                    var id = doc.Objects.AddMesh(m, new ObjectAttributes { LayerIndex = lTerrain, Name = "Demo terrain" });
                    Register(doc, id, PickRole.Terrain, null, null);
                }

                // ground height lookup (metres) on the created terrain, falling back to the analytic demo surface
                // The stock demo (origin 0,0) has an analytic surface: exact and much faster than ray casts.
                var tb = demo.GetTerrainBounds();
                bool analytic = tb.IsValid && Math.Abs(tb.MinX) < 1e-6 && Math.Abs(tb.MinY) < 1e-6 && Math.Abs(tb.Width - DemoSite.Width) < 1e-6 && Math.Abs(tb.Height - DemoSite.Height) < 1e-6;
                double GroundZ(double xm, double ym)
                {
                    if (analytic) return DemoSite.TerrainZ(xm, ym);
                    foreach (var m in terrainMeshes)
                    {
                        var ray = new Ray3d(new Point3d(xm / s, ym / s, 1e5 / s), -Vector3d.ZAxis);
                        double t = Rhino.Geometry.Intersect.Intersection.MeshRay(m, ray);
                        if (t >= 0) return ray.PointAt(t).Z * s;
                    }
                    return DemoSite.TerrainZ(xm, ym);
                }

                // buildings: extrusions standing on the lowest terrain point under the footprint, embedded 0.5 m
                foreach (var b in demo.Buildings)
                {
                    try
                    {
                        if (b.Footprint == null) continue;
                        var fp = b.Footprint;
                        var bb = fp.GetBounds();
                        double zMin = double.MaxValue;
                        int steps = 6;
                        for (int i = 0; i <= steps; i++)
                            for (int j = 0; j <= steps; j++)
                            {
                                double x = bb.MinX + bb.Width * i / steps, y = bb.MinY + bb.Height * j / steps;
                                zMin = Math.Min(zMin, GroundZ(x, y));
                            }
                        if (zMin == double.MaxValue) zMin = 0;
                        const double embed = 0.5;
                        var crv = new PolylineCurve(RhinoConvert.ToPolyline(fp, s, zMin - embed));
                        if (crv.ClosedCurveOrientation(Vector3d.ZAxis) == CurveOrientation.Clockwise) crv.Reverse();
                        var ext = Extrusion.Create(crv, (b.HeightAboveTerrain + embed) / s, true);
                        if (ext == null) continue;
                        var id = doc.Objects.AddExtrusion(ext, new ObjectAttributes { LayerIndex = lBuild, Name = b.Name ?? "Building" });
                        Register(doc, id, PickRole.Buildings, null, null);
                    }
                    catch (Exception ex) { Log("demo building skipped: " + ex.Message); }
                }

                // surfaces: closed polylines draped on the terrain, one layer per material in the material's colour
                foreach (var r in demo.Regions)
                {
                    try
                    {
                        if (r.Outline == null) continue;
                        var mat = Palette?.Get(r.MaterialId);
                        string matName = SafeLayerName(mat?.Name ?? r.MaterialId ?? "Material");
                        int layer = LayerUtil.Ensure(doc, root + "::Surfaces::" + matName, mat != null ? Color.FromArgb(mat.Argb | unchecked((int)0xFF000000)) : Color.Gray);
                        var pl = Drape(RhinoConvert.ToPolyline(r.Outline, s), GroundZ, s, 0.08);
                        var a = new ObjectAttributes { LayerIndex = layer, Name = matName };
                        var id = doc.Objects.AddPolyline(pl, a);
                        Register(doc, id, PickRole.Surfaces, mat?.Id ?? r.MaterialId, null);
                    }
                    catch (Exception ex) { Log("demo surface skipped: " + ex.Message); }
                }

                // kerbs
                foreach (var w in demo.Walls)
                {
                    try
                    {
                        var pl = Drape(RhinoConvert.ToPolyline(w.Line, s), GroundZ, s, w.Height);
                        var id = doc.Objects.AddPolyline(pl, new ObjectAttributes { LayerIndex = lKerb, Name = $"Kerb {w.Height * 100:0} cm" });
                        Register(doc, id, PickRole.Walls, null, w.Height);
                    }
                    catch (Exception ex) { Log("demo kerb skipped: " + ex.Message); }
                }

                doc.Objects.UnselectAll();
                foreach (var v in doc.Views) { try { v.ActiveViewport.ZoomExtents(); } catch { } }
                doc.Views.Redraw();
                Log($"demo site created ({_picks[PickRole.Buildings].Count} buildings, {_picks[PickRole.Surfaces].Count} surface areas). Next: Build grid → Run.");
                return true;
            }
            finally { doc.EndUndoRecord(undo); }
        }

        private void Register(RhinoDoc doc, Guid id, PickRole role, string material, double? height)
        {
            if (id == Guid.Empty) return;
            if (!_picks[role].Contains(id)) _picks[role].Add(id);
            if (role == PickRole.Surfaces) _material[id] = material;
            if (role == PickRole.Walls && height.HasValue) _height[id] = height.Value;
            var obj = doc.Objects.FindId(id);
            if (obj != null) TagObject(doc, obj, role, material, height);
        }

        /// <summary>Densify a polyline (model units) to ~2 m and set Z from the ground function (+ lift).</summary>
        private static Polyline Drape(Polyline pl, Func<double, double, double> groundZm, double s, double liftM)
        {
            var result = new Polyline();
            double step = 2.0 / s;
            for (int i = 0; i < pl.Count; i++)
            {
                if (i > 0)
                {
                    var a = pl[i - 1]; var b = pl[i];
                    int n = (int)Math.Max(1, Math.Ceiling(a.DistanceTo(b) / step));
                    for (int k = 1; k < n; k++) result.Add(a + (b - a) * (k / (double)n));
                }
                result.Add(pl[i]);
            }
            for (int i = 0; i < result.Count; i++)
            {
                var p = result[i];
                p.Z = (groundZm(p.X * s, p.Y * s) + liftM) / s;
                result[i] = p;
            }
            return result;
        }
    }

    internal static class LayerUtil
    {
        /// <summary>Find or create a layer by full path ("A::B::C"); returns its index.</summary>
        public static int Ensure(RhinoDoc doc, string fullPath, Color color)
        {
            var parts = fullPath.Split(new[] { "::" }, StringSplitOptions.RemoveEmptyEntries);
            int index = -1; Guid parent = Guid.Empty; string path = null;
            for (int i = 0; i < parts.Length; i++)
            {
                path = path == null ? parts[i] : path + "::" + parts[i];
                index = doc.Layers.FindByFullPath(path, -1);
                if (index < 0)
                {
                    var layer = new Layer { Name = parts[i], Color = i == parts.Length - 1 ? color : Color.FromArgb(60, 60, 60) };
                    if (parent != Guid.Empty) layer.ParentLayerId = parent;
                    index = doc.Layers.Add(layer);
                    if (index < 0) return doc.Layers.CurrentLayerIndex;
                }
                parent = doc.Layers[index].Id;
            }
            return index;
        }

        /// <summary>Delete all objects on a layer and its sublayers (used to rebuild the demo site).</summary>
        public static void PurgeObjects(RhinoDoc doc, string rootPath)
        {
            int idx = doc.Layers.FindByFullPath(rootPath, -1);
            if (idx < 0) return;
            var root = doc.Layers[idx];
            var layers = new List<Layer> { root };
            var kids = root.GetChildren(true);
            if (kids != null) layers.AddRange(kids);
            foreach (var l in layers)
            {
                var objs = doc.Objects.FindByLayer(l);
                if (objs == null) continue;
                foreach (var o in objs) doc.Objects.Delete(o, true);
            }
        }
    }
}
