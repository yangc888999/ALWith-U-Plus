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
}
