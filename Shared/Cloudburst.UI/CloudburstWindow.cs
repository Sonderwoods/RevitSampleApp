using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Cloudburst.Hosting;

namespace Cloudburst.UI
{
    /// <summary>Modeless, dark tool window hosting a <see cref="CloudburstPanel"/> (Rhino, standalone).</summary>
    public partial class CloudburstWindow : Window
    {
        /// <summary>When true (default) the window enables WinForms modeless keyboard interop if WindowsFormsIntegration is available,
        /// so text boxes receive keystrokes when the host's message loop is WinForms (Rhino).</summary>
        public static bool EnableWinFormsKeyboardInterop { get; set; } = true;

        public CloudburstPanel Panel { get; }

        public CloudburstWindow(ICloudburstHost host, IntPtr owner = default)
        {
            Title = "Cloudburst";
            Width = 440;
            double h = 900;
            try { h = Math.Min(900, SystemParameters.WorkArea.Height - 40); } catch (Exception) { }
            Height = Math.Max(480, h);
            MinWidth = 360;
            MinHeight = 420;
            ShowInTaskbar = false;
            ResizeMode = ResizeMode.CanResize;
            WindowStartupLocation = owner != IntPtr.Zero ? WindowStartupLocation.CenterOwner : WindowStartupLocation.CenterScreen;
            Background = new SolidColorBrush(Color.FromRgb(0x0D, 0x11, 0x17));
            UseLayoutRounding = true;

            Panel = new CloudburstPanel(host);
            Content = Panel;

            try { if (owner != IntPtr.Zero) new WindowInteropHelper(this).Owner = owner; } catch (Exception) { }
            SourceInitialized += (s, e) => TryDarkTitleBar();
            Closed += (s, e) => { try { Panel.Dispose(); } catch (Exception) { } };
            if (EnableWinFormsKeyboardInterop) TryKeyboardInterop();
        }

        private void TryKeyboardInterop()
        {
            try
            {
                var t = Type.GetType("System.Windows.Forms.Integration.ElementHost, WindowsFormsIntegration", throwOnError: false);
                var m = t?.GetMethod("EnableModelessKeyboardInterop", new[] { typeof(Window) });
                m?.Invoke(null, new object[] { this });
            }
            catch (Exception) { /* optional */ }
        }

        [DllImport("dwmapi.dll", PreserveSig = true)]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        private void TryDarkTitleBar()
        {
            try
            {
                var hwnd = new WindowInteropHelper(this).Handle;
                if (hwnd == IntPtr.Zero) return;
                int on = 1;
                if (DwmSetWindowAttribute(hwnd, 20, ref on, sizeof(int)) != 0) DwmSetWindowAttribute(hwnd, 19, ref on, sizeof(int));
            }
            catch (Exception) { }
        }
    }
}
