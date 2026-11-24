using System;
using System.Collections.Generic;
using Cloudburst.Materials;
using Cloudburst.Native;

namespace Cloudburst.Grid
{
    /// <summary>Settings for turning a <see cref="SiteModel"/> into a grid.</summary>
    public sealed class GridSettings
    {
        public double CellSize { get; set; } = 1.0;
        public double BuildingMinHeight { get; set; } = 5.0;
        public int MaxCells { get; set; } = 2_000_000;
        /// <summary>Danish JB soil class 1–11 (default JB-6).</summary>
        public int DefaultSoilClass { get; set; } = 6;
        /// <summary>Palette id of the default material for unassigned cells (null = palette default).</summary>
        public string DefaultMaterialId { get; set; }
        public bool UseRoofHeight { get; set; }
    }

    /// <summary>
    /// The analysis raster. Owns the native grid handle (dispose when replaced) and keeps managed copies of the
    /// arrays needed for display. Row-major, index = j·Nx + i, (0,0) = south-west cell, world metres.
    /// </summary>
    public sealed class SiteGrid : IDisposable
    {
        internal IntPtr Handle { get; private set; }

        public int Nx { get; }
        public int Ny { get; }
        public double X0 { get; }
        public double Y0 { get; }
        public double CellSize { get; }
        public int Count => Nx * Ny;
        public double CellArea => CellSize * CellSize;
        public double MaxX => X0 + Nx * CellSize;
        public double MaxY => Y0 + Ny * CellSize;
        public double AreaM2 => Count * CellArea;

        /// <summary>Ground height before buildings / kerbs (m).</summary>
        public float[] TerrainZ { get; }
        /// <summary>Hydraulic surface incl. building blocks and kerbs (m).</summary>
        public float[] Z { get; }
        /// <summary>Palette index per cell.</summary>
        public ushort[] Material { get; }
        /// <summary>Building index per cell, −1 if none.</summary>
        public int[] Building { get; }
        /// <summary>1 inside terrain / boundary.</summary>
        public byte[] Active { get; }
        public MaterialPalette Palette { get; }
        public IReadOnlyList<string> Warnings { get; }
        /// <summary>Hash of hydraulic inputs, used as a result cache key.</summary>
        public long ContentHash { get; }

        internal SiteGrid(IntPtr handle, MaterialPalette palette)
        {
            Handle = handle;
            Palette = palette;
            NativeMethods.cb_grid_info(handle, out var info);
            Nx = info.Nx; Ny = info.Ny; X0 = info.X0; Y0 = info.Y0; CellSize = info.Dx;
            int n = Nx * Ny;
            TerrainZ = new float[n]; Z = new float[n]; Material = new ushort[n]; Building = new int[n]; Active = new byte[n];
            NativeMethods.cb_grid_copy_z(handle, 0, TerrainZ, n);
            NativeMethods.cb_grid_copy_z(handle, 1, Z, n);
            NativeMethods.cb_grid_copy_material(handle, Material, n);
            NativeMethods.cb_grid_copy_building(handle, Building, n);
            NativeMethods.cb_grid_copy_active(handle, Active, n);
            var w = NativeMethods.TakeString(NativeMethods.cb_grid_warnings(handle));
            Warnings = w.Length == 0 ? Array.Empty<string>() : w.Split('\n');
            unchecked
            {
                long h = 1469598103934665603L;
                void Mix(long v) { h ^= v; h *= 1099511628211L; }
                Mix(Nx); Mix(Ny); Mix(BitConverter.DoubleToInt64Bits(X0)); Mix(BitConverter.DoubleToInt64Bits(Y0)); Mix(BitConverter.DoubleToInt64Bits(CellSize));
                int step = Math.Max(1, n / 200000);
                for (int k = 0; k < n; k += step) { Mix(BitConverter.SingleToInt32Bits(Z[k])); Mix(Material[k]); }
                ContentHash = h;
            }
        }

        public int Index(int i, int j) => j * Nx + i;
        public double CenterX(int i) => X0 + (i + 0.5) * CellSize;
        public double CenterY(int j) => Y0 + (j + 0.5) * CellSize;

        public bool TryCell(double x, double y, out int i, out int j)
        {
            i = (int)Math.Floor((x - X0) / CellSize);
            j = (int)Math.Floor((y - Y0) / CellSize);
            return i >= 0 && j >= 0 && i < Nx && j < Ny;
        }

        public int CellAt(double x, double y) => TryCell(x, y, out int i, out int j) ? Index(i, j) : -1;

        public SurfaceMaterial MaterialAt(int k) => Palette.Materials[Math.Min(Material[k], (ushort)(Palette.Materials.Count - 1))];

        public override string ToString() => $"{Nx} × {Ny} cells @ {CellSize:0.##} m ({AreaM2 / 1e6:0.###} km²)";

        public void Dispose()
        {
            if (Handle != IntPtr.Zero) { NativeMethods.cb_grid_free(Handle); Handle = IntPtr.Zero; }
            GC.SuppressFinalize(this);
        }
        ~SiteGrid() { if (Handle != IntPtr.Zero) NativeMethods.cb_grid_free(Handle); }
    }
}
