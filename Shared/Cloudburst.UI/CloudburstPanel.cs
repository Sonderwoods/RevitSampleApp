using System.Windows.Controls;
using Cloudburst.Hosting;

namespace Cloudburst.UI
{
    /// <summary>The complete Cloudburst UI as a control (Revit dockable pane / Rhino window content). PLACEHOLDER — replaced by the full UI.</summary>
    public partial class CloudburstPanel : UserControl
    {
        public ICloudburstHost Host { get; }
        public CloudburstPanel(ICloudburstHost host) { Host = host; Content = new TextBlock { Text = "Cloudburst" }; }
    }
}
