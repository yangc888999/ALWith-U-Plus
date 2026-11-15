//! The only place that talks to the private Drive library: the service handle, its event stream and
//! host requests, and transactions with their cancel guard. Synchronization, conflict handling,
//! ownership and every other Drive policy run inside the library. The functions have the
//! signatures the implementation would have, so open-sourcing the module replaces this file with
//! the crate itself.
use crate::contract::{DriveEvent, DriveRequest, DriveResponse, LegacyDesktopProfile, Payload, Preferences, Snapshot};
use alwith_native_client::{EventReader, Handle, Library, Module, NativeError};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    future::Future,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::broadcast;

pub const MODULE: Module = Module::new("drive", 2);

/// Opens a URL for Drive (single sign-on, web links) on the host.
pub type UrlOpener = Arc<dyn Fn(&str) -> Result<(), NativeError> + Send + Sync>;

pub struct ServiceOptions {
    pub data_directory: PathBuf,
    pub ownership_directory: PathBuf,
    pub default_root: PathBuf,
    pub reserved_roots: Vec<PathBuf>,
    pub device_name: String,
    pub client_version: String,
    pub open_url: UrlOpener,
}

/// Optional host choices made when the service opens, beside [`ServiceOptions`].
#[derive(Clone, Debug, Default)]
pub struct OpenOptions {
    session_archive_directory: Option<PathBuf>,
    default_preferences: Option<Preferences>,
    legacy_desktop: Option<LegacyDesktopProfile>,
}
impl OpenOptions {
    pub fn new() -> Self {
        Self::default()
    }
    /// The host's conversation directory (`*.jsonl`, `<id>.private` beside a private one). Drive
    /// then archives it itself every five minutes while archiving is enabled, on
    /// `archiveSyncNow`, and reports rounds as `archive` events. Without it the host exports
    /// conversations with `archiveSession`.
    pub fn session_archive_directory(mut self, directory: PathBuf) -> Self {
        self.session_archive_directory = Some(directory);
        self
    }
    /// Preferences of a profile that has not chosen any yet (new sign-ins and imports).
    pub fn default_preferences(mut self, preferences: Preferences) -> Self {
        self.default_preferences = Some(preferences);
        self
    }
    /// Import the previous ALwith Desktop Drive profile on first start.
    pub fn legacy_desktop(mut self, legacy: LegacyDesktopProfile) -> Self {
        self.legacy_desktop = Some(legacy);
        self
    }
}

/// The canonical form of a Drive target, resolving the existing ancestor of a missing path.
pub fn canonical_target(path: &Path) -> Result<PathBuf, NativeError> {
    Library::module(MODULE)?.call("drive.canonical_target", json!({"path": path}))
}

fn poisoned<T>(_: T) -> NativeError {
    NativeError::new("failed", "Drive client state poisoned")
}

/// The host side of the library's event stream. It ends when Drive shuts down, or with an error
/// when the transport failed (for example its queue overflowed); a failed stream is not resumed.
struct Stream {
    sender: Mutex<Option<broadcast::Sender<DriveEvent>>>,
    error: Mutex<Option<NativeError>>,
}
impl Stream {
    fn end(&self, error: Option<NativeError>) {
        if let Ok(mut current) = self.error.lock()
            && current.is_none()
        {
            *current = error;
        }
        if let Ok(mut sender) = self.sender.lock() {
            sender.take();
        }
    }
    fn ended(&self) -> Result<Option<DriveEvent>, NativeError> {
        match self.error.lock().map_err(poisoned)?.clone() {
            Some(error) => Err(error),
            None => Ok(None),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Message {
    Event { event: Box<DriveEvent> },
    OpenUrl { request_id: String, url: String },
}

/// One subscriber of Drive events.
pub struct DriveEvents {
    receiver: Option<broadcast::Receiver<DriveEvent>>,
    handle: Handle,
    stream: Arc<Stream>,
}
impl DriveEvents {
    /// The next event. A subscriber that fell behind receives a fresh snapshot in place of the
    /// skipped events, carrying the snapshot's generation and sequence, so it resynchronizes
    /// instead of failing. `Ok(None)` once Drive has stopped. An error means the transport stream
    /// failed; that is not a resynchronization and the service has to be recreated.
    pub async fn recv(&mut self) -> Result<Option<DriveEvent>, NativeError> {
        let Some(receiver) = &mut self.receiver else {
            return self.stream.ended();
        };
        match receiver.recv().await {
            Ok(event) => Ok(Some(event)),
            Err(broadcast::error::RecvError::Lagged(_)) => {
                let snapshot: Snapshot = self.handle.call_async("snapshot", json!({})).await?;
                Ok(Some(DriveEvent {
                    version: snapshot.version,
                    generation: snapshot.generation,
                    sequence: snapshot.sequence,
                    payload: Payload::Snapshot(snapshot),
                }))
            }
            Err(broadcast::error::RecvError::Closed) => {
                self.receiver = None;
                self.stream.ended()
            }
        }
    }
}

/// The open Drive service. Shut it down explicitly with [`DriveService::shutdown`] before exit;
/// dropping it only stops event delivery and releases the handle.
pub struct DriveService {
    handle: Handle,
    stream: Arc<Stream>,
    reader: Mutex<Option<EventReader>>,
}

/// Cancels the library transaction unless it finished. Dropping the caller's future cancels.
struct Transaction {
    handle: Handle,
    id: String,
    finished: bool,
}
impl Drop for Transaction {
    fn drop(&mut self) {
        if !self.finished
            && let Err(error) = self.handle.call::<()>("transaction_cancel", json!({"transaction_id": self.id}))
        {
            eprintln!("Native Drive transaction cancellation failed: {error}");
        }
    }
}

impl DriveService {
    pub fn new(options: ServiceOptions) -> Result<Self, NativeError> {
        Self::open(options, OpenOptions::default())
    }
    /// [`DriveService::new`] with the optional host choices.
    pub fn open(options: ServiceOptions, extra: OpenOptions) -> Result<Self, NativeError> {
        let handle = Handle::open(
            MODULE,
            json!({
                "data_directory": options.data_directory,
                "ownership_directory": options.ownership_directory,
                "default_root": options.default_root,
                "reserved_roots": options.reserved_roots,
                "device_name": options.device_name,
                "client_version": options.client_version,
                "session_archive_directory": extra.session_archive_directory,
                "default_preferences": extra.default_preferences,
                "legacy_desktop": extra.legacy_desktop,
            }),
        )?;
        let (sender, _) = broadcast::channel(1024);
        let stream = Arc::new(Stream { sender: Mutex::new(Some(sender)), error: Mutex::new(None) });
        let events = stream.clone();
        let replies = handle.clone();
        let open_url = options.open_url;
        let reader = EventReader::start::<Value>(handle.clone(), "next", "stop_events", move |message| {
            let message = message.and_then(|value| {
                serde_json::from_value::<Message>(value)
                    .map_err(|e| NativeError::new("invalidResponse", format!("Invalid Drive event: {e}")))
            });
            match message {
                Ok(Message::Event { event }) => {
                    if let Ok(sender) = events.sender.lock()
                        && let Some(sender) = sender.as_ref()
                    {
                        // No receiver yet is not a failure: subscribers start from a snapshot.
                        let _ = sender.send(*event);
                    }
                }
                Ok(Message::OpenUrl { request_id, url }) => {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| open_url(&url)))
                        .unwrap_or_else(|_| Err(NativeError::new("failed", "Host URL opener panicked")))
                        .map_err(|error| error.message);
                    if let Err(error) = replies.call::<()>("reply", json!({"request_id": request_id, "result": result}))
                    {
                        eprintln!("Native Drive URL response failed: {error}");
                    }
                }
                Err(error) => events.end(Some(error)),
            }
        })?;
        Ok(Self { handle, stream, reader: Mutex::new(Some(reader)) })
    }
    /// Adopt an existing default root folder instead of asking the user to confirm ownership.
    pub fn with_existing_default_root(self) -> Result<Self, NativeError> {
        self.handle.call::<()>("adopt_existing_default_root", json!({}))?;
        Ok(self)
    }
    pub async fn set_skills_directory(&self, directory: PathBuf) -> Result<(), NativeError> {
        self.handle.call_async("set_skills_directory", json!({"directory": directory})).await
    }
    pub fn snapshot(&self) -> Result<Snapshot, NativeError> {
        self.handle.call("snapshot", json!({}))
    }
    /// Events from now on; start from [`DriveService::snapshot`].
    pub fn subscribe(&self) -> DriveEvents {
        let receiver = self.stream.sender.lock().ok().and_then(|sender| sender.as_ref().map(|s| s.subscribe()));
        DriveEvents { receiver, handle: self.handle.clone(), stream: self.stream.clone() }
    }
    pub async fn execute(&self, request: DriveRequest) -> Result<DriveResponse, NativeError> {
        let request = serde_json::to_value(request).map_err(|e| NativeError::new("invalidParams", e))?;
        self.handle.call_async("execute", json!({"request": request})).await
    }
    /// Move a file or folder between two Drive projects on the server. `false` when the paths are
    /// not in two different projects and the caller moves it locally.
    pub async fn move_between_projects(&self, source: &Path, destination: &Path) -> Result<bool, NativeError> {
        self.handle.call_async("move_between_projects", json!({"source": source, "destination": destination})).await
    }
    /// Move uploaded Drive items into a Drive folder that has not landed locally: the server moves
    /// them with their identity and the local copies leave with the next synchronization. Returns
    /// how many moved, in order, and the error that stopped the rest. Frontends use the
    /// `moveToCloudDirectory` request.
    pub async fn move_to_cloud_directory(
        &self, sources: &[PathBuf], directory: &Path,
    ) -> Result<(usize, Option<String>), NativeError> {
        self.handle.call_async("move_to_cloud_directory", json!({"sources": sources, "directory": directory})).await
    }

    async fn transaction<T>(
        &self, params: Value, operation: impl Future<Output = Result<T, NativeError>>,
    ) -> Result<T, NativeError> {
        // Allocate synchronously before the first await so cancellation always owns a revocable handle.
        let id = self.handle.call("transaction_open", params)?;
        let mut transaction = Transaction { handle: self.handle.clone(), id, finished: false };
        self.handle.call_async::<()>("transaction_wait", json!({"transaction_id": transaction.id})).await?;
        let result = operation.await;
        let outcome = result.as_ref().map(|_| ()).map_err(|error| error.message.clone());
        // Finishing synchronously prevents cancellation between commit and handle retirement.
        let finish =
            self.handle.call::<()>("transaction_finish", json!({"transaction_id": transaction.id, "result": outcome}));
        transaction.finished = true;
        // A failed operation is echoed by the library; keep the operation's own coded error.
        let value = result?;
        finish?;
        Ok(value)
    }
    /// Run a local filesystem change while Drive holds synchronization for these paths, then let
    /// it record the change. Dropping the returned future cancels the transaction.
    pub async fn with_filesystem<T>(
        &self, writes: &[PathBuf], removed: &[PathBuf], operation: impl Future<Output = Result<T, NativeError>>,
    ) -> Result<T, NativeError> {
        let params = json!({"writes": writes, "removed": removed, "collaborative": null, "move_target": null});
        self.transaction(params, operation).await
    }
    /// A write to a file under collaborative editing by `owner_id`.
    pub async fn with_collaborative_filesystem<T>(
        &self, path: &Path, owner_id: &str, operation: impl Future<Output = Result<T, NativeError>>,
    ) -> Result<T, NativeError> {
        let params = json!({"writes": [], "removed": [], "collaborative": [path, owner_id], "move_target": null});
        self.transaction(params, operation).await
    }
    /// Moving `sources` into a local Drive `directory`, possibly across projects.
    pub async fn with_move_to_filesystem<T>(
        &self, sources: &[PathBuf], directory: &Path, operation: impl Future<Output = Result<T, NativeError>>,
    ) -> Result<T, NativeError> {
        let params = json!({"writes": [], "removed": [], "collaborative": null, "move_target": [sources, directory]});
        self.transaction(params, operation).await
    }

    /// Cancel open transactions and pending host requests, drain and stop synchronization, then
    /// end the event stream and join its reader. Every subscriber then receives `Ok(None)`.
    pub async fn shutdown(&self) -> Result<(), NativeError> {
        let result = self.handle.call_async::<()>("shutdown", json!({})).await;
        self.stream.end(None);
        let reader = self.reader.lock().map_err(poisoned)?.take();
        tokio::task::spawn_blocking(move || drop(reader)).await.map_err(|e| NativeError::new("failed", e))?;
        result
    }
}
impl Drop for DriveService {
    fn drop(&mut self) {
        self.stream.end(None);
    }
}
