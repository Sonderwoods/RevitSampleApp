using System;
using System.Globalization;
using System.Linq;
using System.Windows;
using System.Windows.Documents;
using System.Windows.Media;
using Cloudburst.Model;

namespace Cloudburst.UI.Controls
{
    /// <summary>Bar chart of a rain event's intensity (mm/h incl. climate factor), peak labelled. Drawn in OnRender.</summary>
    public sealed class HyetographChart : FrameworkElement
    {
        public static readonly DependencyProperty RainProperty = DependencyProperty.Register(nameof(Rain), typeof(RainEvent), typeof(HyetographChart),
            new FrameworkPropertyMetadata(null, FrameworkPropertyMetadataOptions.AffectsRender));
        /// <summary>Bump to force a redraw when the (mutable) rain event changes.</summary>
        public static readonly DependencyProperty VersionProperty = DependencyProperty.Register(nameof(Version), typeof(int), typeof(HyetographChart),
            new FrameworkPropertyMetadata(0, FrameworkPropertyMetadataOptions.AffectsRender));
        public static readonly DependencyProperty BarBrushProperty = DependencyProperty.Register(nameof(BarBrush), typeof(Brush), typeof(HyetographChart),
            new FrameworkPropertyMetadata(new SolidColorBrush(Color.FromRgb(0x2B, 0x8F, 0xD6)), FrameworkPropertyMetadataOptions.AffectsRender));
        public static readonly DependencyProperty PeakBrushProperty = DependencyProperty.Register(nameof(PeakBrush), typeof(Brush), typeof(HyetographChart),
            new FrameworkPropertyMetadata(new SolidColorBrush(Color.FromRgb(0x38, 0xBD, 0xF8)), FrameworkPropertyMetadataOptions.AffectsRender));
        public static readonly DependencyProperty AxisBrushProperty = DependencyProperty.Register(nameof(AxisBrush), typeof(Brush), typeof(HyetographChart),
            new FrameworkPropertyMetadata(new SolidColorBrush(Color.FromRgb(0x8B, 0x98, 0xA9)), FrameworkPropertyMetadataOptions.AffectsRender));
        public static readonly DependencyProperty GridBrushProperty = DependencyProperty.Register(nameof(GridBrush), typeof(Brush), typeof(HyetographChart),
            new FrameworkPropertyMetadata(new SolidColorBrush(Color.FromArgb(0x30, 0x8B, 0x98, 0xA9)), FrameworkPropertyMetadataOptions.AffectsRender));
        public static readonly DependencyProperty LabelBrushProperty = DependencyProperty.Register(nameof(LabelBrush), typeof(Brush), typeof(HyetographChart),
            new FrameworkPropertyMetadata(Brushes.White, FrameworkPropertyMetadataOptions.AffectsRender));

        public RainEvent Rain { get => (RainEvent)GetValue(RainProperty); set => SetValue(RainProperty, value); }
        public int Version { get => (int)GetValue(VersionProperty); set => SetValue(VersionProperty, value); }
        public Brush BarBrush { get => (Brush)GetValue(BarBrushProperty); set => SetValue(BarBrushProperty, value); }
        public Brush PeakBrush { get => (Brush)GetValue(PeakBrushProperty); set => SetValue(PeakBrushProperty, value); }
        public Brush AxisBrush { get => (Brush)GetValue(AxisBrushProperty); set => SetValue(AxisBrushProperty, value); }
        public Brush GridBrush { get => (Brush)GetValue(GridBrushProperty); set => SetValue(GridBrushProperty, value); }
        public Brush LabelBrush { get => (Brush)GetValue(LabelBrushProperty); set => SetValue(LabelBrushProperty, value); }

        protected override void OnRender(DrawingContext dc)
        {
            try { Draw(dc); } catch (Exception) { /* never crash the host from a paint */ }
        }

        private FormattedText Text(string s, double size, Brush b, bool bold = false)
        {
            var ff = TextElement.GetFontFamily(this) ?? new FontFamily("Segoe UI");
            var tf = new Typeface(ff, FontStyles.Normal, bold ? FontWeights.SemiBold : FontWeights.Normal, FontStretches.Normal);
            double ppd = 1.0;
            try { ppd = VisualTreeHelper.GetDpi(this).PixelsPerDip; } catch (Exception) { }
            return new FormattedText(s, CultureInfo.InvariantCulture, FlowDirection.LeftToRight, tf, size, b, ppd);
        }

        private void Draw(DrawingContext dc)
        {
            double w = ActualWidth, h = ActualHeight;
            dc.DrawRectangle(Brushes.Transparent, null, new Rect(0, 0, w, h));
            var rain = Rain;
            if (rain == null || rain.IntensityMmH == null || rain.IntensityMmH.Length == 0 || w < 60 || h < 50)
            {
                var t = Text("No rain event", 11, AxisBrush);
                dc.DrawText(t, new Point((w - t.Width) / 2, (h - t.Height) / 2));
                return;
            }
            double cf = rain.ClimateFactor;
            var vals = rain.IntensityMmH.Select(v => v * cf).ToArray();
            double max = Math.Max(1e-6, vals.Max());
            double niceMax = Nice(max * 1.08);
            const double left = 34, right = 6, top = 22, bottom = 18;
            double pw = w - left - right, ph = h - top - bottom;
            if (pw <= 10 || ph <= 10) return;

            var gridPen = new Pen(GridBrush, 1); gridPen.Freeze();
            for (int g = 0; g <= 2; g++)
            {
                double v = niceMax * g / 2.0;
                double y = Math.Round(top + ph - v / niceMax * ph) + 0.5;
                dc.DrawLine(gridPen, new Point(left, y), new Point(left + pw, y));
                var lt = Text(v.ToString("0", CultureInfo.InvariantCulture), 9.5, AxisBrush);
                dc.DrawText(lt, new Point(left - 6 - lt.Width, y - lt.Height / 2));
            }
            var unit = Text("mm/h", 9.5, AxisBrush);
            dc.DrawText(unit, new Point(0, 2));

            int n = vals.Length;
            double bw = pw / n;
            double gap = bw > 4 ? 1 : 0;
            int peak = Array.IndexOf(vals, vals.Max());
            for (int i = 0; i < n; i++)
            {
                double bh = vals[i] / niceMax * ph;
                if (bh < 0.5) continue;
                var r = new Rect(left + i * bw + gap / 2, top + ph - bh, Math.Max(0.6, bw - gap), bh);
                double rad = Math.Min(2, r.Width / 2);
                dc.DrawRoundedRectangle(i == peak ? PeakBrush : BarBrush, null, r, rad, rad);
            }

            // x axis labels: 0, middle, end (hours or minutes)
            double durMin = n * rain.StepS / 60.0;
            foreach (var f in new[] { 0.0, 0.5, 1.0 })
            {
                double m = durMin * f;
                string s = durMin >= 120 ? (m / 60).ToString("0.#", CultureInfo.InvariantCulture) + " h" : m.ToString("0", CultureInfo.InvariantCulture) + " min";
                var t = Text(s, 9.5, AxisBrush);
                double x = left + pw * f - t.Width * f;
                dc.DrawText(t, new Point(x, top + ph + 3));
            }

            // peak label
            double px = left + (peak + 0.5) * bw;
            double py = top + ph - vals[peak] / niceMax * ph;
            var pl = Text($"peak {vals[peak].ToString("0", CultureInfo.InvariantCulture)} mm/h", 10.5, LabelBrush, true);
            double lx = Math.Max(left, Math.Min(left + pw - pl.Width, px - pl.Width / 2));
            double ly = Math.Max(0, py - pl.Height - 4);
            dc.DrawText(pl, new Point(lx, ly));
        }

        private static double Nice(double v)
        {
            double p = Math.Pow(10, Math.Floor(Math.Log10(v)));
            foreach (var m in new[] { 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 }) if (m * p >= v) return m * p;
            return 10 * p;
        }
    }
}
