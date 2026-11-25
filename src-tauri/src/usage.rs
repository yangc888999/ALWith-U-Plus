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
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

/// One row of the pre-aggregated table: an hour, a provider and a model.
///
/// Hour granularity exists for time-of-day pricing (DeepSeek bills weekday peak and off-peak
/// rates); charts aggregate these rows back up by day. `hour` is the UTC hour of `date`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UsagePoint {
    #[serde(default = "default_client_source")]
    pub client_source: String,
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
    #[serde(default = "default_client_source")]
    pub client_source: String,
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

fn default_client_source() -> String {
    "alwith_l".to_string()
}

fn codex_home() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("CODEX_HOME")
        && !value.trim().is_empty()
    {
        return Ok(PathBuf::from(value));
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
                if let Some(payload) = record.get("payload")
                    && let Some(name) = text(payload, "model")
                {
                    model = name;
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
                    client_source: default_client_source(),
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
    at.get(11..13).and_then(|hour| hour.parse::<u8>().ok()).filter(|hour| *hour < 24).unwrap_or(0)
}

/// One transcript's parsed result, kept beside the identity that produced it.
///
/// A rollout only ever grows, so (length, mtime) answers "did this file change?" without reading
/// it. That is what makes the refresh button incremental: a 70 MiB ledger with one new turn
/// re-parses one file instead of every session on disk.
#[derive(Clone)]
struct ParsedFile {
    len: u64,
    modified: std::time::SystemTime,
    turns: Vec<UsageTurn>,
    prompts: Vec<String>,
    contributed: bool,
}

static PARSED_FILES: Mutex<Option<BTreeMap<PathBuf, ParsedFile>>> = Mutex::new(None);

/// Parses a transcript, reusing the previous result when the file is byte-for-byte the same size
/// and mtime. Entries for files that disappeared are dropped so the cache cannot grow forever.
fn parse_file_cached(path: &Path, turns: &mut Vec<UsageTurn>, prompts: &mut Vec<String>) -> bool {
    let identity =
        std::fs::metadata(path).ok().and_then(|meta| meta.modified().ok().map(|modified| (meta.len(), modified)));
    if let Some((len, modified)) = identity {
        let mut guard = PARSED_FILES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let cache = guard.get_or_insert_with(BTreeMap::new);
        if let Some(hit) = cache.get(path)
            && hit.len == len
            && hit.modified == modified
        {
            let contributed = hit.contributed;
            turns.extend(hit.turns.iter().cloned());
            prompts.extend(hit.prompts.iter().cloned());
            return contributed;
        }
        let turns_before = turns.len();
        let prompts_before = prompts.len();
        let contributed = parse_file(path, turns, prompts);
        cache.insert(
            path.to_path_buf(),
            ParsedFile {
                len,
                modified,
                turns: turns[turns_before..].to_vec(),
                // Only this file's prompts: cloning the whole accumulator would replay every
                // earlier session's words on each cache hit and blow past PROMPT_LIMIT.
                prompts: prompts[prompts_before..].to_vec(),
                contributed,
            },
        );
        return contributed;
    }
    parse_file(path, turns, prompts)
}

/// `$HOME/.alwith/usage/external.jsonl` — the append-only external-call ledger.
///
/// This is the single source of truth for the ledger path on the Rust side. The writer is an
/// external proxy script (not another module in this crate): it appends one camelCase JSON object
/// per line. Keeping the path here makes `usage.rs` self-contained — it compiles and its tests
/// run without any other Rust module having landed.
fn external_ledger_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".alwith").join("usage").join("external.jsonl"))
}

/// One line of the external ledger, as written by the external proxy script.
///
/// Field names are camelCase on the wire (`requestId`, `usageKnown`, …). The fields are private
/// by design: this type is only a deserialization target for the reader, never exported to the
/// frontend. `requestId` and `reasoning` are not surfaced in `UsageTurn`, but they are declared
/// so a row missing them is rejected as malformed instead of being silently reinterpreted.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
// Both fields are part of the wire contract but are deliberately not surfaced in `UsageTurn`.
#[allow(dead_code)]
struct ExternalLedgerRecord {
    request_id: String,
    client: String,
    provider: String,
    model: String,
    at: String,
    input: u64,
    cached: u64,
    output: u64,
    reasoning: u64,
    total: u64,
    usage_known: bool,
}

/// Reads the append-only external call ledger (`external.jsonl`) into the same `UsageTurn` shape
/// the rollout transcripts use.
///
/// The ledger is shared with other clients that call this app's proxy, so its rows are *external*
/// by definition: `client` is kept verbatim as `client_source` (never the internal `alwith_l`
/// marker). The file is appended to by a different writer, and an interrupted append can leave a
/// partial line, so every row is parsed independently and any bad row is skipped instead of
/// failing the whole usage report.
fn read_external_turns(path: &Path) -> Vec<UsageTurn> {
    let mut turns = Vec::new();
    // A ledger that does not exist yet simply has no external calls.
    let Ok(bytes) = std::fs::read(path) else {
        return turns;
    };
    for raw in bytes.split(|byte| *byte == b'\n') {
        let Ok(line) = std::str::from_utf8(raw) else {
            continue;
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Skip half-written appends, malformed JSON and rows missing required fields.
        let Ok(record) = serde_json::from_str::<ExternalLedgerRecord>(line) else {
            continue;
        };
        // `date` is the UTC day prefix, the exact `YYYY-MM-DD` slice rollout turns use. A short
        // or malformed timestamp cannot be placed in a bucket, so drop that row.
        let Some(day) = record.at.get(0..10) else {
            continue;
        };
        let date = day.to_string();
        // Guard against an external call being mislabelled as an internal engine turn: an empty
        // client or the internal marker is normalised to `other_agent`.
        let client_source = if record.client.is_empty() || record.client == "alwith_l" {
            "other_agent".to_string()
        } else {
            record.client.clone()
        };
        // When the upstream response exposed no usage, still count the request but never invent
        // tokens: all four token columns stay zero. Otherwise honour `total`, falling back to the
        // sum of the components when a writer left it at zero.
        let (input, cached, output, tokens) = if record.usage_known {
            let fallback = record.input.saturating_add(record.cached).saturating_add(record.output);
            let tokens = if record.total == 0 { fallback } else { record.total };
            (record.input, record.cached, record.output, tokens)
        } else {
            (0, 0, 0, 0)
        };
        // `UsageTurn` has no `reasoning` column (and no `request_id`); both are intentionally
        // dropped here. Only `UsagePoint` carries `reasoning`, and it stays at its default zero.
        turns.push(UsageTurn {
            client_source,
            at: record.at,
            date,
            provider: record.provider,
            model: record.model,
            input,
            cached,
            output,
            tokens,
        });
    }
    turns
}

fn build(directory: &Path, external: &Path) -> UsageReport {
    let files = rollout_files(directory);
    // Forget transcripts that were deleted or rotated away; everything still present is either
    // reused or re-parsed below.
    {
        let mut guard = PARSED_FILES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(cache) = guard.as_mut() {
            let live: std::collections::BTreeSet<&PathBuf> = files.iter().collect();
            cache.retain(|path, _| live.contains(path));
        }
    }
    let mut turns = Vec::new();
    let mut prompts = Vec::new();
    let mut sessions = 0;
    for file in &files {
        let before = turns.len();
        if parse_file_cached(file, &mut turns, &mut prompts) && turns.len() > before {
            sessions += 1;
        }
    }
    // External proxy calls live in their own append-only ledger, not in the Codex transcripts.
    // Fold them in before sorting so both `recent` and the hourly buckets see one unified,
    // newest-first list. The ledger path is passed explicitly so tests never read the real HOME.
    turns.extend(read_external_turns(external));
    turns.sort_by(|left, right| right.at.cmp(&left.at));
    if prompts.len() > PROMPT_LIMIT {
        prompts.drain(..prompts.len() - PROMPT_LIMIT);
    }
    summarize(&mut turns, sessions, files.len() as u32, prompts)
}

fn summarize(turns: &mut [UsageTurn], sessions: u32, scanned: u32, prompts: Vec<String>) -> UsageReport {
    // `client_source` is part of the key. An internal engine turn and an external proxy call can
    // share the same (date, hour, provider, model); the old 4-tuple key merged them and let one
    // bucket's first turn label every request in it, which made the 内部/外部 filter wrong. One
    // bucket per source keeps the two from ever bleeding into each other.
    let mut points: BTreeMap<(String, u8, String, String, String), UsagePoint> = BTreeMap::new();
    for turn in turns.iter() {
        let hour = hour_of(&turn.at);
        let entry = points
            .entry((turn.date.clone(), hour, turn.provider.clone(), turn.model.clone(), turn.client_source.clone()))
            .or_insert_with(|| UsagePoint {
                client_source: turn.client_source.clone(),
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
        source: if scanned == 0 { String::new() } else { directory_label() },
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
    now.duration_since(modified).is_ok_and(|age| age <= CACHE_TTL)
}

/// Length of the append-only external ledger, or 0 when it does not exist yet.
/// One `stat` only: opening the usage page must never walk the ~73 MiB session tree.
fn external_ledger_len() -> u64 {
    external_ledger_path().ok().and_then(|path| std::fs::metadata(path).ok()).map(|meta| meta.len()).unwrap_or(0)
}

/// The snapshot is stale when its 30-minute lifetime expired **or** the external ledger grew
/// since the snapshot was written. The second check is what makes a fresh WorkBuddy call show up
/// without waiting for the TTL or pressing refresh: `CachedReport.fingerprint` alone cannot do
/// that, because the snapshot reader never compares it. Kept pure so the rule is testable.
fn snapshot_needs_rebuild(
    cache_mtime: Option<std::time::SystemTime>, now: std::time::SystemTime, cached_ledger_len: u64,
    current_ledger_len: u64,
) -> bool {
    let expired = !cache_mtime.is_some_and(|time| cache_is_fresh(time, now));
    expired || cached_ledger_len != current_ledger_len
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
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|span| span.as_millis() as i64).unwrap_or(0)
}

fn file_millis(modified: std::time::SystemTime) -> i64 {
    modified.duration_since(std::time::UNIX_EPOCH).map(|span| span.as_millis() as i64).unwrap_or(0)
}

/// The whole rebuild, on whichever thread asked for it. The lock makes a background rebuild and
/// an explicit refresh cooperate instead of scanning (and writing) the same ledger twice.
fn rebuild_report() -> Result<UsageReport, String> {
    let _guard = BUILD_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let directory = sessions_dir()?;
    if !directory.is_dir() {
        return Ok(UsageReport::default());
    }
    // The external ledger is an input to the report, so its (path, length, mtime) must take part
    // in the fingerprint: appending a row then invalidates the cache and forces a rebuild. Keep
    // the ledger OUT of `rollout_files` (that walk is Codex sessions only) and add it here.
    let external = external_ledger_path()?;
    let mut files = rollout_files(&directory);
    files.push(external.clone());
    let fingerprint = fingerprint(&files);
    let mut report = build(&directory, &external);
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
    if REBUILDING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
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
    let modified = std::fs::metadata(&path).ok().and_then(|meta| meta.modified().ok());
    let mut report = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<CachedReport>(&bytes).ok())
        .map(|cached| {
            // A cache written before this field existed carries 0, so the first read after the
            // upgrade rebuilds once and then settles — no migration, no version bump.
            if snapshot_needs_rebuild(
                modified,
                std::time::SystemTime::now(),
                cached.external_ledger_len,
                external_ledger_len(),
            ) {
                spawn_rebuild();
            }
            cached.report
        })
        .unwrap_or_else(|| {
            spawn_rebuild();
            UsageReport::default()
        });
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
    let payload = CachedReport { fingerprint, external_ledger_len: external_ledger_len(), report: report.clone() };
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
    /// Byte length of the external ledger when this snapshot was built. `default` keeps caches
    /// written before the field existed readable; their first read triggers one rebuild.
    #[serde(default)]
    external_ledger_len: u64,
    report: UsageReport,
}

/// Pull a URL's body as plain text for the usage page's price refresh.
///
/// A naive GET fails on several official pricing pages on macOS: pricing pages reject a
/// non-browser user agent, and a transparent proxy can present a certificate the bundled roots
/// do not know. So we send a browser-like UA, follow redirects, and — because the payload is a
/// public price page, never a secret — retry once without certificate verification when the first
/// attempt fails. But the *common* failure is the connection never being made at all (offline,
/// proxy, or firewall block): in that case the cert retry cannot help, and the error must say so
/// rather than point the user at certificates.
#[tauri3_specta::command]
pub async fn fetch_text(url: String) -> Result<String, String> {
    // A synchronous command would hold the webview's main thread for up to the 20s timeout.
    // Both callers (the usage page's price refresh and the OpenRouter free-model watch) are
    // background work, so the blocking GET belongs on the blocking pool.
    tauri::async_runtime::spawn_blocking(move || fetch_text_blocking(url)).await.map_err(|error| error.to_string())?
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
    let first = attempt(&url, false);
    match first {
        Ok(body) => Ok(body),
        Err(first_msg) => match attempt(&url, true) {
            Ok(body) => Ok(body),
            Err(second_msg) => {
                // Most failures here are not a TLS trust problem: a proxy, offline link, or firewall
                // block makes the connection itself fail, so retrying without cert verification cannot
                // help. Diagnose that instead of pointing the user at certificates.
                let diagnosis = if is_tls_error(&first_msg) {
                    "首次请求因证书校验失败，但跳过证书校验后重试仍然失败"
                } else {
                    "网络不可达（多为离线、代理或防火墙拦截），跳过证书校验重试也无法连接"
                };
                Err(format!("无法拉取 {url}：{diagnosis}。首次：{first_msg}；重试：{second_msg}"))
            }
        },
    }
}

/// True when the error reads like a TLS/certificate trust failure rather than a plain connection
/// failure — only then is the cert-verification retry actually relevant to the diagnosis.
fn is_tls_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("certificate") || lower.contains("tls") || lower.contains("ssl") || lower.contains("cert verify")
}

/// Reads the last snapshot. The numbers are a 30-minute snapshot, not a live meter: an expired
/// cache is returned right away and refreshed in the background. Both commands run on the blocking
/// pool, so even a forced rebuild can never freeze the webview's main thread.
#[tauri3_specta::command]
pub async fn usage_report() -> Result<UsageReport, String> {
    tauri::async_runtime::spawn_blocking(usage_report_snapshot).await.map_err(|error| error.to_string())?
}

/// The refresh button deliberately rebuilds even inside the snapshot lifetime.
#[tauri3_specta::command]
pub async fn usage_report_refresh() -> Result<UsageReport, String> {
    tauri::async_runtime::spawn_blocking(rebuild_report).await.map_err(|error| error.to_string())?
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

    #[test]
    fn an_unchanged_transcript_is_reused_and_a_grown_one_is_reparsed() {
        // The refresh button must be incremental: with one new turn on disk only that file is
        // parsed again, and the reused file contributes exactly its own turns and prompts.
        let root = tempfile::tempdir().unwrap();
        let directory = root.path();
        let token = |at: &str, total: u64| {
            format!(
                r#"{{"type":"event_msg","timestamp":"{at}","payload":{{"type":"token_count","info":{{"last_token_usage":{{"total_tokens":{total},"input_tokens":{total},"output_tokens":0}}}}}}}}"#
            )
        };
        let first = directory.join("rollout-a.jsonl");
        std::fs::write(&first, token("2026-11-13T01:00:00.000Z", 10)).unwrap();
        let mut turns = Vec::new();
        let mut prompts = vec!["carried over".to_string()];
        assert!(parse_file_cached(&first, &mut turns, &mut prompts));
        assert_eq!(turns.len(), 1);
        // The cache must hold only this file's prompts, not the accumulator it was handed.
        {
            let guard = PARSED_FILES.lock().unwrap();
            let entry = guard.as_ref().unwrap().get(&first).unwrap();
            assert!(entry.prompts.is_empty(), "a cache hit must not replay earlier prompts");
        }

        // Same bytes → reused, and the prompt accumulator is not duplicated.
        let mut second_turns = Vec::new();
        let mut second_prompts = Vec::new();
        assert!(parse_file_cached(&first, &mut second_turns, &mut second_prompts));
        assert_eq!(second_turns.len(), 1);
        assert!(second_prompts.is_empty());

        // A grown file is re-parsed: two calls now, not the stale one.
        std::fs::write(
            &first,
            format!("{}\n{}", token("2026-11-13T01:00:00.000Z", 10), token("2026-11-13T02:00:00.000Z", 20)),
        )
        .unwrap();
        let mut grown = Vec::new();
        let mut grown_prompts = Vec::new();
        assert!(parse_file_cached(&first, &mut grown, &mut grown_prompts));
        assert_eq!(grown.len(), 2);
        {
            let mut guard = PARSED_FILES.lock().unwrap();
            if let Some(cache) = guard.as_mut() {
                cache.remove(&first);
            }
        }
    }

    fn write_session(directory: &Path, name: &str, lines: &[&str]) {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(directory.join(name), lines.join("\n")).unwrap();
    }

    /// Unique temp directory for the tests that build a report from a rollout tree.
    ///
    /// These used to be fixed paths (`/tmp/alwith-usage-dedup`, …). Two concurrent
    /// `cargo test` processes then raced: one could `remove_dir_all` the directory the
    /// other had just written, which surfaced as `report.points[0]` index out of bounds.
    /// The process id keeps processes apart, the atomic counter keeps repeated calls
    /// inside one process apart, and the label keeps each test's directory readable.
    /// No new dependency is introduced (`tempfile` stays for the tests already using it).
    fn unique_temp_dir(label: &str) -> PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("alwith-usage-{label}-{}-{seq}", std::process::id()))
    }

    /// `build` takes the ledger path explicitly, so a test can point at a temp dir and never
    /// touch the real `$HOME` ledger. Deliberately left uncreated: `read_external_turns` treats
    /// a missing file as an empty one, which is what these rollout-only tests want.
    fn empty_ledger(root: &Path) -> PathBuf {
        root.join("external.jsonl")
    }

    /// One row of the external ledger, in the camelCase wire format `ExternalLedgerRecord`
    /// deserializes. Written as raw JSON (not via the struct) so these tests describe the file
    /// contract of the reader rather than depending on how the writer constructs its values.
    #[allow(clippy::too_many_arguments)]
    fn external_row(
        request_id: &str, client: &str, provider: &str, model: &str, at: &str, input: u64, cached: u64, output: u64,
        total: u64, usage_known: bool,
    ) -> String {
        serde_json::json!({
            "requestId": request_id,
            "client": client,
            "provider": provider,
            "model": model,
            "at": at,
            "input": input,
            "cached": cached,
            "output": output,
            "reasoning": 0,
            "total": total,
            "usageKnown": usage_known,
        })
        .to_string()
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
        let root = unique_temp_dir("walk");
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
        let root = unique_temp_dir("input");
        let _ = std::fs::remove_dir_all(&root);
        let context = turn_context("kimi/kimi-k2.6");
        let count = token_count("2026-10-14T10:00:05.000Z", 1000, 900, 50);
        write_session(&root.join("2026/10/14"), "rollout-a.jsonl", &[&context, &count]);
        let report = build(&root, &empty_ledger(&root));
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
        let root = unique_temp_dir("compaction");
        let _ = std::fs::remove_dir_all(&root);
        let context = turn_context("gpt-6-luna");
        let first = token_count("2026-10-14T10:00:05.000Z", 1000, 0, 100);
        let second = token_count("2026-10-14T10:01:05.000Z", 2000, 0, 200);
        write_session(&root.join("2026/10/14"), "rollout-a.jsonl", &[&context, &first, &second]);
        let report = build(&root, &empty_ledger(&root));
        let point = &report.points[0];
        assert_eq!(point.requests, 2);
        assert_eq!(point.tokens, 1100 + 2200);
        assert_eq!(report.first.as_deref(), Some("2026-10-14"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_same_record_emitted_twice_counts_once() {
        let root = unique_temp_dir("dedup");
        let _ = std::fs::remove_dir_all(&root);
        let context = turn_context("deepseek-flash");
        let count = token_count("2026-10-14T10:00:05.000Z", 10, 0, 5);
        write_session(&root.join("2026/10/14"), "rollout-a.jsonl", &[&context, &count, &count]);
        let report = build(&root, &empty_ledger(&root));
        assert_eq!(report.points[0].requests, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_bare_model_name_belongs_to_the_account_engine() {
        assert_eq!(split_model("gpt-6.1-sol"), ("codex".to_string(), "gpt-6.1-sol".to_string()));
        assert_eq!(split_model("hakimi/claude-sonnet-5-5"), ("hakimi".to_string(), "claude-sonnet-5-5".to_string()));
    }

    #[test]
    fn a_missing_sessions_directory_is_an_empty_report() {
        let root = unique_temp_dir("missing");
        let _ = std::fs::remove_dir_all(&root);
        let report = build(&root, &empty_ledger(&root));
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

    #[test]
    fn a_missing_external_ledger_is_an_empty_set_of_turns() {
        let root = tempfile::tempdir().unwrap();
        assert!(read_external_turns(&root.path().join("never-written.jsonl")).is_empty());
    }

    #[test]
    fn an_external_ledger_row_becomes_a_point_and_a_recent_turn() {
        let root = tempfile::tempdir().unwrap();
        let sessions = root.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let ledger = root.path().join("external.jsonl");
        std::fs::write(
            &ledger,
            external_row(
                "req-1",
                "workbuddy",
                "acme",
                "acme/gpt-x",
                "2026-11-15T03:11:05.000Z",
                120,
                30,
                50,
                200,
                true,
            ),
        )
        .unwrap();

        let report = build(&sessions, &ledger);
        assert_eq!(report.points.len(), 1, "one external call → one bucket");
        let point = &report.points[0];
        assert_eq!(point.client_source, "workbuddy", "clientSource must be the ledger client");
        assert_eq!(point.date, "2026-11-15");
        assert_eq!(point.hour, 3);
        assert_eq!(point.provider, "acme");
        assert_eq!(point.model, "acme/gpt-x");
        assert_eq!(point.requests, 1);
        assert_eq!(point.input, 120);
        assert_eq!(point.cached, 30);
        assert_eq!(point.output, 50);
        assert_eq!(point.tokens, 200);

        // The same row is also the request table's only entry, still tagged as external.
        assert_eq!(report.recent.len(), 1);
        assert_eq!(report.recent[0].client_source, "workbuddy");
        assert_eq!(report.recent[0].tokens, 200);
        assert_eq!(report.recent[0].at, "2026-11-15T03:11:05.000Z");
        assert_eq!(report.recent[0].date, "2026-11-15");
    }

    #[test]
    fn a_row_with_unknown_usage_counts_the_request_but_has_zero_tokens() {
        let root = tempfile::tempdir().unwrap();
        let sessions = root.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let ledger = root.path().join("external.jsonl");
        // Non-zero numbers in the row must NOT leak through when usageKnown is false.
        std::fs::write(
            &ledger,
            external_row(
                "req-2",
                "qwen_office",
                "acme",
                "acme/gpt-x",
                "2026-11-15T03:11:05.000Z",
                999,
                888,
                777,
                2664,
                false,
            ),
        )
        .unwrap();

        let report = build(&sessions, &ledger);
        assert_eq!(report.recent.len(), 1, "the request still produces a turn");
        let turn = &report.recent[0];
        assert_eq!(turn.client_source, "qwen_office");
        assert_eq!(turn.input, 0);
        assert_eq!(turn.cached, 0);
        assert_eq!(turn.output, 0);
        assert_eq!(turn.tokens, 0);

        assert_eq!(report.points.len(), 1);
        let point = &report.points[0];
        assert_eq!(point.requests, 1, "the request count must not be lost");
        assert_eq!(point.input, 0);
        assert_eq!(point.cached, 0);
        assert_eq!(point.output, 0);
        assert_eq!(point.tokens, 0);
    }

    #[test]
    fn malformed_ledger_rows_are_skipped_without_losing_the_good_ones() {
        let root = tempfile::tempdir().unwrap();
        let sessions = root.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let ledger = root.path().join("external.jsonl");
        let good =
            external_row("req-good", "workbuddy", "acme", "acme/gpt-x", "2026-11-15T03:11:05.000Z", 10, 0, 5, 15, true);
        // A row missing required fields, a half-written append, plain garbage, a blank line and
        // a timestamp too short to yield a UTC day prefix. Only `good` may survive.
        let missing_fields = r#"{"requestId":"req-half","client":"workbuddy"}"#;
        let short_at = external_row("req-short", "workbuddy", "acme", "acme/gpt-x", "2026-11", 1, 0, 1, 2, true);
        std::fs::write(
            &ledger,
            format!("not json at all\n{good}\n{{\"requestId\":\"partial\"\n{missing_fields}\n{short_at}\n\n"),
        )
        .unwrap();

        let report = build(&sessions, &ledger);
        assert_eq!(report.recent.len(), 1, "only the well-formed row survives");
        assert_eq!(report.recent[0].at, "2026-11-15T03:11:05.000Z");
        assert_eq!(report.points.len(), 1);
        assert_eq!(report.points[0].requests, 1);
        assert_eq!(report.points[0].tokens, 15);
    }

    #[test]
    fn internal_and_external_turns_never_share_a_bucket() {
        let root = tempfile::tempdir().unwrap();
        let sessions = root.path().join("sessions");
        // Both calls are made identical in every bucket dimension (date, hour, provider, model)
        // and even share the exact `at`. Only `client_source` differs — precisely the case the
        // old 4-tuple key conflated into one bucket labelled by whichever turn came first.
        let context = turn_context("acme/gpt-x");
        let count = token_count("2026-10-14T10:00:05.000Z", 100, 10, 20);
        write_session(&sessions.join("2026/10/14"), "rollout-a.jsonl", &[&context, &count]);

        let ledger = root.path().join("external.jsonl");
        // `model` is deliberately the split model name (`gpt-x`, not `acme/gpt-x`) so the two
        // turns collide on the OLD key; the writer normally stores the full gateway/model name.
        std::fs::write(
            &ledger,
            external_row("req-3", "workbuddy", "acme", "gpt-x", "2026-10-14T10:00:05.000Z", 300, 0, 40, 340, true),
        )
        .unwrap();

        let report = build(&sessions, &ledger);
        assert_eq!(report.points.len(), 2, "internal and external calls must produce two distinct buckets");
        let internal =
            report.points.iter().find(|point| point.client_source == "alwith_l").expect("an internal bucket");
        let external =
            report.points.iter().find(|point| point.client_source == "workbuddy").expect("an external bucket");

        // Neither bucket may absorb the other's numbers.
        assert_eq!(internal.requests, 1);
        assert_eq!(internal.input, 90, "100 - 10 cached - 0 cache_write");
        assert_eq!(internal.tokens, 120, "100 input + 20 output");
        assert_eq!(external.requests, 1);
        assert_eq!(external.input, 300);
        assert_eq!(external.tokens, 340);

        // The request table keeps both rows, each tagged with its own source.
        assert_eq!(report.recent.len(), 2);
        assert!(report.recent.iter().any(|turn| turn.client_source == "alwith_l"));
        assert!(report.recent.iter().any(|turn| turn.client_source == "workbuddy"));
    }

    #[test]
    fn external_rows_normalise_their_source_and_fall_back_for_a_missing_total() {
        let root = tempfile::tempdir().unwrap();
        let ledger = root.path().join("external.jsonl");
        let empty_client = external_row("r1", "", "acme", "acme/gpt-x", "2026-11-15T03:11:05.000Z", 10, 0, 5, 0, true);
        let internal_marker =
            external_row("r2", "alwith_l", "acme", "acme/gpt-x", "2026-11-15T03:11:06.000Z", 20, 0, 7, 0, true);
        std::fs::write(&ledger, format!("{empty_client}\n{internal_marker}")).unwrap();

        let turns = read_external_turns(&ledger);
        assert_eq!(turns.len(), 2);
        assert!(
            turns.iter().all(|turn| turn.client_source == "other_agent"),
            "empty/'alwith_l' clients must never masquerade as internal turns"
        );
        // total == 0 must fall back to input + cached + output rather than report zero tokens.
        assert_eq!(turns[0].tokens, 15);
        assert_eq!(turns[1].tokens, 27);
    }

    #[test]
    fn ledger_creation_and_growth_invalidate_the_cache_fingerprint() {
        let root = tempfile::tempdir().unwrap();
        let sessions = root.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let ledger = root.path().join("external.jsonl");
        // Mirror rebuild_report's exact input list: rollout files plus the ledger path.
        let mut files = rollout_files(&sessions);
        files.push(ledger.clone());

        let missing = fingerprint(&files);
        let first =
            external_row("req-1", "workbuddy", "acme", "acme/gpt-x", "2026-11-15T03:11:05.000Z", 10, 0, 5, 15, true);
        std::fs::write(&ledger, &first).unwrap();
        let created = fingerprint(&files);
        assert_ne!(missing, created, "creating the ledger must invalidate the cache");

        let second =
            external_row("req-2", "workbuddy", "acme", "acme/gpt-x", "2026-11-15T03:12:05.000Z", 20, 0, 6, 26, true);
        std::fs::write(&ledger, format!("{first}\n{second}")).unwrap();
        let grown = fingerprint(&files);
        assert_ne!(created, grown, "appending a row (len/mtime change) must invalidate the cache");
    }

    /// The single ledger row produced by the real chain on this machine:
    /// WorkBuddy → `~/.workbuddy/alwith-proxy.py` (127.0.0.1:18765) → `/alwith/responses`.
    /// Written **verbatim** from the first (and only) line of
    /// `$HOME/.alwith/usage/external.jsonl` — including the writer's spaces after each `:`.
    /// Unlike a synthetic (or re-minified) fixture, this pins the exact bytes that crossed
    /// the Python writer → Rust reader boundary, field names and values included.
    #[test]
    fn a_real_workbuddy_ledger_row_is_read_as_an_external_turn() {
        const REAL_ROW: &str = r#"{"requestId": "resp_08af0c8728f3ee47016af9284b349487d0a03d2824959b808b", "client": "workbuddy", "provider": "chatgpt", "model": "gpt-6-astra", "at": "2026-11-15T03:34:36.650Z", "input": 7, "cached": 0, "output": 5, "reasoning": 0, "total": 12, "usageKnown": true}"#;

        let root = unique_temp_dir("real-contract");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let ledger = root.join("external.jsonl");
        // The real ledger is an append-only JSONL: one row plus its trailing newline.
        std::fs::write(&ledger, format!("{REAL_ROW}\n")).unwrap();
        assert_eq!(
            std::fs::read_to_string(&ledger).unwrap(),
            format!("{REAL_ROW}\n"),
            "the fixture on disk must be byte-for-byte the real sample"
        );

        let turns = read_external_turns(&ledger);
        assert_eq!(turns.len(), 1, "the real row must deserialize into exactly one turn");
        let turn = &turns[0];
        assert_eq!(turn.client_source, "workbuddy", "never folded into the internal alwith_l source");
        assert_eq!(turn.provider, "chatgpt");
        assert_eq!(turn.model, "gpt-6-astra");
        assert_eq!(turn.input, 7);
        assert_eq!(turn.cached, 0);
        assert_eq!(turn.output, 5);
        assert_eq!(turn.tokens, 12);
        assert_eq!(turn.date, "2026-11-15", "UTC day is the first 10 chars of `at`");
        assert_eq!(turn.at, "2026-11-15T03:34:36.650Z", "`at` must be kept verbatim");

        // The request table (not just the hourly bucket) must carry the real row unchanged.
        let sessions = root.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let report = build(&sessions, &ledger);
        assert_eq!(report.recent.len(), 1);
        assert_eq!(report.recent[0].client_source, "workbuddy");
        assert_eq!(report.recent[0].at, "2026-11-15T03:34:36.650Z");
        assert_eq!(report.recent[0].tokens, 12);

        // The hourly bucket must carry the same numbers, keyed by the external client source
        // (the five-part aggregation key keeps it separate from an internal turn).
        assert_eq!(report.points.len(), 1);
        let point = &report.points[0];
        assert_eq!(point.client_source, "workbuddy");
        assert_eq!(point.date, "2026-11-15");
        assert_eq!(point.hour, 3);
        assert_eq!(point.requests, 1);
        assert_eq!(point.input, 7);
        assert_eq!(point.cached, 0);
        assert_eq!(point.output, 5);
        assert_eq!(point.tokens, 12);

        let _ = std::fs::remove_dir_all(&root);
    }
    #[test]
    fn a_fresh_cache_is_invalidated_when_the_external_ledger_grows() {
        let now = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let just_written = now - std::time::Duration::from_secs(5);
        // Inside the 30-minute lifetime and the ledger did not change: keep the fast path.
        assert!(!snapshot_needs_rebuild(Some(just_written), now, 264, 264));
        // One appended row is enough to invalidate even a five-second-old snapshot.
        assert!(snapshot_needs_rebuild(Some(just_written), now, 264, 528));
        // An expired cache rebuilds regardless of the ledger, and a missing cache rebuilds too.
        let expired = now - std::time::Duration::from_secs(31 * 60);
        assert!(snapshot_needs_rebuild(Some(expired), now, 264, 264));
        assert!(snapshot_needs_rebuild(None, now, 0, 0));
    }
}
