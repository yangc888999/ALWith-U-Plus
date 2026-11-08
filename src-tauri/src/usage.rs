//! Local token usage ledger.
//!
//! Every turn the engine runs already lands on disk: `<CODEX_HOME>/sessions/**/rollout-*.jsonl`
//! carries one `turn_context` record (which names the model) and one `token_count` record per
//! model call, whose `last_token_usage` is that call's delta. That is the only usage figure the
//! app can read without asking a server, so the settings page is built from it rather than from a
//! second, private counter that would disagree with the transcript.
//!
//! Two things this deliberately does not do:
//!
//! * It does not sum `total_token_usage`. That counter restarts when the context is compacted or a
//!   session is forked, so adding it up undercounts; the per-call deltas do not.
//! * It does not invent a price. Nothing on this machine knows what a custom provider charges, so
//!   the report carries tokens and calls only.

use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;

/// One row of the pre-aggregated table: an hour, a provider and a model.
///
/// Hour granularity exists for time-of-day pricing (DeepSeek bills weekday peak and off-peak
/// rates); charts aggregate these rows back up by day. `hour` is the UTC hour of `date`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsagePoint {
    pub date: String,
    pub hour: u8,
    pub provider: String,
    pub model: String,
    pub requests: u32,
    /// Input tokens the provider actually had to read (cached ones excluded).
    pub input: u64,
    pub cached: u64,
    pub output: u64,
    pub reasoning: u64,
    pub tokens: u64,
}

/// A single model call, for the request table.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageTurn {
    pub at: String,
    pub date: String,
    pub provider: String,
    pub model: String,
    pub input: u64,
    pub cached: u64,
    pub output: u64,
    pub tokens: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub points: Vec<UsagePoint>,
    pub recent: Vec<UsageTurn>,
    /// Session files that contributed at least one call.
    pub sessions: u32,
    /// Session files read, including the ones with no calls in them.
    pub scanned: u32,
    pub first: Option<String>,
    pub last: Option<String>,
    /// Empty when the engine has never written a transcript.
    pub source: String,
    /// The words the user actually typed, newest last, stripped of engine-injected context.
    /// Kept as raw text so the client can segment it with the OS locale instead of shipping a
    /// Chinese dictionary inside the binary.
    pub prompts: Vec<String>,
    /// Unix epoch millis when this snapshot was aggregated. 0 means no snapshot exists yet.
    /// Read from the cache file's mtime, so old caches stay readable without a schema bump.
    #[serde(default)]
    pub updated_at: i64,
    /// A background rebuild is in flight: the client shows these numbers immediately and polls
    /// once for the fresh ones instead of blocking the window on a 73 MiB transcript walk.
    #[serde(default)]
    pub pending: bool,
}

/// How many calls the request table can show. The page pages through these client-side and now lets
/// the reader pick any date range, so the buffer has to reach past the first screen: 400 rows would
/// make an older range look empty rather than old. 2000 calls is roughly 200 KB of JSON — cheap on a
/// local channel, and still a hard stop against shipping a decade of transcripts.
const RECENT_LIMIT: usize = 2000;
/// Word-cloud input. One line of context per prompt is plenty: long pasted documents would drown
/// out the short questions the cloud is meant to summarise.
const PROMPT_LIMIT: usize = 1200;
const PROMPT_CHARS: usize = 400;

fn codex_home() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("CODEX_HOME") {
        if !value.trim().is_empty() {
            return Ok(PathBuf::from(value));
        }
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".codex"))
}

fn sessions_dir() -> Result<PathBuf, String> {
    Ok(codex_home()?.join("sessions"))
}

/// Bumped to v2 when `UsagePoint` gained its `hour` field: the old cache would fail to
/// deserialize (missing field) and be rebuilt anyway, but a distinct name keeps the stale file
/// from being read at all.
fn cache_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".alwith").join("usage").join("cache-v3.json"))
}

/// Every `*.jsonl` under `sessions/`: year/month/day directories, so three levels is the whole tree.
fn rollout_files(directory: &Path) -> Vec<PathBuf> {
    fn walk(directory: &Path, depth: usize, found: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(directory) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth > 0 {
                    walk(&path, depth - 1, found);
                }
            } else if path.extension().is_some_and(|extension| extension == "jsonl") {
                found.push(path);
            }
        }
    }
    let mut found = Vec::new();
    walk(directory, 3, &mut found);
    found.sort();
    found
}

/// Cheap identity of the transcript set: a session file only changes by growing or being rewritten,
/// so (path, mtime, length) of every file answers "is the cache still right?".
fn fingerprint(files: &[PathBuf]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for path in files {
        path.hash(&mut hasher);
        if let Ok(metadata) = std::fs::metadata(path) {
            metadata.len().hash(&mut hasher);
            if let Ok(modified) = metadata.modified() {
                modified.hash(&mut hasher);
            }
        }
    }
    hasher.finish()
}

fn text(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key).and_then(|item| item.as_str()).map(str::to_string)
}

fn number(value: &serde_json::Value, key: &str) -> u64 {
    value.get(key).and_then(serde_json::Value::as_u64).unwrap_or(0)
}

/// `kimi/kimi-k2.6` names a provider and a model; a bare name comes from the account's own engine.
fn split_model(raw: &str) -> (String, String) {
    match raw.split_once('/') {
        Some((provider, model)) if !provider.is_empty() && !model.is_empty() => {
            (provider.to_string(), model.to_string())
        }
        _ => ("codex".to_string(), raw.to_string()),
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

/// Remove `<tag>…</tag>` blocks wholesale. The engine prepends an `<environment_context>` block
/// (cwd, shell, date, injected instructions) to the first user message of every turn; counting
/// those words would make the cloud about the app's own prompts instead of the user's questions.
fn strip_xml_blocks(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    loop {
        let Some(start) = rest.find('<') else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        let Some(gt) = rest[start..].find('>') else { break };
        let tag = &rest[start + 1..start + gt];
        let after = &rest[start + gt + 1..];
        let name = tag.trim_start_matches('/').split_whitespace().next().unwrap_or("");
        if name.is_empty() || tag.starts_with('/') || tag.ends_with('/') || tag.starts_with('!') {
            rest = after;
            continue;
        }
        let close = format!("</{name}>");
        match after.find(&close) {
            Some(end) => rest = &after[end + close.len()..],
            None => rest = after,
        }
    }
    out
}

/// One user message, from either the engine's `user_message` event or a `response_item` with
/// `role: user`. Developer/system messages and everything inside injected blocks are excluded.
fn prompt_text(record: &serde_json::Value) -> Option<String> {
    let payload = record.get("payload")?;
    let mut raw = String::new();
    match payload.get("type").and_then(|kind| kind.as_str()) {
        Some("user_message") => raw = payload.get("message")?.as_str()?.to_string(),
        Some("message") if payload.get("role").and_then(|role| role.as_str()) == Some("user") => {
            for part in payload.get("content")?.as_array()? {
                if part.get("type").and_then(|kind| kind.as_str()) != Some("input_text") {
                    continue;
                }
                if let Some(text) = part.get("text").and_then(|value| value.as_str()) {
                    if !raw.is_empty() {
                        raw.push('\n');
                    }
                    raw.push_str(text);
                }
            }
        }
        _ => return None,
    }
    clean_prompt(&raw)
}

/// Keep only lines the user typed. The app prepends a `【当前预览文档】` header, an absolute path and
/// a parenthetical explanation when a document is open; the approval gate records its own English
/// review prompt as a user message. All of those are furniture, not questions.
fn clean_prompt(raw: &str) -> Option<String> {
    let stripped = strip_xml_blocks(raw);
    let mut kept: Vec<&str> = Vec::new();
    for line in stripped.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('【')
            || line.starts_with('（')
            || line.starts_with('/')
            || line.starts_with('~')
            || line.starts_with('\\')
        {
            continue;
        }
        if line.contains("The following is the Codex agent history")
            || line.contains("Treat the transcript, tool call arguments")
            || line.starts_with(">>> TRANSCRIPT")
        {
            return None;
        }
        kept.push(line);
    }
    let joined = kept.join("\n");
    let trimmed = joined.trim();
    if trimmed.chars().count() < 2 {
        return None;
    }
    Some(trimmed.chars().take(PROMPT_CHARS).collect())
}

/// A `token_count` record repeats the same numbers several times per turn (the engine emits one
/// after every tool call). They are distinct calls, so each one counts; but a record whose numbers
/// are byte-identical to the previous one is the same call re-emitted after a resume.
fn parse_file(path: &Path, turns: &mut Vec<UsageTurn>, prompts: &mut Vec<String>) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let mut model = String::new();
    let mut last_signature: Option<(String, u64)> = None;
    let mut contributed = false;
    for line in bytes.split(|byte| *byte == b'\n') {
        if !contains(line, b"token_count")
            && !contains(line, b"turn_context")
            && !contains(line, b"\"role\":\"user\"")
            && !contains(line, b"user_message")
        {
            continue;
        }
        let Ok(record) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(prompt) = prompt_text(&record) {
            prompts.push(prompt);
        }
        match record.get("type").and_then(|kind| kind.as_str()) {
            Some("turn_context") => {
                if let Some(payload) = record.get("payload") {
                    if let Some(name) = text(payload, "model") {
                        model = name;
                    }
                }
            }
            Some("event_msg") => {
                let Some(payload) = record.get("payload") else {
                    continue;
                };
                if payload.get("type").and_then(|kind| kind.as_str()) != Some("token_count") {
                    continue;
                }
                let Some(info) = payload.get("info") else {
                    continue;
                };
                let Some(usage) = info.get("last_token_usage") else {
                    continue;
                };
                let total = number(usage, "total_tokens");
                if total == 0 {
                    continue;
                }
                let at = text(&record, "timestamp").unwrap_or_default();
                if at.is_empty() {
                    continue;
                }
                let signature = (at.clone(), total);
                if last_signature.as_ref() == Some(&signature) {
                    continue;
                }
                last_signature = Some(signature);
                let raw_input = number(usage, "input_tokens");
                let cached = number(usage, "cached_input_tokens");
                let cache_write = number(usage, "cache_write_input_tokens");
                let (provider, name) = split_model(if model.is_empty() { "unknown" } else { &model });
                turns.push(UsageTurn {
                    date: at.get(0..10).unwrap_or(&at).to_string(),
                    at,
                    provider,
                    model: name,
                    input: raw_input.saturating_sub(cached).saturating_sub(cache_write),
                    cached,
                    output: number(usage, "output_tokens"),
                    tokens: total,
                });
                contributed = true;
            }
            _ => {}
        }
    }
    contributed
}

/// `2026-11-03T02:34:56.789Z` → 2. Timestamps without a parseable hour fall back to midnight.
fn hour_of(at: &str) -> u8 {
    at.get(11..13)
        .and_then(|hour| hour.parse::<u8>().ok())
        .filter(|hour| *hour < 24)
        .unwrap_or(0)
}

fn build(directory: &Path) -> UsageReport {
    let files = rollout_files(directory);
    let mut turns = Vec::new();
    let mut prompts = Vec::new();
    let mut sessions = 0;
    for file in &files {
        let before = turns.len();
        if parse_file(file, &mut turns, &mut prompts) && turns.len() > before {
            sessions += 1;
        }
    }
    turns.sort_by(|left, right| right.at.cmp(&left.at));
    if prompts.len() > PROMPT_LIMIT {
        prompts.drain(..prompts.len() - PROMPT_LIMIT);
    }
    summarize(&mut turns, sessions, files.len() as u32, prompts)
}

fn summarize(turns: &mut Vec<UsageTurn>, sessions: u32, scanned: u32, prompts: Vec<String>) -> UsageReport {
    let mut points: BTreeMap<(String, u8, String, String), UsagePoint> = BTreeMap::new();
    for turn in turns.iter() {
        let hour = hour_of(&turn.at);
        let entry = points
            .entry((turn.date.clone(), hour, turn.provider.clone(), turn.model.clone()))
            .or_insert_with(|| UsagePoint {
                date: turn.date.clone(),
                hour,
                provider: turn.provider.clone(),
                model: turn.model.clone(),
                requests: 0,
                input: 0,
                cached: 0,
                output: 0,
                reasoning: 0,
                tokens: 0,
            });
        entry.requests = entry.requests.saturating_add(1);
        entry.input = entry.input.saturating_add(turn.input);
        entry.cached = entry.cached.saturating_add(turn.cached);
        entry.output = entry.output.saturating_add(turn.output);
        entry.tokens = entry.tokens.saturating_add(turn.tokens);
    }
    let first = turns.last().map(|turn| turn.date.clone());
    let last = turns.first().map(|turn| turn.date.clone());
    let recent = turns.iter().take(RECENT_LIMIT).cloned().collect();
    UsageReport {
        points: points.into_values().collect(),
        recent,
        prompts,
        sessions,
        scanned,
        first,
        last,
        source: if scanned == 0 {
            String::new()
        } else {
            directory_label()
        },
        updated_at: 0,
        pending: false,
    }
}

/// Shown under the page title so the numbers are never mistaken for a server-side bill.
fn directory_label() -> String {
    "<CODEX_HOME>/sessions".to_string()
}

/// The ledger is a snapshot, not a live meter. Session transcripts are appended on every agent
/// turn, so fingerprint-only invalidation rebuilt all 88 jsonl (~73 MiB) on every page opening
/// while the app was in use. A 30-minute lifetime keeps the page instant; the refresh button
/// bypasses it when the reader really wants fresh numbers.
const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(30 * 60);

fn cache_is_fresh(modified: std::time::SystemTime, now: std::time::SystemTime) -> bool {
    now.duration_since(modified)
        .is_ok_and(|age| age <= CACHE_TTL)
}

/// One rebuild at a time. The settings window and the refresh button can both ask for fresh
/// numbers; two concurrent 73 MiB walks would also race on the cache's temporary file.
static BUILD_LOCK: Mutex<()> = Mutex::new(());
static REBUILDING: AtomicBool = AtomicBool::new(false);
/// If a rebuild fails (unreadable transcript, missing CODEX_HOME), an expired cache would
/// otherwise trigger another 73 MiB walk on every 2.5 s client poll. Back off for one minute.
static LAST_ATTEMPT_MS: AtomicI64 = AtomicI64::new(0);
const RETRY_COOLDOWN_MS: i64 = 60_000;

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|span| span.as_millis() as i64)
        .unwrap_or(0)
}

fn file_millis(modified: std::time::SystemTime) -> i64 {
    modified
        .duration_since(std::time::UNIX_EPOCH)
        .map(|span| span.as_millis() as i64)
        .unwrap_or(0)
}

/// The whole rebuild, on whichever thread asked for it. The lock makes a background rebuild and
/// an explicit refresh cooperate instead of scanning (and writing) the same ledger twice.
fn rebuild_report() -> Result<UsageReport, String> {
    let _guard = BUILD_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let directory = sessions_dir()?;
    if !directory.is_dir() {
        return Ok(UsageReport::default());
    }
    let fingerprint = fingerprint(&rollout_files(&directory));
    let mut report = build(&directory);
    store_cache(fingerprint, &report);
    report.updated_at = now_millis();
    report.pending = false;
    Ok(report)
}

/// A parser panic must not pin `REBUILDING` forever, which would make the page poll endlessly.
struct RebuildingGuard;
impl Drop for RebuildingGuard {
    fn drop(&mut self) {
        REBUILDING.store(false, Ordering::SeqCst);
    }
}

fn retry_allowed(now: i64, last: i64) -> bool {
    now.saturating_sub(last) >= RETRY_COOLDOWN_MS
}

fn spawn_rebuild() {
    let now = now_millis();
    if !retry_allowed(now, LAST_ATTEMPT_MS.load(Ordering::SeqCst)) {
        return;
    }
    LAST_ATTEMPT_MS.store(now, Ordering::SeqCst);
    if REBUILDING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    std::thread::spawn(|| {
        let _guard = RebuildingGuard;
        let _ = rebuild_report();
    });
}

/// Reads only the cache file — one ~190 KB read, no directory walk, no transcript parsing.
/// An expired or missing snapshot is still returned (stale-while-revalidate) with one background
/// rebuild started, so opening the page never blocks the webview on a 73 MiB scan.
fn usage_report_snapshot() -> Result<UsageReport, String> {
    let path = cache_path()?;
    let modified = std::fs::metadata(&path)
        .ok()
        .and_then(|meta| meta.modified().ok());
    let fresh = modified.is_some_and(|time| cache_is_fresh(time, std::time::SystemTime::now()));
    if !fresh {
        spawn_rebuild();
    }
    let mut report = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CachedReport>(&bytes).ok())
        .map(|cached| cached.report)
        .unwrap_or_default();
    report.updated_at = modified.map(file_millis).unwrap_or(0);
    report.pending = REBUILDING.load(Ordering::SeqCst);
    Ok(report)
}

fn store_cache(fingerprint: u64, report: &UsageReport) {
    let Ok(path) = cache_path() else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let payload = CachedReport {
        fingerprint,
        report: report.clone(),
    };
    let Ok(bytes) = serde_json::to_vec(&payload) else {
        return;
    };
    // Write beside the target and rename, so a crash never leaves a half-written cache behind.
    let temporary = path.with_extension("json.tmp");
    if std::fs::write(&temporary, bytes).is_ok() {
        let _ = std::fs::rename(&temporary, &path);
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct CachedReport {
    fingerprint: u64,
    report: UsageReport,
}

/// Pull a URL's body as plain text for the usage page's price refresh.
///
/// A naive GET fails on several official pricing pages on macOS:
///   * a transparent proxy (fake-IP / TUN mode) can present a certificate the bundled
///     rustls roots do not know, and
///   * pricing pages reject a non-browser user agent.
/// So: send a browser-like UA, follow redirects, and — because the payload is a public
/// price page, never a secret — retry once without certificate verification when the
/// first attempt fails (e.g. on the proxy's certificate).
#[tauri3_specta::command]
pub async fn fetch_text(url: String) -> Result<String, String> {
    // A synchronous command would hold the webview's main thread for up to the 20s timeout.
    // Both callers (the usage page's price refresh and the OpenRouter free-model watch) are
    // background work, so the blocking GET belongs on the blocking pool.
    tauri::async_runtime::spawn_blocking(move || fetch_text_blocking(url))
        .await
        .map_err(|error| error.to_string())?
}

fn fetch_text_blocking(url: String) -> Result<String, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("empty url".to_string());
    }
    fn attempt(url: &str, insecure: bool) -> Result<String, String> {
        let mut builder = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::limited(10));
        if insecure {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let client = builder.build().map_err(|error| error.to_string())?;
        let response = client
            .get(url)
            .header(
                reqwest::header::USER_AGENT,
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            )
            .header(reqwest::header::ACCEPT, "text/html,application/json;q=0.9,*/*;q=0.8")
            .send()
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status()));
        }
        response.text().map_err(|error| error.to_string())
    }
    attempt(&url, false)
        .or_else(|first| attempt(&url, true).map_err(|second| format!("{first}; retried without cert verification: {second}")))
}

/// Reads the last snapshot. The numbers are a 30-minute snapshot, not a live meter: an expired
/// cache is returned right away and refreshed in the background. Both commands run on the blocking
/// pool, so even a forced rebuild can never freeze the webview's main thread.
#[tauri3_specta::command]
pub async fn usage_report() -> Result<UsageReport, String> {
    tauri::async_runtime::spawn_blocking(usage_report_snapshot)
        .await
        .map_err(|error| error.to_string())?
}

/// The refresh button deliberately rebuilds even inside the snapshot lifetime.
#[tauri3_specta::command]
pub async fn usage_report_refresh() -> Result<UsageReport, String> {
    tauri::async_runtime::spawn_blocking(rebuild_report)
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_ttl_is_thirty_minutes_and_rejects_clock_skew() {
        let now = std::time::SystemTime::now();
        assert!(cache_is_fresh(now - std::time::Duration::from_secs(29 * 60), now));
        assert!(!cache_is_fresh(now - std::time::Duration::from_secs(31 * 60), now));
        // A clock that moved backwards must not pin a stale cache forever.
        assert!(!cache_is_fresh(now + std::time::Duration::from_secs(60), now));
    }

    #[test]
    fn failed_rebuilds_back_off_instead_of_rescanning_every_poll() {
        let now = 1_800_000_000_000;
        assert!(retry_allowed(now, 0));
        assert!(!retry_allowed(now + 2_500, now));
        assert!(retry_allowed(now + RETRY_COOLDOWN_MS, now));
        // A clock that jumps backwards must not wedge the ledger either way.
        assert!(!retry_allowed(now - 1_000, now));
    }

    #[test]
    fn a_cache_written_before_snapshot_fields_still_loads() {
        // Users upgrading with an existing cache-v3.json must not see an empty page for the few
        // seconds the background rebuild takes. Both new fields default.
        let legacy = r#"{"fingerprint":7,"report":{"points":[],"recent":[],"sessions":0,"scanned":0,"first":null,"last":null,"source":"","prompts":[]}}"#;
        let cached: CachedReport = serde_json::from_str(legacy).expect("legacy cache");
        assert_eq!(cached.fingerprint, 7);
        assert_eq!(cached.report.updated_at, 0);
        assert!(!cached.report.pending);
    }

    fn write_session(directory: &Path, name: &str, lines: &[&str]) {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(directory.join(name), lines.join("\n")).unwrap();
    }

    fn turn_context(model: &str) -> String {
        format!(r#"{{"timestamp":"2026-10-14T10:00:00.000Z","type":"turn_context","payload":{{"model":"{model}"}}}}"#)
    }

    fn token_count(timestamp: &str, input: u64, cached: u64, output: u64) -> String {
        // Substitution instead of `format!`: the payload is almost entirely braces, and escaping
        // every one of them hides the shape being tested.
        let template = r#"{"timestamp":"__TS__","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":__IN__,"cached_input_tokens":__CACHED__,"cache_write_input_tokens":0,"output_tokens":__OUT__,"reasoning_output_tokens":0,"total_tokens":__TOTAL__}}}}"#;
        template
            .replace("__TS__", timestamp)
            .replace("__IN__", &input.to_string())
            .replace("__CACHED__", &cached.to_string())
            .replace("__OUT__", &output.to_string())
            .replace("__TOTAL__", &(input + output).to_string())
    }

    #[test]
    fn only_rollout_files_are_read() {
        let root = std::env::temp_dir().join("alwith-usage-walk");
        let _ = std::fs::remove_dir_all(&root);
        write_session(&root.join("2026/10/14"), "rollout-a.jsonl", &[]);
        write_session(&root.join("2026/10/14"), "notes.txt", &["nope"]);
        let files = rollout_files(&root);
        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("rollout-a.jsonl"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cached_tokens_are_not_billed_as_input() {
        let root = std::env::temp_dir().join("alwith-usage-input");
        let _ = std::fs::remove_dir_all(&root);
        let context = turn_context("kimi/kimi-k2.6");
        let count = token_count("2026-10-14T10:00:05.000Z", 1000, 900, 50);
        write_session(&root.join("2026/10/14"), "rollout-a.jsonl", &[&context, &count]);
        let report = build(&root);
        assert_eq!(report.points.len(), 1);
        let point = &report.points[0];
        assert_eq!(point.provider, "kimi");
        assert_eq!(point.model, "kimi-k2.6");
        assert_eq!(point.input, 100);
        assert_eq!(point.cached, 900);
        assert_eq!(point.output, 50);
        assert_eq!(point.requests, 1);
        assert_eq!(report.sessions, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_compacted_counter_does_not_shrink_the_total() {
        // The second record repeats a smaller `total_token_usage`; only the per-call deltas matter.
        let root = std::env::temp_dir().join("alwith-usage-compaction");
        let _ = std::fs::remove_dir_all(&root);
        let context = turn_context("gpt-6-luna");
        let first = token_count("2026-10-14T10:00:05.000Z", 1000, 0, 100);
        let second = token_count("2026-10-14T10:01:05.000Z", 2000, 0, 200);
        write_session(&root.join("2026/10/14"), "rollout-a.jsonl", &[&context, &first, &second]);
        let report = build(&root);
        let point = &report.points[0];
        assert_eq!(point.requests, 2);
        assert_eq!(point.tokens, 1100 + 2200);
        assert_eq!(report.first.as_deref(), Some("2026-10-14"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_same_record_emitted_twice_counts_once() {
        let root = std::env::temp_dir().join("alwith-usage-dedup");
        let _ = std::fs::remove_dir_all(&root);
        let context = turn_context("deepseek-flash");
        let count = token_count("2026-10-14T10:00:05.000Z", 10, 0, 5);
        write_session(
            &root.join("2026/10/14"),
            "rollout-a.jsonl",
            &[&context, &count, &count],
        );
        let report = build(&root);
        assert_eq!(report.points[0].requests, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bare_model_name_belongs_to_the_account_engine() {
        assert_eq!(
            split_model("gpt-6.1-sol"),
            ("codex".to_string(), "gpt-6.1-sol".to_string())
        );
        assert_eq!(
            split_model("hakimi/claude-sonnet-5-5"),
            ("hakimi".to_string(), "claude-sonnet-5-5".to_string())
        );
    }

    #[test]
    fn a_missing_sessions_directory_is_an_empty_report() {
        let root = std::env::temp_dir().join("alwith-usage-missing");
        let _ = std::fs::remove_dir_all(&root);
        let report = build(&root);
        assert!(report.points.is_empty());
        assert!(report.recent.is_empty());
        assert_eq!(report.scanned, 0);
        assert!(report.prompts.is_empty());
    }

    #[test]
    fn prompts_keep_the_question_and_drop_injected_context() {
        // The engine prepends this block to the first user message of a turn; counting its words
        // would make the cloud describe the app's prompt instead of the user's question.
        let record = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "<environment_context>\n  <cwd>/tmp/project</cwd>\n</environment_context>\n帮我看看模型价格"
                }]
            }
        });
        assert_eq!(prompt_text(&record).as_deref(), Some("帮我看看模型价格"));

        let developer = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "developer",
                "content": [{ "type": "input_text", "text": "system instructions" }]
            }
        });
        assert_eq!(prompt_text(&developer), None);

        let event = serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "user_message", "message": "  用量页怎么又空了  " }
        });
        assert_eq!(prompt_text(&event).as_deref(), Some("用量页怎么又空了"));
    }
}
