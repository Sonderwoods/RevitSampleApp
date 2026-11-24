using System.Threading.Tasks;

namespace Cloudburst.Hosting
{
    /// <summary>
    /// Optional extension of <see cref="ICloudburstHost"/> for hosts whose model already says what is what (Revit:
    /// toposolids are terrain, roofs/floors/walls are buildings, materials come from the model). The UI checks for it with
    /// <c>host as ICloudburstAutoSite</c> and offers one button instead of picking every role by hand.
    /// </summary>
    public interface ICloudburstAutoSite
    {
        /// <summary>Button text, e.g. "Use the Revit model".</summary>
        string AutoSiteLabel { get; }

        /// <summary>One line on what is read, shown under the button.</summary>
        string AutoSiteHint { get; }

        /// <summary>Find terrain, buildings and surface materials in the model and register them as the current picks
        /// (replacing earlier picks for those roles). Returns a short description of what was found, or null when the
        /// model has no terrain.</summary>
        Task<string> DetectSiteAsync();
    }
}
