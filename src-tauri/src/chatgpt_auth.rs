//! The ChatGPT credentials Codex keeps on disk.
//!
//! Every model runs through one shared Codex provider so a conversation can change vendors, which
//! means Codex never signs the outgoing request with the ChatGPT token itself. Native models still
//! belong to the ChatGPT backend, so the bridge reads the token Codex refreshes and signs that hop
//! with it. `auth.json` is rewritten on every refresh, so the file's mtime is the cache key.

use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

#[derive(Clone)]
pub(crate) struct Credentials {
    pub access_token: String,
    pub account_id: String,
}

fn codex_home() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("CODEX_HOME")
        && !value.trim().is_empty()
    {
        return Some(PathBuf::from(value));
    }
    std::env::var("HOME").ok().map(|home| PathBuf::from(home).join(".codex"))
}

type Cache = Option<(SystemTime, Option<Credentials>)>;

fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// The current ChatGPT credentials, or `None` when Codex is signed out (or on an API key).
pub(crate) fn read() -> Option<Credentials> {
    let path = codex_home()?.join("auth.json");
    let modified = std::fs::metadata(&path).and_then(|meta| meta.modified()).ok()?;
    let mut guard = cache().lock().ok()?;
    if let Some((cached_at, cached)) = guard.as_ref()
        && *cached_at == modified
    {
        return cached.clone();
    }
    let parsed =
        std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()).and_then(|json| {
            let tokens = json.get("tokens")?;
            let access_token = tokens.get("access_token").and_then(Value::as_str)?.to_string();
            let account_id = tokens.get("account_id").and_then(Value::as_str)?.to_string();
            if access_token.is_empty() || account_id.is_empty() {
                return None;
            }
            Some(Credentials { access_token, account_id })
        });
    *guard = Some((modified, parsed.clone()));
    parsed
}
