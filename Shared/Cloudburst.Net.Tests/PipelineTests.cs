using System;
using System.Linq;
using System.Threading;
using Cloudburst.Demo;
using Cloudburst.Materials;
using Cloudburst.Model;
using Cloudburst.Native;
using Cloudburst.Results;
using Xunit;
using Xunit.Abstractions;

namespace Cloudburst.Net.Tests
{
    public class PipelineTests
    {
        private readonly ITestOutputHelper _out;
        public PipelineTests(ITestOutputHelper o) { _out = o; }

        [Fact]
        public void EngineLoads() => Assert.False(string.IsNullOrEmpty(Engine.Version));

        [Fact]
        public void PaletteLoadsAndGuesses()
        {
            var p = MaterialPalette.LoadDefault();
            Assert.True(p.Materials.Count > 20);
            Assert.Equal("asphalt", p.Guess("Vej asfalt")?.Id);
        }

        [Fact]
        public void DemoSiteEndToEnd()
        {
            using var s = new CloudburstSession();
            s.GridSettings.CellSize = 1.0;
            var g = s.BuildGrid(DemoSite.Create());
            _out.WriteLine(g.ToString());
            foreach (var w in g.Warnings) _out.WriteLine(w);
            Assert.Equal(300, g.Nx);
            Assert.Contains(g.Building, b => b >= 0);

            var r = s.RunInstant();
            _out.WriteLine($"instant: {r.Stats.ElapsedMs:0} ms, {r.Stats.BluespotCount} bluespots, stored {r.Stats.StoredVolumeM3:0} m³, max {r.Stats.MaxDepthM:0.00} m, paths {r.FlowPaths.Count}");
            Assert.True(r.Stats.BluespotCount > 0);
            Assert.True(r.FlowPaths.Count > 0);
            var v = s.Visual(ResultLayer.Depth);
            Assert.True(v.Mesh.QuadCount > 0);
            Assert.Contains("SCREENING", v.Caption);

            s.Rain = RainEvent.Box(40, 20, 1.0);
            s.Scenario.AfterRainMin = 10;
            var d = s.RunDynamicAsync(new Progress<Progress>(), CancellationToken.None, new[] { g.CellAt(150, 95) }).Result;
            _out.WriteLine($"dynamic: {d.Mass.ElapsedS:0.0} s for {d.Mass.SimulatedS / 60:0} min, steps {d.Mass.Steps}, mass error {d.Mass.ErrorFraction * 100:0.0000} %, frames {d.FrameCount}");
            Assert.True(Math.Abs(d.Mass.ErrorFraction) < 1e-3);
            Assert.True(d.HMax.Max() > 0.05f);
            Assert.True(d.FrameCount > 0);
            Assert.Single(d.ProbeDepth);
            foreach (ResultLayer layer in new[] { ResultLayer.Depth, ResultLayer.Velocity, ResultLayer.Hazard, ResultLayer.TimeToPeak, ResultLayer.DepthAtTime })
                Assert.NotNull(s.Visual(layer, 0));

            var a = s.SaveOption("A");
            s.Scenario.SewerMode = 0;
            s.RunInstant();
            s.Dynamic.Dispose();
            var b = s.SaveOption("B");
            var c = s.Compare(a, b);
            _out.WriteLine($"compare: {c.FloodedVolumeA:0} → {c.FloodedVolumeB:0} m³");
            Assert.NotNull(VisualFactory.FromComparison(c));

            var ret = s.Retention();
            _out.WriteLine($"retention: Ared {ret.ReducedAreaM2:0} m², peak {ret.PeakFlowLS:0} l/s, V {ret.RequiredStorageM3:0} m³");
            Assert.True(ret.RequiredStorageM3 > 0);
        }

        [Fact]
        public void PresetsMatchPrd()
        {
            var p = RainEvent.Presets();
            Assert.InRange(p[1].DesignDepthMm, 82, 84);
            Assert.True(p[1].PeakMmH > 150);
        }
    }
}
