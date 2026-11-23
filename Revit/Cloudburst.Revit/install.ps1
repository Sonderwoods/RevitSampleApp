<#
  Installs the Cloudburst Revit 2026 add-in for the current user.
  Usage (from the build output folder or the project folder):
     powershell -ExecutionPolicy Bypass -File install.ps1 [-Source <folder with Cloudburst.Revit.dll>] [-Uninstall]
  Result:
     %AppData%\Autodesk\Revit\Addins\2026\Cloudburst.addin
     %AppData%\Autodesk\Revit\Addins\2026\Cloudburst\  (Cloudburst.Revit.dll, Cloudburst.Net.dll, Cloudburst.UI.dll, cloudburst_core.dll)
  Close Revit before running it (loaded DLLs are locked).
#>
param(
    [string]$Source = "",
    [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$addins = Join-Path $env:APPDATA "Autodesk\Revit\Addins\2026"
$target = Join-Path $addins "Cloudburst"

if ($Uninstall) {
    Remove-Item (Join-Path $addins "Cloudburst.addin") -ErrorAction SilentlyContinue
    Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Cloudburst removed from $addins"
    exit 0
}

if (-not $Source) {
    $here = Split-Path -Parent $MyInvocation.MyCommand.Path
    if (Test-Path (Join-Path $here "Cloudburst.Revit.dll")) { $Source = $here }
    else {
        $candidates = @("bin\Release\net8.0-windows", "bin\Debug\net8.0-windows") | ForEach-Object { Join-Path $here $_ }
        $Source = $candidates | Where-Object { Test-Path (Join-Path $_ "Cloudburst.Revit.dll") } | Select-Object -First 1
    }
}
if (-not $Source -or -not (Test-Path (Join-Path $Source "Cloudburst.Revit.dll"))) {
    throw "Cloudburst.Revit.dll not found. Build first (dotnet build -c Release) or pass -Source <folder>."
}

if (Get-Process -Name Revit -ErrorAction SilentlyContinue) { Write-Warning "Revit is running - files may be locked. Close Revit and run again if the copy fails." }

New-Item -ItemType Directory -Force -Path $target | Out-Null
$files = Get-ChildItem $Source -File | Where-Object { $_.Extension -in ".dll", ".pdb", ".json" -and $_.Name -notlike "libcloudburst_core*" }
foreach ($f in $files) { Copy-Item $f.FullName -Destination $target -Force }
Copy-Item (Join-Path $Source "Cloudburst.addin") -Destination $addins -Force

foreach ($req in "Cloudburst.Revit.dll", "Cloudburst.Net.dll", "Cloudburst.UI.dll", "cloudburst_core.dll") {
    if (-not (Test-Path (Join-Path $target $req))) { Write-Warning "Missing $req in $target" }
}
Write-Host "Cloudburst installed to $addins. Start Revit 2026 and open the 'Cloudburst' ribbon tab."
