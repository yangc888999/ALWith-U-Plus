//! Ships the local bridge (`~/.codex/bridge`) inside the app and keeps the installed copy current.
//!
//! The bridge is what lets outside software (WorkBuddy, any OpenAI-compatible client) call this
//! app's models: a small Python proxy on `127.0.0.1:18765` that translates Chat Completions into
//! the app's own Responses endpoint. It used to be a manual install — `install.sh` had to be run
//! once per machine and re-run after every rebuild. That is exactly the kind of step people skip,
//! and a missing bridge is invisible until an outside agent fails to connect.
//!
//! So the runtime files travel with the app bundle (`Resources/alwith-bridge/`) and are released on
//! launch, the same way `groups::release_rob_models` drops the operator personas into `rob_models`.
//!
//! Three rules this module follows, in order of importance:
//!
//! 1. **`bridge-config.json` is never written here.** It is the user's allow-list, editable from
//!    Settings → 外部调用. It is created from the bundled default template only when absent.
//! 2. **A bridge this app did not install is not overwritten.** Without `manifest.json` in the
//!    target directory there is no way to tell an old ALWith release from a hand-edited copy, and
//!    clobbering someone's edits is worse than shipping stale scripts. Missing files are still
//!    filled in, so a partial install heals.
//! 3. **The service is only nudged, never duplicated.** A launchd job that already owns the port is
//!    left alone; only when nothing answers is a process started, and that child dies with the app.
//!
//! `release.sh` inside the payload does the same job from a shell. Both exist on purpose: the shell
//! script is what a user runs by hand, this is what the app does on launch. Keep them in step.

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use serde_json::Value;

/// The proxy's listening port. The bridge discovers the app's own port dynamically; this one is
/// fixed because every outside client is configured with it. Mirrors `LISTEN_PORT` in the proxy.
pub const PORT: u16 = 18765;

/// Files released into the bridge directory. `bridge-config.json` is absent on purpose: it is user
/// state, not payload. `manifest.json` is written separately, after everything else landed.
const FILES: &[&str] =
    &["alwith-proxy.py", "alwith-model.py", "release.sh", "sync.sh", "embed.sh", "install.sh", "README.md"];

/// Template copied into place when the user has no `bridge-config.json` yet.
const DEFAULT_CONFIG: &str = "bridge-config.default.json";
const CONFIG: &str = "bridge-config.json";
const MANIFEST: &str = "manifest.json";

/// Old proxies kept before an overwrite (`release.sh` keeps the same number).
const BACKUPS: usize = 3;

/// `$ALWITH_BRIDGE_DIR`, else `~/.codex/bridge` — the same resolution `release.sh` performs.
pub fn bridge_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("ALWITH_BRIDGE_DIR")
        && !dir.is_empty()
    {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    match home {
        Some(home) => PathBuf::from(home).join(".codex").join("bridge"),
        // No home directory: keep the path relative rather than inventing an absolute one. Every
        // caller treats a missing directory as "nothing installed".
        None => PathBuf::from(".codex").join("bridge"),
    }
}

/// What a release pass did, for the log line and for the UI's "installed version" line.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Released {
    /// The payload version now on disk, when a payload was available at all.
    pub version: Option<String>,
    /// Files copied during this pass (0 means everything was already current).
    pub files: usize,
}

impl Released {
    pub fn updated(&self) -> bool {
        self.files > 0
    }
}

/// The outcome of making sure something is answering on [`PORT`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Service {
    /// A process was already listening; nothing was started.
    AlreadyRunning,
    /// A launchd job was kicked (either to start it or to pick up freshly released code).
    Launchd,
    /// No launchd job exists, so the app started the proxy itself.
    Spawned,
    /// No payload installed, no python, or the spawn failed. The UI says the bridge is down.
    Unavailable,
}

/// The bundled payload directory, or `None` when this build ships no bridge.
fn source_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let bundled = app.path().resource_dir().ok()?.join("alwith-bridge");
    if bundled.join("alwith-proxy.py").is_file() {
        return Some(bundled);
    }
    // `tauri dev` runs from `target/debug`, where bundled resources are not copied. Fall back to the
    // staged tree so the developer sees the same release behaviour as an installed build.
    if cfg!(debug_assertions) {
        let staged = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/alwith-bridge");
        if staged.join("alwith-proxy.py").is_file() {
            return Some(staged);
        }
    }
    None
}

fn manifest_version(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

/// Short digest of a file's contents — the same shape `stage`/`embed.sh` record under `files` in
/// the manifest (16 hex characters of the SHA-256).
fn digest(path: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let encoded = hex::encode(hasher.finalize());
    Some(encoded.get(..16).unwrap_or(&encoded).to_string())
}

/// `true` when the installed proxy no longer matches the hash the manifest recorded for it.
///
/// That is the one signal that distinguishes "an old release we should replace" from "a script the
/// user edited after installing it". Overwriting the second one would be silent data loss — the
/// same failure mode as a cloud client restoring an old copy over local changes — so the release
/// pass backs off and only fills in missing files.
fn proxy_edited(target: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(target.join(MANIFEST)) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    let Some(recorded) = value.get("files").and_then(|files| files.get("alwith-proxy.py")).and_then(Value::as_str)
    else {
        return false;
    };
    digest(&target.join("alwith-proxy.py")).is_some_and(|current| current != recorded)
}

/// Copies `name` from the payload, but never leaves a half-written script behind: write a sibling
/// temp file, then rename over the target, which is atomic within one directory.
fn copy_atomic(from: &Path, to: &Path) -> Result<(), String> {
    let bytes = std::fs::read(from).map_err(|error| format!("读取 {from:?} 失败：{error}"))?;
    let temporary = to.with_extension(format!("{}.tmp", to.extension().and_then(|value| value.to_str()).unwrap_or("")));
    std::fs::write(&temporary, &bytes).map_err(|error| format!("写入 {temporary:?} 失败：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Scripts must stay executable; data files keep the default mode.
        let mode = if to.extension().and_then(|value| value.to_str()) == Some("sh") { 0o755 } else { 0o644 };
        let _ = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(mode));
    }
    std::fs::rename(&temporary, to).map_err(|error| format!("替换 {to:?} 失败：{error}"))
}

/// Keeps the last [`BACKUPS`] proxies, newest first, and drops the rest.
fn backup_proxy(target: &Path) {
    let proxy = target.join("alwith-proxy.py");
    if !proxy.is_file() {
        return;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let backup = target.join(format!("alwith-proxy.py.bak-{stamp}"));
    let _ = std::fs::copy(&proxy, &backup);
    let mut backups: Vec<PathBuf> = std::fs::read_dir(target)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("alwith-proxy.py.bak-"))
        })
        .collect();
    backups.sort();
    while backups.len() > BACKUPS {
        let oldest = backups.remove(0);
        let _ = std::fs::remove_file(oldest);
    }
}

/// Releases the payload in `source` into `target`. Split from [`ensure`] so it can be tested without
/// a Tauri app handle.
pub fn release_from(source: &Path, target: &Path) -> Result<Released, String> {
    if !source.join("alwith-proxy.py").is_file() {
        return Ok(Released::default());
    }
    std::fs::create_dir_all(target).map_err(|error| format!("无法创建 {target:?}：{error}"))?;

    let bundled = manifest_version(&source.join(MANIFEST));
    let installed = manifest_version(&target.join(MANIFEST));
    let proxy_installed = target.join("alwith-proxy.py").is_file();
    let edited = proxy_installed && proxy_edited(target);
    if edited {
        log::warn!("bridge: {:?} 的脚本在安装后被改过，本次只补缺失文件，不覆盖", target.join("alwith-proxy.py"));
    }
    let update = !edited
        && match (&bundled, &installed) {
            // No manifest in the payload: nothing tells us what version this is, so only fill gaps.
            (None, _) => false,
            // Nothing of ours is installed (or nothing at all): release the whole payload.
            (Some(_), None) => !proxy_installed,
            // Both sides known: an identical version means the files are already the ones we ship.
            (Some(bundled), Some(installed)) => bundled != installed,
        };

    if update && proxy_installed {
        backup_proxy(target);
    }

    let mut files = 0usize;
    for name in FILES {
        let from = source.join(name);
        if !from.is_file() {
            continue;
        }
        let to = target.join(name);
        if to.exists() && !update {
            continue;
        }
        copy_atomic(&from, &to)?;
        files += 1;
    }

    // The template is payload, not state: keep it current so a future "restore defaults" has
    // something to restore from.
    let template = source.join(DEFAULT_CONFIG);
    if template.is_file() && (update || !target.join(DEFAULT_CONFIG).exists()) {
        copy_atomic(&template, &target.join(DEFAULT_CONFIG))?;
        files += 1;
    }
    // The user's allow-list is created once and never touched again.
    let config = target.join(CONFIG);
    if !config.exists() && target.join(DEFAULT_CONFIG).is_file() {
        std::fs::copy(target.join(DEFAULT_CONFIG), &config).map_err(|error| format!("无法生成 {config:?}：{error}"))?;
        log::info!("bridge: generated {CONFIG} from the bundled template");
    }

    // The marker goes last: while it is missing or old, the next launch simply releases again.
    // It is only written when this pass actually released the payload — claiming the new version
    // after backing off an edited proxy would make the app believe it is up to date forever.
    // `files` is recomputed from what is on disk rather than copied from the payload, because it is
    // what [`proxy_edited`] will compare against: it must describe the installed copy.
    if update
        && let Ok(text) = std::fs::read_to_string(source.join(MANIFEST))
        && let Ok(mut value) = serde_json::from_str::<Value>(&text)
    {
        if let Some(object) = value.as_object_mut() {
            object.insert("released_at".into(), Value::String(now_iso8601()));
            let mut hashes = serde_json::Map::new();
            for name in FILES.iter().copied().chain(std::iter::once(DEFAULT_CONFIG)) {
                if let Some(hash) = digest(&target.join(name)) {
                    hashes.insert(name.to_string(), Value::String(hash));
                }
            }
            object.insert("files".into(), Value::Object(hashes));
        }
        let _ = std::fs::write(target.join(MANIFEST), serde_json::to_vec_pretty(&value).unwrap_or_default());
    }

    Ok(Released { version: bundled, files })
}

/// A local ISO-8601 timestamp with the current offset. Only used in the manifest, which is read by
/// shell scripts and humans — never parsed back.
fn now_iso8601() -> String {
    // `date -Iseconds` is the shortest correct formatter available without a date crate.
    Command::new("/bin/date")
        .arg("+%Y-%m-%dT%H:%M:%S%z")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| String::from("1970-01-01T00:00:00+0000"))
}

/// `true` when something answers on [`PORT`]. Only the TCP handshake is checked: the proxy closes
/// connections it cannot route, but a refused connection is the one signal that nothing is there.
pub fn port_open() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], PORT));
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

fn launchd_label() -> &'static str {
    "ai.codex.alwith-bridge"
}

fn launchd_plist() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/LaunchAgents").join(format!("{}.plist", launchd_label())))
}

fn kickstart() -> bool {
    let Ok(uid) = Command::new("/usr/bin/id").arg("-u").output() else {
        return false;
    };
    let uid = String::from_utf8_lossy(&uid.stdout).trim().to_string();
    if uid.is_empty() {
        return false;
    }
    Command::new("/bin/launchctl")
        .args(["kickstart", "-k", &format!("gui/{uid}/{}", launchd_label())])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// The child this app started, if any. `None` after launchd took over or when the spawn failed.
fn child() -> &'static std::sync::Mutex<Option<Child>> {
    static CHILD: std::sync::OnceLock<std::sync::Mutex<Option<Child>>> = std::sync::OnceLock::new();
    CHILD.get_or_init(|| std::sync::Mutex::new(None))
}

fn spawn_proxy(directory: &Path) -> Option<Child> {
    let log_path = std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library/Logs/alwith-bridge.out.log"))
        .unwrap_or_else(|| PathBuf::from("/tmp/alwith-bridge.out.log"));
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).ok()?;
    let errors = log.try_clone().ok()?;
    let mut spawned = Command::new("/usr/bin/python3")
        .arg(directory.join("alwith-proxy.py"))
        .arg("--serve")
        .current_dir(directory)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(errors))
        .spawn()
        .ok()?;
    // Give the listen socket a moment: reporting "spawned" for a process that died on import is
    // the same lie as reporting success for a script that never ran.
    for _ in 0..20 {
        if port_open() {
            return Some(spawned);
        }
        if let Ok(Some(_)) = spawned.try_wait() {
            return None;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Some(spawned)
}

/// Makes sure the bridge answers on [`PORT`], starting it only when nothing else does.
///
/// `restart` is set when the payload was just replaced: a launchd job would otherwise keep serving
/// the previous script until the next reboot.
pub fn ensure_service(restart: bool) -> Service {
    let directory = bridge_dir();
    if !directory.join("alwith-proxy.py").is_file() {
        return Service::Unavailable;
    }
    if launchd_plist().is_some_and(|plist| plist.is_file()) {
        if !restart && port_open() {
            return Service::AlreadyRunning;
        }
        if kickstart() {
            // `kickstart -k` returns before the socket is listening; give it a moment so the log
            // line matches what a client would find. Still report Launchd when the socket has not
            // opened yet: the job is `KeepAlive`, and spawning a second proxy now would only race
            // it for the port.
            for _ in 0..40 {
                if port_open() {
                    return Service::Launchd;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            log::warn!("bridge: launchd accepted the kickstart but {PORT} is not answering yet");
            return Service::Launchd;
        }
    }
    if port_open() {
        return Service::AlreadyRunning;
    }
    match spawn_proxy(&directory) {
        Some(spawned) => {
            if let Ok(mut guard) = child().lock() {
                *guard = Some(spawned);
            }
            Service::Spawned
        }
        None => Service::Unavailable,
    }
}

/// Called from `RunEvent::Exit`: a proxy this app started must not outlive it.
pub fn kill_on_exit() {
    let Ok(mut guard) = child().lock() else { return };
    let Some(mut spawned) = guard.take() else { return };
    let _ = spawned.kill();
    let _ = spawned.wait();
    log::info!("bridge: stopped the proxy this app started");
}

/// Release the bundled payload (when it is new) and make sure the service is answering.
///
/// Runs on the setup path, before any window opens, so the bridge is reachable by the time a user
/// can copy the base URL out of Settings.
pub fn ensure(app: &tauri::AppHandle) {
    let Some(source) = source_dir(app) else {
        log::info!("bridge: this build ships no payload, leaving {CONFIG} alone");
        return;
    };
    let target = bridge_dir();
    let updated = match release_from(&source, &target) {
        Ok(released) => {
            if released.updated() {
                log::info!(
                    "bridge: released {} file(s) {} -> {:?}",
                    released.files,
                    released.version.as_deref().unwrap_or("?"),
                    target
                );
            }
            released.updated()
        }
        Err(error) => {
            log::warn!("bridge: could not release the payload: {error}");
            return;
        }
    };
    // The service step runs even when nothing was copied: an app update that changed nothing about
    // the bridge must still bring a stopped proxy back.
    match ensure_service(updated) {
        Service::AlreadyRunning => log::info!("bridge: proxy already answering on 127.0.0.1:{PORT}"),
        Service::Launchd => log::info!("bridge: launchd job restarted on 127.0.0.1:{PORT}"),
        Service::Spawned => log::info!("bridge: started the proxy on 127.0.0.1:{PORT}"),
        Service::Unavailable => log::warn!("bridge: not running and could not be started"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("alwith-{name}-{}-{unique}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    fn payload(directory: &Path, version: &str) {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(directory.join("alwith-proxy.py"), format!("# proxy {version}\n")).unwrap();
        std::fs::write(directory.join("alwith-model.py"), "# model\n").unwrap();
        std::fs::write(directory.join("install.sh"), "#!/bin/bash\n").unwrap();
        std::fs::write(directory.join(DEFAULT_CONFIG), "{\"models\":[]}\n").unwrap();
        std::fs::write(directory.join(MANIFEST), format!("{{\"version\":\"{version}\",\"app_version\":\"0.0.1\"}}"))
            .unwrap();
    }

    #[test]
    fn a_first_release_installs_every_file_and_never_touches_the_config_template() {
        let source = temp("payload-src");
        let target = temp("payload-dst");
        payload(&source, "1.0+abc");
        std::fs::write(source.join(CONFIG), "{\"models\":[{\"id\":\"x\"}]}\n").unwrap();

        let released = release_from(&source, &target).unwrap();
        assert_eq!(released.version.as_deref(), Some("1.0+abc"));
        assert!(released.files >= 3, "the payload files are copied: {released:?}");
        assert!(target.join("alwith-proxy.py").is_file());
        assert!(target.join("install.sh").is_file());
        // A config shipped in the payload is *not* what the user gets: the template is used instead.
        let config = std::fs::read_to_string(target.join(CONFIG)).unwrap();
        assert_eq!(config.trim(), "{\"models\":[]}");
        // The manifest marks the directory as ours, with a release timestamp.
        let manifest: Value = serde_json::from_str(&std::fs::read_to_string(target.join(MANIFEST)).unwrap()).unwrap();
        assert_eq!(manifest["version"], "1.0+abc");
        assert!(manifest["released_at"].is_string());
        let _ = std::fs::remove_dir_all(source);
        let _ = std::fs::remove_dir_all(target);
    }

    #[test]
    fn the_same_version_is_a_no_op_and_the_users_config_survives() {
        let source = temp("payload-same-src");
        let target = temp("payload-same-dst");
        payload(&source, "1.0+abc");
        release_from(&source, &target).unwrap();
        std::fs::write(target.join(CONFIG), "{\"models\":[{\"id\":\"mine\"}]}\n").unwrap();

        // A second pass with the same manifest must not copy a single file.
        let again = release_from(&source, &target).unwrap();
        assert!(!again.updated(), "nothing to do at the same version: {again:?}");
        assert_eq!(std::fs::read_to_string(target.join(CONFIG)).unwrap().trim(), "{\"models\":[{\"id\":\"mine\"}]}");
        let _ = std::fs::remove_dir_all(source);
        let _ = std::fs::remove_dir_all(target);
    }

    #[test]
    fn a_newer_payload_replaces_the_scripts_and_backs_the_old_proxy_up() {
        let source = temp("payload-new-src");
        let target = temp("payload-new-dst");
        payload(&source, "1.0+abc");
        release_from(&source, &target).unwrap();

        payload(&source, "1.1+def");
        let released = release_from(&source, &target).unwrap();
        assert!(released.updated());
        assert_eq!(std::fs::read_to_string(target.join("alwith-proxy.py")).unwrap().trim(), "# proxy 1.1+def");
        let backups: Vec<_> = std::fs::read_dir(&target)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("alwith-proxy.py.bak-"))
            .collect();
        assert_eq!(backups.len(), 1, "the previous proxy is kept once: {backups:?}");
        let _ = std::fs::remove_dir_all(source);
        let _ = std::fs::remove_dir_all(target);
    }

    #[test]
    fn a_directory_this_app_never_installed_is_not_overwritten() {
        let source = temp("payload-foreign-src");
        let target = temp("payload-foreign-dst");
        payload(&source, "1.0+abc");
        // Someone installed a bridge by hand: no manifest, and their own proxy content.
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("alwith-proxy.py"), "# hand edited\n").unwrap();

        let released = release_from(&source, &target).unwrap();
        assert!(released.updated(), "missing files are still filled in: {released:?}");
        assert_eq!(
            std::fs::read_to_string(target.join("alwith-proxy.py")).unwrap().trim(),
            "# hand edited",
            "an unmanaged proxy is left exactly as it was"
        );
        assert!(target.join("alwith-model.py").is_file(), "gaps are healed");
        let _ = std::fs::remove_dir_all(source);
        let _ = std::fs::remove_dir_all(target);
    }

    #[test]
    fn a_proxy_edited_after_installing_is_not_silently_reverted() {
        let source = temp("payload-edited-src");
        let target = temp("payload-edited-dst");
        payload(&source, "1.0+abc");
        release_from(&source, &target).unwrap();

        // The user edits the installed proxy, then an app update ships a new payload.
        std::fs::write(target.join("alwith-proxy.py"), "# my own fix\n").unwrap();
        payload(&source, "1.1+def");
        let released = release_from(&source, &target).unwrap();

        assert!(!released.updated(), "an edited script is not ours to overwrite: {released:?}");
        assert_eq!(std::fs::read_to_string(target.join("alwith-proxy.py")).unwrap().trim(), "# my own fix");
        // The version marker is left alone too, so the next launch still notices the difference —
        // and still backs off while the edit is there.
        let manifest = manifest_version(&target.join(MANIFEST));
        assert_eq!(manifest.as_deref(), Some("1.0+abc"));
        let _ = std::fs::remove_dir_all(source);
        let _ = std::fs::remove_dir_all(target);
    }

    #[test]
    fn no_payload_means_no_work() {
        let source = temp("payload-empty-src");
        let target = temp("payload-empty-dst");
        std::fs::create_dir_all(&source).unwrap();
        let released = release_from(&source, &target).unwrap();
        assert_eq!(released, Released::default());
        assert!(!target.exists(), "an empty payload must not create the directory");
        let _ = std::fs::remove_dir_all(source);
    }
}
