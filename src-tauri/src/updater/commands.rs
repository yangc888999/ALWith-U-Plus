use crate::updater::state::State as UpdaterState;
use crate::updater::{PluginChecker, PluginDownloader, PluginInstaller, UpdaterService};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State as TauriState};

#[tauri3_specta::command]
pub async fn updater_get_state(svc: TauriState<'_, Arc<UpdaterService>>) -> Result<UpdaterState, ()> {
    Ok(svc.state())
}

/// One background round: check (the plugin call blocks, so it runs on a blocking thread),
/// then download straight away when a release is found.
pub async fn check_and_autodownload(app: AppHandle, svc: Arc<UpdaterService>) {
    if !crate::updater::auto_update_enabled(&app) {
        return;
    }
    let checker = PluginChecker::new(app.clone());
    let svc_check = svc.clone();
    if tokio::task::spawn_blocking(move || svc_check.check_for_updates(&checker)).await.is_err() {
        return;
    }
    // The setting can change while the network check is in flight.
    if !crate::updater::auto_update_enabled(&app) {
        svc.set_state(UpdaterState::idle());
        return;
    }
    let Ok(updater_dir) = updater_dir(&app) else {
        return;
    };
    let downloader = PluginDownloader::new(app);
    svc.autodownload_if_available(&downloader, &updater_dir).await;
}

#[tauri3_specta::command]
pub async fn updater_install_and_relaunch(
    app: AppHandle, svc: TauriState<'_, Arc<UpdaterService>>,
) -> Result<(), String> {
    let installer = PluginInstaller::new(app.clone());
    let updater_dir = updater_dir(&app)?;
    svc.install_and_relaunch(&installer, &updater_dir).await
}

/// One check on demand. Turning the switch on in Settings calls this, so the user does not wait
/// for the hourly tick (or the 30s startup delay) before seeing whether a release exists.
#[tauri3_specta::command]
pub async fn updater_check_now(app: AppHandle, svc: TauriState<'_, Arc<UpdaterService>>) -> Result<(), String> {
    let service = svc.inner().clone();
    check_and_autodownload(app, service).await;
    Ok(())
}

pub(crate) fn updater_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let base = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    Ok(base.join("updater"))
}
