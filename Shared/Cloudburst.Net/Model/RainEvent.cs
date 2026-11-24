using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Cloudburst.Native;

namespace Cloudburst.Model
{
    public enum RainShape { Cds, Box, Csv }

    /// <summary>A rain event (IN-7). Intensities are before the climate factor; the factor is applied by the solver.</summary>
    public sealed class RainEvent
    {
        public string Name { get; set; }
        public string Description { get; set; }
        public RainShape Shape { get; set; }
        public double ReturnPeriod { get; set; }
        public double DepthMm { get; set; }
        public double DurationMin { get; set; }
        public double ClimateFactor { get; set; } = 1.0;
        public double StepS { get; set; } = 60;
        /// <summary>mm/h per step, before climate factor.</summary>
        public double[] IntensityMmH { get; set; } = Array.Empty<double>();

        public double DesignDepthMm => DepthMm * ClimateFactor;
        public double PeakMmH => (IntensityMmH.Length == 0 ? 0 : IntensityMmH.Max()) * ClimateFactor;
        public override string ToString() => Name;

        /// <summary>Climate factor default per return period (IN-8).</summary>
        public static double DefaultClimateFactor(double t) => t >= 100 ? 1.4 : t >= 10 ? 1.3 : 1.2;

        public static RainEvent Cds(double returnPeriod, double durationMin = 240, double depthMm = 0, double? climateFactor = null, string name = null)
        {
            if (depthMm <= 0) depthMm = NativeMethods.cb_idf_depth_mm(durationMin, returnPeriod);
            int n = (int)Math.Max(1, Math.Round(durationMin * 60 / 60.0));
            var buf = new double[n];
            NativeMethods.cb_rain_cds(returnPeriod, durationMin, depthMm, 60, 0.5, buf, n);
            var cf = climateFactor ?? DefaultClimateFactor(returnPeriod);
            return new RainEvent
            {
                Name = name ?? $"T = {returnPeriod:0} years CDS",
                Description = $"{durationMin / 60:0.#} h CDS, {depthMm:0} mm × {cf:0.0#} = {depthMm * cf:0} mm",
                Shape = RainShape.Cds, ReturnPeriod = returnPeriod, DepthMm = depthMm, DurationMin = durationMin, ClimateFactor = cf, IntensityMmH = buf
            };
        }

        public static RainEvent Box(double depthMm, double durationMin, double climateFactor = 1.0, string name = null)
        {
            int n = (int)Math.Max(1, Math.Round(durationMin));
            var buf = new double[n];
            NativeMethods.cb_rain_box(depthMm, durationMin, 60, buf, n);
            return new RainEvent
            {
                Name = name ?? $"Box {depthMm:0} mm / {durationMin:0} min",
                Description = $"Box rain {depthMm:0} mm over {durationMin / 60:0.#} h",
                Shape = RainShape.Box, DepthMm = depthMm, DurationMin = durationMin, ClimateFactor = climateFactor, IntensityMmH = buf
            };
        }

        /// <summary>CSV with "minutes,mm/h" rows (header optional). Uniform step inferred from the first two rows.</summary>
        public static RainEvent FromCsv(string path, double climateFactor = 1.0)
        {
            var rows = new List<(double t, double i)>();
            foreach (var line in File.ReadAllLines(path))
            {
                var p = line.Split(new[] { ',', ';', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                if (p.Length < 2) continue;
                if (double.TryParse(p[0], NumberStyles.Float, CultureInfo.InvariantCulture, out var t) &&
                    double.TryParse(p[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var i)) rows.Add((t, i));
            }
            if (rows.Count == 0) throw new InvalidDataException("No numeric rows found in rain CSV.");
            double step = rows.Count > 1 ? (rows[1].t - rows[0].t) * 60 : 60;
            var ints = rows.Select(r => r.i).ToArray();
            return new RainEvent
            {
                Name = Path.GetFileNameWithoutExtension(path), Shape = RainShape.Csv, StepS = step, IntensityMmH = ints,
                DurationMin = ints.Length * step / 60, DepthMm = ints.Sum() * step / 3600, ClimateFactor = climateFactor,
                Description = "Rain from CSV"
            };
        }

        /// <summary>The events shipped with the tool (PRD "Rain events to ship").</summary>
        public static IReadOnlyList<RainEvent> Presets() => new[]
        {
            Cds(10, 240, 35, 1.3, "T = 10 years"),
            Cds(100, 240, 59, 1.4, "T = 100 years (cloudburst)"),
            Box(120, 120, 1.0, "2011 test (Copenhagen)"),
            Box(83, 240, 1.0, "Box 83 mm / 4 h"),
        };
    }
}
