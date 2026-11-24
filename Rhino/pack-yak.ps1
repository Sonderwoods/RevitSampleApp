# Packs dist/Rhino (Rhino plug-in + Grasshopper components + engine DLLs) into a Yak package for the Rhino 8
# Package Manager: dist/cloudburst-<version>-rh8*-win.yak
#   ./build.ps1; ./Rhino/pack-yak.ps1                 (version from Directory.Build.props)
#   ./Rhino/pack-yak.ps1 -Version 0.2.0
# Install: drag the .yak into Rhino 8, or  "C:\Program Files\Rhino 8\System\Yak.exe" install <file.yak>
# Uses Rhino's Yak.exe when Rhino is installed, otherwise downloads McNeel's standalone yak.exe; if neither is
# available the package (a zip with manifest.yml at its root) is written directly.
param([string]$Version = "")
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$src = "$root/dist/Rhino"
if (-not (Test-Path "$src/Cloudburst.Rhino.rhp")) { throw "dist/Rhino not found: run ./build.ps1 first" }

$Version = $Version.TrimStart('v')
if (-not $Version) { $Version = ([xml](Get-Content "$root/Directory.Build.props")).Project.PropertyGroup.Version }
if ($Version -notmatch '^\d+\.\d+\.\d+') { throw "Version '$Version' is not like 1.2.3" }

$stage = "$root/dist/yak"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $stage | Out-Null
Get-ChildItem $src -File | Where-Object { $_.Extension -in '.rhp', '.gha', '.dll' } | Copy-Item -Destination $stage
Copy-Item "$root/Web/icons/icon-192.png" "$stage/icon.png"
(Get-Content "$PSScriptRoot/yak/manifest.yml" -Raw).Replace('$version', $Version) | Set-Content "$stage/manifest.yml" -Encoding utf8

$yak = "C:\Program Files\Rhino 8\System\Yak.exe"
if (-not (Test-Path $yak)) {
  $yak = Join-Path ([IO.Path]::GetTempPath()) "yak.exe"
  if (-not (Test-Path $yak)) {
    try { Invoke-WebRequest "https://files.mcneel.com/yak/tools/latest/yak.exe" -OutFile $yak }
    catch { Write-Warning "Could not download yak.exe: $($_.Exception.Message)"; $yak = $null }
  }
}

$built = $false
if ($yak) {
  Push-Location $stage
  try { & $yak build --platform win; $built = ($LASTEXITCODE -eq 0) -and [bool](Get-ChildItem *.yak) }
  catch { Write-Warning "yak build failed: $($_.Exception.Message)" }
  finally { Pop-Location }
}
if (-not $built) {
  Write-Warning "Writing the package without yak.exe."
  Get-ChildItem $stage -Filter *.yak | Remove-Item -Force
  $zip = "$root/dist/cloudburst-$Version-rh8-win.zip"
  Compress-Archive -Path "$stage/*" -DestinationPath $zip -Force
  Move-Item $zip "$stage/cloudburst-$Version-rh8-win.yak" -Force
}

$out = Get-ChildItem $stage -Filter *.yak | Select-Object -First 1
Move-Item $out.FullName "$root/dist/$($out.Name)" -Force
Remove-Item $stage -Recurse -Force
Write-Host "Yak package: dist/$($out.Name)"
