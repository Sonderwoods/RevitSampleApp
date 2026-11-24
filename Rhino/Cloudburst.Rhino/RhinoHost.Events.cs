using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using Cloudburst.Hosting;
using CloudburstRhinoCommon;
using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace CloudburstRhino
{
    /// <summary>Model-change and selection notifications + the material overlay (ICloudburstHostEvents).</summary>
    public sealed partial class RhinoHost
    {
        public event EventHandler ModelChanged;
        public event EventHandler<SelectionInfo> SelectionChanged;

        private readonly MaterialConduit _materialConduit = new MaterialConduit();
        private bool _materialOverlay;
        private bool _selectionQueued;

        private void HookDocEvents()
        {
            RhinoDoc.ReplaceRhinoObject += (s, e) => OnObjectEvent(e.ObjectId);
            RhinoDoc.DeleteRhinoObject += (s, e) => OnObjectEvent(e.ObjectId);
            RhinoDoc.UndeleteRhinoObject += (s, e) => OnObjectEvent(e.ObjectId);
            RhinoDoc.ModifyObjectAttributes += (s, e) => OnObjectEvent(e.RhinoObject?.Id ?? Guid.Empty);
            RhinoDoc.SelectObjects += (s, e) => QueueSelection();
            RhinoDoc.DeselectObjects += (s, e) => QueueSelection();
            RhinoDoc.DeselectAllObjects += (s, e) => QueueSelection();
        }

        private bool IsPicked(Guid id) => id != Guid.Empty && _picks.Values.Any(l => l.Contains(id));

        private void OnObjectEvent(Guid id)
        {
            try
            {
                if (!IsPicked(id)) return;
                ModelChanged?.Invoke(this, EventArgs.Empty);
                if (_materialOverlay) RhinoApp.Idle += RefreshOverlayOnIdle;
            }
            catch { }
        }

        // selection events arrive per object; coalesce them to one notification on idle
        private void QueueSelection()
        {
            if (_selectionQueued) return;
            _selectionQueued = true;
            RhinoApp.Idle += RaiseSelectionOnIdle;
        }

        private void RaiseSelectionOnIdle(object sender, EventArgs e)
        {
            RhinoApp.Idle -= RaiseSelectionOnIdle;
            _selectionQueued = false;
            try { SelectionChanged?.Invoke(this, BuildSelectionInfo()); } catch { }
        }

        private SelectionInfo BuildSelectionInfo()
        {
            var info = new SelectionInfo();
            var doc = Doc; if (doc == null) return info;
            var sel = doc.Objects.GetSelectedObjects(false, false)?.ToList() ?? new List<RhinoObject>();
            info.Count = sel.Count;
            foreach (var o in sel)
            {
                foreach (var kv in _picks)
                    if (kv.Value.Contains(o.Id)) info.Roles[kv.Key] = info.Roles.TryGetValue(kv.Key, out var n) ? n + 1 : 1;
                string mat = _material.TryGetValue(o.Id, out var m) && !string.IsNullOrEmpty(m) ? m : o.Attributes.GetUserString(KeyMaterial);
                if (string.IsNullOrEmpty(mat) && _picks[PickRole.Surfaces].Contains(o.Id)) mat = GuessMaterial(doc, o);
                if (!string.IsNullOrEmpty(mat)) info.Materials[mat] = info.Materials.TryGetValue(mat, out var c) ? c + 1 : 1;
            }
            return info;
        }

        // ---------------------------------------------------------------- material overlay

        public Task ShowMaterialOverlayAsync(bool show) => RunOnUi(() =>
        {
            _materialOverlay = show;
            if (show) RefreshOverlay();
            _materialConduit.Enabled = show;
            Doc?.Views.Redraw();
        }, "Material view");

        private void RefreshOverlayOnIdle(object sender, EventArgs e)
        {
            RhinoApp.Idle -= RefreshOverlayOnIdle;
            if (!_materialOverlay) return;
            RefreshOverlay();
            Doc?.Views.Redraw();
        }

        private void RefreshOverlay()
        {
            var doc = Doc; if (doc == null) return;
            var pal = Palette;
            var fills = new List<(Mesh, Color)>();
            var outlines = new List<(Polyline, Color)>();
            var labels = new List<(Point3d, string, Color)>();
            var used = new Dictionary<string, Color>();
            var mp = MeshingParameters.FastRenderMesh;

            foreach (var o in LiveObjects(doc, PickRole.Surfaces))
            {
                try
                {
                    string id = _material.TryGetValue(o.Id, out var m) && m != null ? m : GuessMaterial(doc, o);
                    var sm = pal?.Get(id);
                    var color = sm != null ? Color.FromArgb(sm.Argb) : Color.Gray;
                    string name = sm?.Name ?? id ?? "?";
                    used[name] = color;
                    Point3d labelAt = Point3d.Unset;
                    switch (o.Geometry)
                    {
                        case Curve c:
                            {
                                if (!c.TryGetPolyline(out var pl)) pl = c.ToPolyline(0.01, 0.1, 0.05, 1e6)?.ToPolyline();
                                if (pl == null || pl.Count < 3) break;
                                if (!pl.IsClosed) pl.Add(pl[0]);
                                outlines.Add((pl, color));
                                var mesh = Mesh.CreateFromClosedPolyline(pl);
                                if (mesh != null) fills.Add((mesh, color));
                                labelAt = pl.CenterPoint();
                                break;
                            }
                        case Hatch h:
                            foreach (var hc in h.Get3dCurves(true) ?? Array.Empty<Curve>())
                                if (hc.TryGetPolyline(out var hp) || (hp = hc.ToPolyline(0.01, 0.1, 0.05, 1e6)?.ToPolyline()) != null)
                                {
                                    outlines.Add((hp, color));
                                    var hm = Mesh.CreateFromClosedPolyline(hp);
                                    if (hm != null) fills.Add((hm, color));
                                    if (!labelAt.IsValid) labelAt = hp.CenterPoint();
                                }
                            break;
                        case Mesh msh:
                            fills.Add((msh, color));
                            labelAt = msh.GetBoundingBox(false).Center;
                            break;
                        default:
                            {
                                Mesh[] ms = null;
                                if (o.Geometry is Brep b) ms = Mesh.CreateFromBrep(b, mp);
                                else if (o.Geometry is Extrusion ex) ms = Mesh.CreateFromBrep(ex.ToBrep(), mp);
                                else if (o.Geometry is Surface sf) ms = Mesh.CreateFromBrep(sf.ToBrep(), mp);
                                else if (o.Geometry is SubD sd) ms = new[] { Mesh.CreateFromSubD(sd, 2) };
                                if (ms != null) foreach (var x in ms) if (x != null) fills.Add((x, color));
                                labelAt = o.Geometry.GetBoundingBox(false).Center;
                                break;
                            }
                    }
                    if (labelAt.IsValid) labels.Add((labelAt + new Vector3d(0, 0, 0.3 / Scale(doc)), name, color));
                }
                catch (Exception ex) { Log($"material view skipped {o.Id}: {ex.Message}"); }
            }
            // buildings in neutral grey so roofs read as "not a surface material"
            foreach (var o in LiveObjects(doc, PickRole.Buildings))
            {
                try
                {
                    var grey = Color.FromArgb(150, 155, 165);
                    if (o.Geometry is Curve c && c.TryGetPolyline(out var pl)) { outlines.Add((pl, grey)); continue; }
                    Mesh[] ms = o.Geometry is Brep b ? Mesh.CreateFromBrep(b, mp) : o.Geometry is Extrusion ex ? Mesh.CreateFromBrep(ex.ToBrep(), mp) : o.Geometry is Mesh m ? new[] { m } : null;
                    if (ms != null) foreach (var x in ms) if (x != null) fills.Add((x, grey));
                    used["Building (roof → sewer)"] = grey;
                }
                catch { }
            }
            if (pal != null && LiveObjects(doc, PickRole.Terrain).Count > 0)
            {
                var d = pal.Default;
                if (!used.ContainsKey(d.Name)) used[d.Name + " (unassigned terrain)"] = Color.FromArgb(d.Argb);
            }
            _materialConduit.Set(fills, outlines, labels, used.Select(kv => (kv.Key, kv.Value)).ToList(), 0.01 / Scale(doc));
        }
    }
}
