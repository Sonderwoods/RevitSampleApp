using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using Cloudburst.Results;
using CloudburstRhinoCommon;
using Rhino.Display;
using Rhino.Geometry;

namespace CloudburstRhino
{
    /// <summary>
    /// Draws one <see cref="ResultVisual"/>: the classed result mesh (vertex colours), flow paths (blue, width by
    /// upstream volume), bluespot labels as dots and a 2D HUD (legend card top-left, assumptions caption bottom-left).
    /// All Rhino geometry is built once in <see cref="SetVisual"/>; the draw callbacks only draw.
    /// </summary>
    internal sealed class ResultConduit : DisplayConduit
    {
        private readonly object _lock = new object();
        private Mesh _mesh;
        private List<(Polyline line, int thickness)> _flows = new List<(Polyline, int)>();
        private List<(Point3d at, string text)> _labels = new List<(Point3d, string)>();
        private List<LegendItem> _legend = new List<LegendItem>();
        private string _title, _subtitle, _caption;
        private BoundingBox _bbox = BoundingBox.Empty;

        private static readonly Color CardFill = Color.FromArgb(232, 255, 255, 255);
        private static readonly Color CardStroke = Color.FromArgb(200, 210, 216, 224);
        private static readonly Color Ink = Color.FromArgb(255, 30, 42, 56);
        private static readonly Color InkSoft = Color.FromArgb(255, 96, 108, 122);
        private static readonly Color CaptionFill = Color.FromArgb(185, 15, 23, 42);
        private static readonly Color DotFill = Color.FromArgb(255, 8, 48, 107);
        private static readonly Color Halo = Color.FromArgb(255, 245, 250, 255);
        private const string Font = "Segoe UI";
        private const string FontBold = "Segoe UI Semibold";

        public void SetVisual(ResultVisual v, double scale)
        {
            Mesh mesh = null;
            var flows = new List<(Polyline, int)>();
            var labels = new List<(Point3d, string)>();
            var bbox = BoundingBox.Empty;
            try
            {
                mesh = RhinoConvert.ToRhinoMesh(v.Mesh, scale);
                if (mesh != null) bbox.Union(mesh.GetBoundingBox(false));
            }
            catch { mesh = null; }
            try
            {
                if (v.FlowPaths != null)
                    foreach (var p in v.FlowPaths)
                        foreach (var seg in RhinoConvert.FlowSegments(p, scale))
                        {
                            flows.Add(seg);
                            bbox.Union(seg.line.BoundingBox);
                        }
                // thin first so thick trunks draw on top
                flows = flows.OrderBy(f => f.Item2).ToList();
            }
            catch { }
            try
            {
                if (v.Labels != null)
                    foreach (var l in v.Labels)
                    {
                        var p = new Point3d(l.X / scale, l.Y / scale, l.Z / scale);
                        labels.Add((p, l.Text));
                        bbox.Union(p);
                    }
            }
            catch { }

            lock (_lock)
            {
                _mesh = mesh; _flows = flows; _labels = labels; _bbox = bbox;
                _legend = v.Legend?.ToList() ?? new List<LegendItem>();
                _title = v.Title;
                _subtitle = v.Ramp != null ? (string.IsNullOrEmpty(v.Ramp.Unit) ? v.Ramp.Title : $"{v.Ramp.Title} ({v.Ramp.Unit})") : null;
                if (_subtitle == _title) _subtitle = null;
                _caption = v.Caption;
            }
        }

        public void Clear()
        {
            lock (_lock)
            {
                _mesh = null; _flows = new List<(Polyline, int)>(); _labels = new List<(Point3d, string)>();
                _legend = new List<LegendItem>(); _title = _subtitle = _caption = null; _bbox = BoundingBox.Empty;
            }
        }

        protected override void CalculateBoundingBox(CalculateBoundingBoxEventArgs e)
        {
            try { if (_bbox.IsValid) e.IncludeBoundingBox(_bbox); } catch { }
        }

        protected override void PostDrawObjects(DrawEventArgs e)
        {
            try
            {
                Mesh mesh; List<(Polyline line, int thickness)> flows;
                lock (_lock) { mesh = _mesh; flows = _flows; }
                if (mesh != null) e.Display.DrawMeshFalseColors(mesh);
                // Flow paths sit on the analysis grid, which can be below a smoother/finer terrain surface:
                // draw them without depth testing so they are always visible.
                e.Display.PushDepthTesting(false);
                try
                {
                    foreach (var (line, t) in flows)
                        if (t >= 2) e.Display.DrawPolyline(line, Halo, t + 2);
                    foreach (var (line, t) in flows)
                        e.Display.DrawPolyline(line, RhinoConvert.FlowBlue, Math.Max(2, t));
                }
                finally { e.Display.PopDepthTesting(); }
            }
            catch { }
        }

        protected override void DrawForeground(DrawEventArgs e)
        {
            try
            {
                List<(Point3d at, string text)> labels; List<LegendItem> legend; string title, subtitle, caption;
                lock (_lock) { labels = _labels; legend = _legend; title = _title; subtitle = _subtitle; caption = _caption; }

                foreach (var (at, text) in labels) e.Display.DrawDot(at, text, DotFill, Color.White);

                double dpi = 1.0;
                try { dpi = Math.Max(1.0, e.Display.DpiScale); } catch { }
                var vp = e.Viewport.Bounds;
                if (legend.Count > 0 || !string.IsNullOrEmpty(title)) DrawLegend(e.Display, legend, title, subtitle, dpi);
                if (!string.IsNullOrEmpty(caption)) DrawCaption(e.Display, caption, vp, dpi);
            }
            catch { }
        }

        // ------------------------------------------------------------------ HUD

        private static int Px(double v, double dpi) => (int)Math.Round(v * dpi);

        private static Size Measure(DisplayPipeline d, string text, int height, string font)
        {
            try { var r = d.Measure2dText(text, new Point2d(0, 0), false, 0, height, font); return new Size(Math.Abs(r.Width), Math.Abs(r.Height)); }
            catch { return new Size(text.Length * height * 6 / 10, height); }
        }

        /// <summary>Draw text so its top-left lands exactly at (x, y), independent of Rhino's anchor convention.</summary>
        private static void TextAt(DisplayPipeline d, string text, int x, int y, int height, string font, Color color)
        {
            int dx = 0, dy = 0;
            try { var r = d.Measure2dText(text, new Point2d(0, 0), false, 0, height, font); dx = -r.Left; dy = -r.Top; } catch { }
            d.Draw2dText(text, color, new Point2d(x + dx, y + dy), false, height, font);
        }

        private static void DrawLegend(DisplayPipeline d, List<LegendItem> legend, string title, string subtitle, double dpi)
        {
            int pad = Px(12, dpi), x0 = Px(16, dpi), y0 = Px(16, dpi);
            int brandH = Px(9, dpi), titleH = Px(14, dpi), subH = Px(11, dpi), rowH = Px(20, dpi), chip = Px(14, dpi), textH = Px(12, dpi);
            const string brand = "CLOUDBURST";
            int w = Math.Max(Px(170, dpi), Measure(d, title ?? "", titleH, FontBold).Width);
            if (!string.IsNullOrEmpty(subtitle)) w = Math.Max(w, Measure(d, subtitle, subH, Font).Width);
            foreach (var it in legend) w = Math.Max(w, chip + Px(8, dpi) + Measure(d, it.Label ?? "", textH, Font).Width);

            int h = pad + brandH + Px(6, dpi) + titleH + Px(4, dpi);
            if (!string.IsNullOrEmpty(subtitle)) h += subH + Px(6, dpi);
            h += Px(4, dpi) + legend.Count * rowH + pad - Px(4, dpi);
            var card = new Rectangle(x0, y0, w + 2 * pad, h);
            d.Draw2dRectangle(card, CardStroke, 1, CardFill);
            // accent bar
            d.Draw2dRectangle(new Rectangle(x0, y0, Px(4, dpi), h), RhinoConvert.FlowBlue, 1, RhinoConvert.FlowBlue);

            int x = x0 + pad, y = y0 + pad;
            TextAt(d, brand, x, y, brandH, FontBold, RhinoConvert.FlowBlue);
            y += brandH + Px(6, dpi);
            TextAt(d, title ?? "", x, y, titleH, FontBold, Ink);
            y += titleH + Px(4, dpi);
            if (!string.IsNullOrEmpty(subtitle)) { TextAt(d, subtitle, x, y, subH, Font, InkSoft); y += subH + Px(6, dpi); }
            y += Px(4, dpi);
            foreach (var it in legend)
            {
                var c = Color.FromArgb(it.Argb);
                bool transparent = c.A == 0;
                var fill = transparent ? Color.White : Color.FromArgb(255, c);
                d.Draw2dRectangle(new Rectangle(x, y + (rowH - chip) / 2 - Px(2, dpi), chip, chip), transparent ? InkSoft : Color.FromArgb(255, Darken(c)), 1, fill);
                TextAt(d, it.Label ?? "", x + chip + Px(8, dpi), y + (rowH - textH) / 2 - Px(2, dpi), textH, Font, Ink);
                y += rowH;
            }
        }

        private static Color Darken(Color c) => Color.FromArgb(c.R * 3 / 4, c.G * 3 / 4, c.B * 3 / 4);

        private static void DrawCaption(DisplayPipeline d, string caption, Rectangle vp, double dpi)
        {
            int textH = Px(11, dpi), pad = Px(8, dpi), margin = Px(16, dpi);
            int maxW = Math.Max(Px(200, dpi), vp.Width - 2 * margin - 2 * pad);
            var lines = Wrap(d, caption, textH, maxW);
            int lineH = textH + Px(5, dpi);
            int w = lines.Max(l => Measure(d, l, textH, Font).Width);
            int h = lines.Count * lineH - Px(5, dpi) + 2 * pad;
            int x = margin, y = vp.Height - margin - h;
            d.Draw2dRectangle(new Rectangle(x, y, w + 2 * pad, h), CaptionFill, 1, CaptionFill);
            for (int i = 0; i < lines.Count; i++)
            {
                bool warn = lines[i].Contains("SCREENING MODEL");
                TextAt(d, lines[i], x + pad, y + pad + i * lineH, textH, warn ? FontBold : Font, warn ? Color.FromArgb(255, 255, 214, 102) : Color.White);
            }
        }

        /// <summary>Wrap at " · " separators (then spaces) to fit the viewport; the screening warning gets its own line when it can.</summary>
        private static List<string> Wrap(DisplayPipeline d, string text, int h, int maxW)
        {
            var tokens = text.Split(new[] { " · " }, StringSplitOptions.None).ToList();
            var lines = new List<string>();
            string cur = "";
            foreach (var tok in tokens)
            {
                string next = cur.Length == 0 ? tok : cur + " · " + tok;
                if (cur.Length > 0 && Measure(d, next, h, Font).Width > maxW) { lines.Add(cur); cur = tok; }
                else cur = next;
            }
            if (cur.Length > 0) lines.Add(cur);
            return lines.Count == 0 ? new List<string> { text } : lines;
        }
    }
}
