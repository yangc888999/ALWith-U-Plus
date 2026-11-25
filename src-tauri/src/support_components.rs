//! Detection and installation of runtime dependencies: Node.js and npm.
//!
//! These power `lark-cli` (which is itself installed via npm) and any other tooling the app
//! shells out to. GUI apps do not inherit the user's shell PATH, so discovery searches a fixed
//! set of well-known locations — including the WorkBuddy-managed Node — rather than relying on
//! PATH, and `enriched_path` re-advertises those locations to child processes.

use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatus {
    pub installed: bool,
    /// Node.js version (without a leading `v`), e.g. `22.22.2`.
    pub version: Option<String>,
    /// Bundled npm version, when Node is found.
    pub npm_version: Option<String>,
    /// Resolved path to the `node` binary.
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub ok: bool,
    pub message: String,
}

/// Candidate directories that may hold `node` / `npm` on this machine, in addition to PATH.
fn candidate_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> =
        vec![PathBuf::from("/usr/local/bin"), PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/bin")];
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(PathBuf::from(&home).join(".local/bin"));
        // WorkBuddy manages its own Node; surface that bin dir so a CLI installed against it is
        // still discoverable from a GUI app that did not inherit the user's shell PATH.
        let workbuddy_node = PathBuf::from(&home).join(".workbuddy/binaries/node/versions");
        if let Ok(reader) = std::fs::read_dir(&workbuddy_node) {
            for entry in reader.flatten() {
                let bin = entry.path().join("bin");
                if bin.is_dir() {
                    dirs.push(bin);
                }
            }
        }
    }
    dirs
}

/// Search PATH first, then the well-known candidate directories, for an executable by name.
fn search_executable(name: &str) -> Option<PathBuf> {
    let path = std::env::var("PATH").unwrap_or_default();
    for directory in path.split(':') {
        if directory.is_empty() {
            continue;
        }
        let candidate = PathBuf::from(directory).join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    for directory in candidate_dirs() {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// A PATH string that prepends every candidate directory to the inherited PATH, so the CLI's
/// Node-based `auth` helpers can still resolve node from a GUI launch context. The Lark CLI's
/// install / update no longer invoke npm: `lark_cli` downloads the binary from the registry
/// mirror into an app-owned directory instead.
pub fn enriched_path() -> String {
    let mut parts: Vec<String> =
        candidate_dirs().into_iter().map(|directory| directory.display().to_string()).collect();
    parts.push(std::env::var("PATH").unwrap_or_default());
    parts.join(":")
}

/// Run `<binary> --version` and return the first version-like token (leading `v` stripped).
fn version_of(binary: &PathBuf) -> Option<String> {
    let output = Command::new(binary).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    parse_version(&String::from_utf8_lossy(&output.stdout))
}

fn parse_version(text: &str) -> Option<String> {
    let line = text.lines().next().unwrap_or("");
    let token = line
        .split_whitespace()
        .find(|token| token.contains('.') && token.chars().any(|character| character.is_ascii_digit()))?;
    Some(token.trim_start_matches('v').to_string())
}

#[tauri3_specta::command]
pub async fn node_status() -> NodeStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let node = search_executable("node");
        let npm = search_executable("npm");
        let version = node.as_ref().and_then(version_of);
        let npm_version = npm.as_ref().and_then(version_of);
        NodeStatus {
            installed: node.is_some(),
            version,
            npm_version,
            path: node.map(|binary| binary.display().to_string()),
        }
    })
    .await
    .unwrap_or(NodeStatus { installed: false, version: None, npm_version: None, path: None })
}

/// Download the official macOS universal Node.js `.pkg` for the latest LTS and open it with the
/// system Installer. Falls back to a manual-download instruction when the download fails (e.g. no
/// network), which the Settings UI also surfaces as a link.
#[tauri3_specta::command]
pub async fn node_install() -> Result<InstallOutcome, String> {
    if !cfg!(target_os = "macos") {
        return Err("Node.js 自动安装目前仅支持 macOS。".to_string());
    }
    let version = fetch_latest_node_lts().await.unwrap_or_else(|| "v22.11.0".to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let url = format!("https://nodejs.org/dist/{version}/node-{version}.pkg");
        let temp = std::env::temp_dir().join(format!("node-{version}.pkg"));
        let temp_string = temp.to_string_lossy().to_string();
        let download = Command::new("curl").args(["-fL", "-o", &temp_string, &url]).output();
        match download {
            Ok(result) if result.status.success() => {}
            Ok(result) => {
                return Err(format!(
                    "下载 Node.js 安装包失败（退出码 {:?}）：{}",
                    result.status.code(),
                    String::from_utf8_lossy(&result.stderr)
                ));
            }
            Err(error) => return Err(format!("无法启动 curl 下载 Node.js：{}", error)),
        }
        // Best-effort: drop Gatekeeper quarantine so the Installer opens without a warning sheet.
        let _ = Command::new("xattr").args(["-dr", "com.apple.quarantine", &temp_string]).output();
        match Command::new("open").arg(&temp_string).status() {
            Ok(status) if status.success() => Ok(InstallOutcome {
                ok: true,
                message: "已打开 Node.js 安装器，请按提示完成安装（需要管理员密码）。装好后再点「检测」刷新状态。"
                    .to_string(),
            }),
            Ok(status) => Err(format!("打开安装器失败（退出码 {:?}）", status.code())),
            Err(error) => Err(format!("无法打开安装器：{}", error)),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Homebrew presence and version, detected the same PATH-agnostic way as Node.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BrewStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[tauri3_specta::command]
pub async fn brew_status() -> BrewStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let brew = search_executable("brew");
        let version = brew.as_ref().and_then(version_of);
        BrewStatus { installed: brew.is_some(), version, path: brew.map(|binary| binary.display().to_string()) }
    })
    .await
    .unwrap_or(BrewStatus { installed: false, version: None, path: None })
}

/// Install Homebrew by running the official script inside Terminal. The installer needs `sudo`
/// and a TTY, so a silent background process cannot supply the admin password; delegating to
/// Terminal gives the user a real prompt while still being a single click from Settings.
#[tauri3_specta::command]
pub async fn brew_install() -> Result<InstallOutcome, String> {
    if !cfg!(target_os = "macos") {
        return Err("Homebrew 自动安装目前仅支持 macOS。".to_string());
    }
    let command = "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"";
    tauri::async_runtime::spawn_blocking(move || {
        let osa = format!("tell application \"Terminal\" to do script \"{}\"", command.replace('"', "\\\""));
        match Command::new("osascript").args(["-e", &osa]).status() {
            Ok(status) if status.success() => Ok(InstallOutcome {
                ok: true,
                message:
                    "已打开终端执行 Homebrew 安装脚本，请在终端中输入管理员密码完成安装，装好后再点「检测」刷新状态。"
                        .to_string(),
            }),
            Ok(status) => Err(format!("打开终端失败（退出码 {:?}）", status.code())),
            Err(error) => Err(format!("无法启动安装：{}", error)),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Query nodejs.org for the newest LTS release; returns the bare version string, e.g. `v22.11.0`.
async fn fetch_latest_node_lts() -> Option<String> {
    let output = match tauri::async_runtime::spawn_blocking(|| {
        Command::new("curl").args(["-fsSL", "https://nodejs.org/dist/index.json"]).output()
    })
    .await
    {
        Ok(Ok(result)) => result,
        _ => return None,
    };
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let array = value.as_array()?;
    for entry in array {
        let is_lts =
            entry.get("lts").map(|field| !field.is_null() && !field.as_bool().unwrap_or(false)).unwrap_or(false);
        if is_lts && let Some(version) = entry.get("version").and_then(serde_json::Value::as_str) {
            return Some(version.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_token_strips_leading_v() {
        assert_eq!(parse_version("v22.22.2\n"), Some("22.22.2".to_string()));
        assert_eq!(parse_version("10.9.7\n"), Some("10.9.7".to_string()));
        assert_eq!(parse_version("node: v20.0.0"), Some("20.0.0".to_string()));
        assert_eq!(parse_version("nothing useful"), None);
    }

    #[test]
    fn brew_version_line_is_parsed() {
        assert_eq!(
            parse_version("Homebrew 4.3.0\nHomebrew/homebrew-core (git revision abc123)\n"),
            Some("4.3.0".to_string())
        );
    }
}
