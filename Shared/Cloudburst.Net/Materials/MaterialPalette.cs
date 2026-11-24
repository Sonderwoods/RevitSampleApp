using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Cloudburst.Materials
{
    /// <summary>One surface material. Values are defaults the user can override (see palette.json).</summary>
    public sealed class SurfaceMaterial
    {
        [JsonPropertyName("id")] public string Id { get; set; }
        [JsonPropertyName("name")] public string Name { get; set; }
        [JsonPropertyName("category")] public string Category { get; set; }
        /// <summary>Danish administrative runoff coefficient (afløbskoefficient).</summary>
        [JsonPropertyName("cNormal")] public double CNormal { get; set; }
        [JsonPropertyName("cCloudburstSand")] public double CCloudburstSand { get; set; }
        [JsonPropertyName("cCloudburstClay")] public double CCloudburstClay { get; set; }
        /// <summary>Manning n, s/m^(1/3).</summary>
        [JsonPropertyName("manningN")] public double ManningN { get; set; }
        /// <summary>Long-term infiltration (Horton fc), mm/h on sand.</summary>
        [JsonPropertyName("infiltrationSand")] public double InfiltrationSand { get; set; }
        [JsonPropertyName("infiltrationClay")] public double InfiltrationClay { get; set; }
        [JsonPropertyName("initialLossMm")] public double InitialLossMm { get; set; }
        [JsonPropertyName("sealed")] public bool Sealed { get; set; }
        /// <summary>When true and a soil class is known, M2 takes Horton parameters from the JB soil table.</summary>
        [JsonPropertyName("useSoilTable")] public bool UseSoilTable { get; set; }
        [JsonPropertyName("compacted")] public bool Compacted { get; set; } = true;
        /// <summary>Storage below the surface, mm. With <see cref="SubsoilLimited"/> it is the sub-base reservoir that fills
        /// with infiltrated water and drains to the subsoil; otherwise it is added to the initial-loss bucket.
        /// See docs/physics-permeability.md.</summary>
        [JsonPropertyName("storageMm")] public double StorageMm { get; set; }
        /// <summary>Informational design ponding depth (rain garden, swale, basin). Not applied by the engine: model the
        /// depression in the terrain.</summary>
        [JsonPropertyName("pondingMm")] public double PondingMm { get; set; }
        /// <summary>Engineered permeable surface on a sub-base: entry is limited by sub-base room plus subsoil drainage
        /// (JB soil fc). Keep in the palette so the engine sees it after a .NET round trip.</summary>
        [JsonPropertyName("subsoilLimited")] public bool SubsoilLimited { get; set; }
        /// <summary>Whether the sewer drains this surface. Null = same as <see cref="Sealed"/>. False for open water.</summary>
        [JsonPropertyName("sewerConnected")]
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public bool? SewerConnected { get; set; }
        [JsonPropertyName("color")] public string Color { get; set; } = "#888888";
        [JsonPropertyName("keywords")] public List<string> Keywords { get; set; } = new List<string>();

        /// <summary>ARGB colour parsed from <see cref="Color"/>.</summary>
        [JsonIgnore] public int Argb => ColorUtil.ParseHex(Color);

        public double CCloudburst(double clayFraction) => Lerp(CCloudburstSand, CCloudburstClay, clayFraction);
        public double Infiltration(double clayFraction) => Lerp(InfiltrationSand, InfiltrationClay, clayFraction);
        public SurfaceMaterial Clone() => (SurfaceMaterial)MemberwiseClone();
        public override string ToString() => Name;
        private static double Lerp(double a, double b, double t) => a + (b - a) * Math.Max(0, Math.Min(1, t));
    }

    public sealed class MaterialPalette
    {
        [JsonPropertyName("name")] public string Name { get; set; }
        [JsonPropertyName("version")] public int Version { get; set; } = 1;
        [JsonPropertyName("defaultMaterial")] public string DefaultMaterialId { get; set; } = "lawn_compacted";
        [JsonPropertyName("materials")] public List<SurfaceMaterial> Materials { get; set; } = new List<SurfaceMaterial>();

        private static readonly JsonSerializerOptions Options = new JsonSerializerOptions
        {
            WriteIndented = true,
            ReadCommentHandling = JsonCommentHandling.Skip,
            AllowTrailingCommas = true,
            PropertyNameCaseInsensitive = true
        };

        /// <summary>The palette shipped with the plugin.</summary>
        public static MaterialPalette LoadDefault()
        {
            using var s = typeof(MaterialPalette).Assembly.GetManifestResourceStream("Cloudburst.palette.json")
                          ?? throw new InvalidOperationException("Embedded palette missing.");
            using var r = new StreamReader(s);
            return FromJson(r.ReadToEnd());
        }

        public static MaterialPalette FromJson(string json) => JsonSerializer.Deserialize<MaterialPalette>(json, Options);
        public static MaterialPalette Load(string path) => FromJson(File.ReadAllText(path));
        public string ToJson() => JsonSerializer.Serialize(this, Options);
        public void Save(string path) => File.WriteAllText(path, ToJson());

        public int IndexOf(string id)
        {
            if (string.IsNullOrEmpty(id)) return -1;
            for (int i = 0; i < Materials.Count; i++)
                if (string.Equals(Materials[i].Id, id, StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(Materials[i].Name, id, StringComparison.OrdinalIgnoreCase)) return i;
            return -1;
        }

        public SurfaceMaterial Get(string id) { int i = IndexOf(id); return i >= 0 ? Materials[i] : null; }
        public int DefaultIndex => Math.Max(0, IndexOf(DefaultMaterialId));
        public SurfaceMaterial Default => Materials[DefaultIndex];

        /// <summary>Guess a material from a free-text name (layer, Revit material, object name). English and Danish keywords.
        /// Returns null when nothing matches.</summary>
        public SurfaceMaterial Guess(string text)
        {
            if (string.IsNullOrWhiteSpace(text)) return null;
            var t = text.ToLowerInvariant();
            var exact = Materials.FirstOrDefault(m => t == m.Id || t == m.Name.ToLowerInvariant());
            if (exact != null) return exact;
            SurfaceMaterial best = null; int bestLen = 0;
            foreach (var m in Materials)
                foreach (var k in m.Keywords)
                    if (k.Length > bestLen && t.Contains(k.ToLowerInvariant())) { best = m; bestLen = k.Length; }
            return best;
        }

        public MaterialPalette Clone()
        {
            var p = (MaterialPalette)MemberwiseClone();
            p.Materials = Materials.Select(m => m.Clone()).ToList();
            return p;
        }
    }

    internal static class ColorUtil
    {
        public static int ParseHex(string hex)
        {
            if (string.IsNullOrEmpty(hex)) return unchecked((int)0xFF888888);
            hex = hex.TrimStart('#');
            uint v = Convert.ToUInt32(hex, 16);
            if (hex.Length == 6) v |= 0xFF000000;
            return unchecked((int)v);
        }
    }
}
