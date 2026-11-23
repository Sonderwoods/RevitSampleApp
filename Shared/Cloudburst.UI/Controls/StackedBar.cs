using System;
using System.Collections;
using System.Collections.Specialized;
using System.Linq;
using System.Windows;
using System.Windows.Media;

namespace Cloudburst.UI.Controls
{
    public interface IBarSegment
    {
        double Value { get; }
        Brush Brush { get; }
    }

    /// <summary>Horizontal 100 % stacked bar with rounded ends.</summary>
    public sealed class StackedBar : FrameworkElement
    {
        public static readonly DependencyProperty SegmentsProperty = DependencyProperty.Register(nameof(Segments), typeof(IEnumerable), typeof(StackedBar),
            new FrameworkPropertyMetadata(null, FrameworkPropertyMetadataOptions.AffectsRender, OnSegmentsChanged));
        public static readonly DependencyProperty TrackBrushProperty = DependencyProperty.Register(nameof(TrackBrush), typeof(Brush), typeof(StackedBar),
            new FrameworkPropertyMetadata(new SolidColorBrush(Color.FromRgb(0x22, 0x2A, 0x35)), FrameworkPropertyMetadataOptions.AffectsRender));

        public IEnumerable Segments { get => (IEnumerable)GetValue(SegmentsProperty); set => SetValue(SegmentsProperty, value); }
        public Brush TrackBrush { get => (Brush)GetValue(TrackBrushProperty); set => SetValue(TrackBrushProperty, value); }

        private static void OnSegmentsChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
        {
            var bar = (StackedBar)d;
            if (e.OldValue is INotifyCollectionChanged o) o.CollectionChanged -= bar.OnCollectionChanged;
            if (e.NewValue is INotifyCollectionChanged n) n.CollectionChanged += bar.OnCollectionChanged;
        }

        private void OnCollectionChanged(object sender, NotifyCollectionChangedEventArgs e) => InvalidateVisual();

        protected override void OnRender(DrawingContext dc)
        {
            try
            {
                double w = ActualWidth, h = ActualHeight;
                if (w <= 0 || h <= 0) return;
                double r = h / 2;
                var clip = new RectangleGeometry(new Rect(0, 0, w, h), r, r);
                dc.PushClip(clip);
                dc.DrawRectangle(TrackBrush, null, new Rect(0, 0, w, h));
                var segs = Segments?.OfType<IBarSegment>().Where(s => s.Value > 0 && !double.IsNaN(s.Value)).ToList();
                if (segs != null && segs.Count > 0)
                {
                    double total = segs.Sum(s => s.Value);
                    double x = 0;
                    for (int i = 0; i < segs.Count; i++)
                    {
                        double sw = segs[i].Value / total * w;
                        dc.DrawRectangle(segs[i].Brush, null, new Rect(x, 0, Math.Max(0, sw + (i < segs.Count - 1 ? 0.5 : 0)), h));
                        x += sw;
                    }
                }
                dc.Pop();
            }
            catch (Exception) { }
        }
    }
}
