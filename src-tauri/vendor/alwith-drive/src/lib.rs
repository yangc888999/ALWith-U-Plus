//! ALwith Drive plugin. Synchronization runs in the private native Drive library; this crate holds
//! the public types, the client (service handle, events, transactions and their cancellation),
//! typed commands and the application integration: start, event delivery and ordered shutdown.
mod client;
pub mod contract;
pub mod types;
pub use client::{DriveEvents, DriveService, MODULE, OpenOptions, ServiceOptions, UrlOpener, canonical_target};
pub use contract::{DriveEvent, DriveRequest, DriveResponse, LegacyDesktopProfile, Payload, Preferences, ServerOverrides, Snapshot};

pub use alwith_native_client::{Module, NativeError};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{
    AppHandle, Manager, State,
    plugin::{Builder, TauriPlugin},
};
use tauri3_specta::Event;

pub const PLUGIN: &str = "alwith-drive";

impl Event for DriveEvent {
    const NAME: &'static str = "drive:event";
}

type Open = Box<dyn FnOnce(&AppHandle) -> Result<DriveService, NativeError> + Send>;

/// Application rules for the plugin.
pub struct Config {
    open: Open,
    event_windows: Vec<String>,
    development_directory: Option<PathBuf>,
}
impl Config {
    /// `open` starts the service during plugin setup, from the application's directories, names and
    /// URL opener, after the plugin configured the native library directory. A failure is kept and
    /// returned by every command instead of stopping the app.
    pub fn new(open: impl FnOnce(&AppHandle) -> Result<DriveService, NativeError> + Send + 'static) -> Self {
        Self { open: Box::new(open), event_windows: Vec::new(), development_directory: None }
    }
    /// The host's staged native library directory, used only by debug builds; release builds
    /// always load the bundled `native` resources.
    pub fn development_directory(mut self, directory: Option<PathBuf>) -> Self {
        self.development_directory = directory;
        self
    }
    /// Deliver `drive:event` only to these windows; by default every window receives it.
    pub fn event_windows(mut self, labels: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.event_windows = labels.into_iter().map(Into::into).collect();
        self
    }
}

/// Plugin state, reached with `app.state::<Drive>()`: the service for the application's own Rust
/// code (workspace transactions, cross-project moves) and the ordered shutdown.
pub struct Drive {
    service: Result<Arc<DriveService>, NativeError>,
    closing: AtomicBool,
    stopped: AtomicBool,
}
impl Drive {
    /// The running service; refused once shutdown began or if it failed to start.
    pub fn service(&self) -> Result<&Arc<DriveService>, NativeError> {
        if self.closing.load(Ordering::Acquire) {
            return Err(NativeError::new("closing", "Application is closing"));
        }
        self.service.as_ref().map_err(Clone::clone)
    }
    pub fn is_closing(&self) -> bool {
        self.closing.load(Ordering::Acquire)
    }
    /// Shutdown completed; the application may exit now.
    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }
    /// Refuse new requests from now on. `true` only for the call that began closing, which then
    /// owns calling [`Drive::shutdown`].
    pub fn begin_shutdown(&self) -> bool {
        !self.closing.swap(true, Ordering::AcqRel)
    }
    /// Refuse new requests, cancel transactions, drain and stop Drive, and end event delivery. The
    /// application exits after this returns, whatever the result; call it once.
    pub async fn shutdown(&self) -> Result<(), NativeError> {
        self.closing.store(true, Ordering::Release);
        let result = match &self.service {
            Ok(service) => service.shutdown().await,
            Err(_) => Ok(()),
        };
        self.stopped.store(true, Ordering::Release);
        result
    }
}

fn credentials(request: &DriveRequest) -> bool {
    matches!(request, DriveRequest::McpSessionConfig | DriveRequest::CollabSession { .. })
}

/// Execute a Drive request. Session credentials go through `sessionRequest`.
#[tauri3_specta::command]
async fn request(state: State<'_, Drive>, request: DriveRequest) -> Result<DriveResponse, NativeError> {
    if credentials(&request) {
        return Err(NativeError::new("forbidden", "Drive session credentials require sessionRequest"));
    }
    state.service()?.execute(request).await
}

/// Request Drive session credentials: `mcpSessionConfig` or `collabSession`.
#[tauri3_specta::command]
async fn session_request(state: State<'_, Drive>, request: DriveRequest) -> Result<DriveResponse, NativeError> {
    if !credentials(&request) {
        return Err(NativeError::new("invalidParams", "Only session credential requests are accepted here"));
    }
    state.service()?.execute(request).await
}

/// Write the collaborative document `path` that the editor `ownerId` holds a collaboration session
/// for (from `collabSession`): Drive checks the session, the file's identity and write access,
/// then the content replaces the file atomically. Needs `allow-collaborative-write`.
#[tauri3_specta::command]
async fn collaborative_write(
    state: State<'_, Drive>, path: String, owner_id: String, content: String,
) -> Result<(), NativeError> {
    let path = PathBuf::from(path);
    let target = path.clone();
    state.service()?.with_collaborative_filesystem(&path, &owner_id, write_atomically(target, content)).await
}

async fn write_atomically(target: PathBuf, content: String) -> Result<(), NativeError> {
    let failed = |error: std::io::Error| NativeError::new("failed", error);
    let parent = target.parent().ok_or_else(|| NativeError::new("invalidParams", "The document has no directory"))?;
    let name = target.file_name().ok_or_else(|| NativeError::new("invalidParams", "The document has no file name"))?;
    let temporary = parent.join(format!(".{}.alwith-write", name.to_string_lossy()));
    tokio::fs::write(&temporary, content).await.map_err(failed)?;
    if let Err(error) = tokio::fs::rename(&temporary, &target).await {
        if let Err(cleanup) = tokio::fs::remove_file(&temporary).await {
            eprintln!("Cannot remove the temporary collaborative write: {cleanup}");
        }
        return Err(failed(error));
    }
    Ok(())
}

/// Commands, events and TypeScript bindings from one list.
pub fn bindings() -> tauri3_specta::Bindings {
    tauri3_specta::commands![request, session_request, collaborative_write]
        .event::<DriveEvent>()
        .plugin(PLUGIN)
        .expect("valid plugin name")
}

fn deliver(app: &AppHandle, windows: &[String], event: &DriveEvent) {
    if windows.is_empty() {
        if let Err(error) = event.emit(app) {
            eprintln!("Cannot deliver Drive event: {error}");
        }
        return;
    }
    for label in windows {
        if let Err(error) = event.emit_to(app, label.as_str()) {
            eprintln!("Cannot deliver Drive event to {label}: {error}");
        }
    }
}

pub fn init(config: Config) -> TauriPlugin<tauri::DynRuntime> {
    let handler = bindings().invoke_handler();
    Builder::new(PLUGIN)
        .invoke_handler(handler)
        .setup(move |app, _api| {
            let resource_dir = app.path().resource_dir().map_err(|e| NativeError::new("failed", e));
            let service = resource_dir
                .and_then(|resources| {
                    alwith_native_client::configure_host(&resources, config.development_directory.as_deref())
                })
                .and_then(|()| (config.open)(app))
                .map(Arc::new);
            app.manage(Drive {
                service: service.clone(),
                closing: AtomicBool::new(false),
                stopped: AtomicBool::new(false),
            });
            let Ok(service) = service else { return Ok(()) };
            let app = app.clone();
            let windows = config.event_windows;
            let mut events = service.subscribe();
            drop(service);
            tauri::async_runtime::spawn(async move {
                let mut last = None;
                loop {
                    match events.recv().await {
                        Ok(Some(event)) => {
                            last = Some((event.version, event.generation, event.sequence));
                            deliver(&app, &windows, &event);
                        }
                        Ok(None) => break,
                        Err(error) => {
                            // The transport failed; report it instead of silently going quiet.
                            eprintln!("Drive event stream failed: {error}");
                            let (version, generation, sequence) = last.unwrap_or_default();
                            let payload = Payload::Error(format!("Drive event stream failed: {}", error.message));
                            deliver(&app, &windows, &DriveEvent { version, generation, sequence, payload });
                            break;
                        }
                    }
                }
            });
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    #[test]
    fn generated_bindings_are_current() {
        let options = tauri3_specta::ExportOptions { bigints_as_numbers: true, ..Default::default() };
        let source = super::bindings().typescript_with(options).unwrap() + alwith_native_client::TYPESCRIPT_HELPERS;
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/generated/commands.ts");
        if std::env::var_os("UPDATE_BINDINGS").is_some() {
            std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
            std::fs::write(path, &source).unwrap();
        }
        assert_eq!(std::fs::read_to_string(path).unwrap_or_default(), source, "run with UPDATE_BINDINGS=1");
    }

    #[test]
    fn credentials_are_separated_from_ordinary_requests() {
        use super::{DriveRequest, credentials};
        let decode = |value| serde_json::from_value::<DriveRequest>(value).unwrap();
        assert!(credentials(&decode(serde_json::json!({"type": "mcpSessionConfig"}))));
        assert!(credentials(&decode(serde_json::json!({"type": "collabSession", "path": "/a", "ownerId": "o"}))));
        assert!(!credentials(&decode(serde_json::json!({"type": "snapshot"}))));
    }
}
