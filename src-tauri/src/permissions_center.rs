//! The macOS permission center behind Settings → 操作电脑.
//!
//! macOS exposes different TCC APIs for different privacy panes. The six permissions backed by
//! the `macos-privacy` crate have real status checks; the remaining panes have no supported query
//! API, so the UI links to System Settings and labels them as needing confirmation instead of
//! inventing a granted/denied state.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OperationPermissionStatus {
    pub id: String,
    pub granted: bool,
    /// `authorized`, `notDetermined`, `denied`, `restricted`, `notAuthorized`, or `unavailable`.
    pub state: String,
}

#[cfg(target_os = "macos")]
fn permission_for(id: &str) -> Option<macos_privacy::Permission> {
    use macos_privacy::Permission;
    match id {
        "accessibility" => Some(Permission::Accessibility),
        "screenRecording" => Some(Permission::ScreenRecording),
        "inputMonitoring" => Some(Permission::InputMonitoring),
        "fullDiskAccess" => Some(Permission::FullDiskAccess),
        "camera" => Some(Permission::Camera),
        "microphone" => Some(Permission::Microphone),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn state_of(status: macos_privacy::Status) -> (&'static str, bool) {
    use macos_privacy::{AuthorizationStatus, Status};
    match status {
        Status::Known(AuthorizationStatus::Authorized) => ("authorized", true),
        Status::Known(AuthorizationStatus::NotDetermined) => ("notDetermined", false),
        Status::Known(AuthorizationStatus::Denied) => ("denied", false),
        Status::Known(AuthorizationStatus::Restricted) => ("restricted", false),
        Status::Observed { authorized: true } => ("authorized", true),
        Status::Observed { authorized: false } => ("notAuthorized", false),
    }
}

#[tauri3_specta::command]
pub async fn permissions_center_status() -> Vec<OperationPermissionStatus> {
    #[cfg(not(target_os = "macos"))]
    return Vec::new();
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            ["accessibility", "screenRecording", "inputMonitoring", "fullDiskAccess", "camera", "microphone"]
                .into_iter()
                .filter_map(|id| {
                    let permission = permission_for(id)?;
                    let (state, granted) = state_of(macos_privacy::status(permission));
                    Some(OperationPermissionStatus { id: id.to_string(), granted, state: state.to_string() })
                })
                .collect()
        })
        .await
        .unwrap_or_default()
    }
}

#[tauri3_specta::command]
pub async fn permissions_center_request(permission: String) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    return Err("当前平台没有 macOS 隐私授权接口".to_string());
    #[cfg(target_os = "macos")]
    {
        let parsed = permission_for(&permission).ok_or_else(|| format!("未知权限：{permission}"))?;
        tauri::async_runtime::spawn_blocking(move || {
            if parsed == macos_privacy::Permission::FullDiskAccess {
                return macos_privacy::open_settings(parsed).map_err(|error| error.to_string());
            }
            macos_privacy::prompt(parsed).map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

#[tauri3_specta::command]
pub async fn permissions_center_open_settings(permission: String) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    return Err("当前平台没有 macOS 隐私授权接口".to_string());
    #[cfg(target_os = "macos")]
    {
        let parsed = permission_for(&permission).ok_or_else(|| format!("未知权限：{permission}"))?;
        tauri::async_runtime::spawn_blocking(move || {
            macos_privacy::open_settings(parsed).map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

/// Opens a System Settings privacy pane that macOS does not expose through a TCC query API.
///
/// The webview must not use the generic opener plugin for `x-apple.systempreferences:` URLs: its
/// URL scope rejects the scheme, which produced "Not allowed to open url …" for Files and Folders,
/// App Management, Media, Contacts and the other settings-only rows. Validate the small URL family
/// here, then launch System Settings through the system `open` binary; this is the same route the
/// macOS privacy crate uses for the supported TCC panes.
fn allowed_settings_url(url: &str) -> bool {
    url.starts_with("x-apple.systempreferences:com.apple.preference.security?")
        || url == "x-apple.systempreferences:com.apple.preference.notifications"
        || url.starts_with("x-apple.systempreferences:com.apple.settings.")
}

#[tauri3_specta::command]
pub async fn permissions_center_open_url(url: String) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    return Err("当前平台没有 macOS 系统设置深链".to_string());
    #[cfg(target_os = "macos")]
    {
        if !allowed_settings_url(&url) {
            return Err("不支持的系统设置地址".to_string());
        }
        tauri::async_runtime::spawn_blocking(move || {
            let status =
                std::process::Command::new("/usr/bin/open").arg(&url).status().map_err(|error| error.to_string())?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("打开系统设置失败（退出码 {}）", status.code().unwrap_or(-1)))
            }
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_real_tcc_permissions_are_accepted() {
        #[cfg(target_os = "macos")]
        {
            assert!(permission_for("accessibility").is_some());
            assert!(permission_for("screenRecording").is_some());
            assert!(permission_for("fullDiskAccess").is_some());
            assert!(permission_for("camera").is_some());
            assert!(permission_for("filesAndFolders").is_none());
        }
    }

    #[test]
    fn only_privacy_settings_deep_links_are_allowed() {
        assert!(allowed_settings_url(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
        ));
        assert!(allowed_settings_url(
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Contacts"
        ));
        assert!(!allowed_settings_url("https://example.com"));
        assert!(!allowed_settings_url("file:///Applications"));
        assert!(allowed_settings_url("x-apple.systempreferences:com.apple.preference.notifications"));
    }
}
