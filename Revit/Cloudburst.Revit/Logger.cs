using System;
using System.Diagnostics;
using System.IO;

namespace Cloudburst.Revit
{
    /// <summary>Tiny file logger: %TEMP%\Cloudburst\revit.log. Never throws.</summary>
    internal static class Logger
    {
        private static readonly object Gate = new object();
        public static string FilePath { get; } = Path.Combine(Path.GetTempPath(), "Cloudburst", "revit.log");

        public static void Write(string message)
        {
            try
            {
                Debug.WriteLine("[Cloudburst] " + message);
                lock (Gate)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(FilePath));
                    File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
                }
            }
            catch { }
        }
    }
}
