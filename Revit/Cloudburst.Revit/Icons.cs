using System;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Cloudburst.Revit
{
    /// <summary>Ribbon icons drawn in code (no resource files): water drop, demo (drop + houses), clear (drop + cross).</summary>
    internal static class Icons
    {
        public enum Kind { Drop, Demo, Clear, Window }

        public static BitmapSource Create(Kind kind, int size)
        {
            try
            {
                var dv = new DrawingVisual();
                using (var dc = dv.RenderOpen())
                {
                    double s = size;
                    var drop = DropGeometry(s * 0.5, s * 0.06, s * 0.40, s * 0.94);
                    var fill = new LinearGradientBrush(Color.FromRgb(0x6F, 0xC3, 0xF5), Color.FromRgb(0x0D, 0x4F, 0xA0), 90);
                    fill.Freeze();
                    var pen = new Pen(new SolidColorBrush(Color.FromRgb(0x08, 0x30, 0x6B)), Math.Max(1, s / 24)); pen.Freeze();

                    if (kind == Kind.Demo)
                    {
                        // small skyline behind a smaller drop
                        var house = new SolidColorBrush(Color.FromRgb(0x9A, 0xA5, 0xB1)); house.Freeze();
                        dc.DrawRectangle(house, null, new Rect(s * 0.04, s * 0.45, s * 0.26, s * 0.5));
                        dc.DrawRectangle(house, null, new Rect(s * 0.68, s * 0.30, s * 0.28, s * 0.65));
                        drop = DropGeometry(s * 0.5, s * 0.14, s * 0.30, s * 0.92);
                    }
                    dc.DrawGeometry(fill, pen, drop);
                    // highlight
                    var hl = new SolidColorBrush(Color.FromArgb(170, 255, 255, 255)); hl.Freeze();
                    dc.DrawEllipse(hl, null, new Point(s * 0.40, s * 0.66), s * 0.06, s * 0.10);

                    if (kind == Kind.Clear)
                    {
                        var red = new Pen(new SolidColorBrush(Color.FromRgb(0xD7, 0x30, 0x27)), Math.Max(2, s / 9)) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round };
                        red.Freeze();
                        dc.DrawLine(red, new Point(s * 0.58, s * 0.58), new Point(s * 0.92, s * 0.92));
                        dc.DrawLine(red, new Point(s * 0.92, s * 0.58), new Point(s * 0.58, s * 0.92));
                    }
                    else if (kind == Kind.Window)
                    {
                        var frame = new Pen(new SolidColorBrush(Color.FromRgb(0x33, 0x33, 0x33)), Math.Max(1, s / 16)); frame.Freeze();
                        dc.DrawRectangle(Brushes.White, frame, new Rect(s * 0.55, s * 0.55, s * 0.40, s * 0.40));
                    }
                }
                var bmp = new RenderTargetBitmap(size, size, 96, 96, PixelFormats.Pbgra32);
                bmp.Render(dv);
                bmp.Freeze();
                return bmp;
            }
            catch (Exception ex)
            {
                Logger.Write("Icon creation failed: " + ex.Message);
                return null;
            }
        }

        /// <summary>Tear drop: tip at (cx, top), round belly of radius r whose bottom touches <paramref name="bottom"/>.</summary>
        private static Geometry DropGeometry(double cx, double top, double r, double bottom)
        {
            double cy = bottom - r;
            // tangent points from the tip to the circle
            double d = cy - top;
            double a = Math.Asin(Math.Min(1, r / Math.Max(d, r + 1e-6)));
            double tx = r * Math.Cos(a), ty = cy - r * Math.Sin(a);
            var g = new StreamGeometry();
            using (var c = g.Open())
            {
                c.BeginFigure(new Point(cx, top), true, true);
                c.LineTo(new Point(cx + tx, ty), true, true);
                c.ArcTo(new Point(cx - tx, ty), new Size(r, r), 0, true, SweepDirection.Clockwise, true, true);
            }
            g.Freeze();
            return g;
        }
    }
}
