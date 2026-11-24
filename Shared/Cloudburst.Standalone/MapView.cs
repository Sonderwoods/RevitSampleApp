using System;
using System.Globalization;
using System.Linq;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Cloudburst.Grid;
using Cloudburst.Results;

namespace Cloudburst.Standalone
{
    /// <summary>Top-down 2D map: hillshade of the grid terrain, buildings, coloured result quads, flow paths and labels.</summary>
    public sealed class MapView : FrameworkElement
    {
        private SiteGrid _grid;
        private ResultVisual _visual;
        private WriteableBitmap _bmp;
        private byte[] _base; // BGRA hillshade
        private static readonly Typeface Face = new Typeface(new FontFamily("Segoe UI"), FontStyles.Normal, FontWeights.SemiBold, FontStretches.Normal);

        public MapView()
        {
            RenderOptions.SetBitmapScalingMode(this, BitmapScalingMode.NearestNeighbor);
            ClipToBounds = true;
        }

        public void SetGrid(SiteGrid grid)
        {
            if (ReferenceEquals(grid, _grid)) return;
            _grid = grid;
            _base = grid != null ? Hillshade(grid) : null;
            Compose();
        }

        public void SetVisual(ResultVisual v)
        {
            _visual = v;
            Compose();
        }

        private void Compose()
        {
            try
            {
                var g = _grid;
                if (g == null || _base == null) { _bmp = null; InvalidateVisual(); return; }
                var px = (byte[])_base.Clone();
                var m = _visual?.Mesh;
                if (m != null && m.QuadCount > 0)
                {
                    bool materials = _visual.Layer == ResultLayer.Materials;
                    double alpha = materials ? 0.72 : 0.9;
                    var V = m.Vertices; double cs = g.CellSize;
                    for (int q = 0; q < m.QuadCount; q++)
                    {
                        int b0 = m.Quads[4 * q], b2 = m.Quads[4 * q + 2];
                        double x0 = Math.Min(V[3 * b0], V[3 * b2]), x1 = Math.Max(V[3 * b0], V[3 * b2]);
                        double y0 = Math.Min(V[3 * b0 + 1], V[3 * b2 + 1]), y1 = Math.Max(V[3 * b0 + 1], V[3 * b2 + 1]);
                        int i0 = (int)Math.Floor((x0 - g.X0) / cs + 1e-6), i1 = (int)Math.Ceiling((x1 - g.X0) / cs - 1e-6);
                        int j0 = (int)Math.Floor((y0 - g.Y0) / cs + 1e-6), j1 = (int)Math.Ceiling((y1 - g.Y0) / cs - 1e-6);
                        uint c = unchecked((uint)m.VertexColors[b0]);
                        double a = ((c >> 24) / 255.0) * alpha;
                        if (a <= 0) continue;
                        byte r = (byte)(c >> 16), gg = (byte)(c >> 8), bb = (byte)c;
                        for (int j = Math.Max(0, j0); j < Math.Min(g.Ny, j1); j++)
                            for (int i = Math.Max(0, i0); i < Math.Min(g.Nx, i1); i++)
                            {
                                int o = ((g.Ny - 1 - j) * g.Nx + i) * 4;
                                px[o] = (byte)(px[o] * (1 - a) + bb * a);
                                px[o + 1] = (byte)(px[o + 1] * (1 - a) + gg * a);
                                px[o + 2] = (byte)(px[o + 2] * (1 - a) + r * a);
                            }
                    }
                }
                var bmp = new WriteableBitmap(g.Nx, g.Ny, 96, 96, PixelFormats.Bgra32, null);
                bmp.WritePixels(new Int32Rect(0, 0, g.Nx, g.Ny), px, g.Nx * 4, 0);
                bmp.Freeze();
                _bmp = bmp;
            }
            catch (Exception) { _bmp = null; }
            InvalidateVisual();
        }

        private static byte[] Hillshade(SiteGrid g)
        {
            int nx = g.Nx, ny = g.Ny;
            var z = g.TerrainZ; var hz = g.Z;
            var px = new byte[nx * ny * 4];
            double zmin = double.MaxValue, zmax = double.MinValue;
            for (int k = 0; k < z.Length; k++) if (g.Active[k] != 0) { zmin = Math.Min(zmin, z[k]); zmax = Math.Max(zmax, z[k]); }
            if (zmin > zmax) { zmin = 0; zmax = 1; }
            double range = Math.Max(0.01, zmax - zmin);
            double cs = g.CellSize, az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
            for (int j = 0; j < ny; j++)
                for (int i = 0; i < nx; i++)
                {
                    int k = j * nx + i;
                    int o = ((ny - 1 - j) * nx + i) * 4;
                    if (g.Active[k] == 0) { px[o] = 0x17; px[o + 1] = 0x11; px[o + 2] = 0x0D; px[o + 3] = 255; continue; }
                    float Z(int ii, int jj) { ii = Math.Max(0, Math.Min(nx - 1, ii)); jj = Math.Max(0, Math.Min(ny - 1, jj)); return hz[jj * nx + ii] * 3f; }
                    double dzdx = (Z(i + 1, j) - Z(i - 1, j)) / (2 * cs);
                    double dzdy = (Z(i, j + 1) - Z(i, j - 1)) / (2 * cs);
                    double slope = Math.Atan(Math.Sqrt(dzdx * dzdx + dzdy * dzdy));
                    double aspect = Math.Atan2(dzdy, -dzdx);
                    double shade = Math.Cos(Math.PI / 2 - alt) * Math.Cos(slope) + Math.Sin(Math.PI / 2 - alt) * Math.Sin(slope) * Math.Cos(az - aspect);
                    shade = Math.Max(0, Math.Min(1, shade));
                    double t = (z[k] - zmin) / range;
                    double r, gr, b;
                    if (g.Building[k] >= 0) { r = 92; gr = 100; b = 114; }
                    else { r = 38 + 40 * t; gr = 48 + 40 * t; b = 44 + 30 * t; } // low = dark green-grey, high = lighter
                    double f = 0.55 + 0.75 * shade;
                    px[o] = (byte)Math.Min(255, b * f);
                    px[o + 1] = (byte)Math.Min(255, gr * f);
                    px[o + 2] = (byte)Math.Min(255, r * f);
                    px[o + 3] = 255;
                }
            return px;
        }

        protected override void OnRender(DrawingContext dc)
        {
            try
            {
                double w = ActualWidth, h = ActualHeight;
                dc.DrawRectangle(new SolidColorBrush(Color.FromRgb(0x0A, 0x0E, 0x13)), null, new Rect(0, 0, w, h));
                var g = _grid;
                double ppd = VisualTreeHelper.GetDpi(this).PixelsPerDip;
                if (g == null || _bmp == null)
                {
                    var ft = new FormattedText("Load the demo site or build a grid to see the map", CultureInfo.InvariantCulture, FlowDirection.LeftToRight,
                                               Face, 14, new SolidColorBrush(Color.FromRgb(0x5F, 0x6E, 0x80)), ppd);
                    dc.DrawText(ft, new Point((w - ft.Width) / 2, (h - ft.Height) / 2));
                    return;
                }
                const double pad = 24;
                double s = Math.Min((w - 2 * pad) / g.Nx, (h - 2 * pad) / g.Ny);
                if (s <= 0) return;
                double ox = (w - g.Nx * s) / 2, oy = (h - g.Ny * s) / 2;
                var rect = new Rect(ox, oy, g.Nx * s, g.Ny * s);
                dc.DrawRoundedRectangle(null, new Pen(new SolidColorBrush(Color.FromRgb(0x23, 0x2D, 0x3A)), 1), Rect.Inflate(rect, 1, 1), 2, 2);
                dc.DrawImage(_bmp, rect);

                Point P(double x, double y) => new Point(ox + (x - g.X0) / g.CellSize * s, oy + (g.Ny - (y - g.Y0) / g.CellSize) * s);

                var v = _visual;
                if (v?.FlowPaths != null && v.FlowPaths.Count > 0 && (v.Layer == ResultLayer.FlowAccumulation || v.Layer == ResultLayer.Depth))
                {
                    double wmax = v.FlowPaths.Max(p => p.Weight != null && p.Weight.Length > 0 ? p.Weight.Max() : 1);
                    foreach (var p in v.FlowPaths)
                    {
                        if (p.Count < 2) continue;
                        double wt = p.Weight != null && p.Weight.Length > 0 ? p.Weight.Max() : 1;
                        double th = 0.6 + 3.2 * Math.Sqrt(Math.Max(0, wt) / Math.Max(1e-9, wmax));
                        var geo = new StreamGeometry();
                        using (var c = geo.Open())
                        {
                            c.BeginFigure(P(p.X[0], p.Y[0]), false, false);
                            for (int i = 1; i < p.Count; i++) c.LineTo(P(p.X[i], p.Y[i]), true, true);
                        }
                        geo.Freeze();
                        var pen = new Pen(new SolidColorBrush(Color.FromArgb(0xD0, 0x7D, 0xD3, 0xFC)), th) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round, LineJoin = PenLineJoin.Round };
                        dc.DrawGeometry(null, pen, geo);
                    }
                }
                if (v?.Labels != null)
                {
                    foreach (var l in v.Labels.Take(12))
                    {
                        var pt = P(l.X, l.Y);
                        var ft = new FormattedText(l.Text, CultureInfo.InvariantCulture, FlowDirection.LeftToRight, Face, 10.5, Brushes.White, ppd);
                        var r = new Rect(pt.X - ft.Width / 2 - 5, pt.Y - ft.Height - 8, ft.Width + 10, ft.Height + 4);
                        dc.DrawRoundedRectangle(new SolidColorBrush(Color.FromArgb(0xCC, 0x0D, 0x11, 0x17)), null, r, 4, 4);
                        dc.DrawText(ft, new Point(r.X + 5, r.Y + 2));
                        dc.DrawEllipse(Brushes.White, null, pt, 2.5, 2.5);
                    }
                }
                // scale bar
                double metres = Nice(g.Nx * g.CellSize / 5);
                double len = metres / g.CellSize * s;
                var y0 = rect.Bottom - 14; var x0 = rect.Left + 14;
                var penW = new Pen(Brushes.White, 2);
                dc.DrawLine(penW, new Point(x0, y0), new Point(x0 + len, y0));
                dc.DrawLine(penW, new Point(x0, y0 - 4), new Point(x0, y0 + 1));
                dc.DrawLine(penW, new Point(x0 + len, y0 - 4), new Point(x0 + len, y0 + 1));
                var st = new FormattedText($"{metres:0} m", CultureInfo.InvariantCulture, FlowDirection.LeftToRight, Face, 10.5, Brushes.White, ppd);
                dc.DrawText(st, new Point(x0 + len + 6, y0 - st.Height / 2 - 1));
            }
            catch (Exception) { }
        }

        private static double Nice(double v)
        {
            if (v <= 0) return 1;
            double p = Math.Pow(10, Math.Floor(Math.Log10(v)));
            foreach (var m in new[] { 1.0, 2, 5, 10 }) if (m * p >= v) return m * p;
            return 10 * p;
        }
    }
}
