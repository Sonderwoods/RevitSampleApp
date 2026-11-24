using System;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Cloudburst.Results;
using Cloudburst.UI;
using WGrid = System.Windows.Controls.Grid;

namespace Cloudburst.Standalone
{
    /// <summary>Map on the left, the shared Cloudburst panel on the right.</summary>
    public sealed class MainWindow : Window
    {
        private readonly FakeHost _host = new FakeHost();
        private readonly MapView _map = new MapView();
        private readonly CloudburstPanel _panel;
        private readonly TextBlock _title, _caption;
        private readonly StackPanel _legend;

        public MainWindow()
        {
            Title = "Cloudburst – standalone preview";
            Width = 1400; Height = 900; MinWidth = 900; MinHeight = 600;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Background = new SolidColorBrush(Color.FromRgb(0x0D, 0x11, 0x17));
            UseLayoutRounding = true;

            _panel = new CloudburstPanel(_host);
            var root = new WGrid();
            root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1) });
            root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(420) });

            var left = new WGrid();
            left.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            left.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            left.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var header = new StackPanel { Margin = new Thickness(24, 18, 24, 6) };
            _title = new TextBlock { Text = "Map preview", FontSize = 18, FontWeight = FontWeights.SemiBold, Foreground = Brushes.White, FontFamily = new FontFamily("Segoe UI Variable Display, Segoe UI") };
            _caption = new TextBlock { Text = "Top-down view of the analysis grid. In Rhino and Revit the same results are drawn in the model.", FontSize = 11.5, TextWrapping = TextWrapping.Wrap,
                                       Foreground = new SolidColorBrush(Color.FromRgb(0x93, 0xA1, 0xB3)), Margin = new Thickness(0, 3, 0, 0) };
            header.Children.Add(_title); header.Children.Add(_caption);
            left.Children.Add(header);
            WGrid.SetRow(_map, 1);
            left.Children.Add(_map);
            _legend = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(24, 4, 24, 16) };
            WGrid.SetRow(_legend, 2);
            left.Children.Add(_legend);

            var split = new Border { Background = new SolidColorBrush(Color.FromRgb(0x23, 0x2D, 0x3A)) };
            WGrid.SetColumn(split, 1);
            WGrid.SetColumn(_panel, 2);
            root.Children.Add(left); root.Children.Add(split); root.Children.Add(_panel);
            Content = root;

            _host.VisualShown += OnVisual;
            Closed += (s, e) => _panel.Dispose();
        }

        private void OnVisual(ResultVisual v)
        {
            try
            {
                _map.SetGrid(_panel.Session?.Grid);
                _map.SetVisual(v);
                _title.Text = v?.Title ?? "Map preview";
                _caption.Text = v?.Caption ?? "";
                _legend.Children.Clear();
                if (v?.Legend == null) return;
                foreach (var li in v.Legend.Take(12))
                {
                    uint c = unchecked((uint)li.Argb);
                    var sp = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 14, 0) };
                    sp.Children.Add(new Border { Width = 16, Height = 10, CornerRadius = new CornerRadius(2), Margin = new Thickness(0, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center,
                                                 Background = new SolidColorBrush(Color.FromArgb((byte)(c >> 24), (byte)(c >> 16), (byte)(c >> 8), (byte)c)) });
                    sp.Children.Add(new TextBlock { Text = li.Label, FontSize = 11, Foreground = new SolidColorBrush(Color.FromRgb(0xE6, 0xED, 0xF3)), VerticalAlignment = VerticalAlignment.Center });
                    _legend.Children.Add(sp);
                }
            }
            catch (Exception ex) { _panel.ShowMessage("Map: " + ex.Message, true); }
        }
    }
}
