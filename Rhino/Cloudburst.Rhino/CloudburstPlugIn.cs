using System;
using System.IO;
using System.Runtime.InteropServices;
using Cloudburst.Model;
using CloudburstRhinoCommon;
using Rhino;
using Rhino.PlugIns;

[assembly: Guid("6C1D8E36-2F4B-4E59-9B1A-3D7A5C0E8B21")]
[assembly: PlugInDescription(DescriptionType.Organization, "Cloudburst")]
[assembly: PlugInDescription(DescriptionType.WebSite, "https://github.com/")]

namespace CloudburstRhino
{
    /// <summary>Rhino 8 plug-in: owns the single <see cref="RhinoHost"/> and the modeless Cloudburst window.</summary>
    [Guid("0E8E2C55-5E4A-4C8F-A0B7-9D3E61F2C4A7")]
    public sealed class CloudburstPlugIn : PlugIn
    {
        public static CloudburstPlugIn Instance { get; private set; }
        public RhinoHost Host { get; private set; }

        private Cloudburst.UI.CloudburstWindow _window;
        private bool _appClosing;

        public CloudburstPlugIn() { Instance = this; }

        public override PlugInLoadTime LoadTime => PlugInLoadTime.AtStartup;

        protected override LoadReturnCode OnLoad(ref string errorMessage)
        {
            try
            {
                Host = new RhinoHost();
                string dir = null;
                try { dir = Path.GetDirectoryName(Assembly.Location); } catch { }
                NativeLoader.Preload(new[] { dir, AppContext.BaseDirectory });

                RhinoDoc.CloseDocument += OnCloseDocument;
                RhinoDoc.NewDocument += OnNewDocument;
                RhinoDoc.EndOpenDocument += OnEndOpenDocument;
                RhinoApp.Closing += (s, e) => { _appClosing = true; };

                // Report the engine status once Rhino is idle (the command line exists by then).
                RhinoApp.Idle += ReportEngineOnce;
                return LoadReturnCode.Success;
            }
            catch (Exception ex)
            {
                errorMessage = "Cloudburst failed to load: " + ex.Message;
                return LoadReturnCode.ErrorShowDialog;
            }
        }

        private void ReportEngineOnce(object sender, EventArgs e)
        {
            RhinoApp.Idle -= ReportEngineOnce;
            try { RhinoApp.WriteLine($"Cloudburst {GetType().Assembly.GetName().Version} loaded (engine {Engine.Version}). Type Cloudburst to start."); }
            catch (Exception ex) { RhinoApp.WriteLine("Cloudburst: the native engine (cloudburst_core.dll) could not be loaded: " + ex.Message); }
        }

        private void OnCloseDocument(object sender, DocumentEventArgs e)
        {
            try { Host?.ResetAll(); } catch { }
        }

        private void OnNewDocument(object sender, DocumentEventArgs e)
        {
            try { Host?.ResetAll(); } catch { }
        }

        private void OnEndOpenDocument(object sender, DocumentOpenEventArgs e)
        {
            try
            {
                if (e.Merge || e.Reference) return;
                Host?.ResetAll();
                Host?.RestoreFromDocument(e.Document);
            }
            catch { }
        }

        /// <summary>Open (or bring to front) the single modeless Cloudburst window owned by Rhino's main window.</summary>
        public bool ShowWindow()
        {
            try
            {
                if (_window == null)
                {
                    var owner = RhinoApp.MainWindowHandle();
                    _window = new Cloudburst.UI.CloudburstWindow(Host, owner);
                    try { System.Windows.Forms.Integration.ElementHost.EnableModelessKeyboardInterop(_window); } catch { }
                    _window.Closing += (s, e) =>
                    {
                        if (_appClosing) return;
                        e.Cancel = true;            // keep the window (and its state) alive; just hide it
                        try { _window.Hide(); } catch { }
                    };
                    _window.Closed += (s, e) => { _window = null; };
                }
                if (_window.WindowState == System.Windows.WindowState.Minimized) _window.WindowState = System.Windows.WindowState.Normal;
                _window.Show();
                _window.Activate();
                return true;
            }
            catch (Exception ex)
            {
                RhinoApp.WriteLine("Cloudburst: could not open the window: " + ex.Message);
                _window = null;
                return false;
            }
        }
    }
}
