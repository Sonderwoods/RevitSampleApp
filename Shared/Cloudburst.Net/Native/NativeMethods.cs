using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

namespace Cloudburst.Native
{
    // ---- Structs mirror #[repr(C)] types in Shared/cloudburst-core/src. Keep field order identical.

    /// <summary>Scenario shared by the instant and dynamic models (hydro.rs).</summary>
    [StructLayout(LayoutKind.Sequential)]
    public struct Scenario
    {
        public double RainDepthMm;
        public double ClimateFactor;
        public double SewerCapacityMmH;
        public double InfiltrationScale;
        public double Alpha;
        public double Theta;
        public double HDry;
        public double AfterRainMin;
        public double OutputIntervalS;
        public double MinDepth;
        /// <summary>0 none, 1 combined initial loss 34 mm, 2 separate 29 mm, 3 constant capacity.</summary>
        public int SewerMode;
        /// <summary>0 dry, 1 moist, 2 wet.</summary>
        public int Moisture;
        /// <summary>0 open, 1 closed.</summary>
        public int Boundary;
        public int MaxFrames;
        public int DepthRoughness;
        /// <summary>Bitmask of closed edges: 1 W, 2 E, 4 S, 8 N.</summary>
        public int ClosedEdges;

        public static Scenario Default { get { NativeMethods.cb_scenario_default(out var s); return s; } }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct GridSettingsNative
    {
        public double CellSize;
        public double BuildingMinHeight;
        public int MaxCells;
        public int DefaultSoil;
        public int DefaultMaterial;
        public int UseRoofHeight;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct GridInfo
    {
        public int Nx, Ny;
        public double X0, Y0, Dx;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct InstantStats
    {
        public double RainVolumeM3;
        public double EffectiveVolumeM3;
        public double StoredVolumeM3;
        public double OutflowVolumeM3;
        public double FloodedAreaM2;
        public double AreaOver10CmM2;
        public double MaxDepthM;
        public double ElapsedMs;
        public int BluespotCount;
        public int SpillingCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Bluespot
    {
        public int Id;
        public int CellCount;
        public int Spills;
        private int _pad;
        public double AreaM2;
        public double CapacityM3;
        public double VolumeM3;
        public double MaxDepthM;
        public double FullDepthM;
        public double WetAreaM2;
        public double ContributingAreaM2;
        public double SpillRainMm;
        public double LevelZ;
        public double SpillZ;
        public double X;
        public double Y;
        public double FillFraction => CapacityM3 > 0 ? VolumeM3 / CapacityM3 : 0;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MassBalance
    {
        public double RainM3;
        public double InitialLossM3;
        public double InfiltratedM3;
        public double SewerM3;
        public double BoundaryOutM3;
        public double StoredM3;
        public double ErrorFraction;
        public double SimulatedS;
        public double ElapsedS;
        public double InitialWaterM3;
        public long Steps;
        public int Cancelled;
        private int _pad;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Progress
    {
        public double Fraction;
        public double TimeS;
        public double DtS;
        public double HMaxM;
        public double VolumeM3;
        public double ElapsedS;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RetentionInput
    {
        public double ReturnPeriod;
        public double ClimateFactor;
        public double DischargeLSHa;
        public double SafetyFactor;
        public double RationalDurationMin;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RetentionResult
    {
        public double TotalAreaM2;
        public double ReducedAreaM2;
        public double MeanC;
        public double PeakFlowLS;
        public double OutflowLS;
        public double RequiredStorageM3;
        public double CriticalDurationMin;
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    public delegate int ProgressCallback(ref Progress p, IntPtr user);

    /// <summary>P/Invoke surface of cloudburst_core (Rust). See ffi.rs.</summary>
    public static class NativeMethods
    {
        public const string Lib = "cloudburst_core";

        static NativeMethods()
        {
            // Rhino/Revit load plugins from their own folder; the default probe only searches the host exe folder.
            try { NativeLibrary.SetDllImportResolver(typeof(NativeMethods).Assembly, Resolve); } catch (InvalidOperationException) { }
        }

        private static IntPtr Resolve(string name, Assembly asm, DllImportSearchPath? path)
        {
            if (name != Lib) return IntPtr.Zero;
            var dir = Path.GetDirectoryName(asm.Location) ?? AppContext.BaseDirectory;
            foreach (var file in new[] { "cloudburst_core.dll", "libcloudburst_core.so", "libcloudburst_core.dylib" })
            {
                foreach (var d in new[] { dir, Path.Combine(dir, "runtimes"), AppContext.BaseDirectory })
                {
                    var p = Path.Combine(d, file);
                    if (File.Exists(p) && NativeLibrary.TryLoad(p, out var h)) return h;
                }
            }
            return IntPtr.Zero;
        }

        /// <summary>Forces the resolver to run and verifies the engine loads. Returns the engine version.</summary>
        public static string EnsureLoaded() => TakeString(cb_version());

        public static string TakeString(IntPtr p)
        {
            if (p == IntPtr.Zero) return string.Empty;
            try { return Marshal.PtrToStringUTF8(p) ?? string.Empty; } finally { cb_string_free(p); }
        }

        public static string LastError() => TakeString(cb_last_error());

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr cb_version();
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr cb_last_error();
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void cb_string_free(IntPtr p);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr cb_default_palette_json();
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_material_guess([MarshalAs(UnmanagedType.LPUTF8Str)] string paletteJson, [MarshalAs(UnmanagedType.LPUTF8Str)] string text);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void cb_scenario_default(out Scenario s);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr cb_samples_json();
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr cb_sample_json([MarshalAs(UnmanagedType.LPUTF8Str)] string id);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr cb_site_new();
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void cb_site_free(IntPtr site);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void cb_site_add_terrain(IntPtr site, double[] v, int nv, int[] t, int nt, int design);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void cb_site_add_building_mesh(IntPtr site, double[] v, int nv, int[] t, int nt, int drainage, int roofMaterial);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void cb_site_add_building_footprint(IntPtr site, double[] xs, double[] ys, int n, double height, int drainage, int roofMaterial);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void cb_site_add_region_polygon(IntPtr site, double[] xs, double[] ys, int n, int material, int soil, int compaction, int sewer);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void cb_site_add_region_mesh(IntPtr site, double[] v, int nv, int[] t, int nt, int material, int soil, int compaction, int sewer);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void cb_site_add_wall(IntPtr site, double[] xs, double[] ys, int n, double height);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void cb_site_add_bridge_cut(IntPtr site, double[] xs, double[] ys, int n);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void cb_site_set_boundary(IntPtr site, double[] xs, double[] ys, int n);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_site_add_terrain_file(IntPtr site, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int step, int design);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr cb_raster_to_mesh([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int step);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_mesh_copy(IntPtr mesh, int which, double[] outF64, int[] outI32, int len);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void cb_mesh_free(IntPtr mesh);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_grid_export_ascii(IntPtr grid, float[] values, int len, [MarshalAs(UnmanagedType.LPUTF8Str)] string path);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr cb_grid_build(IntPtr site, [MarshalAs(UnmanagedType.LPUTF8Str)] string paletteJson, ref GridSettingsNative settings);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void cb_grid_free(IntPtr grid);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_grid_info(IntPtr grid, out GridInfo info);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_grid_copy_z(IntPtr grid, int which, float[] output, int len);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_grid_copy_material(IntPtr grid, ushort[] output, int len);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_grid_copy_building(IntPtr grid, int[] output, int len);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_grid_copy_active(IntPtr grid, byte[] output, int len);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr cb_grid_warnings(IntPtr grid);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_grid_retention(IntPtr grid, ref RetentionInput input, out RetentionResult output);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_retention(double totalAreaM2, double reducedAreaM2, ref RetentionInput input, out RetentionResult output);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_rain_cds(double returnPeriod, double durationMin, double depthMm, double stepS, double peakPosition, double[] output, int cap);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_rain_box(double depthMm, double durationMin, double stepS, double[] output, int cap);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern double cb_idf_depth_mm(double durationMin, double returnPeriod);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr cb_instant_run(IntPtr grid, ref Scenario sc);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void cb_instant_free(IntPtr r);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_instant_stats(IntPtr r, out InstantStats stats);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_instant_copy(IntPtr r, int which, float[] output, int len);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_instant_copy_labels(IntPtr r, int[] output, int len);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_instant_copy_bluespots(IntPtr r, [Out] Bluespot[] output, int len);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_instant_path_count(IntPtr r);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_instant_copy_path(IntPtr r, int idx, double[] output, int len);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern IntPtr cb_dynamic_run(IntPtr grid, ref Scenario sc, double[] rainMmH, int nRain, double rainStepS, int[] probes, int nProbes, ProgressCallback cb, IntPtr user);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void cb_dynamic_free(IntPtr r);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_dynamic_mass(IntPtr r, out MassBalance mb);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_dynamic_copy(IntPtr r, int which, float[] output, int len);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_dynamic_frame_count(IntPtr r);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern double cb_dynamic_frame_time(IntPtr r, int i);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_dynamic_copy_frame(IntPtr r, int i, float[] output, int len);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_dynamic_probe_count(IntPtr r);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int cb_dynamic_copy_probe(IntPtr r, int i, float[] output, int len);
    }
}
