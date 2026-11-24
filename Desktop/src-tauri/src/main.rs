// Cloudburst desktop: hosts Web/ (sample gallery, live instant model, dynamic runs, all on the WebAssembly engine)
// in a native window. DHM terrain is downloaded here in Rust, so there are no browser CORS limits and no local server.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

const DATAFORDELER: &str = "https://wcs.datafordeler.dk/DHMNedboer/dhm_wcs/1.0.0/WCS";
const DATAFORSYNINGEN: &str = "https://api.dataforsyningen.dk/dhm_wcs_DAF";

/// GET a DHM WCS request. `query` is the full query string built by the front end (including the key).
/// Returns the raw GeoTIFF bytes, or an error text with the HTTP status and server message.
#[tauri::command]
async fn fetch_dhm(provider: String, query: String) -> Result<tauri::ipc::Response, String> {
    let base = if provider == "dataforsyningen" { DATAFORSYNINGEN } else { DATAFORDELER };
    let url = format!("{base}?{query}");
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(180)).user_agent("cloudburst-desktop/0.1").build();
        match agent.get(&url).call() {
            Ok(resp) => {
                let mut buf = Vec::new();
                std::io::Read::read_to_end(&mut resp.into_reader(), &mut buf).map_err(|e| e.to_string())?;
                Ok(buf)
            }
            Err(ureq::Error::Status(code, resp)) => {
                let body = resp.into_string().unwrap_or_default();
                Err(format!("HTTP {code}: {}", body.chars().take(400).collect::<String>()))
            }
            Err(e) => Err(format!("network error: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![fetch_dhm])
        .run(tauri::generate_context!())
        .expect("error while running Cloudburst");
}
