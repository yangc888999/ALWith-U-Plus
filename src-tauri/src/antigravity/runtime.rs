//! On-demand download of the official, unmodified Antigravity ACP runtime.
//!
//! The runtime is proprietary (`agent.json` in the ACP registry marks it `proprietary`), so a new
//! machine that did not receive it inside the installer can fetch it from Google directly, verify
//! the exact SHA-256 published in the registry, and release it beside the app. Nothing here reads
//! or stores Google credentials: the official binary owns its own OAuth flow.
//!
//! The URLs and hashes are the 1.5.2 entries of the ACP registry `antigravity-acp/agent.json`.
//! They are pinned on purpose — a mutable "latest" URL cannot be verified against a fixed digest.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use sha2::{Digest, Sha256};

/// The version this build expects. Kept in sync with `runtime.stamp` and the registry pins.
pub(crate) const VERSION: &str = "1.5.2";

struct Release {
    url: &'static str,
    sha256: &'static str,
}

/// Build the release key from Rust's OS/ARCH constants. `consts::ARCH` is `aarch64` (not the full
/// triple), so the two values have to be combined explicitly.
fn current_target() -> String {
    let os = match std::env::consts::OS {
        "macos" => "apple-darwin",
        "linux" => "unknown-linux-gnu",
        "windows" => "pc-windows-msvc",
        other => other,
    };
    format!("{}-{os}", std::env::consts::ARCH)
}

/// Pick the pinned release for the current target. Only platforms Google publishes are listed;
/// an unsupported target fails closed instead of guessing a URL.
fn release_for(target: &str) -> Option<Release> {
    let base = "https://dl.google.com/agy-extensions/releases";
    let (archive, hash) = match target {
        "aarch64-apple-darwin" => (
            format!("{base}/macos/agy-acp-server-{VERSION}-darwin-arm64.zip"),
            "123a16d5c40a8ac99e20f01a62b68dd860fd96b1c528dfb8eaa37ca8733d4845",
        ),
        "x86_64-apple-darwin" => (
            format!("{base}/macos/agy-acp-server-{VERSION}-darwin-x86_64.zip"),
            "92addb5580577b5356d35484d72d1a113d9c5312ad766bcb304983aa8e3fbb06",
        ),
        "x86_64-unknown-linux-gnu" => (
            format!("{base}/linux/agy-acp-server-{VERSION}-linux-x86_64.zip"),
            "99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852",
        ),
        "aarch64-unknown-linux-gnu" => (
            format!("{base}/linux/agy-acp-server-{VERSION}-linux-arm64.zip"),
            "e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb",
        ),
        "x86_64-pc-windows-msvc" => (
            format!("{base}/windows/agy-acp-server-{VERSION}-windows-x86_64.zip"),
            "5cbadd4f4df698572473d8890fc26ec2dc1724501f06e3a963941daec2bd21d6",
        ),
        "aarch64-pc-windows-msvc" => (
            format!("{base}/windows/agy-acp-server-{VERSION}-windows-arm64.zip"),
            "8a4b2ea8df2ffefae33309348752e9119d21a6d36090c0eb48631c2e8f5781ab",
        ),
        _ => return None,
    };
    // `url` is owned here; leak a single small string because `Release` holds &'static str for the
    // tiny, process-lifetime config table. This happens at most once per call, never in a loop.
    let url: &'static str = Box::leak(archive.into_boxed_str());
    Some(Release { url, sha256: hash })
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Verify bytes against a registry hash. Constant-time is unnecessary: the digest is public.
fn verify(bytes: &[u8], expected: &str) -> Result<(), String> {
    let actual = digest(bytes);
    if actual == expected {
        Ok(())
    } else {
        Err(format!("Antigravity runtime checksum mismatch: expected {expected}, got {actual}"))
    }
}

/// Download the pinned archive to memory with a hard size cap, so a proxy or captive portal
/// cannot stream an unbounded body to disk.
fn fetch(url: &str) -> Result<Vec<u8>, String> {
    const MAX_ARCHIVE: u64 = 512 * 1024 * 1024;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Cannot create download client: {error}"))?;
    let response = client
        .get(url)
        .send()
        .map_err(|error| format!("Cannot download Antigravity runtime: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Antigravity runtime download returned HTTP {}", response.status().as_u16()));
    }
    let size = response.content_length().unwrap_or(0);
    if size > MAX_ARCHIVE {
        return Err(format!("Antigravity runtime archive is too large ({size} bytes)"));
    }
    let mut bytes = Vec::with_capacity(size.min(MAX_ARCHIVE) as usize);
    response
        .take(MAX_ARCHIVE + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read Antigravity runtime archive: {error}"))?;
    if bytes.len() as u64 > MAX_ARCHIVE {
        return Err("Antigravity runtime archive exceeded the size limit".into());
    }
    Ok(bytes)
}

/// Extract only the two known runtime files out of the verified archive into a staging directory.
/// Uses the system `unzip` so the app carries no extra native dependency.
fn extract(archive: &Path, into: &Path) -> Result<(), String> {
    std::fs::create_dir_all(into).map_err(|error| format!("Cannot create staging directory: {error}"))?;
    let output = Command::new("unzip")
        .arg("-o")
        .arg("-q")
        .arg(archive)
        .arg("-d")
        .arg(into)
        .output()
        .map_err(|error| format!("Cannot run unzip: {error}"))?;
    if !output.status.success() {
        return Err(format!("Cannot extract Antigravity runtime: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(())
}

/// Download, verify, and release the runtime into `target_dir`. `copy_file` is the caller's atomic
/// release helper, so an interrupted install never leaves a half-written executable.
pub(crate) fn download_into<F>(
    target_dir: &Path,
    names: &[&str; 2],
    stamp: &str,
    mut copy_file: F
) -> Result<PathBuf, String>
where
    F: FnMut(&Path, &Path) -> Result<(), String>,
{
    let target = current_target();
    let release = release_for(&target).ok_or_else(|| {
        format!("Antigravity has no pinned runtime for target {target}")
    })?;
    let bytes = fetch(release.url)?;
    verify(&bytes, release.sha256)?;

    let staging_root = tempfile::tempdir().map_err(|error| format!("Cannot create temp directory: {error}"))?;
    let archive = staging_root.path().join("runtime.zip");
    std::fs::write(&archive, &bytes).map_err(|error| format!("Cannot stage archive: {error}"))?;
    let unpacked = staging_root.path().join("unpacked");
    extract(&archive, &unpacked)?;

    std::fs::create_dir_all(target_dir).map_err(|error| format!("Cannot create runtime directory: {error}"))?;
    for name in names {
        let source = unpacked.join(name);
        if !source.is_file() {
            return Err(format!("Antigravity archive is missing {name}"));
        }
        copy_file(&source, &target_dir.join(name))?;
    }
    std::fs::write(target_dir.join("runtime.stamp"), stamp)
        .map_err(|error| format!("Cannot write runtime stamp: {error}"))?;
    Ok(target_dir.join(names[0]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_only_the_exact_registry_digest() {
        let bytes = b"official runtime bytes";
        let expected = digest(bytes);
        assert!(verify(bytes, &expected).is_ok());
        let failure = verify(bytes, &"0".repeat(64)).unwrap_err();
        assert!(failure.contains("checksum mismatch"));
    }

    #[test]
    fn pinned_release_is_available_for_supported_and_unknown_targets() {
        // The pinned registry entry for this build's own target must exist.
        let key = current_target();
        assert!(key.starts_with(std::env::consts::ARCH));
        assert!(release_for(&key).is_some(), "no pin for current target {key}");
        assert!(release_for("mips-unknown-linux-gnu").is_none());
    }

    #[test]
    fn digest_matches_a_known_sha256_vector() {
        // sha256("abc")
        assert_eq!(
            digest(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
