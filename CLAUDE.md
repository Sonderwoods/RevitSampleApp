# Cloudburst (RevitSampleApp)

Rainwater / cloudburst screening: a shared Rust engine (`Shared/cloudburst-core`) with .NET wrapper and WPF UI
(`Shared/`), hosts for Revit 2026 (`Revit/`) and Rhino 8 / Grasshopper (`Rhino/`), a web app (`Web/`) and a Tauri
desktop app (`Desktop/`). See `README.md`.

## Rules

- **Revit: always include linked models.** Anything that reads the Revit model (terrain, buildings, surfaces,
  materials, future features) must also read every loaded `RevitLinkInstance` via `GetLinkDocument()`, placed with
  `GetTotalTransform()`. Never read only the host document. See `RevitHost.DetectCore` and the `LinkId` on picks.
