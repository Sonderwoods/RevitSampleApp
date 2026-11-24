using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Cloudburst.Hosting
{
    /// <summary>What the user has selected in the CAD model, as far as Cloudburst knows it.</summary>
    public sealed class SelectionInfo
    {
        /// <summary>Number of selected objects.</summary>
        public int Count { get; set; }
        /// <summary>Selected objects that are picked for Cloudburst, per role.</summary>
        public Dictionary<PickRole, int> Roles { get; } = new Dictionary<PickRole, int>();
        /// <summary>Material id → number of selected objects with that material (assigned or guessed).</summary>
        public Dictionary<string, int> Materials { get; } = new Dictionary<string, int>();
        public static SelectionInfo Empty => new SelectionInfo();
    }

    /// <summary>
    /// Optional extension of <see cref="ICloudburstHost"/> for hosts that can report model changes and selections and colour
    /// objects by material. The UI checks for it with <c>host as ICloudburstHostEvents</c>. Events may be raised on the
    /// host's UI thread; handlers must be cheap (the UI debounces them).
    /// </summary>
    public interface ICloudburstHostEvents
    {
        /// <summary>A picked object was moved, edited, deleted or undeleted (or its Cloudburst attributes changed).</summary>
        event EventHandler ModelChanged;

        /// <summary>The model selection changed.</summary>
        event EventHandler<SelectionInfo> SelectionChanged;

        /// <summary>Show/hide an overlay that colours the picked objects by their assigned material (with labels).</summary>
        Task ShowMaterialOverlayAsync(bool show);
    }
}
