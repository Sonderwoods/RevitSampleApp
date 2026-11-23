using System;
using System.Windows.Input;
using System.Windows.Media;
using Cloudburst.Hosting;
using Cloudburst.Materials;
using Cloudburst.Model;
using Cloudburst.Results;
using Cloudburst.UI.Controls;
using Cloudburst.UI.Infrastructure;

namespace Cloudburst.UI.ViewModels
{
    internal static class Brushy
    {
        public static SolidColorBrush FromArgb(int argb)
        {
            uint u = unchecked((uint)argb);
            var b = new SolidColorBrush(Color.FromArgb((byte)(u >> 24), (byte)(u >> 16), (byte)(u >> 8), (byte)u));
            b.Freeze();
            return b;
        }

        public static SolidColorBrush Hex(string hex)
        {
            try { return FromArgb(unchecked((int)(0xFF000000 | Convert.ToUInt32(hex.TrimStart('#'), 16)))); }
            catch (Exception) { return FromArgb(unchecked((int)0xFF888888)); }
        }
    }

    public sealed class StepViewModel : ObservableObject
    {
        private bool _isDone;
        public int Index { get; set; }
        public int Number => Index + 1;
        public string Title { get; set; }
        public string Glyph { get; set; }
        public string Description { get; set; }
        public bool IsFirst { get; set; }
        public bool IsLast { get; set; }
        public bool IsDone { get => _isDone; set => Set(ref _isDone, value); }
    }

    /// <summary>One "pick from the model" row in the Site step.</summary>
    public sealed class PickItemViewModel : ObservableObject
    {
        private int _count;
        private string _description;
        private double _heightCm = 10;

        public PickRole Role { get; set; }
        public string Title { get; set; }
        public string Hint { get; set; }
        public string Glyph { get; set; }
        public bool IsOptional { get; set; }
        public bool ShowsHeight { get; set; }
        public ICommand PickCommand { get; set; }
        public ICommand ClearCommand { get; set; }

        public int Count { get => _count; set { if (Set(ref _count, value)) Raise(nameof(HasItems), nameof(PickLabel), nameof(SubText)); } }
        public bool HasItems => Count > 0;
        public string PickLabel => HasItems ? "Re-pick" : "Pick";
        public string Description { get => _description; set { if (Set(ref _description, value)) Raise(nameof(SubText)); } }
        public string SubText => HasItems && !string.IsNullOrWhiteSpace(Description) ? Description : Hint;

        /// <summary>Kerb/wall height in cm (negative = channel). Only used for <see cref="PickRole.Walls"/>.</summary>
        public double HeightCm { get => _heightCm; set => Set(ref _heightCm, Math.Max(-200, Math.Min(500, value))); }

        public void Apply(PickSummary s)
        {
            Count = s?.Count ?? 0;
            Description = s?.Description ?? "";
        }
    }

    /// <summary>A palette material (wraps the live <see cref="SurfaceMaterial"/> of the session palette, edits write through).</summary>
    public sealed class MaterialItemViewModel : ObservableObject
    {
        private readonly Action _edited;
        public SurfaceMaterial M { get; }
        public int Order { get; }

        public MaterialItemViewModel(SurfaceMaterial m, int order, Action edited)
        {
            M = m; Order = order; _edited = edited;
            Brush = Brushy.FromArgb(SafeArgb(m));
        }

        private static int SafeArgb(SurfaceMaterial m) { try { return m.Argb; } catch (Exception) { return unchecked((int)0xFF888888); } }

        public string Id => M.Id;
        public string Name => M.Name;
        public string Category => M.Category;
        public SolidColorBrush Brush { get; }

        public string CategoryLabel => M.Category switch
        {
            "Roofs" => "Roofs",
            "Hard" => "Hard surfaces",
            "Green" => "Green & soft",
            "LAR" => "LAR · SuDS",
            _ => M.Category ?? "Other"
        };

        public int CategoryOrder => M.Category switch { "Roofs" => 0, "Hard" => 1, "Green" => 2, "LAR" => 3, _ => 4 };

        public string KeyValues =>
            $"C {Fmt.N(M.CCloudburstSand, "0.0#")}{(Math.Abs(M.CCloudburstSand - M.CCloudburstClay) > 1e-9 ? "–" + Fmt.N(M.CCloudburstClay, "0.0#") : "")}" +
            $" · n {Fmt.N(M.ManningN, "0.0##")}" +
            $" · f {Fmt.N(M.InfiltrationSand, "0.#")}{(Math.Abs(M.InfiltrationSand - M.InfiltrationClay) > 1e-9 ? "/" + Fmt.N(M.InfiltrationClay, "0.#") : "")} mm/h";

        public string Tooltip => $"{M.Name}\nCloudburst runoff coefficient C: {M.CCloudburstSand:0.00} (sand) – {M.CCloudburstClay:0.00} (clay)\n" +
                                 $"Normal C: {M.CNormal:0.00}\nManning n: {M.ManningN:0.000}\nInfiltration: {M.InfiltrationSand:0.#} (sand) / {M.InfiltrationClay:0.#} (clay) mm/h\n" +
                                 $"Initial loss: {M.InitialLossMm:0.#} mm{(M.Sealed ? " · sealed" : "")}";

        private void Edit(Action a, string name)
        {
            a();
            Raise(name);
            Raise(nameof(KeyValues), nameof(Tooltip));
            _edited?.Invoke();
        }

        private static double Clamp(double v, double lo, double hi) => double.IsNaN(v) ? lo : Math.Max(lo, Math.Min(hi, v));

        public double CNormal { get => M.CNormal; set => Edit(() => M.CNormal = Clamp(value, 0, 1), nameof(CNormal)); }
        public double CCloudburstSand { get => M.CCloudburstSand; set => Edit(() => M.CCloudburstSand = Clamp(value, 0, 1), nameof(CCloudburstSand)); }
        public double CCloudburstClay { get => M.CCloudburstClay; set => Edit(() => M.CCloudburstClay = Clamp(value, 0, 1), nameof(CCloudburstClay)); }
        public double ManningN { get => M.ManningN; set => Edit(() => M.ManningN = Clamp(value, 0.005, 1), nameof(ManningN)); }
        public double InfiltrationSand { get => M.InfiltrationSand; set => Edit(() => M.InfiltrationSand = Clamp(value, 0, 5000), nameof(InfiltrationSand)); }
        public double InfiltrationClay { get => M.InfiltrationClay; set => Edit(() => M.InfiltrationClay = Clamp(value, 0, 5000), nameof(InfiltrationClay)); }
        public double InitialLossMm { get => M.InitialLossMm; set => Edit(() => M.InitialLossMm = Clamp(value, 0, 1000), nameof(InitialLossMm)); }
        public double StorageMm { get => M.StorageMm; set => Edit(() => M.StorageMm = Clamp(value, 0, 5000), nameof(StorageMm)); }

        public override string ToString() => Name;
    }

    public sealed class AssignedMaterialRow
    {
        public string Name { get; set; }
        public int Count { get; set; }
        public Brush Brush { get; set; }
    }

    public sealed class SoilClassItem
    {
        public int Number { get; set; }
        public string Name { get; set; }
        public string Display => $"JB {Number} · {Name}";
        public override string ToString() => Display;
    }

    public sealed class SewerOption
    {
        public int Mode { get; set; }
        public string Title { get; set; }
        public string Detail { get; set; }
        public override string ToString() => Title;
    }

    public enum RainKind { Preset, Custom, Csv }

    public sealed class RainOptionViewModel : ObservableObject
    {
        private RainEvent _event;
        public RainKind Kind { get; set; }
        public string Glyph { get; set; }
        public RainEvent Event { get => _event; set { _event = value; Refresh(); } }
        public string Title { get; set; }

        public string DepthText => Event == null ? "–" : Fmt.N(Event.DesignDepthMm, "0");
        public string PeakText => Event == null ? "" : $"peak {Fmt.N(Event.PeakMmH, "0")} mm/h";
        public string DurationText => Event == null ? "" : Fmt.Minutes(Event.DurationMin);
        public string Subtitle => Event == null ? "" : $"{PeakText} · {DurationText}";

        public void Refresh() => Raise(nameof(Event), nameof(DepthText), nameof(PeakText), nameof(DurationText), nameof(Subtitle), nameof(Title));
    }

    public enum UiLayer { Depth, Velocity, Hazard, TimeToPeak, FlowPaths, Materials }

    public sealed class LayerOptionViewModel : ObservableObject
    {
        private bool _isAvailable, _isSelected;
        private readonly Action<LayerOptionViewModel> _selected;
        public LayerOptionViewModel(UiLayer layer, string title, string glyph, bool dynamicOnly, Action<LayerOptionViewModel> selected)
        { Layer = layer; Title = title; Glyph = glyph; DynamicOnly = dynamicOnly; _selected = selected; }

        public UiLayer Layer { get; }
        public string Title { get; }
        public string Glyph { get; }
        public bool DynamicOnly { get; }
        public bool IsAvailable { get => _isAvailable; set => Set(ref _isAvailable, value); }

        /// <summary>Bound TwoWay to a RadioButton; only "true" from the UI triggers a selection.</summary>
        public bool IsSelected
        {
            get => _isSelected;
            set
            {
                if (_isSelected == value) return;
                _isSelected = value; Raise();
                if (value) _selected?.Invoke(this);
            }
        }

        internal void SetSelectedSilently(bool v) { if (_isSelected != v) { _isSelected = v; Raise(nameof(IsSelected)); } }
    }

    public sealed class LegendRow
    {
        public Brush Brush { get; set; }
        public string Label { get; set; }
    }

    public sealed class MassSegment : IBarSegment
    {
        public string Label { get; set; }
        public double Value { get; set; }
        public Brush Brush { get; set; }
        public string ValueText { get; set; }
        public string PercentText { get; set; }
    }

    public sealed class BluespotRow
    {
        public int Rank { get; set; }
        public string Volume { get; set; }
        public string Depth { get; set; }
        public string Area { get; set; }
        public string SpillRain { get; set; }
        public bool Spills { get; set; }
        public bool Deep { get; set; }
    }

    public sealed class SavedOptionViewModel
    {
        public SavedOption Option { get; set; }
        public string Letter { get; set; }
        public string Name => Option?.Name;
        public string Model => Option?.Model;
        public string VolumeText => Fmt.Smart(Option?.FloodedVolumeM3 ?? 0) + " m³";
        public string AreaText => Fmt.Smart(Option?.AreaOver10CmM2 ?? 0) + " m² > 10 cm";
        public string TimeText => Option?.Created.ToString("HH:mm") ?? "";
        public override string ToString() => Name;
    }

    public sealed class TerrainFileViewModel
    {
        public string Path { get; set; }
        public string Name => System.IO.Path.GetFileName(Path);
        public ICommand RemoveCommand { get; set; }
    }
}
