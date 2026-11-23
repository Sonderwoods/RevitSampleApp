#!/usr/bin/env bash
# Cross-builds everything from Linux: Rust engine for Windows (mingw) + Linux, .NET plugins (EnableWindowsTargeting),
# runs all tests, and assembles dist/. Requires: rustup target x86_64-pc-windows-gnu, gcc-mingw-w64-x86-64, .NET 8 SDK.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
cd "$root/Shared/cloudburst-core"
cargo test --release
cargo build --release
cargo build --release --target x86_64-pc-windows-gnu
cd "$root"
dotnet test Shared/Cloudburst.Net.Tests -c Release
dotnet build Cloudburst.sln -c Release
rm -rf dist && mkdir -p dist/Rhino dist/Revit/Cloudburst
cp -r Rhino/Cloudburst.Rhino/bin/Release/net7.0-windows/* dist/Rhino/
cp Rhino/Cloudburst.Grasshopper/bin/Release/net7.0-windows/Cloudburst.Grasshopper.gha dist/Rhino/
cp -r Revit/Cloudburst.Revit/bin/Release/net8.0-windows/* dist/Revit/Cloudburst/
[ -f dist/Revit/Cloudburst/Cloudburst.addin ] && mv dist/Revit/Cloudburst/Cloudburst.addin dist/Revit/
if [ -d Shared/Cloudburst.Standalone/bin/Release/net8.0-windows ]; then mkdir -p dist/Standalone && cp -r Shared/Cloudburst.Standalone/bin/Release/net8.0-windows/* dist/Standalone/; fi
rm -f dist/*/libcloudburst_core.so dist/Revit/Cloudburst/libcloudburst_core.so
echo "dist ready"; find dist -name cloudburst_core.dll
