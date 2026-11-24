# Copies the built plug-ins into Desktop/src-tauri/plugins so the desktop setup program can install them too
# (see src-tauri/installer-hooks.nsh). Run after ./build.ps1 and ./Rhino/pack-yak.ps1, before the Tauri build.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$dst = "$PSScriptRoot/src-tauri/plugins"
Remove-Item "$dst/Revit", "$dst/Rhino" -Recurse -Force -ErrorAction SilentlyContinue

if (-not (Test-Path "$root/dist/Revit/Cloudburst.addin")) { throw "dist/Revit not found: run ./build.ps1 first" }
New-Item -ItemType Directory "$dst/Revit" | Out-Null
Copy-Item "$root/dist/Revit/*" "$dst/Revit" -Recurse -Force
Get-ChildItem "$dst/Revit" -Recurse -Include *.pdb | Remove-Item -Force

$yak = Get-ChildItem "$root/dist" -Filter *.yak | Select-Object -First 1
if (-not $yak) { throw "No .yak in dist/: run ./Rhino/pack-yak.ps1 first" }
New-Item -ItemType Directory "$dst/Rhino" | Out-Null
Copy-Item $yak.FullName "$dst/Rhino/$($yak.Name)"
Write-Host "Plug-ins staged for the desktop installer:"
Get-ChildItem $dst -Recurse -File | ForEach-Object { "  " + $_.FullName.Substring($dst.Length + 1) }
