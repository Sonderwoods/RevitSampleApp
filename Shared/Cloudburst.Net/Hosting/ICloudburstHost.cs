using System.Collections.Generic;
using System.Threading.Tasks;
using Cloudburst.Results;

namespace Cloudburst.Hosting
{
    /// <summary>What the user is asked to pick in the host CAD application.</summary>
    public enum PickRole
    {
        /// <summary>Existing terrain: meshes/surfaces (Rhino), Toposolid/TopographySurface (Revit).</summary>
        Terrain,
        /// <summary>Design terrain that replaces existing heights where it covers.</summary>
        DesignTerrain,
        /// <summary>Buildings: closed breps/meshes/extrusions (Rhino), walls/roofs/masses/families (Revit).</summary>
        Buildings,
        /// <summary>Surface material regions: closed curves, hatches, surfaces/meshes (Rhino); floors, toposolid sub-divisions (Revit).
        /// With materialId = null the host guesses the material from layer/material/object names.</summary>
        Surfaces,
        /// <summary>Kerbs/walls (positive height) or channels (negative) as curves/lines.</summary>
        Walls,
        /// <summary>Bridge deck cut-out polygons.</summary>
        BridgeCuts,
        /// <summary>Optional analysis boundary polygon.</summary>
        Boundary,
        /// <summary>Probe points for time series.</summary>
        Probes
    }

    public sealed class PickSummary
    {
        public PickRole Role { get; set; }
        public int Count { get; set; }
        /// <summary>Short human text, e.g. "3 meshes, 120 k triangles".</summary>
        public string Description { get; set; } = "";
        /// <summary>For Surfaces: material id → object count.</summary>
        public Dictionary<string, int> Materials { get; set; } = new Dictionary<string, int>();
        public static PickSummary Empty(PickRole r) => new PickSummary { Role = r, Description = "Nothing selected" };
    }

    /// <summary>
    /// Implemented once per CAD host (Rhino 8, Revit 2026). The shared WPF UI talks only to this interface.
    /// All coordinates crossing this interface are METRES in the host's world XY (Z up). Hosts convert units.
    /// Methods may be called from the UI thread; implementations marshal to their API thread/context
    /// (Rhino: UI thread, Revit: ExternalEvent) and complete the task when done.
    /// </summary>
    public interface ICloudburstHost
    {
        /// <summary>"Rhino 8" / "Revit 2026".</summary>
        string HostName { get; }

        /// <summary>Let the user pick objects for a role and remember them (replacing earlier picks for that role,
        /// except Surfaces which accumulate per material). Returns a summary of what is stored now.</summary>
        Task<PickSummary> PickAsync(PickRole role, string materialId = null, double wallHeight = 0.10);

        /// <summary>Forget picks for a role.</summary>
        void Clear(PickRole role);

        PickSummary GetSummary(PickRole role);

        /// <summary>Convert stored picks into a host-neutral site description (metres).</summary>
        Task<SiteModel> CollectSiteAsync();

        /// <summary>Replace the current preview with this visual (coloured mesh, flow paths, labels, legend/caption optional).</summary>
        Task ShowAsync(ResultVisual visual);

        Task ClearPreviewAsync();

        /// <summary>Bake the visual as permanent document geometry (layer "Cloudburst::…" in Rhino, DirectShapes in Revit).</summary>
        Task BakeAsync(ResultVisual visual);

        /// <summary>Create the built-in demo site as document geometry and register it as the current picks.</summary>
        Task<bool> CreateDemoSiteAsync(SiteModel demo);

        /// <summary>Called when the user wants to see the project's palette file etc. (optional, may no-op).</summary>
        void Log(string message);
    }
}
