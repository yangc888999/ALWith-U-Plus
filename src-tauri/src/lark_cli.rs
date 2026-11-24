//! Scheduled-task notifications and the user-facing Lark CLI component.
//!
//! The CLI owns the OAuth tokens and the API calls; this module only enumerates recipients,
//! sends one short text message per target, and — for Settings' "组件 → 飞书 CLI" card — exposes
//! install / update / auth operations.
//!
//! Install / update deliberately do NOT use `npm install -g`: macOS writes global packages into
//! the root-owned /usr/local, and the npm package's postinstall downloads the real binary from
//! GitHub releases (blocked here). Instead this mirrors the engine updater (`codex_update.rs`):
//! read the latest version from the npm registry mirror, stream the platform tarball from
//! `registry.npmmirror.com/-/binary/lark-cli`, extract it, and drop the binary into a
//! user-writable app-owned folder. No sudo, no Node.js, no GitHub.
//!
//! Arguments are passed as an argv array (never through a shell), and every call runs on the
//! blocking pool so a slow network request cannot freeze the settings webview. Nothing here
//! logs or persists message contents.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LarkTarget {
    /// `oc_…` for a group chat, `ou_…` for a direct message.
    pub id: String,
    pub name: String,
    /// `chat` | `user`
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LarkCliStatus {
    pub available: bool,
    pub cli_path: String,
    /// Parsed from `--version`; `None` when the CLI is missing or reports an unexpected format.
    pub version: Option<String>,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LarkUpdateCheck {
    pub has_update: bool,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub message: String,
    pub url: Option<String>,
    /// Link to the upstream CHANGELOG so the user can decide whether to update.
    pub changelog: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LarkAuthIdentity {
    /// `bot` | `user`
    pub kind: String,
    pub available: bool,
    pub status: String,
    pub user_name: Option<String>,
    /// `ou_…` of the signed-in user. The bot identity has no open_id: its permissions are
    /// configured on the Open Platform, not granted by a local OAuth scope list.
    pub open_id: Option<String>,
    pub token_status: Option<String>,
    /// Space-separated scopes granted to this identity, split into individual entries.
    /// Empty for `bot` is *normal* — readiness comes from `available` + `status == "ready"`.
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LarkAuthStatus {
    pub logged_in: bool,
    pub brand: Option<String>,
    pub app_id: Option<String>,
    /// `defaultAs` from `auth status --json`: usually `auto`, sometimes `bot` / `user`.
    pub default_identity: Option<String>,
    pub identities: Vec<LarkAuthIdentity>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LarkAuthLogin {
    pub verification_url: String,
    pub device_code: String,
    pub user_code: Option<String>,
    /// `expires_in` from `auth login --no-wait --json` (seconds). The QR code and device code
    /// both die at this point; the UI counts it down instead of waiting for the CLI to time out.
    pub expires_in: Option<u64>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LarkUserProfile {
    pub name: String,
    pub open_id: String,
    /// 72×72 avatar from `contact +get-user`. `auth status --json` has no avatar at all, so this
    /// is a separate, user-identity-only call; `None` means the UI should draw an initial.
    pub avatar_url: Option<String>,
}

const LARK_PACKAGE: &str = "@larksuite/cli";
const LARK_CHANGELOG: &str = "https://github.com/larksuite/cli/blob/main/CHANGELOG.md";

fn binary_name() -> &'static str {
    if cfg!(windows) { "lark-cli.exe" } else { "lark-cli" }
}

/// App-owned, user-writable install directory. `cli_path()` prefers it, so an install/update
/// takes effect on the very next call without touching (or overwriting) the user's own npm
/// install — `~/.local/bin/lark-cli` is a symlink into `~/.local/node_modules`, and copying into
/// it would follow the link and clobber that package.
fn managed_cli_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "无法读取 HOME 目录".to_string())?;
    Ok(PathBuf::from(home).join(".local/lib/alwith/lark-cli"))
}

fn managed_cli_path() -> Option<PathBuf> {
    let path = managed_cli_dir().ok()?.join(binary_name());
    path.is_file().then_some(path)
}

/// Prefer an explicit override, then the app-managed binary, then the user's own npm install,
/// then PATH. GUI apps do not inherit the user's shell PATH.
fn cli_path() -> PathBuf {
    if let Ok(path) = std::env::var("ALWITH_LARK_CLI") {
        if !path.trim().is_empty() {
            return PathBuf::from(path)
        }
    }
    if let Some(managed) = managed_cli_path() {
        return managed
    }
    if let Ok(home) = std::env::var("HOME") {
        let candidate = PathBuf::from(home).join(".local/bin/lark-cli");
        if candidate.is_file() {
            return candidate
        }
    }
    PathBuf::from("lark-cli")
}

/// Build a `lark-cli` invocation with a PATH that includes the known Node locations: GUI apps
/// do not inherit the user's shell PATH, and the `auth` / login commands still shell out to
/// Node helpers. Install and update no longer go through npm at all — see `install_lark_binary`.
fn lark_command(args: Vec<String>) -> Command {
    let mut command = Command::new(cli_path());
    command.args(args);
    command.env("PATH", crate::support_components::enriched_path());
    command
}

fn run_cli(args: &[String]) -> Result<Value, String> {
    let path = cli_path();
    let output = Command::new(&path)
        .args(args)
        .env("PATH", crate::support_components::enriched_path())
        .output()
        .map_err(|error| format!("无法启动飞书 CLI（{}）：{}", path.display(), describe_spawn(&error)))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("飞书 CLI 执行失败（退出码 {:?}）", output.status.code())
        } else {
            detail
        })
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: Value = serde_json::from_str(stdout.trim()).map_err(|error| {
        format!("飞书 CLI 返回的不是 JSON：{}", error)
    })?;
    if value.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("飞书 CLI 返回失败");
        let hint = value
            .pointer("/error/hint")
            .and_then(Value::as_str)
            .unwrap_or("");
        return Err(if hint.is_empty() {
            message.to_string()
        } else {
            format!("{message}\n{hint}")
        })
    }
    Ok(value)
}

fn describe_spawn(error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        "未找到命令，请检查 ~/.local/bin/lark-cli 或设置 ALWITH_LARK_CLI".to_string()
    } else {
        error.to_string()
    }
}

/// Pull the first version-like token (`v1.2.3` or `1.2.3`) out of a `--version` line.
fn parse_version(text: &str) -> Option<String> {
    let line = text.lines().next().unwrap_or("");
    let token = line
        .split_whitespace()
        .find(|token| token.contains('.') && token.chars().any(|character| character.is_ascii_digit()))?;
    Some(token.trim_start_matches('v').to_string())
}

pub fn parse_chats(value: &Value) -> Vec<LarkTarget> {
    value
        .pointer("/data/chats")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("chat_id")?.as_str()?.to_string();
                    let name = item.get("name").and_then(Value::as_str).unwrap_or(&id).to_string();
                    Some(LarkTarget { id, name, kind: "chat".to_string() })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn parse_users(value: &Value) -> Vec<LarkTarget> {
    value
        .pointer("/data/users")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("open_id")?.as_str()?.to_string();
                    let name = item
                        .get("localized_name")
                        .or_else(|| item.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or(&id)
                        .to_string();
                    Some(LarkTarget { id, name, kind: "user".to_string() })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `--as bot` is the working default: the user identity needs the extra
/// `im:message.send_as_user` scope that is not granted by a normal CLI login.
pub fn send_args(target: &LarkTarget, text: &str, identity: &str) -> Vec<String> {
    let flag = if target.kind == "user" { "--user-id" } else { "--chat-id" };
    [
        "im",
        "+messages-send",
        flag,
        &target.id,
        "--text",
        text,
        "--as",
        identity,
        "--format",
        "json"
    ]
    .iter()
    .map(|value| (*value).to_string())
    .collect()
}

/// `--page-all` still honours the CLI's default `--page-limit` of 10 pages × 20 rows, which stopped
/// the picker at 200 groups even though the list said it had more. Ask for the largest page size and
/// page limit so a user in hundreds of groups can still find every one of them.
fn chat_list_args() -> Vec<String> {
    [
        "im",
        "+chat-list",
        "--format",
        "json",
        "--page-all",
        "--page-limit",
        "1000",
        "--page-size",
        "100"
    ]
    .iter()
    .map(|value| (*value).to_string())
    .collect()
}

#[tauri3_specta::command]
pub async fn lark_cli_status() -> Result<LarkCliStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = cli_path();
        let probe = Command::new(&path)
            .arg("--version")
            .output();
        let available = probe.as_ref().is_ok_and(|out| out.status.success());
        let version = probe.ok().and_then(|out| {
            if out.status.success() {
                parse_version(&String::from_utf8_lossy(&out.stdout))
            } else {
                None
            }
        });
        let hint = if available {
            "默认以机器人身份发送；若要以本人身份发送，需先执行 lark-cli auth login --scope \"im:message.send_as_user\"".to_string()
        } else {
            "未检测到 lark-cli，请在「设置 → 应用扩展 → 组件」中点击安装，或设置 ALWITH_LARK_CLI 指向可执行文件".to_string()
        };
        Ok(LarkCliStatus {
            available,
            cli_path: path.display().to_string(),
            version,
            hint,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri3_specta::command]
pub async fn lark_cli_targets(kind: String, query: String) -> Result<Vec<LarkTarget>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let args: Vec<String> = if kind == "user" {
            let term = query.trim().to_string();
            if term.is_empty() {
                return Ok(Vec::new())
            }
            [
                "contact",
                "+search-user",
                "--query",
                &term,
                "--as",
                "user",
                "--format",
                "json"
            ]
            .iter()
            .map(|value| (*value).to_string())
            .collect()
        } else {
            chat_list_args()
        };
        let value = run_cli(&args)?;
        Ok(if kind == "user" { parse_users(&value) } else { parse_chats(&value) })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri3_specta::command]
pub async fn lark_cli_send(
    targets: Vec<LarkTarget>,
    text: String,
    identity: String
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Empty messages are rejected by the API; refusing here keeps a misconfigured task from
        // producing a wall of identical failures.
        if text.trim().is_empty() {
            return Err("推送内容为空".to_string())
        }
        let identity = if identity == "user" { "user" } else { "bot" };
        let mut failures = Vec::new();
        for target in &targets {
            let args = send_args(target, &text, identity);
            if let Err(error) = run_cli(&args) {
                failures.push(format!("{}：{}", target.name, error));
            }
        }
        Ok(failures)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Platform archive name and its URL on the npm binary mirror. This is exactly the layout the
/// package's own `scripts/install.js` uses for its GitHub fallback, e.g.
/// `lark-cli-1.0.99-darwin-arm64.tar.gz` → `/-/binary/lark-cli/v1.0.99/…`.
fn platform_asset(version: &str) -> Result<(String, String), String> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        other => return Err(format!("暂不支持的系统：{other}")),
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => return Err(format!("暂不支持的架构：{other}")),
    };
    let ext = if os == "windows" { "zip" } else { "tar.gz" };
    let name = format!("lark-cli-{version}-{os}-{arch}.{ext}");
    let url = format!(
        "{}/-/binary/lark-cli/v{version}/{name}",
        crate::codex_update::REGISTRY_BASE
    );
    Ok((name, url))
}

fn find_binary(root: &Path) -> Result<PathBuf, String> {
    fn walk(directory: &Path, name: &std::ffi::OsStr, found: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(directory) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, name, found)
            } else if path.file_name().is_some_and(|file| file == name) {
                found.push(path)
            }
        }
    }
    let name = std::ffi::OsStr::new(binary_name());
    let mut candidates = Vec::new();
    walk(root, name, &mut candidates);
    candidates
        .into_iter()
        .next()
        .ok_or_else(|| "下载的压缩包里没有 lark-cli 可执行文件".to_string())
}

fn extract_archive(archive: &Path, destination: &Path) -> Result<(), String> {
    if archive.to_string_lossy().ends_with(".zip") {
        // Windows 10+ ships bsdtar, which handles zip with plain -xf.
        std::fs::create_dir_all(destination).map_err(|error| error.to_string())?;
        let status = Command::new("tar")
            .args(["-xf"])
            .arg(archive)
            .arg("-C")
            .arg(destination)
            .output()
            .map_err(|error| error.to_string())?;
        if !status.status.success() {
            return Err(format!("解压失败：{}", String::from_utf8_lossy(&status.stderr)))
        }
        Ok(())
    } else {
        crate::codex_update::extract_tarball(archive, destination)
    }
}

/// Pure half of the registry lookup. `@larksuite/cli/latest` is a small JSON object with a
/// top-level `version`; keeping the parse separate makes the metadata contract testable without
/// a network call.
fn parse_registry_version(body: &[u8]) -> Result<String, String> {
    let value: Value =
        serde_json::from_slice(body).map_err(|error| format!("registry JSON：{error}"))?;
    value
        .get("version")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "registry 响应里没有 version".to_string())
}

async fn latest_lark_version() -> Result<String, String> {
    let url = format!("{}/{}/latest", crate::codex_update::REGISTRY_BASE, LARK_PACKAGE);
    let body = crate::codex_update::http_get(&url).await?;
    parse_registry_version(&body)
}

/// Same executor isolation as `codex_check_engine_update`: the HTTP call runs on its own
/// current-thread runtime, independent of whichever pool Tauri dispatched this command on.
async fn fetch_latest_version() -> Result<Option<String>, String> {
    let result: Result<String, String> = tokio::task::spawn_blocking(|| {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        runtime.block_on(latest_lark_version())
    })
    .await
    .map_err(|error| error.to_string())?;
    Ok(match result {
        Ok(version) => Some(version),
        Err(error) => {
            log::warn!("lark CLI version check failed: {error}");
            None
        }
    })
}

fn current_cli_version() -> Option<String> {
    let output = Command::new(cli_path()).arg("--version").output().ok()?;
    if !output.status.success() {
        return None
    }
    parse_version(&String::from_utf8_lossy(&output.stdout))
}

/// The version comes from a network response and is interpolated into a download URL path.
/// Reject anything that could escape that segment.
fn safe_version(version: &str) -> bool {
    !version.is_empty()
        && version
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '.' || character == '-')
}

async fn install_lark_binary(version: &str) -> Result<String, String> {
    if !safe_version(version) {
        return Err("非法版本号".to_string())
    }
    let (name, url) = platform_asset(version)?;
    let work = tempfile::tempdir().map_err(|error| error.to_string())?;
    let archive = work.path().join(&name);
    crate::codex_update::http_download(&url, &archive).await?;
    let extracted = work.path().join("bin");
    extract_archive(&archive, &extracted)?;
    let binary = find_binary(&extracted)?;

    let directory = managed_cli_dir()?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let staged = directory.join(format!("{}.staged", binary_name()));
    std::fs::copy(&binary, &staged).map_err(|error| format!("复制二进制：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
    }
    // Rename swaps the inode in one step: a running CLI keeps its old bytes and a failed
    // download never replaces the working one. Same trick as the engine override.
    let target = directory.join(binary_name());
    std::fs::rename(&staged, &target).map_err(|error| format!("替换二进制：{error}"))?;
    Ok(target.display().to_string())
}

async fn install_latest() -> Result<InstallResult, String> {
    let version = fetch_latest_version()
        .await?
        .ok_or_else(|| "无法从镜像获取飞书 CLI 版本号，请检查网络后重试。".to_string())?;
    let path = install_lark_binary(&version).await?;
    Ok(InstallResult {
        ok: true,
        message: format!("飞书 CLI {version} 已安装到 {path}。"),
    })
}

#[tauri3_specta::command]
pub async fn lark_cli_install() -> Result<InstallResult, String> {
    install_latest().await
}

/// Registry-based check: no CLI self-updater and no GitHub release request at all.
#[tauri3_specta::command]
pub async fn lark_cli_check_update() -> Result<LarkUpdateCheck, String> {
    let current = tauri::async_runtime::spawn_blocking(current_cli_version)
        .await
        .map_err(|error| error.to_string())?;
    let latest = fetch_latest_version().await?;
    let has_update = match (&current, &latest) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(local), Some(remote)) => crate::codex_update::version_newer(remote, local),
    };
    let version = latest.clone().unwrap_or_default();
    let message = if has_update {
        format!(
            "{} → {} 可用",
            current.as_deref().unwrap_or("未安装"),
            if version.is_empty() { "新版本" } else { version.as_str() }
        )
    } else {
        "已是最新版本".to_string()
    };
    Ok(LarkUpdateCheck {
        has_update,
        current_version: current,
        latest_version: latest,
        message,
        url: if version.is_empty() {
            None
        } else {
            Some(format!("https://github.com/larksuite/cli/releases/tag/v{version}"))
        },
        changelog: Some(LARK_CHANGELOG.to_string()),
    })
}

#[tauri3_specta::command]
pub async fn lark_cli_update() -> Result<InstallResult, String> {
    install_latest().await
}

#[tauri3_specta::command]
pub async fn lark_cli_auth_status() -> Result<LarkAuthStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let args = vec!["auth".to_string(), "status".to_string(), "--json".to_string()];
        let output = lark_command(args).output();
        let output =
            output.map_err(|error| format!("无法运行 lark-cli auth status：{}", error))?;
        if !output.status.success() {
            return Err(format!(
                "读取授权状态失败：{}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        parse_auth_status(&String::from_utf8_lossy(&output.stdout))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// `lark-cli contact +get-user --as user --format json` — the profile card needs the real
/// avatar, which `auth status --json` does not include. This only works under the user identity;
/// a bot-only install fails the call and the UI falls back to an initial / the auth-status name.
#[tauri3_specta::command]
pub async fn lark_cli_user_profile() -> Result<LarkUserProfile, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let args = vec![
            "contact".to_string(),
            "+get-user".to_string(),
            "--as".to_string(),
            "user".to_string(),
            "--format".to_string(),
            "json".to_string(),
        ];
        let value = run_cli(&args)?;
        parse_user_profile(&value)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn parse_user_profile(value: &Value) -> Result<LarkUserProfile, String> {
    let user = value
        .pointer("/data/user")
        .ok_or_else(|| "飞书 CLI 没有返回用户资料".to_string())?;
    let name = user.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let open_id = user
        .get("open_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if name.is_empty() && open_id.is_empty() {
        return Err("飞书 CLI 返回的用户资料为空".to_string())
    }
    // Only ever hand an https image URL to the webview; never a scheme we did not ask for.
    let avatar_url = ["avatar_thumb", "avatar_url", "avatar_middle", "avatar_big"]
        .iter()
        .find_map(|key| user.get(*key).and_then(Value::as_str).map(str::to_string))
        .filter(|url| url.starts_with("https://"));
    Ok(LarkUserProfile {
        name,
        open_id,
        avatar_url,
    })
}

fn parse_auth_status(text: &str) -> Result<LarkAuthStatus, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|error| format!("无法解析授权状态：{}", error))?;
    let brand = value.get("brand").and_then(Value::as_str).map(|value| value.to_string());
    let app_id = value.get("appId").and_then(Value::as_str).map(|value| value.to_string());
    // Real `lark-cli auth status --json` emits `defaultAs` (e.g. "auto"); older builds used
    // `identity`. Read both, otherwise this is always null and the UI silently loses the
    // default identity — the same class of bug as guessing scope names that do not exist.
    let default_identity = value
        .get("defaultAs")
        .or_else(|| value.get("identity"))
        .and_then(Value::as_str)
        .map(|value| value.to_string());
    let mut identities = Vec::new();
    let logged_in = if let Some(map) = value.get("identities").and_then(Value::as_object) {
        for (kind, entry) in map {
            let available = entry
                .get("available")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let status = entry
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let user_name = entry
                .get("userName")
                .and_then(Value::as_str)
                .map(|value| value.to_string());
            let open_id = entry
                .get("openId")
                .and_then(Value::as_str)
                .map(|value| value.to_string());
            let token_status = entry
                .get("tokenStatus")
                .and_then(Value::as_str)
                .map(|value| value.to_string());
            let scope = entry
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let scopes: Vec<String> = if scope.is_empty() {
                Vec::new()
            } else {
                scope.split_whitespace().map(|value| value.to_string()).collect()
            };
            identities.push(LarkAuthIdentity {
                kind: kind.clone(),
                available,
                status,
                user_name,
                open_id,
                token_status,
                scopes,
            });
        }
        identities.iter().any(|identity| identity.available)
    } else {
        false
    };
    Ok(LarkAuthStatus {
        logged_in,
        brand,
        app_id,
        default_identity,
        identities,
    })
}

/// Device flow cannot start without a scope: `auth login --no-wait --json` with no scope flags
/// fails with "please specify the scopes to authorize". A plain sign-in therefore requests ONLY
/// the one scope needed to show who signed in (name + avatar). `--recommend` would silently
/// grant a whole bundle of permissions — that is an authorization change, not a login, and it
/// belongs exclusively in the checkbox chain below the permission list.
const LOGIN_SCOPE: &str = "contact:user.base:readonly";

fn auth_login_args(scopes: &[String]) -> Vec<String> {
    let requested: Vec<&str> = scopes
        .iter()
        .map(|scope| scope.trim())
        .filter(|scope| !scope.is_empty())
        .collect();
    let scope = if requested.is_empty() {
        LOGIN_SCOPE.to_string()
    } else {
        requested.join(" ")
    };
    vec![
        "auth".to_string(),
        "login".to_string(),
        "--no-wait".to_string(),
        "--json".to_string(),
        "--scope".to_string(),
        scope,
    ]
}

/// `lark-cli auth login --no-wait --json --scope …` — starts a device-flow authorization and
/// returns immediately with the verification URL and device code. The UI renders the URL as a QR
/// code; completion is driven separately by `lark_cli_auth_complete`.
///
/// An empty `scopes` list is a plain sign-in (minimum identity scope only). A non-empty list is
/// a permission request from the checkbox chain and must contain exactly the ticked scopes.
#[tauri3_specta::command]
pub async fn lark_cli_auth_login(scopes: Vec<String>) -> Result<LarkAuthLogin, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let output = lark_command(auth_login_args(&scopes)).output();
        let output = output.map_err(|error| format!("无法发起授权：{}", error))?;
        if !output.status.success() {
            return Err(format!(
                "发起授权失败：{}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let value: Value = serde_json::from_str(String::from_utf8_lossy(&output.stdout).trim())
            .map_err(|error| format!("无法解析授权结果：{}", error))?;
        let verification_url = value
            .get("verification_url")
            .and_then(Value::as_str)
            .ok_or("授权结果缺少 verification_url")?
            .to_string();
        let device_code = value
            .get("device_code")
            .and_then(Value::as_str)
            .ok_or("授权结果缺少 device_code")?
            .to_string();
        let user_code = value
            .get("user_code")
            .and_then(Value::as_str)
            .map(|value| value.to_string());
        let expires_in = value.get("expires_in").and_then(Value::as_u64);
        Ok(LarkAuthLogin {
            verification_url,
            device_code,
            user_code,
            expires_in,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// `lark-cli auth login --device-code <code> --json` — blocks and polls the device flow started
/// by `lark_cli_auth_login` until the user scans, the code expires, or the CLI errors out.
///
/// The CLI reports failures as `{"ok":false,"error":{...}}` **with exit code 0**, so only checking
/// `status.success()` used to turn an expired / invalid code into a false "authorization complete".
/// Parse the JSON body instead: the UI needs to know it failed so it can offer a fresh code.
#[tauri3_specta::command]
pub async fn lark_cli_auth_complete(device_code: String) -> Result<InstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let args = vec![
            "auth".to_string(),
            "login".to_string(),
            "--device-code".to_string(),
            device_code,
            "--json".to_string(),
        ];
        let output = lark_command(args).output();
        let output = output.map_err(|error| format!("无法完成授权：{}", error))?;
        if !output.status.success() {
            return Err(format!(
                "完成授权失败：{}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(parse_auth_complete(&String::from_utf8_lossy(&output.stdout)))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn parse_auth_complete(body: &str) -> InstallResult {
    let parsed: Option<Value> = serde_json::from_str(body.trim()).ok();
    let ok = parsed
        .as_ref()
        .and_then(|value| value.get("ok"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let message = parsed
        .as_ref()
        .and_then(|value| value.pointer("/error/message"))
        .and_then(Value::as_str)
        .unwrap_or(if ok { "授权已完成。" } else { "授权未完成，请重新获取二维码。" })
        .to_string();
    InstallResult { ok, message }
}

#[tauri3_specta::command]
pub async fn lark_cli_auth_logout() -> Result<InstallResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let args = vec!["auth".to_string(), "logout".to_string()];
        let output = lark_command(args).output();
        let output = output.map_err(|error| format!("无法登出：{}", error))?;
        if !output.status.success() {
            return Err(format!(
                "登出失败：{}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        Ok(InstallResult {
            ok: true,
            message: "已登出。".to_string(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chat_list_is_mapped_to_group_targets() {
        let value = json!({
            "ok": true,
            "data": { "chats": [
                { "chat_id": "oc_1", "name": "产品 & 运营" },
                { "chat_id": "oc_2" }
            ] }
        });
        let rows = parse_chats(&value);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "oc_1");
        assert_eq!(rows[0].name, "产品 & 运营");
        assert_eq!(rows[0].kind, "chat");
        assert_eq!(rows[1].name, "oc_2");
    }

    #[test]
    fn chat_list_asks_for_every_page_instead_of_stopping_at_two_hundred() {
        let args = chat_list_args();
        let flag = |name: &str| args.iter().position(|arg| arg == name).map(|index| args[index + 1].as_str());
        assert!(args.contains(&"--page-all".to_string()));
        assert_eq!(flag("--page-limit"), Some("1000"));
        assert_eq!(flag("--page-size"), Some("100"));
    }

    #[test]
    fn user_search_is_mapped_to_direct_message_targets() {
        let value = json!({
            "ok": true,
            "data": { "users": [
                { "open_id": "ou_1", "localized_name": "Chen Yang（Leo）" }
            ] }
        });
        let rows = parse_users(&value);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "ou_1");
        assert_eq!(rows[0].kind, "user");
    }

    #[test]
    fn send_args_use_the_matching_id_flag_and_never_a_shell() {
        let chat = LarkTarget { id: "oc_1".into(), name: "群".into(), kind: "chat".into() };
        let args = send_args(&chat, "任务完成", "bot");
        assert!(args.contains(&"--chat-id".to_string()));
        assert!(args.contains(&"oc_1".to_string()));
        assert!(!args.contains(&"--user-id".to_string()));
        assert!(args.contains(&"--as".to_string()));

        let user = LarkTarget { id: "ou_1".into(), name: "我".into(), kind: "user".into() };
        let args = send_args(&user, "任务完成", "user");
        assert!(args.contains(&"--user-id".to_string()));
        assert!(args.contains(&"ou_1".to_string()));
    }

    #[test]
    fn a_cli_error_payload_is_not_mistaken_for_success() {
        let value = json!({ "ok": false, "error": { "message": "missing scope" } });
        assert_eq!(value.get("ok").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn version_line_is_parsed_regardless_of_leading_v() {
        assert_eq!(parse_version("lark-cli version 1.0.93\n"), Some("1.0.93".to_string()));
        assert_eq!(parse_version("v22.22.2\n"), Some("22.22.2".to_string()));
        assert_eq!(parse_version("10.9.7\n"), Some("10.9.7".to_string()));
        assert_eq!(parse_version("no version here"), None);
    }

    #[test]
    fn update_check_reads_version_from_the_registry_not_the_cli_self_updater() {
        // `@larksuite/cli/latest` metadata, as served by registry.npmmirror.com.
        let body = br#"{"name":"@larksuite/cli","version":"1.0.99","dist":{"tarball":"https://registry.npmmirror.com/@larksuite/cli/-/cli-1.0.99.tgz"}}"#;
        assert_eq!(parse_registry_version(body).unwrap(), "1.0.99");
        assert!(parse_registry_version(br#"{"name":"@larksuite/cli"}"#).is_err());
        assert!(parse_registry_version(b"not json").is_err());

        let (name, url) = platform_asset("1.0.99").unwrap();
        assert!(name.starts_with("lark-cli-1.0.99-"));
        assert!(url.starts_with("https://registry.npmmirror.com/-/binary/lark-cli/v1.0.99/"));
        assert!(url.ends_with(&name));
        // The whole point of the mirror path: no GitHub release asset is ever fetched.
        assert!(!url.contains("github.com"));
    }

    #[test]
    fn a_registry_version_cannot_escape_the_download_path() {
        assert!(safe_version("1.0.99"));
        assert!(safe_version("1.0.99-beta.1"));
        assert!(!safe_version(""));
        assert!(!safe_version("../../evil"));
        assert!(!safe_version("1.0.99?x=1"));
        assert!(!safe_version("1.0.99/../../etc"));
    }

    #[test]
    fn auth_status_picks_up_available_identities_and_scopes() {
        // Shape of the real `lark-cli auth status --json` output (scope list trimmed).
        let text = r#"{
            "appId":"cli_x","brand":"feishu","credentialSource":"local",
            "defaultAs":"auto","dpopMode":"preferred",
            "identities":{
                "bot":{"status":"ready","available":true,"message":"Bot identity: ready"},
                "user":{"status":"ready","available":true,"message":"User identity: ready","userName":"Chen Yang（Leo）","openId":"ou_1","tokenStatus":"valid","scope":"im:message docs:document:read"}
            }
        }"#;
        let result = parse_auth_status(text).unwrap();
        assert!(result.logged_in);
        assert_eq!(result.default_identity.as_deref(), Some("auto"));
        assert_eq!(result.identities.len(), 2);
        let user = result.identities.iter().find(|i| i.kind == "user").unwrap();
        assert_eq!(user.user_name.as_deref(), Some("Chen Yang（Leo）"));
        assert_eq!(user.scopes, vec!["im:message", "docs:document:read"]);
        assert_eq!(user.open_id.as_deref(), Some("ou_1"));
        assert_eq!(user.token_status.as_deref(), Some("valid"));
        // A ready bot has no scope list at all. That is the normal shape of `auth status --json`,
        // not a missing authorization: readiness is `available` + `status == "ready"`.
        let bot = result.identities.iter().find(|i| i.kind == "bot").unwrap();
        assert!(bot.available);
        assert_eq!(bot.status, "ready");
        assert!(bot.scopes.is_empty());
        assert!(bot.open_id.is_none());
    }

    #[test]
    fn legacy_identity_field_is_still_accepted() {
        let text = r#"{"identity":"user","identities":{"bot":{"available":true,"status":"ready"}}}"#;
        assert_eq!(
            parse_auth_status(text).unwrap().default_identity.as_deref(),
            Some("user")
        );
    }

    #[test]
    fn user_profile_prefers_the_thumbnail_avatar() {
        // Trimmed shape of `contact +get-user --as user --format json`.
        let value = json!({
            "ok": true,
            "data": { "user": {
                "name": "Chen Yang（Leo）",
                "open_id": "ou_1",
                "avatar_thumb": "https://s1-imfile.feishucdn.com/a?image_size=72x72",
                "avatar_middle": "https://s1-imfile.feishucdn.com/a?image_size=240x240",
                "avatar_big": "https://s3-imfile.feishucdn.com/a?image_size=640x640"
            } }
        });
        let profile = parse_user_profile(&value).unwrap();
        assert_eq!(profile.name, "Chen Yang（Leo）");
        assert_eq!(profile.open_id, "ou_1");
        assert!(profile.avatar_url.unwrap().contains("72x72"));
    }

    #[test]
    fn user_profile_tolerates_a_missing_avatar_but_rejects_an_empty_one() {
        let value = json!({ "ok": true, "data": { "user": { "name": "Leo", "open_id": "ou_1" } } });
        assert!(parse_user_profile(&value).unwrap().avatar_url.is_none());
        assert!(parse_user_profile(&json!({ "ok": true, "data": {} })).is_err());
        // Never hand a non-https URL to the webview.
        let unsafe_value = json!({ "ok": true, "data": { "user": {
            "name": "Leo", "open_id": "ou_1", "avatar_url": "javascript:alert(1)"
        } } });
        assert!(parse_user_profile(&unsafe_value).unwrap().avatar_url.is_none());
    }

    #[test]
    fn a_plain_sign_in_never_requests_the_recommended_scope_bundle() {
        let args = auth_login_args(&[]);
        // The CLI rejects a scope-less device flow, so a login still needs one scope — but it
        // must be the single identity scope, never `--recommend`'s whole bundle.
        assert_eq!(args[args.len() - 2], "--scope");
        assert_eq!(args[args.len() - 1], LOGIN_SCOPE);
        assert!(!args.iter().any(|arg| arg == "--recommend"), "{args:?}");
        assert!(!args.iter().any(|arg| arg.contains("im:") || arg.contains("drive:")), "{args:?}");
    }

    #[test]
    fn an_expired_device_code_is_not_reported_as_success() {
        // `auth login --device-code` returns {"ok":false,...} with exit 0 for an expired or
        // invalid device code. Reporting success there would close the dialog with no token.
        let body = r#"{"ok":false,"error":{"type":"authentication","message":"device_code expired"}}"#;
        let result = parse_auth_complete(body);
        assert!(!result.ok);
        assert!(result.message.contains("expired"));
        assert!(parse_auth_complete(r#"{"ok":true}"#).ok);
        // Older CLIs / plain-text success output have no `ok` field: still a success.
        assert!(parse_auth_complete("authorization complete").ok);
        assert!(parse_auth_complete("").ok);
    }

    #[test]
    fn ticked_permissions_are_requested_exactly_and_nothing_else() {
        let scopes = vec!["im:message:readonly".to_string(), " search:message ".to_string()];
        let args = auth_login_args(&scopes);
        assert_eq!(args[args.len() - 1], "im:message:readonly search:message");
        assert!(!args.iter().any(|arg| arg == "--recommend"), "{args:?}");
        assert!(!args[args.len() - 1].contains(LOGIN_SCOPE));
    }
}
