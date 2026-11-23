using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using Cloudburst.Hosting;
using Cloudburst.Model;
using Cloudburst.UI.ViewModels;

namespace Cloudburst.UI
{
    /// <summary>
    /// The complete Cloudburst UI as a control: Revit dockable pane content or Rhino tool window content.
    /// Self-contained theme (no App.xaml needed). Never throws into the host: failures become status messages.
    /// </summary>
    public partial class CloudburstPanel : UserControl, IDisposable
    {
        private static readonly HashSet<Dispatcher> _guarded = new HashSet<Dispatcher>();

        static CloudburstPanel()
        {
            // Registers the pack:// URI scheme when the host never created a WPF Application (Rhino).
            try { _ = System.IO.Packaging.PackUriHelper.UriSchemePack; } catch (Exception) { }
        }

        /// <summary>The CAD host this panel talks to.</summary>
        public ICloudburstHost Host { get; }

        /// <summary>The view model (null only if the UI failed to initialise).</summary>
        public MainViewModel ViewModel { get; }

        /// <summary>The analysis session behind the panel (null if the engine failed to load).</summary>
        public CloudburstSession Session => ViewModel?.Session;

        public CloudburstPanel(ICloudburstHost host)
        {
            Host = host;
            try
            {
                InitializeComponent();
            }
            catch (Exception ex)
            {
                ShowFatal("The Cloudburst panel could not be created.", ex);
                return;
            }

            try
            {
                ViewModel = new MainViewModel(host, Dispatcher);
                DataContext = ViewModel;
                ViewModel.PropertyChanged += OnViewModelChanged;
                Loaded += OnLoaded;
                InstallSafetyNet(Dispatcher);
            }
            catch (Exception ex)
            {
                ShowFatal("The Cloudburst session could not be started.", ex);
            }
        }

        private void OnLoaded(object sender, RoutedEventArgs e)
        {
            try { ViewModel?.RefreshPicks(); } catch (Exception) { }
        }

        private void OnViewModelChanged(object sender, PropertyChangedEventArgs e)
        {
            try
            {
                if (e.PropertyName == nameof(MainViewModel.CurrentStepIndex)) MainScroll?.ScrollToTop();
            }
            catch (Exception) { }
        }

        /// <summary>Show a message in the panel's status bar (non-blocking).</summary>
        public void ShowMessage(string message, bool isError = false)
        {
            try { ViewModel?.Toast(message, isError ? "Error" : "Info"); } catch (Exception) { }
        }

        /// <summary>Re-read pick summaries from the host (e.g. after the user edited the model).</summary>
        public void RefreshPicks()
        {
            try { ViewModel?.RefreshPicks(); } catch (Exception) { }
        }

        /// <summary>Cancel running work and free native memory. Call when the host closes the panel for good.</summary>
        public void Dispose()
        {
            try { ViewModel?.Dispose(); } catch (Exception) { }
        }

        private void ShowFatal(string title, Exception ex)
        {
            try
            {
                var inner = ex;
                while (inner.InnerException != null) inner = inner.InnerException;
                Content = new Border
                {
                    Background = new SolidColorBrush(Color.FromRgb(0x0D, 0x11, 0x17)),
                    Padding = new Thickness(16),
                    Child = new TextBlock
                    {
                        Text = $"{title}\n\n{inner.GetType().Name}: {inner.Message}",
                        Foreground = new SolidColorBrush(Color.FromRgb(0xF8, 0x71, 0x71)),
                        TextWrapping = TextWrapping.Wrap,
                        FontSize = 12
                    }
                };
                try { Host?.Log($"Cloudburst UI: {title} {ex}"); } catch (Exception) { }
            }
            catch (Exception) { }
        }

        /// <summary>
        /// Last-resort guard: an unhandled exception raised by Cloudburst code on the UI thread is shown in the panel
        /// instead of terminating Rhino/Revit. Exceptions from other code are left to the host.
        /// </summary>
        private void InstallSafetyNet(Dispatcher d)
        {
            lock (_guarded)
            {
                if (!_guarded.Add(d)) return;
            }
            d.UnhandledException += (s, e) =>
            {
                try
                {
                    var st = e.Exception?.ToString() ?? "";
                    if (st.IndexOf("Cloudburst.", StringComparison.Ordinal) < 0) return;
                    e.Handled = true;
                    ViewModel?.ShowError(null, e.Exception);
                }
                catch (Exception) { }
            };
        }
    }
}
