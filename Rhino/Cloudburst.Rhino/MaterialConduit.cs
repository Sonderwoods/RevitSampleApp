using System;
using System.Collections.Generic;
using System.Drawing;
using Rhino;
using Rhino.Display;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace CloudburstRhino
{
    /// <summary>
    /// "Material view": draws every picked surface object filled with its material colour plus a name label, buildings in
    /// grey, and a small legend. Built once per refresh (cheap to draw).
    /// </summary>
    internal sealed class MaterialConduit : DisplayConduit
    {
        private readonly object _lock = new object();
        private List<(Mesh mesh, DisplayMaterial mat, Color color)> _fills = new List<(Mesh, DisplayMaterial, Color)>();
        private List<(Polyline line, Color color)> _outlines = new List<(Polyline, Color)>();
        private List<(Point3d at, string text, Color color)> _labels = new List<(Point3d, string, Color)>();
        private List<(string name, Color color)> _legend = new List<(string, Color)>();
        private BoundingBox _bbox = BoundingBox.Empty;

        public void Set(List<(Mesh, Color)> fills, List<(Polyline, Color)> outlines, List<(Point3d, string, Color)> labels, List<(string, Color)> legend)
        {
            var f = new List<(Mesh, DisplayMaterial, Color)>();
            var bb = BoundingBox.Empty;
            foreach (var (m, c) in fills)
            {
                if (m == null) continue;
                f.Add((m, new DisplayMaterial(c, 0.25), c));
                bb.Union(m.GetBoundingBox(false));
            }
            foreach (var (l, _) in outlines) bb.Union(l.BoundingBox);
            lock (_lock) { _fills = f; _outlines = outlines; _labels = labels; _legend = legend; _bbox = bb; }
        }

        protected override void CalculateBoundingBox(CalculateBoundingBoxEventArgs e)
        {
            try { if (_bbox.IsValid) e.IncludeBoundingBox(_bbox); } catch { }
        }

        protected override void PostDrawObjects(DrawEventArgs e)
        {
            try
            {
                List<(Mesh mesh, DisplayMaterial mat, Color color)> fills; List<(Polyline line, Color color)> outlines;
                lock (_lock) { fills = _fills; outlines = _outlines; }
                foreach (var (mesh, mat, _) in fills) e.Display.DrawMeshShaded(mesh, mat);
                e.Display.PushDepthTesting(false);
                try { foreach (var (line, c) in outlines) e.Display.DrawPolyline(line, c, 3); }
                finally { e.Display.PopDepthTesting(); }
            }
            catch { }
        }

        protected override void DrawForeground(DrawEventArgs e)
        {
            try
            {
                List<(Point3d at, string text, Color color)> labels; List<(string name, Color color)> legend;
                lock (_lock) { labels = _labels; legend = _legend; }
                foreach (var (at, text, c) in labels) e.Display.DrawDot(at, text, c, c.GetBrightness() > 0.6f ? Color.Black : Color.White);
                if (legend.Count == 0) return;
                // legend card top-right
                var vp = e.Viewport.Bounds;
                int row = 20, w = 230, h = 34 + legend.Count * row;
                int x0 = vp.Width - w - 16, y0 = 16;
                e.Display.Draw2dRectangle(new Rectangle(x0, y0, w, h), Color.FromArgb(220, 15, 23, 42), 1, Color.FromArgb(235, 11, 18, 32));
                e.Display.Draw2dText("SURFACE MATERIALS", Color.FromArgb(255, 79, 168, 224), new Point2d(x0 + 12, y0 + 10), false, 11, "Segoe UI Semibold");
                for (int i = 0; i < legend.Count; i++)
                {
                    int y = y0 + 30 + i * row;
                    e.Display.Draw2dRectangle(new Rectangle(x0 + 12, y + 3, 14, 12), legend[i].color, 1, legend[i].color);
                    e.Display.Draw2dText(legend[i].name, Color.FromArgb(255, 230, 238, 248), new Point2d(x0 + 34, y + 1), false, 12, "Segoe UI");
                }
            }
            catch { }
        }
    }
}
