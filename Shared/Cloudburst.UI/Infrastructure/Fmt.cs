using System;
using System.Globalization;

namespace Cloudburst.UI.Infrastructure
{
    /// <summary>Number formatting for tiles and labels (invariant, thin grouping).</summary>
    public static class Fmt
    {
        public static readonly CultureInfo C = CultureInfo.InvariantCulture;

        public static string N0(double v) => double.IsNaN(v) || double.IsInfinity(v) ? "–" : v.ToString("#,0", C);
        public static string N(double v, string f) => double.IsNaN(v) || double.IsInfinity(v) ? "–" : v.ToString(f, C);

        /// <summary>Volume or area: integers above 100, one decimal below.</summary>
        public static string Smart(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return "–";
            double a = Math.Abs(v);
            return a >= 100 ? N0(v) : a >= 10 ? v.ToString("0.#", C) : v.ToString("0.##", C);
        }

        public static string Signed(double v, string f = "#,0")
        {
            if (double.IsNaN(v)) return "–";
            var s = Math.Abs(v).ToString(f, C);
            return v > 0 ? "+" + s : v < 0 ? "−" + s : s;
        }

        /// <summary>Clock style "h:mm" for simulation time.</summary>
        public static string Clock(double seconds)
        {
            if (double.IsNaN(seconds) || seconds < 0) seconds = 0;
            var t = TimeSpan.FromSeconds(seconds);
            return $"{(int)t.TotalHours}:{t.Minutes:00}";
        }

        /// <summary>Human duration "45 s", "3 min 05 s", "1 h 20 min".</summary>
        public static string Duration(double seconds)
        {
            if (double.IsNaN(seconds) || double.IsInfinity(seconds) || seconds < 0) return "–";
            if (seconds < 60) return $"{seconds.ToString(seconds < 10 ? "0.0" : "0", C)} s";
            var t = TimeSpan.FromSeconds(seconds);
            if (t.TotalHours < 1) return $"{t.Minutes} min {t.Seconds:00} s";
            return $"{(int)t.TotalHours} h {t.Minutes:00} min";
        }

        public static string Minutes(double min)
        {
            if (min < 60) return $"{min.ToString("0", C)} min";
            int h = (int)(min / 60); double m = min - h * 60;
            return m < 0.5 ? $"{h} h" : $"{h} h {m.ToString("0", C)} min";
        }
    }
}
