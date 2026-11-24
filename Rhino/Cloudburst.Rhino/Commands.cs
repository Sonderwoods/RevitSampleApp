using System;
using System.Runtime.InteropServices;
using Cloudburst.Demo;
using Rhino;
using Rhino.Commands;

namespace CloudburstRhino
{
    /// <summary>Open / focus the Cloudburst window.</summary>
    [Guid("9A4F0D2B-7C61-4E3A-8B55-21C6E7D9F0A1")]
    public sealed class CloudburstCommand : Command
    {
        public override string EnglishName => "Cloudburst";

        protected override Result RunCommand(RhinoDoc doc, RunMode mode)
        {
            try { return CloudburstPlugIn.Instance?.ShowWindow() == true ? Result.Success : Result.Failure; }
            catch (Exception ex) { RhinoApp.WriteLine("Cloudburst: " + ex.Message); return Result.Failure; }
        }
    }

    /// <summary>Create the built-in demo site (terrain, buildings, surfaces, kerbs) and register it as the current picks.</summary>
    [Guid("3E7B5A19-0D84-4F26-9C3B-6A1E8F4D2B70")]
    public sealed class CloudburstDemoCommand : Command
    {
        public override string EnglishName => "CloudburstDemo";

        protected override Result RunCommand(RhinoDoc doc, RunMode mode)
        {
            try
            {
                var host = CloudburstPlugIn.Instance?.Host;
                if (host == null) return Result.Failure;
                // Runs synchronously: commands execute on Rhino's UI thread, so the host does not post.
                bool ok = host.CreateDemoSiteAsync(DemoSite.Create()).GetAwaiter().GetResult();
                return ok ? Result.Success : Result.Failure;
            }
            catch (Exception ex) { RhinoApp.WriteLine("Cloudburst: demo failed: " + ex.Message); return Result.Failure; }
        }
    }

    /// <summary>Remove the Cloudburst result preview from the viewports.</summary>
    [Guid("C52D7E80-1B39-4A6F-8E24-5F0B9A3C7D16")]
    public sealed class CloudburstClearCommand : Command
    {
        public override string EnglishName => "CloudburstClear";

        protected override Result RunCommand(RhinoDoc doc, RunMode mode)
        {
            try
            {
                CloudburstPlugIn.Instance?.Host?.ClearPreviewAsync().GetAwaiter().GetResult();
                return Result.Success;
            }
            catch (Exception ex) { RhinoApp.WriteLine("Cloudburst: " + ex.Message); return Result.Failure; }
        }
    }
}
