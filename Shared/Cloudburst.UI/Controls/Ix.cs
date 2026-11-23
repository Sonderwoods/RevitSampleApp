using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace Cloudburst.UI.Controls
{
    /// <summary>Attached properties used by the theme templates (icon glyph, hover brushes, placeholder, unit suffix) and small behaviours.</summary>
    public static class Ix
    {
        public static readonly DependencyProperty GlyphProperty = DependencyProperty.RegisterAttached(
            "Glyph", typeof(string), typeof(Ix), new FrameworkPropertyMetadata(null, FrameworkPropertyMetadataOptions.Inherits));
        public static string GetGlyph(DependencyObject o) => (string)o.GetValue(GlyphProperty);
        public static void SetGlyph(DependencyObject o, string v) => o.SetValue(GlyphProperty, v);

        public static readonly DependencyProperty GlyphSizeProperty = DependencyProperty.RegisterAttached(
            "GlyphSize", typeof(double), typeof(Ix), new FrameworkPropertyMetadata(13.0));
        public static double GetGlyphSize(DependencyObject o) => (double)o.GetValue(GlyphSizeProperty);
        public static void SetGlyphSize(DependencyObject o, double v) => o.SetValue(GlyphSizeProperty, v);

        public static readonly DependencyProperty HoverProperty = DependencyProperty.RegisterAttached(
            "Hover", typeof(Brush), typeof(Ix), new FrameworkPropertyMetadata(null));
        public static Brush GetHover(DependencyObject o) => (Brush)o.GetValue(HoverProperty);
        public static void SetHover(DependencyObject o, Brush v) => o.SetValue(HoverProperty, v);

        public static readonly DependencyProperty PressedProperty = DependencyProperty.RegisterAttached(
            "Pressed", typeof(Brush), typeof(Ix), new FrameworkPropertyMetadata(null));
        public static Brush GetPressed(DependencyObject o) => (Brush)o.GetValue(PressedProperty);
        public static void SetPressed(DependencyObject o, Brush v) => o.SetValue(PressedProperty, v);

        public static readonly DependencyProperty RadiusProperty = DependencyProperty.RegisterAttached(
            "Radius", typeof(CornerRadius), typeof(Ix), new FrameworkPropertyMetadata(new CornerRadius(8)));
        public static CornerRadius GetRadius(DependencyObject o) => (CornerRadius)o.GetValue(RadiusProperty);
        public static void SetRadius(DependencyObject o, CornerRadius v) => o.SetValue(RadiusProperty, v);

        public static readonly DependencyProperty PlaceholderProperty = DependencyProperty.RegisterAttached(
            "Placeholder", typeof(string), typeof(Ix), new FrameworkPropertyMetadata(null));
        public static string GetPlaceholder(DependencyObject o) => (string)o.GetValue(PlaceholderProperty);
        public static void SetPlaceholder(DependencyObject o, string v) => o.SetValue(PlaceholderProperty, v);

        public static readonly DependencyProperty SuffixProperty = DependencyProperty.RegisterAttached(
            "Suffix", typeof(string), typeof(Ix), new FrameworkPropertyMetadata(null));
        public static string GetSuffix(DependencyObject o) => (string)o.GetValue(SuffixProperty);
        public static void SetSuffix(DependencyObject o, string v) => o.SetValue(SuffixProperty, v);

        // ---- Behaviour: Enter key commits a TextBox binding (default trigger is LostFocus).
        public static readonly DependencyProperty CommitOnEnterProperty = DependencyProperty.RegisterAttached(
            "CommitOnEnter", typeof(bool), typeof(Ix), new PropertyMetadata(false, OnCommitOnEnter));
        public static bool GetCommitOnEnter(DependencyObject o) => (bool)o.GetValue(CommitOnEnterProperty);
        public static void SetCommitOnEnter(DependencyObject o, bool v) => o.SetValue(CommitOnEnterProperty, v);

        private static void OnCommitOnEnter(DependencyObject d, DependencyPropertyChangedEventArgs e)
        {
            if (d is TextBox tb)
            {
                tb.KeyDown -= CommitKeyDown;
                if ((bool)e.NewValue) tb.KeyDown += CommitKeyDown;
            }
        }

        private static void CommitKeyDown(object sender, KeyEventArgs e)
        {
            try
            {
                if (e.Key != Key.Enter && e.Key != Key.Return) return;
                if (sender is TextBox tb && !tb.AcceptsReturn)
                {
                    tb.GetBindingExpression(TextBox.TextProperty)?.UpdateSource();
                    tb.SelectAll();
                    e.Handled = true;
                }
            }
            catch (Exception) { }
        }

        // ---- Behaviour: an inner scroller passes the mouse wheel on to the page when it is at its top/bottom.
        public static readonly DependencyProperty BubbleWheelProperty = DependencyProperty.RegisterAttached(
            "BubbleWheel", typeof(bool), typeof(Ix), new PropertyMetadata(false, OnBubbleWheel));
        public static bool GetBubbleWheel(DependencyObject o) => (bool)o.GetValue(BubbleWheelProperty);
        public static void SetBubbleWheel(DependencyObject o, bool v) => o.SetValue(BubbleWheelProperty, v);

        private static void OnBubbleWheel(DependencyObject d, DependencyPropertyChangedEventArgs e)
        {
            if (d is UIElement u)
            {
                u.PreviewMouseWheel -= WheelPreview;
                if ((bool)e.NewValue) u.PreviewMouseWheel += WheelPreview;
            }
        }

        private static void WheelPreview(object sender, MouseWheelEventArgs e)
        {
            try
            {
                if (e.Handled || !(sender is DependencyObject d)) return;
                var sv = d as ScrollViewer ?? FindChild<ScrollViewer>(d);
                bool atTop = sv == null || sv.VerticalOffset <= 0;
                bool atBottom = sv == null || sv.VerticalOffset >= sv.ScrollableHeight - 0.5;
                if ((e.Delta > 0 && atTop) || (e.Delta < 0 && atBottom))
                {
                    e.Handled = true;
                    var parent = VisualTreeHelper.GetParent(d) as UIElement;
                    parent?.RaiseEvent(new MouseWheelEventArgs(e.MouseDevice, e.Timestamp, e.Delta) { RoutedEvent = UIElement.MouseWheelEvent, Source = sender });
                }
            }
            catch (Exception) { }
        }

        internal static T FindChild<T>(DependencyObject d) where T : DependencyObject
        {
            if (d == null) return null;
            int n = VisualTreeHelper.GetChildrenCount(d);
            for (int i = 0; i < n; i++)
            {
                var c = VisualTreeHelper.GetChild(d, i);
                if (c is T t) return t;
                var r = FindChild<T>(c);
                if (r != null) return r;
            }
            return null;
        }
    }
}
