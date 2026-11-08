//! Login launches start the host with its normal window state.

use tauri_plugin_autostart::ManagerExt;

#[derive(serde::Serialize, specta::Type)]
pub struct AutostartStatus {
    supported: bool,
    enabled: bool,
}

fn supported() -> bool {
    if tauri::is_dev() {
        return false;
    }
    #[cfg(target_os = "macos")]
    return std::env::current_exe().is_ok_and(|path| is_app_executable(&path));
    #[cfg(not(target_os = "macos"))]
    true
}

#[cfg(target_os = "macos")]
fn is_app_executable(path: &std::path::Path) -> bool {
    path.parent().is_some_and(|macos| {
        macos.file_name().is_some_and(|name| name == "MacOS")
            && macos.parent().is_some_and(|contents| {
                contents.file_name().is_some_and(|name| name == "Contents")
                    && contents.parent().is_some_and(|bundle| bundle.extension().is_some_and(|ext| ext == "app"))
            })
    })
}

#[tauri3_specta::command]
pub fn autostart_status(app: tauri::AppHandle) -> Result<AutostartStatus, String> {
    let supported = supported();
    let enabled = supported && app.autostart().is_enabled().map_err(|error| error.to_string())?;
    Ok(AutostartStatus { supported, enabled })
}

#[tauri3_specta::command]
pub fn autostart_set(app: tauri::AppHandle, window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("Only settings may change launch at login".into());
    }
    if !supported() {
        return Err("Launch at login requires an installed application build".into());
    }
    let launcher = app.autostart();
    if enabled { launcher.enable() } else { launcher.disable() }.map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "__tests__/autostart.rs"]
mod tests;
