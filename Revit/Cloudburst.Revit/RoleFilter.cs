using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using Autodesk.Revit.UI.Selection;
using Cloudburst.Hosting;

namespace Cloudburst.Revit
{
    /// <summary>Which element kinds can be picked for each <see cref="PickRole"/>.</summary>
    internal sealed class RoleFilter : ISelectionFilter
    {
        private readonly PickRole _role;
        public RoleFilter(PickRole role) { _role = role; }

        public bool AllowReference(Reference reference, XYZ position) => true;

        public bool AllowElement(Element e) => Allows(_role, e);

        public static bool Allows(PickRole role, Element e)
        {
            try
            {
                if (e == null || e is ElementType || e.ViewSpecific && !(e is CurveElement)) return false;
                // never pick our own result geometry
                if (RevitUtil.IsCloudburstShape(e, RevitUtil.DataPreview) || RevitUtil.IsCloudburstShape(e, RevitUtil.DataBake)) return false;
                var cat = RevitUtil.Cat(e);
                switch (role)
                {
                    case PickRole.Terrain:
                    case PickRole.DesignTerrain:
                        return e is Toposolid || e is TopographySurface || cat == BuiltInCategory.OST_Toposolid || cat == BuiltInCategory.OST_Topography
                               || e is Floor || e is DirectShape || e is ImportInstance;
                    case PickRole.Buildings:
                        return e is Wall || e is RoofBase || e is Floor || e is FamilyInstance || e is DirectShape
                               || cat == BuiltInCategory.OST_Mass || cat == BuiltInCategory.OST_GenericModel || cat == BuiltInCategory.OST_Roofs;
                    case PickRole.Surfaces:
                        return e is Floor || e is Toposolid || e is RoofBase || e is DirectShape || cat == BuiltInCategory.OST_Toposolid
                               || cat == BuiltInCategory.OST_Floors || cat == BuiltInCategory.OST_Roofs;
                    case PickRole.Walls:
                        return e is CurveElement || e is Wall;
                    case PickRole.BridgeCuts:
                    case PickRole.Boundary:
                        return e is CurveElement || e is Floor || e is Toposolid;
                    default:
                        return false;
                }
            }
            catch { return false; }
        }
    }
}
