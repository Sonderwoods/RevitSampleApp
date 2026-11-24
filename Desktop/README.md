# Cloudburst desktop app (Tauri 2)

A native Windows (also macOS/Linux) app that hosts the web front end (`../Web`) and its WebAssembly engine in a
WebView window. DHM terrain is downloaded by Rust code in the app (`src-tauri/src/main.rs`, command `fetch_dhm`), so
there are no CORS limits and no Python or local server is needed.

* **Installers**: GitHub Actions → `build` workflow → artifact **cloudburst-desktop-windows** (`.msi` and NSIS setup `.exe`).
  The setup `.exe` is per-user (no administrator rights) and also offers to install the Revit 2026 add-in and the
  Rhino 8 + Grasshopper package when those programs are found: `stage-plugins.ps1` copies them into
  `src-tauri/plugins/` before the build and `src-tauri/installer-hooks.nsh` installs them. The `.msi` installs the
  desktop app only and needs administrator rights.
* **Portable exe** (cross-compiled on Linux): `./build.sh` → `dist/Desktop/Cloudburst.exe`.
* **Build locally on Windows** (Rust + Node.js):

  ```powershell
  cd Desktop/src-tauri
  npx @tauri-apps/cli@2 build      # installers in target/release/bundle/
  npx @tauri-apps/cli@2 dev        # run with live reload of ../Web
  ```

Real terrain needs a free Datafordeler API key: https://portal.datafordeler.dk/hjem (MitID/NemID or e-mail login).
See [../docs/DHM_API_KEY.md](../docs/DHM_API_KEY.md).

Next step (not done yet): call the native multithreaded engine from Rust instead of WebAssembly for ~4–8× faster
dynamic runs. The crate is already shared, so this is a Tauri command away.
