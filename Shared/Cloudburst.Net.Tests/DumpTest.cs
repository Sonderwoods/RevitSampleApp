using System.IO;
using System.Linq;
using System.Threading;
using Cloudburst.Demo;
using Cloudburst.Model;
using Xunit;
namespace Cloudburst.Net.Tests
{
    public class DumpTest
    {
        [Fact]
        public void DumpDemo()
        {
            var dir = System.Environment.GetEnvironmentVariable("CB_DUMP");
            if (string.IsNullOrEmpty(dir)) return;
            using var s = new CloudburstSession();
            var g = s.BuildGrid(DemoSite.Create());
            var r = s.RunInstant();
            void W(string n, float[] a) => File.WriteAllBytes(Path.Combine(dir, n), a.SelectMany(System.BitConverter.GetBytes).ToArray());
            W("z.bin", g.Z); W("depth.bin", r.Depth); W("acc.bin", r.Accumulation);
            W("mat.bin", g.Material.Select(m => (float)m).ToArray()); W("bld.bin", g.Building.Select(b => (float)b).ToArray());
            File.WriteAllText(Path.Combine(dir, "paths.txt"), string.Join("\n", r.FlowPaths.Select(p => string.Join(" ", Enumerable.Range(0, p.Count).Select(i => $"{p.X[i]:0.0},{p.Y[i]:0.0},{p.Weight[i]:0.0}")))));
            File.WriteAllText(Path.Combine(dir, "info.txt"), $"{g.Nx} {g.Ny} {g.X0} {g.Y0} {g.CellSize}");
            s.Rain = RainEvent.Presets()[1]; s.Scenario.AfterRainMin = 30;
            var d = s.RunDynamicAsync(null, CancellationToken.None).Result;
            W("hmax.bin", d.HMax); W("vmax.bin", d.VMax);
            File.WriteAllText(Path.Combine(dir, "mass.txt"), $"{d.Mass.RainM3} {d.Mass.InitialLossM3} {d.Mass.InfiltratedM3} {d.Mass.SewerM3} {d.Mass.BoundaryOutM3} {d.Mass.StoredM3} {d.Mass.ErrorFraction} {d.Mass.ElapsedS} {d.Mass.SimulatedS}");
        }
    }
}
