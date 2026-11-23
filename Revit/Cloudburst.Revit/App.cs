using System;
using System.Windows;
using System.Windows.Controls;
using Autodesk.Revit.UI;

namespace Cloudburst.Revit
{
    /// <summary>Revit entry point: ribbon tab "Cloudburst", dockable pane, host + ExternalEvent bridge.</summary>
    public sealed class App : IExternalApplication
    {
        public const string TabName = "Cloudburst";
        public const string PanelName = "Rainwater";
        public static readonly DockablePaneId PaneId = new DockablePaneId(new Guid("3C8E1B52-7F0A-4D6B-9E21-5A4F2C9B7D13"));

        public static RevitBridge Bridge { get; private set; }
        public static RevitHost Host { get; private set; }
        public static bool PaneRegistered { get; private set; }

        public Result OnStartup(UIControlledApplication app)
        {
            try
            {
                Bridge = new RevitBridge();
                Bridge.Initialize();                 // ExternalEvent.Create — valid here
                Host = new RevitHost(Bridge);
                Logger.Write("Cloudburst starting (Revit " + app.ControlledApplication.VersionNumber + ").");
            }
            catch (Exception ex)
            {
                Logger.Write("Startup (host) failed: " + ex);
                return Result.Failed;
            }

            try { CreateRibbon(app); }
            catch (Exception ex) { Logger.Write("Ribbon failed: " + ex); }

            try
            {
                app.RegisterDockablePane(PaneId, "Cloudburst", new PaneProvider(Host));
                PaneRegistered = true;
            }
            catch (Exception ex) { Logger.Write("Dockable pane registration failed (the Window command still works): " + ex); }
            return Result.Succeeded;
        }

        public Result OnShutdown(UIControlledApplication app)
        {
            try { Commands.WindowCommand.CloseWindow(); } catch { }
            try { Bridge?.Dispose(); } catch { }
            return Result.Succeeded;
        }

        private static void CreateRibbon(UIControlledApplication app)
        {
            try { app.CreateRibbonTab(TabName); } catch { /* exists already */ }
            RibbonPanel panel = null;
            try { panel = app.CreateRibbonPanel(TabName, PanelName); }
            catch { panel = app.CreateRibbonPanel(PanelName); }
            string asm = typeof(App).Assembly.Location;

            PushButtonData Btn(string name, string text, Type cmd, Icons.Kind icon, string tip, bool always)
            {
                var d = new PushButtonData(name, text, asm, cmd.FullName)
                {
                    ToolTip = tip,
                    LargeImage = Icons.Create(icon, 32),
                    Image = Icons.Create(icon, 16)
                };
                if (always) d.AvailabilityClassName = typeof(Commands.AlwaysAvailable).FullName;
                return d;
            }

            panel.AddItem(Btn("CloudburstPane", "Cloudburst", typeof(Commands.TogglePaneCommand), Icons.Kind.Drop,
                "Show or hide the Cloudburst panel: pick terrain, buildings and surfaces, run the rain event and preview flooding.", true));
            panel.AddItem(Btn("CloudburstDemo", "Demo site", typeof(Commands.DemoSiteCommand), Icons.Kind.Demo,
                "Create the built-in 300 × 200 m demo block (terrain, buildings, surfaces, kerbs) and select it for analysis.", false));
            panel.AddItem(Btn("CloudburstClear", "Clear preview", typeof(Commands.ClearPreviewCommand), Icons.Kind.Clear,
                "Remove the Cloudburst result preview from the model (baked results stay).", false));
            panel.AddSeparator();
            panel.AddItem(Btn("CloudburstWindow", "Window", typeof(Commands.WindowCommand), Icons.Kind.Window,
                "Open Cloudburst as a floating window (fallback if the dockable panel is unavailable).", true));
        }
    }

    /// <summary>Supplies the WPF panel to Revit's dockable pane framework.</summary>
    internal sealed class PaneProvider : IDockablePaneProvider
    {
        private readonly RevitHost _host;
        public PaneProvider(RevitHost host) { _host = host; }

        public void SetupDockablePane(DockablePaneProviderData data)
        {
            data.FrameworkElement = CreatePanel(_host);
            data.VisibleByDefault = false;
            var state = new DockablePaneState
            {
                DockPosition = DockPosition.Right,
                MinimumWidth = 400,
                MinimumHeight = 300
            };
            try { state.SetFloatingRectangle(new Autodesk.Revit.DB.Rectangle(200, 120, 620, 940)); } catch { }
            data.InitialState = state;
        }

        internal static FrameworkElement CreatePanel(RevitHost host)
        {
            try { return new Cloudburst.UI.CloudburstPanel(host); }
            catch (Exception ex)
            {
                Logger.Write("CloudburstPanel failed: " + ex);
                return new TextBlock { Text = "Cloudburst UI failed to load:\n" + ex.Message, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(12) };
            }
        }
    }
}
