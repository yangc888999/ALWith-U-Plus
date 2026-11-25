//! Application policy around the shared Drive plugin.
//!
//! `alwith_drive::init` owns the service lifecycle (native library directory, event delivery,
//! ordered shutdown); this module only supplies the host's policy — directories, device name, URL
//! opener — and keeps the two behaviours the plugin cannot know about: the window whitelist for
//! filesystem lookups and the "hide windows, drain Drive, then exit" shutdown path.
use std::sync::Arc;

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[path = "drive_paths.rs"]
mod paths;

/// Builds the Drive plugin with this application's policy.
///
/// The service opens during plugin setup, so a failure there is kept inside the plugin and
/// returned by every command instead of stopping the app from launching.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::DynRuntime> {
    alwith_drive::init(
        alwith_drive::Config::new(|app| {
            let home = app.path().home_dir().map_err(failed)?;
            let opener = app.clone();
            let service = alwith_drive::DriveService::new(alwith_drive::ServiceOptions {
                data_directory: app.path().app_data_dir().map_err(failed)?.join("drive"),
                ownership_directory: home.join(".alwith-drive").join("owners"),
                default_root: home.join("YUP Drive"),
                reserved_roots: vec![],
                device_name: "ALWith U⁺".into(),
                client_version: env!("CARGO_PKG_VERSION").into(),
                open_url: Arc::new(move |url| {
                    opener
                        .opener()
                        .open_url(url, None::<&str>)
                        .map_err(|error| alwith_drive::NativeError::new("failed", error))
                }),
            })?
            .with_existing_default_root()?;
            // Skills live in the Codex home so Drive mirrors them beside the user's own skills.
            let codex_home =
                std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from).unwrap_or_else(|| home.join(".codex"));
            tauri::async_runtime::block_on(service.set_skills_directory(codex_home.join("skills")))?;
            Ok(service)
        })
        .development_directory(crate::native::development_directory())
        .event_windows(["main", "settings"]),
    )
}

/// A Tauri path error as a coded native error, matching what the plugin reports elsewhere.
fn failed(error: tauri::Error) -> alwith_drive::NativeError {
    alwith_drive::NativeError::new("failed", error)
}

#[tauri3_specta::command]
pub async fn drive_path_exists(
    window: tauri::WebviewWindow, state: tauri::State<'_, alwith_drive::Drive>, path: std::path::PathBuf,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("Drive filesystem access is limited to the main window".into());
    }
    let snapshot = state.service().map_err(|error| error.to_string())?.snapshot().map_err(|error| error.to_string())?;
    let roots = snapshot
        .roots
        .iter()
        .filter(|root| !root.drive_path.is_empty())
        .map(|root| std::path::PathBuf::from(&root.local_path))
        .collect::<Vec<_>>();
    paths::exists(std::path::Path::new(&snapshot.local_root), &roots, &path)
}

pub fn prevent_exit(app: &tauri::AppHandle, code: Option<i32>) -> bool {
    // Window notifications can arrive before the plugin's setup has managed Drive at all; that is
    // "not started", not "still draining".
    let Some(drive) = app.try_state::<alwith_drive::Drive>() else {
        return false;
    };
    if drive.is_stopped() {
        return false;
    }
    if drive.begin_shutdown() {
        // macOS leaves native fullscreen with an animation. Hiding that window in the same tick
        // as set_fullscreen(false) strands its fullscreen Space as an empty black rectangle —
        // exactly the "Cmd+Q leaves a black screen" report. Keep fullscreen windows visible
        // until the process exits, so macOS tears the Space down together with the window.
        let fullscreen: Vec<String> = app
            .webview_windows()
            .into_iter()
            .filter(|(_, window)| window.is_fullscreen().unwrap_or(false))
            .map(|(label, _)| label)
            .collect();
        if !fullscreen.is_empty() {
            crate::window::mark_fullscreen_exit();
        }
        crate::window::leave_fullscreen_all(app);
        // Dirty-buffer approval precedes this irreversible shutdown phase. Hiding the remaining
        // windows keeps cleanup invisible without destroying webviews still draining IPC replies.
        for (label, window) in app.webview_windows() {
            if fullscreen.contains(&label) {
                continue;
            }
            if let Err(error) = window.hide() {
                log::error!("Cannot hide window {} during shutdown: {error}", label);
            }
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let started = std::time::Instant::now();
            log::info!("Stopping Drive before application exit");
            if let Some(drive) = app.try_state::<alwith_drive::Drive>() {
                // A wedged service must never keep the process (and its hidden windows) alive.
                match tokio::time::timeout(std::time::Duration::from_secs(5), drive.shutdown()).await {
                    Ok(Err(error)) => log::error!("Drive shutdown failed: {error}"),
                    Err(_) => log::error!("Drive shutdown timed out; exiting anyway"),
                    Ok(Ok(())) => {}
                }
            }
            log::info!("Drive shutdown completed in {:?}", started.elapsed());
            app.exit(code.unwrap_or(0));
        });
    }
    true
}
