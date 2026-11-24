using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Linq;

namespace Cloudburst.Demo
{
    /// <summary>
    /// Downloads DHM/Terræn (Danmarks Højdemodel) GeoTIFFs from the Datafordeler / Dataforsyningen WCS services.
    /// The key comes from, in order: the environment variable DHM_API_KEY or DATAFORDELER_API_KEY on the user's machine,
    /// or the key built into this assembly at compile time (GitHub secret DHM_API_KEY, see Cloudburst.Net.csproj).
    /// </summary>
    public static class DhmClient
    {
        public const string DatafordelerUrl = "https://wcs.datafordeler.dk/DHMNedboer/dhm_wcs/1.0.0/WCS";
        public const string DataforsyningenUrl = "https://api.dataforsyningen.dk/dhm_wcs_DAF";

        private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromMinutes(3) };

        /// <summary>The key used when none is passed explicitly, or null if there is none.</summary>
        public static string DefaultKey
        {
            get
            {
                foreach (var v in new[] { "DHM_API_KEY", "DATAFORDELER_API_KEY" })
                {
                    var e = Environment.GetEnvironmentVariable(v);
                    if (!string.IsNullOrWhiteSpace(e)) return e.Trim();
                }
                return string.IsNullOrWhiteSpace(DhmBuildKey.Value) ? null : DhmBuildKey.Value;
            }
        }

        public static bool HasKey => DefaultKey != null;

        /// <summary>Download DHM/Terræn for an EPSG:25832 bbox [minx, miny, maxx, maxy] as GeoTIFF bytes.
        /// Tries Datafordeler first and Dataforsyningen second (a key may belong to either service).</summary>
        public static async Task<byte[]> FetchAsync(double[] bbox, double resolution = 0.4, string key = null, CancellationToken ct = default)
        {
            if (bbox == null || bbox.Length != 4) throw new ArgumentException("bbox must be [minx, miny, maxx, maxy] in EPSG:25832.", nameof(bbox));
            key = string.IsNullOrWhiteSpace(key) ? DefaultKey : key.Trim();
            if (key == null) throw new InvalidOperationException("No DHM API key. Get a free key at https://portal.datafordeler.dk and set the DHM_API_KEY environment variable.");

            long x0 = (long)Math.Round(bbox[0]), y0 = (long)Math.Round(bbox[1]), x1 = (long)Math.Round(bbox[2]), y1 = (long)Math.Round(bbox[3]);
            int w = (int)Math.Round((x1 - x0) / resolution), h = (int)Math.Round((y1 - y0) / resolution);
            string Q(string param) => string.Join("&", new Dictionary<string, string>
            {
                ["service"] = "WCS", ["request"] = "GetCoverage", ["version"] = "1.0.0", ["coverage"] = "dhm_terraen",
                ["crs"] = "EPSG:25832", ["bbox"] = $"{x0},{y0},{x1},{y1}",
                ["width"] = w.ToString(CultureInfo.InvariantCulture), ["height"] = h.ToString(CultureInfo.InvariantCulture),
                ["format"] = "GTiff", [param] = key,
            }.Select(kv => kv.Key + "=" + Uri.EscapeDataString(kv.Value)));

            Exception first = null;
            foreach (var (url, param) in new[] { (DatafordelerUrl, "apikey"), (DataforsyningenUrl, "token") })
            {
                try { return await GetTiffAsync(url + "?" + Q(param), ct).ConfigureAwait(false); }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex) { first ??= ex; }
            }
            throw first;
        }

        private static async Task<byte[]> GetTiffAsync(string url, CancellationToken ct)
        {
            using var resp = await Http.GetAsync(url, ct).ConfigureAwait(false);
            var bytes = await resp.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
            bool tiff = bytes.Length > 4 && ((bytes[0] == 0x49 && bytes[1] == 0x49) || (bytes[0] == 0x4D && bytes[1] == 0x4D));
            if (resp.IsSuccessStatusCode && tiff) return bytes;
            var text = System.Text.Encoding.UTF8.GetString(bytes, 0, Math.Min(bytes.Length, 400)).Trim();
            int code = (int)resp.StatusCode;
            throw new InvalidOperationException(code == 401 || code == 403 ? $"DHM key rejected ({code}). {text}" : $"DHM download failed (HTTP {code}). {text}");
        }

        /// <summary>Download the terrain of a real sample site into Documents\Cloudburst\samples and return the file path.</summary>
        public static async Task<string> DownloadSampleAsync(SampleInfo info, string key = null, CancellationToken ct = default)
        {
            if (info?.Bbox == null || string.IsNullOrEmpty(info.DhmFile)) throw new ArgumentException("Not a real sample site.", nameof(info));
            var bytes = await FetchAsync(info.Bbox, 0.4, key, ct).ConfigureAwait(false);
            var dir = SampleLibrary.SearchFolders[1];
            Directory.CreateDirectory(dir);
            var path = Path.Combine(dir, info.DhmFile);
            File.WriteAllBytes(path, bytes);
            return path;
        }
    }
}
