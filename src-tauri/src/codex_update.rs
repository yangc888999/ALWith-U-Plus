//! Engine (Codex CLI) update check and install.
//!
//! The bundled `codex` binary is replaced by installing a newer one into
//! `<app data>/codex-override/codex`; `engines_table` prefers that path, so the next runtime
//! start picks it up. Updates are pulled from the npm registry mirror (reachable here, unlike
//! GitHub release assets) as package tarballs: the launcher package first, to resolve the
//! platform binary package for this machine, then that package for the executable itself.

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub(crate) const REGISTRY_BASE: &str = "https://registry.npmmirror.com";
const PACKAGE: &str = "@openai/codex";

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineUpdateStatus {
    pub current: String,
    pub latest: Option<String>,
    pub has_update: bool,
}

fn override_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| error.to_string())?.join("codex-override");
    Ok(dir)
}

pub(crate) async fn http_get(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client.get(url).send().await.map_err(|error| format!("{url}: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url}: HTTP {status}"));
    }
    Ok(response.bytes().await.map_err(|error| format!("{url}: {error}"))?.to_vec())
}

/// Streams a release tarball to disk.
///
/// The platform package is ~147 MB. Sharing `http_get`'s 20 s deadline made the install time out
/// mid-transfer on anything slower than ~7 MB/s, and buffering the whole tarball in memory on top
/// of that starved the model stream enough to surface as "the model connection dropped". A
/// connect timeout still bounds a dead endpoint; the body gets a long read budget and goes
/// straight to the file.
pub(crate) async fn http_download(url: &str, path: &Path) -> Result<(), String> {
    let url = url.to_string();
    let path = path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(30 * 60))
            .build()
            .map_err(|error| error.to_string())?;
        let mut response = client.get(&url).send().map_err(|error| format!("{url}: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("{url}: HTTP {status}"));
        }
        let mut file = std::fs::File::create(&path).map_err(|error| error.to_string())?;
        std::io::copy(&mut response, &mut file).map_err(|error| format!("{url}: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

async fn latest_registry_version() -> Result<String, String> {
    let url = format!("{REGISTRY_BASE}/{PACKAGE}/latest");
    let body = http_get(&url).await?;
    let value: serde_json::Value = serde_json::from_slice(&body).map_err(|error| format!("registry JSON: {error}"))?;
    value
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "registry response has no version".into())
}

pub(crate) fn version_newer(latest: &str, current: &str) -> bool {
    let parse = |text: &str| -> Vec<u64> {
        text.trim_start_matches('v')
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };
    parse(latest) > parse(current)
}

#[tauri3_specta::command]
pub async fn codex_check_engine_update(app: AppHandle) -> Result<EngineUpdateStatus, String> {
    let current = {
        let codex = crate::runtime::bundled_codex_path(&app);
        let mut command = tokio::process::Command::new(&codex);
        command.arg("--version").kill_on_drop(true);
        let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
            .await
            .map_err(|_| "Codex version check timed out")?
            .map_err(|error| error.to_string())?;
        let stdout = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
        stdout
            .trim()
            .strip_prefix("codex-cli ")
            .filter(|version| !version.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| String::from("Unexpected Codex version output"))?
    };
    let latest = tokio::task::spawn_blocking(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?
            .block_on(latest_registry_version())
    })
    .await
    .map_err(|error| error.to_string())?;
    let latest = match latest {
        Ok(value) => Some(value),
        Err(error) => {
            log::warn!("engine update check failed: {error}");
            None
        }
    };
    let has_update = latest.as_deref().is_some_and(|latest| version_newer(latest, &current));
    Ok(EngineUpdateStatus { current, latest, has_update })
}

pub(crate) fn extract_tarball(archive: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    let status = std::process::Command::new("tar")
        .args(["-xzf"])
        .arg(archive)
        .arg("-C")
        .arg(destination)
        .output()
        .map_err(|error| error.to_string())?;
    if !status.status.success() {
        return Err(format!("tar extract failed: {}", String::from_utf8_lossy(&status.stderr)));
    }
    Ok(())
}

/// Finds the first executable `codex` binary inside an extracted platform package.
fn find_codex_binary(extracted: &Path) -> Result<PathBuf, String> {
    fn walk(directory: &Path, found: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(directory) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, found);
            } else if path.file_name().is_some_and(|name| name == "codex") && path.is_file() {
                found.push(path);
            }
        }
    }
    let mut candidates = Vec::new();
    walk(extracted, &mut candidates);
    candidates
        .into_iter()
        .find(|path| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::metadata(path).map(|meta| meta.permissions().mode() & 0o111 != 0).unwrap_or(false)
            }
            #[cfg(not(unix))]
            {
                true
            }
        })
        .ok_or_else(|| "extracted package has no codex executable".into())
}

fn package_tarball_url(name: &str, version: &str) -> String {
    // Scoped names keep their slash: @openai/codex → @openai%2fcodex in the tarball path.
    let encoded = name.replace('/', "%2f");
    let file = name.rsplit('/').next().unwrap_or(name);
    format!("{REGISTRY_BASE}/{encoded}/-/{file}-{version}.tgz")
}


/// The `npm:` alias of this machine's platform binary inside the launcher manifest.
///
/// Every value is inspected, not just the first one: the map is ordered
/// linux-x64, win32-x64, darwin-x64, linux-arm64, win32-arm64, darwin-arm64, so "take the
/// first dependency" silently picks a Linux package and the install aborts with
/// "no macOS arm64 package" on a Mac.
fn platform_alias(manifest: &serde_json::Value) -> Option<String> {
    manifest["optionalDependencies"]
        .as_object()?
        .values()
        .filter_map(serde_json::Value::as_str)
        .find(|value| value.contains("darwin-arm64"))
        .map(str::to_string)
}

/// Splits `npm:@openai/codex@0.166.0-darwin-arm64` into the real package name and version.
fn split_alias(alias: &str) -> Result<(String, String), String> {
    let spec = alias.strip_prefix("npm:").unwrap_or(alias);
    let (name, version) = spec.rsplit_once('@').ok_or_else(|| format!("malformed platform alias '{alias}'"))?;
    Ok((name.to_string(), version.to_string()))
}

#[tauri3_specta::command]
pub async fn codex_install_engine_update(app: AppHandle, version: String) -> Result<String, String> {
    if !version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Err("Invalid version".into());
    }
    let work = tempfile::tempdir().map_err(|error| error.to_string())?;
    let work = work.path();

    // Launcher package: resolves the platform binary package name for this machine.
    let launcher_archive = work.join("launcher.tgz");
    http_download(&package_tarball_url(PACKAGE, &version), &launcher_archive).await?;
    let launcher_dir = work.join("launcher");
    extract_tarball(&launcher_archive, &launcher_dir)?;
    let manifest = launcher_dir.join("package/package.json");
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&manifest).map_err(|error| error.to_string())?)
            .map_err(|error| format!("launcher manifest: {error}"))?;
    // Platform package: the actual native binary. The manifest maps a platform key to an
    // alias (`"@openai/codex-darwin-arm64": "npm:@openai/codex@0.166.0-darwin-arm64"`) — the
    // real package is @openai/codex at a platform-suffixed version, not the alias key.
    let platform_archive = work.join("platform.tgz");
    let alias = platform_alias(&manifest).ok_or("no macOS arm64 package in the launcher manifest")?;
    let (platform_name, platform_version) = split_alias(&alias)?;
    http_download(&package_tarball_url(&platform_name, &platform_version), &platform_archive).await?;
    let platform_dir = work.join("platform");
    extract_tarball(&platform_archive, &platform_dir)?;
    let binary = find_codex_binary(&platform_dir)?;

    let destination = override_dir(&app)?;
    std::fs::create_dir_all(&destination).map_err(|error| error.to_string())?;
    let target = destination.join("codex");
    // Stage beside the target and rename. A direct `copy` writes into the file the running engine
    // was launched from: macOS then kills that process mid-write, which the chat reports as "the
    // model connection dropped", and an interrupted copy leaves a truncated engine behind. Rename
    // swaps the inode in one step, so a running engine keeps its old bytes and a failed download
    // never touches the working one.
    let staged = destination.join("codex.staged");
    std::fs::copy(&binary, &staged).map_err(|error| format!("copy binary: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
    }
    // The vendor `bin/` also ships helpers the engine spawns from its own directory
    // (codex-code-mode-host for code mode). Copy them alongside so the override is a complete
    // engine, not just a lone binary.
    if let Some(source_dir) = binary.parent() {
        if let Ok(entries) = std::fs::read_dir(source_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() || path == binary {
                    continue;
                }
                if let Some(name) = path.file_name() {
                    let copy = destination.join(format!("{}.staged", name.to_string_lossy()));
                    if std::fs::copy(&path, &copy).is_ok() {
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::PermissionsExt;
                            let _ = std::fs::set_permissions(&copy, std::fs::Permissions::from_mode(0o755));
                        }
                        let _ = std::fs::rename(&copy, destination.join(name));
                    }
                }
            }
        }
    }
    // Surface helper-copy failures instead of shipping a silently broken engine. The main binary is
    // still published below (chat keeps working), but a missing helper (e.g. codex-code-mode-host
    // for code mode) would otherwise fail silently. Orphaned `.staged` files mean the rename — not
    // the copy — failed, and are cleared so the next update starts clean.
    if let Some(source_dir) = binary.parent() {
        if let Ok(entries) = std::fs::read_dir(source_dir) {
            let mut missing: Vec<String> = Vec::new();
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() || path == binary {
                    continue;
                }
                if let Some(name) = path.file_name() {
                    let final_path = destination.join(name);
                    let staged_path =
                        destination.join(format!("{}.staged", name.to_string_lossy()));
                    if !final_path.exists() {
                        missing.push(name.to_string_lossy().to_string());
                        let _ = std::fs::remove_file(&staged_path);
                    }
                }
            }
            if !missing.is_empty() {
                log::warn!(
                    "engine update: {} helper file(s) failed to land in {}: {:?}; code mode or other capabilities may be unavailable",
                    missing.len(),
                    destination.display(),
                    missing
                );
            }
        }
    }
    // Sanity: the downloaded binary must report the version we asked for. The probe runs on the
    // staged copy, so a bad download is discarded before it can replace a working engine.
    let probe = std::process::Command::new(&staged)
        .arg("--version")
        .output()
        .map_err(|error| error.to_string())?;
    let reported = String::from_utf8_lossy(&probe.stdout).trim().to_string();
    if !probe.status.success() || !reported.contains(version.trim_start_matches('v')) {
        let _ = std::fs::remove_file(&staged);
        return Err(format!("installed binary reports '{reported}' instead of {version}; rolled back"));
    }
    std::fs::rename(&staged, &target).map_err(|error| format!("publish binary: {error}"))?;
    log::info!("engine update: Codex {version} installed at {}", target.display());
    Ok(target.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn platform_alias_skips_non_macos_dependencies() {
        // The real 0.166.0 ordering: Linux and Windows entries come before darwin-arm64.
        let manifest = json!({
            "optionalDependencies": {
                "@openai/codex-linux-x64": "npm:@openai/codex@0.166.0-linux-x64",
                "@openai/codex-win32-x64": "npm:@openai/codex@0.166.0-win32-x64",
                "@openai/codex-darwin-x64": "npm:@openai/codex@0.166.0-darwin-x64",
                "@openai/codex-linux-arm64": "npm:@openai/codex@0.166.0-linux-arm64",
                "@openai/codex-win32-arm64": "npm:@openai/codex@0.166.0-win32-arm64",
                "@openai/codex-darwin-arm64": "npm:@openai/codex@0.166.0-darwin-arm64"
            }
        });
        assert_eq!(platform_alias(&manifest).as_deref(), Some("npm:@openai/codex@0.166.0-darwin-arm64"));
    }

    #[test]
    fn split_alias_resolves_name_and_version() {
        let (name, version) = split_alias("npm:@openai/codex@0.166.0-darwin-arm64").unwrap();
        assert_eq!(name, "@openai/codex");
        assert_eq!(version, "0.166.0-darwin-arm64");
    }
}
