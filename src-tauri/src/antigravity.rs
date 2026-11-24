//! Local launcher for the experimental Antigravity ACP bridge.
//!
//! The official Antigravity ACP runtime is carried inside the app bundle for this local build and
//! released to Application Support on first use. The Bun bridge owns the official binary's native
//! OAuth flow; events are forwarded as NDJSON strings on `antigravity:event`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock, mpsc};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::runtime::sidecar_path;

mod responses;
mod runtime;

pub(crate) use responses::respond_to_turn;

const EVENT: &str = "antigravity:event";
const RUNTIME_FILES: [&str; 2] = ["agy_acp_server.par", "localharness_external"];
const RUNTIME_STAMP: &str = "runtime.stamp";
/// Stamp written for an on-demand download. Kept distinct from the bundled stamp so a future build
/// that bundles a newer runtime still detects a version change and replaces the downloaded files.
const DOWNLOAD_STAMP: &str = "downloaded=1.5.2";

/// What 设置 → 大模型 may show without ever touching the Google token.
///
/// The official binary stores its OAuth credential in the login keychain under service `gemini`
/// and account `antigravity-acp`. U⁺ only asks whether that item exists (no `-w`, so no secret is
/// read) and reads the non-secret `auth.type` from the official settings file.
#[derive(Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityStatus {
    pub signed_in: bool,
    pub auth_type: Option<String>,
}

struct BridgeProcess {
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
}

type Pending = Arc<Mutex<HashMap<String, mpsc::Sender<TurnEvent>>>>;

/// requestId -> caller-supplied key for native Agent turns whose events stream to the frontend
/// instead of being consumed by the Responses bridge.
type AgentTurns = Arc<Mutex<HashMap<String, String>>>;

#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TurnEvent {
    Delta {
        text: String,
    },
    Done {
        #[serde(rename = "stopReason")]
        stop_reason: String,
    },
    Error {
        message: String,
    },
    /// A tool the official Agent started/completed. Forwarded to the host to render a tool card.
    ToolCall {
        #[serde(rename = "toolCall")]
        tool_call: Value,
    },
    ToolCallUpdate {
        #[serde(rename = "toolCall")]
        tool_call: Value,
    },
}

impl BridgeProcess {
    fn send(&mut self, value: &Value) -> Result<(), String> {
        writeln!(self.stdin, "{value}").and_then(|_| self.stdin.flush()).map_err(|error| error.to_string())
    }

    fn stop(self) {
        let Self { mut child, stdin, .. } = self;
        drop(stdin);
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

#[derive(Default)]
pub struct AntigravityBridge {
    process: Mutex<Option<BridgeProcess>>,
    /// requestId -> turn key for frontend-streamed Agent turns.
    agent_turns: AgentTurns,
}

impl Drop for AntigravityBridge {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.process.lock() {
            if let Some(process) = guard.take() {
                process.stop();
            }
        }
    }
}

struct Turn {
    id: String,
    app: AppHandle,
    events: mpsc::Receiver<TurnEvent>,
}

impl Drop for Turn {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.app.state::<AntigravityBridge>().process.lock()
            && let Some(process) = guard.as_mut()
        {
            let pending = process.pending.lock().unwrap().remove(&self.id).is_some();
            if pending {
                let _ = process.send(&json!({"type":"cancel", "requestId":self.id}));
            }
        }
    }
}

fn catalog() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/features/antigravity/catalog.json")).expect("Antigravity catalog")
    })
}

pub(crate) fn gateway_id() -> &'static str {
    catalog()["id"].as_str().expect("Antigravity gateway id")
}

pub(crate) fn catalog_models() -> Vec<Value> {
    let catalog = catalog();
    let levels = catalog["efforts"]
        .as_array()
        .expect("Antigravity effort list")
        .iter()
        .map(|effort| json!({"effort":effort, "description":effort}))
        .collect::<Vec<_>>();
    catalog["models"].as_array().expect("Antigravity model list").iter().map(|model| {
        json!({
            "slug": format!("{}/{}", gateway_id(), model["id"].as_str().expect("Antigravity model id")),
            "display_name": model["label"], "description": "Gemini via Google Antigravity.",
            "visibility": "hide", "context_window": catalog["contextWindow"], "max_context_window": catalog["contextWindow"],
            "supported_reasoning_levels": levels, "default_reasoning_level": catalog["defaultEffort"]
        })
    }).collect()
}

fn dispatch_event(pending: &Pending, value: Value) {
    let Some(id) = value["requestId"].as_str().map(str::to_owned) else { return };
    let Ok(event) = serde_json::from_value::<TurnEvent>(value) else { return };
    let sender = {
        let mut pending = pending.lock().unwrap();
        match event {
            TurnEvent::Delta { .. } => pending.get(&id).cloned(),
            TurnEvent::Done { .. } | TurnEvent::Error { .. } => pending.remove(&id),
            // Tool events belong to native Agent turns; gateway turns are text-only.
            TurnEvent::ToolCall { .. } | TurnEvent::ToolCallUpdate { .. } => None,
        }
    };
    if let Some(sender) = sender {
        let _ = sender.send(event);
    }
}

fn send_turn(
    app: &AppHandle,
    request_id: Option<&str>,
    model: &str,
    effort: Option<&str>,
    prompt: Vec<Value>,
    cwd: Option<&str>,
    session_key: Option<&str>,
) -> Result<String, String> {
    let state = app.state::<AntigravityBridge>();
    let mut guard = state.process.lock().map_err(|error| error.to_string())?;
    start_bridge(app, &mut guard)?;
    let process = guard.as_mut().expect("Antigravity bridge started");
    let id = request_id.map(str::to_owned).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut message = json!({"type":"turn", "requestId":id, "model":model, "effort":effort, "prompt":prompt});
    if let Some(cwd) = cwd {
        message["cwd"] = Value::String(cwd.to_string());
    }
    if let Some(session_key) = session_key {
        message["sessionKey"] = Value::String(session_key.to_string());
    }
    process.send(&message).map_err(|error| error.to_string())?;
    Ok(id)
}

fn start_turn(app: &AppHandle, model: &str, effort: Option<&str>, prompt: Vec<Value>) -> Result<Turn, String> {
    let state = app.state::<AntigravityBridge>();
    let mut guard = state.process.lock().map_err(|error| error.to_string())?;
    start_bridge(app, &mut guard)?;
    let process = guard.as_mut().expect("Antigravity bridge started");
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, events) = mpsc::channel();
    process.pending.lock().unwrap().insert(id.clone(), sender);
    let result = process.send(&json!({"type":"turn", "requestId":id, "model":model, "effort":effort, "prompt":prompt}));
    if let Err(error) = result {
        process.pending.lock().unwrap().remove(&id);
        return Err(error);
    }
    Ok(Turn { id, app: app.clone(), events })
}

fn resource_root(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"))
    }
    #[cfg(not(debug_assertions))]
    {
        app.path().resource_dir().map_err(|error| error.to_string())
    }
}

fn copy_runtime_file(source: &PathBuf, target: &PathBuf) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("Cannot release {}: target has no parent directory", source.display()))?;
    // A previous release can leave the executable read-only (0555). Copying directly over it
    // fails with EACCES, which is exactly what the Antigravity screen showed as
    // "Cannot release ... localharness_external: Permission denied". Stage the new bytes beside
    // the target and rename them into place; directory replacement does not need the old inode to
    // be writable and never leaves a half-written executable if the app exits mid-copy.
    let staging = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Cannot prepare {}: {error}", target.display()))?;
    std::fs::copy(source, staging.path())
        .map_err(|error| format!("Cannot release {} to {}: {error}", source.display(), target.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(staging.path(), std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("Cannot mark {} executable: {error}", target.display()))?;
    }
    staging.persist(target).map_err(|error| format!("Cannot replace {}: {}", target.display(), error.error))?;
    Ok(())
}

/// Release the runtime carried by the bundle to the writable Application Support directory.
///
/// The official harness writes beside its process and cannot run from a read-only `.app`, so the
/// first Antigravity start copies both files out. A stamp makes an app update replace them once,
/// instead of copying ~300 MB on every launch or leaving an older runtime behind.
fn ensure_official_runtime(app: &AppHandle) -> Result<PathBuf, String> {
    let target_dir = app.path().app_data_dir().map_err(|error| error.to_string())?.join("antigravity");
    let source_dir = resource_root(app)?.join("antigravity");
    let target = target_dir.join(RUNTIME_FILES[0]);
    let source_stamp = std::fs::read_to_string(source_dir.join(RUNTIME_STAMP)).ok();
    let target_stamp = std::fs::read_to_string(target_dir.join(RUNTIME_STAMP)).ok();
    let needs_release = RUNTIME_FILES.iter().any(|name| !target_dir.join(name).is_file())
        || source_stamp.as_ref().is_some_and(|stamp| target_stamp.as_ref() != Some(stamp));
    if needs_release {
        let source = source_dir.join(RUNTIME_FILES[0]);
        if !source.is_file() {
            if target.is_file() {
                return Ok(target);
            }
            // No bundled runtime (e.g. an app installed without the large optional payload): fetch
            // the pinned official release from dl.google.com, verify its SHA-256 against the ACP
            // registry hash, and release it atomically. This is what makes a fresh machine work.
            log::info!("[antigravity] runtime not bundled or installed; downloading pinned release");
            return runtime::download_into(&target_dir, &RUNTIME_FILES, DOWNLOAD_STAMP, |source, target| {
                copy_runtime_file(&source.to_path_buf(), &target.to_path_buf())
            });
        }
        std::fs::create_dir_all(&target_dir).map_err(|error| error.to_string())?;
        for name in RUNTIME_FILES {
            let source = source_dir.join(name);
            if !source.is_file() {
                return Err(format!("Bundled Antigravity runtime is incomplete: {}", source.display()));
            }
            copy_runtime_file(&source, &target_dir.join(name))?;
        }
        if let Some(stamp) = source_stamp {
            std::fs::write(target_dir.join(RUNTIME_STAMP), stamp).map_err(|error| error.to_string())?;
        }
    }
    Ok(target)
}

/// Login state as the official ACP persisted it. This is deliberately a metadata check: the
/// refresh token never enters U⁺ and no Keychain prompt is shown.
#[tauri3_specta::command]
pub fn antigravity_status() -> AntigravityStatus {
    let keychain_signed_in = Command::new("security")
        .args(["find-generic-password", "-s", "gemini", "-a", "antigravity-acp"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let token_file = home
        .as_ref()
        .map(|home| home.join(".gemini/antigravity-acp/acp_token.json"))
        .is_some_and(|path| path.is_file());
    let auth_type = home
        .map(|home| home.join(".gemini/antigravity-acp/settings.json"))
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| {
            value.get("auth").and_then(|auth| auth.get("type")).and_then(|kind| kind.as_str()).map(str::to_owned)
        });
    AntigravityStatus { signed_in: keychain_signed_in || token_file, auth_type }
}

#[tauri3_specta::command]
pub fn antigravity_start(app: AppHandle, state: State<'_, AntigravityBridge>) -> Result<(), String> {
    let mut guard = state.process.lock().map_err(|error| error.to_string())?;
    start_bridge(&app, &mut guard)
}

fn start_bridge(app: &AppHandle, guard: &mut Option<BridgeProcess>) -> Result<(), String> {
    if let Some(process) = guard.as_mut() {
        match process.child.try_wait().map_err(|error| error.to_string())? {
            Some(_) => guard.take(),
            None => return Ok(()),
        };
    }

    let script = resource_root(app)?.join("antigravity/bridge.js");
    if !script.is_file() {
        return Err(format!("Antigravity bridge missing at {}", script.display()));
    }
    let binary = match std::env::var_os("ALWITH_U_ANTIGRAVITY_BINARY") {
        Some(path) => PathBuf::from(path),
        None => ensure_official_runtime(app)?,
    };
    if !binary.is_file() {
        return Err(format!(
            "Antigravity ACP binary missing at {}. Install the official ACP binary there first.",
            binary.display()
        ));
    }

    let mut command = Command::new(sidecar_path("bun")?);
    command
        .arg("--no-install")
        .arg(&script)
        .arg("--binary")
        .arg(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The app is launched by Finder, so it inherits no shell proxy variables. The official
    // Antigravity ACP refreshes its Google token from Python and otherwise attempts a direct
    // connection to Google, which hangs on networks where the system proxy is required. Pass the
    // same macOS proxy to bun and the ACP child; preserve an explicitly supplied environment.
    let has_proxy_env = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .any(|key| std::env::var_os(key).is_some());
    if !has_proxy_env {
        if let Some(proxy) = crate::providers::system_proxy() {
            command.env("HTTPS_PROXY", &proxy).env("HTTP_PROXY", &proxy).env("ALL_PROXY", &proxy);
            log::info!("[antigravity] routing ACP through the macOS system proxy");
        }
    }
    let mut child = command.spawn().map_err(|error| format!("Cannot start Antigravity bridge: {error}"))?;
    let stdin = child.stdin.take().ok_or("Antigravity bridge has no stdin")?;
    let stdout = child.stdout.take().ok_or("Antigravity bridge has no stdout")?;
    let stderr = child.stderr.take().ok_or("Antigravity bridge has no stderr")?;

    let event_app = app.clone();
    let pending = Pending::default();
    let event_pending = pending.clone();
    let event_agents = app.state::<AntigravityBridge>().agent_turns.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if let Ok(value) = serde_json::from_str::<Value>(&line) {
                        let request_id = value.get("requestId").and_then(Value::as_str).map(str::to_owned);
                        let turn_key = request_id
                            .as_deref()
                            .and_then(|id| event_agents.lock().unwrap().get(id).cloned());
                        if let Some(turn_key) = turn_key {
                            // Native Agent turn: stream every event to the frontend, tagged with
                            // the caller's key. Completion removes the registration.
                            let mut event = value.clone();
                            event["turnKey"] = Value::String(turn_key.clone());
                            if matches!(event["type"].as_str(), Some("done" | "error")) {
                                if let Some(id) = request_id.as_deref() {
                                    event_agents.lock().unwrap().remove(id);
                                }
                            }
                            let _ = event_app.emit(EVENT, event.to_string());
                        } else if request_id.is_some() {
                            dispatch_event(&event_pending, value);
                        } else {
                            let _ = event_app.emit(EVENT, line);
                        }
                    }
                }
                Err(error) => {
                    log::warn!("Antigravity bridge stdout ended: {error}");
                    break;
                }
            }
        }
        event_pending.lock().unwrap().clear();
        event_agents.lock().unwrap().clear();
        let _ = event_app.emit(EVENT, r#"{"type":"exit"}"#);
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            log::info!("[antigravity] {line}");
        }
    });

    *guard = Some(BridgeProcess { child, stdin, pending });
    Ok(())
}

#[tauri3_specta::command]
pub fn antigravity_send(message: String, state: State<'_, AntigravityBridge>) -> Result<(), String> {
    let message: Value = serde_json::from_str(&message).map_err(|error| error.to_string())?;
    if !matches!(message["type"].as_str(), Some("initialize" | "login" | "logout" | "usage"))
        || (message["type"] == "usage" && message["readId"].as_str().is_none())
    {
        return Err("Unsupported Antigravity account command".into());
    }
    let mut guard = state.process.lock().map_err(|error| error.to_string())?;
    let process = guard.as_mut().ok_or("Antigravity bridge is not running")?;
    process.send(&message)
}

/// Start a native Agent turn whose text, tool and permission events stream on `antigravity:event`
/// tagged with `turnKey`. Only Gemini sessions call this; the Responses gateway path is untouched.
#[tauri3_specta::command]
pub fn antigravity_agent_turn(
    app: AppHandle,
    state: State<'_, AntigravityBridge>,
    turn_key: String,
    model: String,
    effort: Option<String>,
    prompt: Vec<Value>,
    cwd: String,
    session_key: String,
) -> Result<String, String> {
    if cwd.trim().is_empty() {
        return Err("Agent turn requires a project directory".into());
    }
    // The turn must be registered BEFORE the bridge is told to start: the reader thread drops any
    // event whose requestId has no registered turn key, and a fast bridge could answer in between.
    let id = uuid::Uuid::new_v4().to_string();
    state.agent_turns.lock().unwrap().insert(id.clone(), turn_key);
    let sent = send_turn(
        &app,
        Some(&id),
        &model,
        effort.as_deref(),
        prompt,
        Some(&cwd),
        Some(&session_key),
    );
    if sent.is_err() {
        state.agent_turns.lock().unwrap().remove(&id);
    }
    sent?;
    Ok(id)
}

/// Answer one permission request raised by a running Agent turn.
///
/// `request_id` is the turn (used to prove the turn is still alive); `permission_id` identifies the
/// individual request, because a single turn asks once per tool call and answering one must not
/// resolve the others.
#[tauri3_specta::command]
pub fn antigravity_permission_answer(
    state: State<'_, AntigravityBridge>,
    request_id: String,
    permission_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let known = state.agent_turns.lock().unwrap().contains_key(&request_id);
    if !known {
        return Err("Unknown or finished Antigravity permission request".into());
    }
    let mut guard = state.process.lock().map_err(|error| error.to_string())?;
    let process = guard.as_mut().ok_or("Antigravity bridge is not running")?;
    process.send(&json!({
        "type": "permission_answer",
        "requestId": request_id,
        "permissionId": permission_id,
        "optionId": option_id
    }))
}

/// Cancel a native Agent turn.
#[tauri3_specta::command]
pub fn antigravity_agent_cancel(
    state: State<'_, AntigravityBridge>,
    request_id: String,
) -> Result<(), String> {
    let mut guard = state.process.lock().map_err(|error| error.to_string())?;
    let process = guard.as_mut().ok_or("Antigravity bridge is not running")?;
    process.send(&json!({"type": "cancel", "requestId": request_id}))
}

#[tauri3_specta::command]
pub fn antigravity_stop(state: State<'_, AntigravityBridge>) -> Result<(), String> {
    let mut guard = state.process.lock().map_err(|error| error.to_string())?;
    if let Some(process) = guard.take() {
        process.stop();
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    #[test]
    fn interleaved_turns_only_receive_events_for_their_request() {
        let pending = Pending::default();
        let (first, first_events) = mpsc::channel();
        let (second, second_events) = mpsc::channel();
        pending.lock().unwrap().extend([("first".into(), first), ("second".into(), second)]);
        dispatch_event(&pending, json!({"type":"delta", "requestId":"second", "text":"second reply"}));
        assert!(first_events.try_recv().is_err());
        assert!(matches!(second_events.try_recv().unwrap(), TurnEvent::Delta {text} if text == "second reply"));
        dispatch_event(&pending, json!({"type":"done", "requestId":"first", "stopReason":"end_turn"}));
        assert!(matches!(first_events.try_recv().unwrap(), TurnEvent::Done { .. }));
        assert!(!pending.lock().unwrap().contains_key("first"));
        assert!(pending.lock().unwrap().contains_key("second"));
    }

    #[test]
    fn releasing_replaces_a_read_only_runtime_and_makes_it_executable() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("localharness_external.new");
        let target = directory.path().join("localharness_external");
        std::fs::write(&source, b"new runtime").unwrap();
        std::fs::write(&target, b"old runtime").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o555)).unwrap();

        copy_runtime_file(&source, &target).unwrap();

        let mut released = String::new();
        std::fs::File::open(&target).unwrap().read_to_string(&mut released).unwrap();
        assert_eq!(released, "new runtime");
        assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o755);
    }

    #[test]
    fn a_failed_release_leaves_the_previous_runtime_untouched() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("missing");
        let target = directory.path().join("localharness_external");
        std::fs::write(&target, b"old runtime").unwrap();

        assert!(copy_runtime_file(&source, &target).is_err());

        let mut released = String::new();
        std::fs::File::open(&target).unwrap().read_to_string(&mut released).unwrap();
        assert_eq!(released, "old runtime");
    }
}
