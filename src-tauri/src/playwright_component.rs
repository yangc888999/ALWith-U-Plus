//! Optional Playwright Core + Chromium Headless Shell component.
//!
//! The browser is deliberately not shipped in the app bundle: it is ~100 MB and only browser
//! automation tasks need it. This module downloads Playwright Core into a user-writable app-owned
//! directory, then asks its own CLI to install the matching headless shell. Tasks receive
//! `PLAYWRIGHT_BROWSERS_PATH` through the Runtime environment, so a project that already pins its
//! own Playwright version can reuse the browser without a second copy.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::Value;

const PLAYWRIGHT_PACKAGE: &str = "playwright-core";
const PLAYWRIGHT_RELEASES: &str = "https://github.com/microsoft/playwright/releases";

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlaywrightComponentStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub browser_revision: Option<String>,
    pub browser_version: Option<String>,
    pub browser_path: Option<String>,
    pub install_dir: String,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlaywrightUpdateCheck {
    pub has_update: bool,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub message: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PlaywrightInstallResult {
    pub ok: bool,
    pub message: String,
}

fn home() -> Result<PathBuf, String> {
    std::env::var("HOME").map(PathBuf::from).map_err(|_| "无法读取 HOME 目录".to_string())
}

fn managed_root() -> Result<PathBuf, String> {
    Ok(home()?.join(".local/lib/alwith/playwright"))
}

fn package_dir() -> Result<PathBuf, String> {
    Ok(managed_root()?.join(PLAYWRIGHT_PACKAGE))
}

fn browsers_dir() -> Result<PathBuf, String> {
    Ok(managed_root()?.join("browsers"))
}

/// Environment value handed to agent processes. Empty when HOME is unavailable.
pub(crate) fn browsers_path() -> String {
    let Ok(path) = browsers_dir() else { return String::new() };
    let Ok(entries) = std::fs::read_dir(&path) else { return String::new() };
    let binary = if cfg!(windows) { "chrome-headless-shell.exe" } else { "chrome-headless-shell" };
    let has_headless = entries.flatten().any(|entry| {
        entry.file_name().to_string_lossy().starts_with("chromium_headless_shell-")
            && find_named(&entry.path(), binary).is_some()
    });
    if has_headless { path.display().to_string() } else { String::new() }
}

/// Absolute path to the managed Playwright Core package, for scripts that import it explicitly.
pub(crate) fn core_path() -> String {
    let Ok(path) = package_dir() else { return String::new() };
    if path.join("package.json").is_file() { path.display().to_string() } else { String::new() }
}

fn read_package_version() -> Option<String> {
    let raw = std::fs::read_to_string(package_dir().ok()?.join("package.json")).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    value.get("version").and_then(Value::as_str).map(str::to_string)
}

fn headless_metadata() -> Option<(String, Option<String>)> {
    let raw = std::fs::read_to_string(package_dir().ok()?.join("browsers.json")).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let entry = value
        .get("browsers")?
        .as_array()?
        .iter()
        .find(|entry| entry.get("name").and_then(Value::as_str) == Some("chromium-headless-shell"))?;
    let revision = entry.get("revision")?.as_str()?.to_string();
    let browser_version = entry.get("browserVersion").and_then(Value::as_str).map(str::to_string);
    Some((revision, browser_version))
}

fn find_named(root: &Path, name: &str) -> Option<PathBuf> {
    fn walk(directory: &Path, name: &str, found: &mut Option<PathBuf>) {
        if found.is_some() {
            return;
        }
        let Ok(entries) = std::fs::read_dir(directory) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, name, found);
            } else if path.file_name().and_then(|value| value.to_str()) == Some(name) {
                *found = Some(path);
                return;
            }
        }
    }
    let mut found = None;
    walk(root, name, &mut found);
    found
}

fn browser_path_for(revision: &str) -> Option<PathBuf> {
    let root = browsers_dir().ok()?.join(format!("chromium_headless_shell-{revision}"));
    let binary = if cfg!(windows) { "chrome-headless-shell.exe" } else { "chrome-headless-shell" };
    find_named(&root, binary)
}

/// The component owns one browser runtime at a time. Removing older headless-shell revisions keeps
/// a machine from accumulating hundreds of MB after every Playwright update; a running browser
/// keeps its open files until the process exits (Unix), and Windows failures are best-effort.
fn cleanup_old_browsers(current_revision: &str) {
    let Ok(root) = browsers_dir() else { return };
    cleanup_old_browsers_in(&root, current_revision);
}

fn cleanup_old_browsers_in(root: &Path, current_revision: &str) {
    let Ok(entries) = std::fs::read_dir(&root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("chromium_headless_shell-")
            || name == format!("chromium_headless_shell-{current_revision}")
        {
            continue;
        }
        let _ = std::fs::remove_dir_all(entry.path());
    }
}

fn status_now() -> PlaywrightComponentStatus {
    let install_dir = managed_root().map(|path| path.display().to_string()).unwrap_or_default();
    let version = read_package_version();
    let metadata = headless_metadata();
    let browser_revision = metadata.as_ref().map(|(revision, _)| revision.clone());
    let browser_version = metadata.and_then(|(_, version)| version);
    let browser_path = browser_revision.as_deref().and_then(browser_path_for).map(|path| path.display().to_string());
    let installed = version.is_some() && browser_path.is_some();
    let hint = if installed {
        "Playwright Core 和 Headless Shell 已就绪。".to_string()
    } else if version.is_some() {
        "Playwright Core 已安装，但 Headless Shell 还没安装。".to_string()
    } else {
        "尚未安装；浏览器自动化任务需要先在这里安装。".to_string()
    };
    PlaywrightComponentStatus { installed, version, browser_revision, browser_version, browser_path, install_dir, hint }
}

#[tauri3_specta::command]
pub async fn playwright_component_status() -> PlaywrightComponentStatus {
    tauri::async_runtime::spawn_blocking(status_now).await.unwrap_or_else(|_| PlaywrightComponentStatus {
        installed: false,
        version: None,
        browser_revision: None,
        browser_version: None,
        browser_path: None,
        install_dir: String::new(),
        hint: "无法读取 Playwright 组件状态。".to_string(),
    })
}

/// Pure half of the registry lookup, kept testable without a network call.
fn parse_registry_metadata(body: &[u8]) -> Result<(String, String), String> {
    let value: Value = serde_json::from_slice(body).map_err(|error| format!("registry JSON：{error}"))?;
    let version = value.get("version").and_then(Value::as_str).ok_or("registry 响应里没有 version")?.to_string();
    let tarball =
        value.pointer("/dist/tarball").and_then(Value::as_str).ok_or("registry 响应里没有 dist.tarball")?.to_string();
    Ok((version, tarball))
}

async fn latest_metadata() -> Result<(String, String), String> {
    let url = format!("{}/{}/latest", crate::codex_update::REGISTRY_BASE, PLAYWRIGHT_PACKAGE);
    let body = crate::codex_update::http_get(&url).await?;
    parse_registry_metadata(&body)
}

fn run_playwright_install(package: &Path, browsers: &Path) -> Result<(), String> {
    let bun = crate::runtime::sidecar_path("bun")?;
    let cli = package.join("cli.js");
    if !cli.is_file() {
        return Err(format!("Playwright CLI 不存在：{}", cli.display()));
    }
    let output = Command::new(bun)
        .arg(cli)
        .args(["install", "chromium", "--only-shell", "--no-progress"])
        .env("PLAYWRIGHT_BROWSERS_PATH", browsers)
        .env("PATH", crate::support_components::enriched_path())
        .current_dir(package)
        .output()
        .map_err(|error| format!("无法启动 Playwright 安装器：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "Headless Shell 安装失败：{}",
            if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() }
        ));
    }
    Ok(())
}

async fn install_version(version: &str, tarball: &str) -> Result<PlaywrightInstallResult, String> {
    let root = managed_root()?;
    let package = package_dir()?;
    let browsers = browsers_dir()?;
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let work = tempfile::tempdir().map_err(|error| error.to_string())?;
    let archive = work.path().join(format!("{PLAYWRIGHT_PACKAGE}-{version}.tgz"));
    crate::codex_update::http_download(tarball, &archive).await?;
    let extracted = work.path().join("extracted");
    crate::codex_update::extract_tarball(&archive, &extracted)?;
    let staged = extracted.join("package");
    if !staged.is_dir() {
        return Err("Playwright 压缩包里没有 package 目录".to_string());
    }
    let backup = root.join(format!("{PLAYWRIGHT_PACKAGE}.old"));
    if backup.exists() {
        std::fs::remove_dir_all(&backup).map_err(|error| format!("清理旧 Playwright 备份：{error}"))?;
    }
    let had_package = package.exists();
    if had_package {
        std::fs::rename(&package, &backup).map_err(|error| format!("备份旧 Playwright 包：{error}"))?;
    }
    if let Err(error) = std::fs::rename(&staged, &package) {
        if had_package {
            let _ = std::fs::rename(&backup, &package);
        }
        return Err(format!("安装 Playwright 包：{error}"));
    }
    if had_package {
        let _ = std::fs::remove_dir_all(&backup);
    }
    let package_for_install = package.clone();
    let browsers_for_install = browsers.clone();
    tauri::async_runtime::spawn_blocking(move || run_playwright_install(&package_for_install, &browsers_for_install))
        .await
        .map_err(|error| error.to_string())??;
    if let Some((revision, _)) = headless_metadata() {
        cleanup_old_browsers(&revision);
    }
    Ok(PlaywrightInstallResult {
        ok: true,
        message: format!("Playwright Core {version} 与对应 Headless Shell 已安装到 {}", browsers.display()),
    })
}

#[tauri3_specta::command]
pub async fn playwright_component_install() -> Result<PlaywrightInstallResult, String> {
    let (version, tarball) = latest_metadata().await?;
    install_version(&version, &tarball).await
}

#[tauri3_specta::command]
pub async fn playwright_component_update() -> Result<PlaywrightInstallResult, String> {
    let (version, tarball) = latest_metadata().await?;
    install_version(&version, &tarball).await
}

#[tauri3_specta::command]
pub async fn playwright_component_check_update() -> Result<PlaywrightUpdateCheck, String> {
    let current = read_package_version();
    let latest = latest_metadata().await.map(|(version, _)| version).ok();
    let has_update = match (&current, &latest) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(local), Some(remote)) => crate::codex_update::version_newer(remote, local),
    };
    let message = match (&current, &latest) {
        (Some(local), Some(remote)) if has_update => format!("{local} → {remote} 可用"),
        (Some(_), Some(_)) => "已是最新版本".to_string(),
        (None, Some(remote)) => format!("尚未安装，可安装 {remote}"),
        _ => "暂时无法检查更新".to_string(),
    };
    Ok(PlaywrightUpdateCheck {
        has_update,
        current_version: current,
        latest_version: latest,
        message,
        url: Some(PLAYWRIGHT_RELEASES.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_metadata_requires_version_and_tarball() {
        let body = br#"{"version":"1.65.0","dist":{"tarball":"https://example/playwright-core-1.65.0.tgz"}}"#;
        assert_eq!(
            parse_registry_metadata(body).unwrap(),
            ("1.65.0".to_string(), "https://example/playwright-core-1.65.0.tgz".to_string())
        );
        assert!(parse_registry_metadata(br#"{"version":"1.65.0"}"#).is_err());
    }

    #[test]
    fn headless_metadata_parses_revision_without_a_download() {
        let json = br#"{"browsers":[{"name":"chromium","revision":"1253"},{"name":"chromium-headless-shell","revision":"1254","browserVersion":"157.0.0"}]}"#;
        let value: Value = serde_json::from_slice(json).unwrap();
        let entry = value["browsers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == "chromium-headless-shell")
            .unwrap();
        assert_eq!(entry["revision"], "1254");
        assert_eq!(entry["browserVersion"], "157.0.0");
    }

    #[test]
    fn cleanup_keeps_only_the_current_headless_revision() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("chromium_headless_shell-1254")).unwrap();
        std::fs::create_dir_all(directory.path().join("chromium_headless_shell-1255")).unwrap();
        std::fs::create_dir_all(directory.path().join("ffmpeg-1013")).unwrap();
        cleanup_old_browsers_in(directory.path(), "1255");
        assert!(!directory.path().join("chromium_headless_shell-1254").exists());
        assert!(directory.path().join("chromium_headless_shell-1255").exists());
        assert!(directory.path().join("ffmpeg-1013").exists());
    }
}
