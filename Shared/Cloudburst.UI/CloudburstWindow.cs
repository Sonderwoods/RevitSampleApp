using System;
using System.Windows;
using System.Windows.Interop;
using Cloudburst.Hosting;

namespace Cloudburst.UI
{
    /// <summary>Modeless tool window hosting <see cref="CloudburstPanel"/>. PLACEHOLDER — replaced by the full UI.</summary>
    public partial class CloudburstWindow : Window
    {
        public CloudburstPanel Panel { get; }
        public CloudburstWindow(ICloudburstHost host, IntPtr owner = default)
        {
            Title = "Cloudburst"; Width = 420; Height = 860;
            Panel = new CloudburstPanel(host); Content = Panel;
            if (owner != IntPtr.Zero) new WindowInteropHelper(this).Owner = owner;
        }
    }
}
