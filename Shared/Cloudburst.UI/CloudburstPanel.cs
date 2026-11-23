using System.Windows.Controls;
using Cloudburst.Hosting;
namespace Cloudburst.UI { public partial class CloudburstPanel : UserControl { public ICloudburstHost Host { get; } public CloudburstPanel(ICloudburstHost host) { Host = host; } } }
