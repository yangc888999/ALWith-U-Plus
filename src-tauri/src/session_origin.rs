//! Reads a session's original model/provider from its rollout.
//!
//! Codex resumes a thread by replaying its recorded history through the provider it is asked to
//! use. Replaying a gateway (Claude/DeepSeek) history through the native OpenAI provider makes
//! the Responses API reject it (`input[n].content` too long for a reasoning item → 400), which
//! surfaced as "打开这个聊天" cards and `api request internal error`. The fix is to resume on the
//! provider that recorded the thread: this command hands the caller that origin.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionOrigin {
    /// `openai`, `deepseek`, `hakimi`, … as recorded in the rollout's session_meta.
    pub provider: Option<String>,
    /// The model the thread was created with (first turn_context).
    pub model: Option<String>,
}

fn codex_home() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("CODEX_HOME") {
        if !value.trim().is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".codex"))
}

fn find_rollout(directory: &Path, session_id: &str, budget: &mut usize) -> Option<PathBuf> {
    if *budget == 0 {
        return None;
    }
    let entries = std::fs::read_dir(directory).ok()?;
    for entry in entries.flatten() {
        *budget = budget.saturating_sub(1);
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_rollout(&path, session_id, budget) {
                return Some(found);
            }
        } else if path.file_name().and_then(|name| name.to_str()).is_some_and(|name| {
            name.starts_with("rollout-") && name.contains(session_id) && name.ends_with(".jsonl")
        }) {
            return Some(path);
        }
    }
    None
}

/// The runtime provider id for a custom provider is `custom-<hex(id)>`; the model picker knows it
/// as the raw id (`custom_<…>`). Decode so the resume hint names something the adapter resolves.
fn provider_name(raw: &str) -> String {
    if let Some(encoded) = raw.strip_prefix("custom-") {
        if let Ok(bytes) = hex::decode(encoded) {
            if let Ok(decoded) = String::from_utf8(bytes) {
                return decoded;
            }
        }
    }
    raw.to_string()
}

#[tauri3_specta::command]
pub fn session_origin(session_id: String) -> Result<Option<SessionOrigin>, String> {
    if session_id.len() < 8 || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid session id".into());
    }
    let root = codex_home()?.join("sessions");
    let mut budget = 20_000usize;
    let Some(path) = find_rollout(&root, &session_id, &mut budget) else {
        return Ok(None);
    };
    let contents = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut provider = None;
    let mut model = None;
    // The *last* turn_context names the model the conversation actually ended on — that is the
    // one its history is formatted for. (The first one would resume a later-switched thread on
    // the original model and replay foreign history.)
    for line in contents.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        match value.get("type").and_then(|kind| kind.as_str()) {
            Some("session_meta") => {
                provider = value
                    .pointer("/payload/model_provider")
                    .and_then(|entry| entry.as_str())
                    .map(str::to_string);
            }
            Some("turn_context") => {
                if let Some(found) = value
                    .pointer("/payload/model")
                    .and_then(|entry| entry.as_str())
                    .or_else(|| value.pointer("/payload/turn_context/model").and_then(|entry| entry.as_str()))
                {
                    model = Some(found.to_string());
                }
            }
            _ => {}
        }
    }
    if provider.is_none() && model.is_none() {
        return Ok(None);
    }
    Ok(Some(SessionOrigin { provider: provider.map(|raw| provider_name(&raw)), model }))
}

/// Removes the `reasoning` items from a session's rollout so its history can be replayed by a
/// different provider.
///
/// Gateway models record reasoning text that the Responses API only accepts in an empty `content`
/// array; replaying such a history (especially through another gateway or the native provider)
/// fails with `input[n].content` 400s or an internal error. The user/assistant turns and tool
/// calls are untouched, so the conversation keeps its content — only the model's private
/// thinking is dropped. A `.bak-repair` copy is written before the first rewrite.
#[tauri3_specta::command]
pub fn repair_session_rollout(session_id: String) -> Result<u64, String> {
    if session_id.len() < 8 || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid session id".into());
    }
    let root = codex_home()?.join("sessions");
    let mut budget = 20_000usize;
    let Some(path) = find_rollout(&root, &session_id, &mut budget) else {
        return Err("Session rollout not found".into());
    };
    let contents = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut kept: Vec<&str> = Vec::new();
    let mut removed = 0u64;
    for line in contents.lines() {
        let is_reasoning = serde_json::from_str::<serde_json::Value>(line)
            .ok()
            .is_some_and(|value| {
                value.get("type").and_then(|kind| kind.as_str()) == Some("response_item")
                    && value.pointer("/payload/type").and_then(|kind| kind.as_str()) == Some("reasoning")
            });
        if is_reasoning {
            removed += 1;
        } else {
            kept.push(line);
        }
    }
    if removed == 0 {
        return Ok(0);
    }
    let backup = path.with_extension("jsonl.bak-repair");
    if !backup.exists() {
        std::fs::copy(&path, &backup).map_err(|error| error.to_string())?;
    }
    let mut out = kept.join("\n");
    out.push('\n');
    std::fs::write(&path, out).map_err(|error| error.to_string())?;
    Ok(removed)
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RouterMigration {
    /// Threads whose recorded provider was moved onto the shared router.
    pub threads: u64,
    /// Rollout files whose `session_meta` had to be rewritten to match.
    pub rollouts: u64,
}

/// Shells out to the system SQLite. The state DB is a WAL database owned by Codex; this only runs
/// before the runtime starts, so nothing else has it open.
fn sqlite(db: &Path, sql: &str) -> Result<String, String> {
    let output = std::process::Command::new("/usr/bin/sqlite3")
        .arg("-json")
        .arg(db)
        .arg(sql)
        .output()
        .map_err(|error| format!("sqlite3: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Rewrites `payload.model_provider` in a rollout's `session_meta` line, keeping every other field
/// and byte. Returns whether the file actually changed.
fn rewrite_rollout_provider(path: &Path, router: &str) -> Result<bool, String> {
    let contents = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut lines: Vec<String> = contents.lines().map(str::to_string).collect();
    let Some(first) = lines.first() else {
        return Ok(false);
    };
    let Ok(mut meta) = serde_json::from_str::<serde_json::Value>(first) else {
        return Ok(false);
    };
    if meta.get("type").and_then(|kind| kind.as_str()) != Some("session_meta") {
        return Ok(false);
    }
    let Some(payload) = meta.get_mut("payload").and_then(|value| value.as_object_mut()) else {
        return Ok(false);
    };
    if payload.get("model_provider").and_then(|value| value.as_str()) == Some(router) {
        return Ok(false);
    }
    payload.insert("model_provider".into(), serde_json::Value::String(router.to_string()));
    lines[0] = serde_json::to_string(&meta).map_err(|error| error.to_string())?;
    let backup = path.with_extension("jsonl.bak-router");
    if !backup.exists() {
        std::fs::copy(path, &backup).map_err(|error| error.to_string())?;
    }
    let mut out = lines.join("\n");
    out.push('\n');
    // Write beside the rollout and rename: a half-written file would lose the conversation.
    let staging = path.with_extension("jsonl.router-tmp");
    std::fs::write(&staging, out).map_err(|error| error.to_string())?;
    std::fs::rename(&staging, path).map_err(|error| error.to_string())?;
    Ok(true)
}

/// Moves every thread written before the shared router onto it.
///
/// A thread records the provider it was born on and codex refuses to resume it anywhere else; the
/// adapter's only remedy is restarting the whole app-server, which aborts whatever other chats are
/// streaming ("内核正在切换厂商，这次请求被打断了"). Rewriting the record once — rollout
/// `session_meta` plus the state DB row — lets those chats open on the router with no restart, so
/// switching between vendors stops costing someone else's turn.
///
/// Runs before the runtime starts. The state DB is copied once to `state_5.sqlite.bak-router` and
/// each rollout keeps a `.jsonl.bak-router`; a missing or locked DB is a no-op, not a failure.
#[tauri3_specta::command]
pub fn migrate_threads_to_router() -> Result<RouterMigration, String> {
    let router = crate::bridge::ROUTER_ID;
    let home = codex_home()?;
    let db = home.join("state_5.sqlite");
    if !db.is_file() {
        return Ok(RouterMigration { threads: 0, rollouts: 0 });
    }
    let listing = match sqlite(
        &db,
        &format!("SELECT id, rollout_path FROM threads WHERE model_provider <> '{router}'"),
    ) {
        Ok(listing) => listing,
        Err(error) => {
            log::warn!("thread router migration skipped: {error}");
            return Ok(RouterMigration { threads: 0, rollouts: 0 });
        }
    };
    if listing.trim().is_empty() {
        return Ok(RouterMigration { threads: 0, rollouts: 0 });
    }
    let rows: Vec<serde_json::Value> = serde_json::from_str(&listing).map_err(|error| error.to_string())?;
    let backup = db.with_extension("sqlite.bak-router");
    if !backup.exists() {
        std::fs::copy(&db, &backup).map_err(|error| error.to_string())?;
    }
    let mut rollouts = 0u64;
    let mut ids: Vec<String> = Vec::new();
    for row in &rows {
        let Some(id) = row.get("id").and_then(|value| value.as_str()) else {
            continue;
        };
        if let Some(path) = row.get("rollout_path").and_then(|value| value.as_str()) {
            match rewrite_rollout_provider(Path::new(path), router) {
                Ok(changed) => {
                    if changed {
                        rollouts += 1;
                    }
                }
                Err(error) => log::warn!("rollout {path} not migrated: {error}"),
            }
        }
        ids.push(id.replace('\'', "''"));
    }
    if ids.is_empty() {
        return Ok(RouterMigration { threads: 0, rollouts });
    }
    let quoted: Vec<String> = ids.iter().map(|id| format!("'{id}'")).collect();
    sqlite(
        &db,
        &format!("UPDATE threads SET model_provider = '{router}' WHERE id IN ({})", quoted.join(",")),
    )?;
    log::info!("thread router migration: {} threads, {rollouts} rollouts", ids.len());
    Ok(RouterMigration { threads: ids.len() as u64, rollouts })
}

/// Points the Codex engine at another provider (top-level `model_provider` in config.toml).
///
/// codex fixes its provider per process, so a thread recorded on another provider can only be
/// resumed after the engine restarts on that provider. The model itself is left alone: model
/// names are provider-scoped but writing a stale one would break new chats.
#[tauri3_specta::command]
pub fn apply_session_provider(provider: String) -> Result<(), String> {
    if provider.is_empty() || !provider.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Invalid provider".into());
    }
    let config = codex_home()?.join("config.toml");
    let contents = std::fs::read_to_string(&config).map_err(|error| error.to_string())?;
    let backup = config.with_extension("toml.bak-provider");
    if !backup.exists() {
        std::fs::copy(&config, &backup).map_err(|error| error.to_string())?;
    }
    // Rewrite only the top-level table: everything after the first `[section]` belongs to a
    // section and must stay byte-for-byte untouched.
    let mut top: Vec<String> = Vec::new();
    let mut rest: Vec<String> = Vec::new();
    let mut in_section = false;
    for line in contents.lines() {
        let trimmed = line.trim_start();
        if !in_section && trimmed.starts_with('[') {
            in_section = true;
        }
        if in_section {
            rest.push(line.to_string());
        } else if !trimmed.starts_with("model_provider") && !trimmed.starts_with("model ") {
            top.push(line.to_string());
        }
    }
    while top.last().is_some_and(|line| line.trim().is_empty()) {
        top.pop();
    }
    top.push(format!("model_provider = \"{provider}\""));
    if !rest.is_empty() {
        top.push(String::new());
        top.extend(rest);
    }
    let mut out = top.join("\n");
    out.push('\n');
    std::fs::write(&config, out).map_err(|error| error.to_string())?;
    Ok(())
}

/// Restarts the app so a provider change takes effect (the engine spawns per launch).
#[tauri3_specta::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// Appends one line to the self-test log (`~/Library/Logs/ai.alwith.u/autotest.log`).
#[tauri3_specta::command]
pub fn append_diagnostic(line: String) -> Result<(), String> {
    use std::io::Write;
    let log_dir = std::path::PathBuf::from(std::env::var("HOME").map_err(|_| "HOME is not set")?)
        .join("Library/Logs/ai.alwith.u");
    std::fs::create_dir_all(&log_dir).map_err(|error| error.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("autotest.log"))
        .map_err(|error| error.to_string())?;
    writeln!(file, "{line}").map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_short_or_unsafe_ids() {
        assert!(session_origin("short".into()).is_err());
        assert!(session_origin("../../etc/passwd".into()).is_err());
    }
}
