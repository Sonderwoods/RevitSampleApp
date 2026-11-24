using System;
using Autodesk.Revit.Attributes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace Cloudburst.Revit.Commands
{
    public sealed class AlwaysAvailable : IExternalCommandAvailability
    {
        public bool IsCommandAvailable(UIApplication app, CategorySet selected) => true;
    }

    internal static class CommandHelper
    {
        public static void ShowError(string title, Exception ex)
        {
            Logger.Write(title + ": " + ex);
            try { TaskDialog.Show("Cloudburst", title + "\n\n" + ex.Message); } catch { }
        }

        public static void ShowPane(UIApplication app)
        {
            try
            {
                if (!App.PaneRegistered) return;
                var pane = app.GetDockablePane(App.PaneId);
                if (pane != null && !pane.IsShown()) pane.Show();
            }
            catch (Exception ex) { Logger.Write("ShowPane: " + ex.Message); }
        }
    }

    /// <summary>Toggle the dockable pane (falls back to the floating window).</summary>
    [Transaction(TransactionMode.Manual)]
    public sealed class TogglePaneCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData data, ref string message, ElementSet elements)
        {
            try
            {
                if (!App.PaneRegistered) { WindowCommand.ShowWindow(data.Application); return Result.Succeeded; }
                var pane = data.Application.GetDockablePane(App.PaneId);
                if (pane.IsShown()) pane.Hide(); else pane.Show();
                return Result.Succeeded;
            }
            catch (Exception ex)
            {
                Logger.Write("Toggle pane failed, opening window: " + ex.Message);
                try { WindowCommand.ShowWindow(data.Application); return Result.Succeeded; }
                catch (Exception ex2) { CommandHelper.ShowError("Could not open the Cloudburst panel.", ex2); return Result.Cancelled; }
            }
        }
    }

    /// <summary>Build the demo site directly (already in API context) and show the panel.</summary>
    [Transaction(TransactionMode.Manual)]
    public sealed class DemoSiteCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData data, ref string message, ElementSet elements)
        {
            try
            {
                App.Host.CreateDemoSiteCore(data.Application, Cloudburst.Demo.DemoSite.Create());
                CommandHelper.ShowPane(data.Application);
                return Result.Succeeded;
            }
            catch (Exception ex)
            {
                CommandHelper.ShowError("The demo site could not be created.", ex);
                return Result.Cancelled;
            }
        }
    }

    [Transaction(TransactionMode.Manual)]
    public sealed class ClearPreviewCommand : IExternalCommand
    {
        public Result Execute(ExternalCommandData data, ref string message, ElementSet elements)
        {
            // Queue through the bridge (keeps tracking in one place); it runs as soon as this command returns.
            try
            {
                var task = App.Host.ClearPreviewAsync();
                task.ContinueWith(t => Logger.Write("Clear preview failed: " + t.Exception?.GetBaseException().Message),
                    System.Threading.Tasks.TaskContinuationOptions.OnlyOnFaulted);
                return Result.Succeeded;
            }
            catch (Exception ex)
            {
                CommandHelper.ShowError("Could not clear the preview.", ex);
                return Result.Cancelled;
            }
        }
    }

    /// <summary>Modeless <see cref="Cloudburst.UI.CloudburstWindow"/> owned by the Revit main window.</summary>
    [Transaction(TransactionMode.Manual)]
    public sealed class WindowCommand : IExternalCommand
    {
        private static Cloudburst.UI.CloudburstWindow _window;

        public Result Execute(ExternalCommandData data, ref string message, ElementSet elements)
        {
            try { ShowWindow(data.Application); return Result.Succeeded; }
            catch (Exception ex) { CommandHelper.ShowError("Could not open the Cloudburst window.", ex); return Result.Cancelled; }
        }

        public static void ShowWindow(UIApplication app)
        {
            if (_window != null)
            {
                try
                {
                    if (_window.IsLoaded)
                    {
                        if (_window.WindowState == System.Windows.WindowState.Minimized) _window.WindowState = System.Windows.WindowState.Normal;
                        _window.Activate();
                        return;
                    }
                }
                catch { }
                _window = null;
            }
            _window = new Cloudburst.UI.CloudburstWindow(App.Host, app.MainWindowHandle);
            _window.Closed += (s, e) => _window = null;
            _window.Show();
        }

        public static void CloseWindow()
        {
            try { _window?.Close(); } catch { }
            _window = null;
        }
    }
}
