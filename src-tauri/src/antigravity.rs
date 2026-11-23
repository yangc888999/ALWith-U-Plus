//! Local launcher for the experimental Antigravity ACP bridge.
//!
//! The official Antigravity ACP runtime is carried inside the app bundle for this local build and
//! released to Application Support on first use. The Bun bridge owns the official binary's native
//! OAuth flow; events are forwarded as NDJSON strings on `antigravity:event`.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::runtime::sidecar_path;

const EVENT: &str = "antigravity:event";
const RUNTIME_FILES: [&str; 2] = ["agy_acp_server.par", "localharness_external"];
const RUNTIME_STAMP: &str = "runtime.stamp";

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
}

#[derive(Default)]
pub struct AntigravityBridge {
    process: Mutex<Option<BridgeProcess>>,
}

impl Drop for AntigravityBridge {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.process.lock() {
            if let Some(mut process) = guard.take() {
                let _ = process.child.kill();
            }
        }
    }
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
    staging
        .persist(target)
        .map_err(|error| format!("Cannot replace {}: {}", target.display(), error.error))?;
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
        || source_stamp
            .as_ref()
            .is_some_and(|stamp| target_stamp.as_ref() != Some(stamp));
    if needs_release {
        let source = source_dir.join(RUNTIME_FILES[0]);
        if !source.is_file() {
            if target.is_file() {
                return Ok(target);
            }
            return Err(format!(
                "Antigravity ACP runtime missing at {} and not bundled at {}",
                target.display(),
                source.display()
            ));
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
    if let Some(process) = guard.as_mut() {
        match process.child.try_wait().map_err(|error| error.to_string())? {
            Some(_) => guard.take(),
            None => return Ok(()),
        };
    }

    let script = resource_root(&app)?.join("antigravity/bridge.js");
    if !script.is_file() {
        return Err(format!("Antigravity bridge missing at {}", script.display()));
    }
    let binary = match std::env::var_os("ALWITH_U_ANTIGRAVITY_BINARY") {
        Some(path) => PathBuf::from(path),
        None => ensure_official_runtime(&app)?,
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
            command
                .env("HTTPS_PROXY", &proxy)
                .env("HTTP_PROXY", &proxy)
                .env("ALL_PROXY", &proxy);
            log::info!("[antigravity] routing ACP through the macOS system proxy");
        }
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Cannot start Antigravity bridge: {error}"))?;
    let stdin = child.stdin.take().ok_or("Antigravity bridge has no stdin")?;
    let stdout = child.stdout.take().ok_or("Antigravity bridge has no stdout")?;
    let stderr = child.stderr.take().ok_or("Antigravity bridge has no stderr")?;

    let event_app = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    if !line.trim().is_empty() {
                        let _ = event_app.emit(EVENT, line);
                    }
                }
                Err(error) => {
                    log::warn!("Antigravity bridge stdout ended: {error}");
                    break;
                }
            }
        }
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            log::info!("[antigravity] {line}");
        }
    });

    *guard = Some(BridgeProcess { child, stdin });
    Ok(())
}

#[tauri3_specta::command]
pub fn antigravity_send(message: String, state: State<'_, AntigravityBridge>) -> Result<(), String> {
    let mut guard = state.process.lock().map_err(|error| error.to_string())?;
    let process = guard.as_mut().ok_or("Antigravity bridge is not running")?;
    writeln!(process.stdin, "{message}").map_err(|error| error.to_string())?;
    process.stdin.flush().map_err(|error| error.to_string())
}

#[tauri3_specta::command]
pub fn antigravity_stop(state: State<'_, AntigravityBridge>) -> Result<(), String> {
    let mut guard = state.process.lock().map_err(|error| error.to_string())?;
    if let Some(mut process) = guard.take() {
        let _ = process.child.kill();
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;

    use super::*;

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
