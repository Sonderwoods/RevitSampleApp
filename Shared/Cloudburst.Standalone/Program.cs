using System;
using System.Windows;
using System.Windows.Threading;

namespace Cloudburst.Standalone
{
    public static class Program
    {
        [STAThread]
        public static int Main()
        {
            var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            app.DispatcherUnhandledException += (s, e) =>
            {
                MessageBox.Show(e.Exception.ToString(), "Cloudburst – unexpected error", MessageBoxButton.OK, MessageBoxImage.Error);
                e.Handled = true;
            };
            var w = new MainWindow();
            return app.Run(w);
        }
    }
}
