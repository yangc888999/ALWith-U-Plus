//! npm-registry tarball helpers, shared by the Lark CLI installer.
//!
//! This module used to also own a Codex "engine update" flow: it downloaded a newer Codex CLI
//! into `<app data>/codex-override/codex` and the Runtime preferred that copy. The product
//! dropped that in 2026-11-17 — components ship with the app, an externally delivered engine
//! binary is no longer accepted — so the flow is gone: the commands, the override writer and the
//! version-display path that read it. What remains is the registry plumbing `lark_cli` reuses.
//!
//! Reason it had to go rather than linger: `bundled_codex_path` still consulted the override
//! directory, so 「构建信息 → 引擎」 kept reporting the stale 0.167.0 binary sitting in that
//! folder while the app actually ran the bundled 0.170.0 (2026-11-19).

use std::path::Path;

pub(crate) const REGISTRY_BASE: &str = "https://registry.npmmirror.com";

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

pub(crate) fn version_newer(latest: &str, current: &str) -> bool {
    let parse = |text: &str| -> Vec<u64> {
        text.trim_start_matches('v')
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect()
    };
    parse(latest) > parse(current)
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
