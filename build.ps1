# Builds the Rust engine and all Windows plugins, and assembles dist/.
#   ./build.ps1            (Release)
# Requires: Rust (rustup, MSVC toolchain), .NET 8 SDK.
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Push-Location "$root/Shared/cloudburst-core"
cargo build --release
Pop-Location

dotnet build "$root/Cloudburst.sln" -c Release
if ($LASTEXITCODE -ne 0) { throw "dotnet build failed" }

$dist = "$root/dist"
Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory "$dist/Rhino", "$dist/Revit/Cloudburst" | Out-Null

Copy-Item "$root/Rhino/Cloudburst.Rhino/bin/Release/net7.0-windows/*" "$dist/Rhino" -Recurse -Force
Copy-Item "$root/Rhino/Cloudburst.Grasshopper/bin/Release/net7.0-windows/Cloudburst.Grasshopper.gha" "$dist/Rhino" -Force
Copy-Item "$root/Revit/Cloudburst.Revit/bin/Release/net8.0-windows/*" "$dist/Revit/Cloudburst" -Recurse -Force
Move-Item "$dist/Revit/Cloudburst/Cloudburst.addin" "$dist/Revit/Cloudburst.addin" -Force -ErrorAction SilentlyContinue
if (Test-Path "$root/Shared/Cloudburst.Standalone/bin/Release/net8.0-windows/win-x64") {
  New-Item -ItemType Directory "$dist/Standalone" | Out-Null
  Copy-Item "$root/Shared/Cloudburst.Standalone/bin/Release/net8.0-windows/win-x64/*" "$dist/Standalone" -Recurse -Force
}
Write-Host "dist/ ready:"
Get-ChildItem $dist -Recurse -Filter *.dll | Where-Object Name -like "cloudburst_core.dll" | ForEach-Object { $_.FullName }
