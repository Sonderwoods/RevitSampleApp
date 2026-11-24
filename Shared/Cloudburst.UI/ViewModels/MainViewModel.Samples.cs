using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using Cloudburst.Demo;
using Cloudburst.Model;

namespace Cloudburst.UI.ViewModels
{
    public sealed partial class MainViewModel
    {
        public const string DefaultSampleId = "demo_block";

        public ObservableCollection<SampleItemViewModel> Samples { get; } = new ObservableCollection<SampleItemViewModel>();
        private string _loadedSampleId;

        private void InitSamples()
        {
            try
            {
                var list = SampleLibrary.List();
                foreach (var info in list.OrderBy(i => i.Id == DefaultSampleId ? 0 : 1))
                {
                    bool avail;
                    try { avail = SampleLibrary.IsAvailable(info); } catch (Exception) { avail = false; }
                    var vm = new SampleItemViewModel { Info = info, IsAvailable = avail };
                    if (!string.IsNullOrWhiteSpace(info.CompareWith))
                    {
                        var other = list.FirstOrDefault(o => o.Id == info.CompareWith)?.Name ?? info.CompareWith;
                        vm.CompareHint = $"Tip: save this as an option, load “{other}” and compare";
                    }
                    vm.LoadCommand = Cmd(() => LoadSampleAsync(vm), () => vm.IsAvailable && !IsDynamicRunning, "Load sample");
                    Samples.Add(vm);
                }
            }
            catch (Exception ex) { Log("Cloudburst: sample library unavailable: " + ex.Message); }

            if (Samples.Count == 0)
            {
                // fallback: the built-in synthetic block
                var vm = new SampleItemViewModel
                {
                    Info = new SampleInfo { Id = DefaultSampleId, Name = "Urban block", Kind = "synthetic",
                                            Description = "300 × 200 m block with streets, kerbs, a park and six buildings.", RainPreset = 1 }
                };
                vm.LoadCommand = Cmd(() => LoadSampleAsync(vm), () => !IsDynamicRunning, "Load sample");
                Samples.Add(vm);
            }
        }

        public string LoadedSampleId { get => _loadedSampleId; private set => Set(ref _loadedSampleId, value); }

        private Task LoadDemoAsync() => LoadSampleAsync(Samples.FirstOrDefault(s => s.Id == DefaultSampleId) ?? Samples.FirstOrDefault());

        private async Task LoadSampleAsync(SampleItemViewModel sample)
        {
            if (sample == null) return;
            if (!sample.IsAvailable) { Toast(sample.UnavailableHint, "Warning"); return; }
            if (IsDynamicRunning) { Toast("Wait for the dynamic run to finish (or cancel it) first.", "Warning"); return; }
            using (Busy($"Loading “{sample.Name}”…"))
            {
                string id = sample.Id;
                SiteModel site = await Task.Run(() =>
                {
                    try { return SampleLibrary.Load(id); }
                    catch (Exception) when (id == DefaultSampleId) { return DemoSite.Create(); }
                });
                if (site == null) throw new InvalidOperationException($"Sample “{sample.Name}” could not be loaded.");
                bool ok = await OnUi(() => Host.CreateDemoSiteAsync(site));
                RefreshPicks();
                if (!ok) { Toast($"{HostName} could not create the sample site.", "Warning"); return; }
                LoadedSampleId = id;
                RememberBounds(site);
                UpdateCellEstimate();
                SelectRainPreset(sample.Info?.RainPreset ?? -1);
                Toast(sample.CompareHint != null ? $"“{sample.Name}” loaded. {sample.CompareHint}." : $"“{sample.Name}” loaded.", "Success");
            }
            await BuildGridCoreAsync();
        }

        private void SelectRainPreset(int index)
        {
            try
            {
                var presets = RainOptions.Where(o => o.Kind == RainKind.Preset).ToList();
                if (index >= 0 && index < presets.Count) SelectedRainOption = presets[index];
            }
            catch (Exception) { }
        }
    }
}
