using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;

namespace Cloudburst.Revit
{
    internal static class RevitUtil
    {
        public const string AppId = "Cloudburst";
        public const string DataPreview = "CloudburstPreview";
        public const string DataBake = "CloudburstBake";
        public const string DataDemo = "CloudburstDemo";
        public const string DemoComment = "Cloudburst demo";

        public static Color ToColor(int argb) => new Color((byte)((argb >> 16) & 0xFF), (byte)((argb >> 8) & 0xFF), (byte)(argb & 0xFF));

        public static BuiltInCategory Cat(Element e)
        {
            try { return e?.Category?.BuiltInCategory ?? BuiltInCategory.INVALID; } catch { return BuiltInCategory.INVALID; }
        }

        /// <summary>Revit element names may not contain \ : { } [ ] | ; &lt; &gt; ? ` ~</summary>
        public static string SafeElementName(string s)
        {
            if (string.IsNullOrWhiteSpace(s)) return "Cloudburst";
            const string bad = "\\:{}[]|;?`~";
            var sb = new System.Text.StringBuilder();
            foreach (var c in s)
            {
                if (c == '<') sb.Append("under ");
                else if (c == '>') sb.Append("over ");
                else if (c == '\u25B2') continue; // ▲
                else sb.Append(bad.IndexOf(c) >= 0 ? '-' : c);
            }
            var r = sb.ToString().Trim();
            while (r.Contains("  ")) r = r.Replace("  ", " ");
            return r.Length > 120 ? r.Substring(0, 120) : r;
        }

        public static ElementId SolidFillPatternId(Document doc)
        {
            try
            {
                foreach (FillPatternElement fp in new FilteredElementCollector(doc).OfClass(typeof(FillPatternElement)))
                {
                    var p = fp.GetFillPattern();
                    if (p != null && p.IsSolidFill) return fp.Id;
                }
            }
            catch { }
            return ElementId.InvalidElementId;
        }

        public static ElementId GenericModelCategory(Document doc, BuiltInCategory preferred = BuiltInCategory.OST_GenericModel)
        {
            var id = new ElementId(preferred);
            try { if (DirectShape.IsValidCategoryId(id, doc)) return id; } catch { }
            return new ElementId(BuiltInCategory.OST_GenericModel);
        }

        public static DirectShape NewDirectShape(Document doc, string dataId, string name, BuiltInCategory cat = BuiltInCategory.OST_GenericModel)
        {
            var ds = DirectShape.CreateElement(doc, GenericModelCategory(doc, cat));
            ds.ApplicationId = AppId;
            ds.ApplicationDataId = dataId;
            try { ds.SetName(SafeElementName(name)); } catch { }
            return ds;
        }

        public static void SetComment(Element e, string text)
        {
            try
            {
                var p = e.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS);
                if (p != null && !p.IsReadOnly) p.Set(text ?? "");
            }
            catch { }
        }

        public static string GetComment(Element e)
        {
            try { return e.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.AsString(); } catch { return null; }
        }

        public static bool IsCloudburstShape(Element e, string dataId = null)
        {
            if (!(e is DirectShape ds)) return false;
            try { return ds.ApplicationId == AppId && (dataId == null || ds.ApplicationDataId == dataId); } catch { return false; }
        }

        /// <summary>Material by name: created once, colour/transparency updated every time.</summary>
        public static ElementId EnsureMaterial(Document doc, string name, Color color, int transparency, ElementId solidFill)
        {
            name = SafeElementName(name);
            Material mat = new FilteredElementCollector(doc).OfClass(typeof(Material)).Cast<Material>().FirstOrDefault(m => m.Name == name);
            if (mat == null)
            {
                var id = Material.Create(doc, name);
                mat = doc.GetElement(id) as Material;
                if (mat == null) return ElementId.InvalidElementId;
            }
            try
            {
                mat.Color = color;
                mat.Transparency = Math.Max(0, Math.Min(100, transparency));
                if (solidFill != ElementId.InvalidElementId)
                {
                    mat.SurfaceForegroundPatternId = solidFill;
                    mat.SurfaceForegroundPatternColor = color;
                }
            }
            catch (Exception ex) { Logger.Write("Material update: " + ex.Message); }
            return mat.Id;
        }

        public static void TryOverride(View view, ElementId id, OverrideGraphicSettings ogs)
        {
            try
            {
                if (view == null || view.IsTemplate || !view.AreGraphicsOverridesAllowed()) return;
                view.SetElementOverrides(id, ogs);
            }
            catch (Exception ex) { Logger.Write("Override: " + ex.Message); }
        }

        public static OverrideGraphicSettings SurfaceOverride(Color color, ElementId solidFill, int transparency)
        {
            var ogs = new OverrideGraphicSettings();
            if (solidFill != ElementId.InvalidElementId)
            {
                ogs.SetSurfaceForegroundPatternId(solidFill);
                ogs.SetSurfaceForegroundPatternColor(color);
                ogs.SetSurfaceForegroundPatternVisible(true);
            }
            ogs.SetProjectionLineColor(color);
            if (transparency > 0) ogs.SetSurfaceTransparency(Math.Min(100, transparency));
            return ogs;
        }

        public static OverrideGraphicSettings LineOverride(Color color, int weight)
        {
            var ogs = new OverrideGraphicSettings();
            ogs.SetProjectionLineColor(color);
            ogs.SetProjectionLineWeight(Math.Max(1, Math.Min(16, weight)));
            return ogs;
        }

        /// <summary>Transaction options that swallow warnings so no Revit dialog interrupts the demo.</summary>
        public static void QuietFailures(Transaction t)
        {
            var o = t.GetFailureHandlingOptions();
            o.SetFailuresPreprocessor(new WarningSwallower());
            o.SetClearAfterRollback(true);
            t.SetFailureHandlingOptions(o);
        }

        private sealed class WarningSwallower : IFailuresPreprocessor
        {
            public FailureProcessingResult PreprocessFailures(FailuresAccessor a)
            {
                try
                {
                    foreach (var f in a.GetFailureMessages())
                        if (f.GetSeverity() == FailureSeverity.Warning) a.DeleteWarning(f);
                }
                catch { }
                return FailureProcessingResult.Continue;
            }
        }

        public static void Require(Document doc)
        {
            if (doc == null) throw new InvalidOperationException("Open a Revit project first.");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Cloudburst works in project documents, not in the family editor.");
            if (doc.IsReadOnly) throw new InvalidOperationException("The active document is read-only.");
        }

        public static List<ElementId> ValidIds(Document doc, IEnumerable<ElementId> ids) =>
            ids.Where(id => id != null && id != ElementId.InvalidElementId && doc.GetElement(id) != null).Distinct().ToList();
    }
}
