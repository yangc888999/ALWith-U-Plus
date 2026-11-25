//! Provider quota / balance snapshots (OpenRouter credits, New API token quota, local usage).
//!
//! Implemented in this module; commands are registered from `lib.rs`.
//!
//! Two rules shape everything below:
//!
//! 1. **No invented numbers.** A provider either answers with a balance or says why it cannot
//!    (`unsupported`, `console`, `unauthorized`, `unreachable`, `error`). Nothing is estimated,
//!    no reset time is guessed, and a failed refresh does not wipe a still-recent `ok` snapshot.
//! 2. **The API key never leaves.** It is read from `runtime-providers.json`, sent as a bearer
//!    header, and dropped: it is never logged, never put in an error string, and never stored in
//!    the cache file or in a returned struct.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Cache file, inside the app data directory.
const CACHE_FILE: &str = "provider-quota.json";
/// Provider credentials written by `providers.rs`.
const PROVIDERS_FILE: &str = "runtime-providers.json";
/// How long a successful snapshot stays usable when the network fails afterwards.
const STALE_WINDOW_SECONDS: i64 = 24 * 60 * 60;
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_OPENROUTER_ORIGIN: &str = "https://openrouter.ai";
/// Local counter file for `:free` calls, relative to the home directory.
const FREE_STORE: &str = ".alwith/usage/openrouter-free.json";
/// How long an upstream `limit`/`remaining` pair counts as current while its window end is unknown.
const REPORTED_TTL_SECONDS: i64 = 10 * 60;

pub const STATUS_OK: &str = "ok";
pub const STATUS_UNSUPPORTED: &str = "unsupported";
pub const STATUS_CONSOLE: &str = "console";
pub const STATUS_UNAUTHORIZED: &str = "unauthorized";
pub const STATUS_UNREACHABLE: &str = "unreachable";
pub const STATUS_ERROR: &str = "error";

/// Why no probe was attempted, when the verdict is `unsupported`.
///
/// Three states share that verdict but have three different answers for the reader, and two of them
/// are the reader's to fix: a closed credential and a missing base URL are both recoverable, while a
/// vendor with no quota API is not. Collapsing them into one sentence told users 「该供应商没有公开
/// 的额度接口」 about vendors that do have one — a claim about the vendor that we had no basis for.
/// These are machine tokens, matched by exact equality on the frontend; prose stays in `detail`.
pub const UNSUPPORTED_NO_API: &str = "noApi";
pub const UNSUPPORTED_DISABLED: &str = "disabled";
pub const UNSUPPORTED_NO_BASE_URL: &str = "noBaseUrl";

const KIND_OPENROUTER: &str = "openrouter";
/// The account-wide credit balance (`/api/v1/credits`), as opposed to a per-key cap.
const KIND_OPENROUTER_CREDITS: &str = "credits";
const KIND_NEWAPI: &str = "newapi";
const KIND_BILLING: &str = "billing";
const KIND_QWEN_PLAN: &str = "qwenPlan";
const KIND_NONE: &str = "none";

/// A balance snapshot for one provider, as the settings page renders it.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderQuota {
    pub provider_id: String,
    /// `ok` | `unsupported` | `console` | `unauthorized` | `unreachable` | `error`.
    pub status: String,
    /// `openrouter` | `newapi` | `billing` | `qwenPlan` | `none`.
    pub kind: String,
    pub remaining: Option<f64>,
    pub limit: Option<f64>,
    pub used: Option<f64>,
    /// `usd` | `credits` | `requests` | `tokens`.
    pub unit: Option<String>,
    /// Unix seconds.
    pub reset_at: Option<i64>,
    /// Unix seconds.
    pub expires_at: Option<i64>,
    pub plan: Option<String>,
    /// The provider's own wording / our diagnostics. Never the primary label on screen.
    pub detail: Option<String>,
    /// `noApi` | `disabled` | `noBaseUrl`, and only when `status == "unsupported"`. This is what the
    /// settings card branches on, so it never has to read `detail` prose.
    pub unsupported_reason: Option<String>,
    /// Unix seconds.
    pub fetched_at: i64,
}

impl ProviderQuota {
    fn blank(provider_id: &str, status: &str, kind: &str, now: i64) -> Self {
        Self {
            provider_id: provider_id.to_string(),
            status: status.to_string(),
            kind: kind.to_string(),
            remaining: None,
            limit: None,
            used: None,
            unit: None,
            reset_at: None,
            expires_at: None,
            plan: None,
            detail: None,
            unsupported_reason: None,
            fetched_at: now,
        }
    }

    fn failure(provider_id: &str, status: &str, kind: &str, detail: impl Into<String>, now: i64) -> Self {
        Self { detail: Some(detail.into()), ..Self::blank(provider_id, status, kind, now) }
    }

    /// `unsupported`, with the machine token the settings card switches on.
    fn unsupported(provider_id: &str, reason: &str, detail: impl Into<String>, now: i64) -> Self {
        Self {
            unsupported_reason: Some(reason.to_string()),
            ..Self::failure(provider_id, STATUS_UNSUPPORTED, KIND_NONE, detail, now)
        }
    }

    fn ok(provider_id: &str, kind: &str, unit: &str, now: i64) -> Self {
        Self { unit: Some(unit.to_string()), ..Self::blank(provider_id, STATUS_OK, kind, now) }
    }
}

/// Local `:free` usage for today, plus the vendor's own free-model allowance.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FreeUsage {
    /// Local `yyyy-mm-dd` the `calls` tally belongs to.
    pub date: String,
    /// `:free` calls made by this machine today.
    pub calls: u32,
    /// The free-model allowance for the current day, from the vendor when it answered.
    pub limit: Option<u32>,
    pub remaining: Option<u32>,
    /// Unix seconds.
    pub reset_at: Option<i64>,
    /// Where `reset_at` comes from. `"utcDay"` is the 00:00 UTC rollover we compute ourselves (the
    /// vendor's daily counter resets then but ships no timestamp); `"vendor"` is an instant the
    /// vendor sent in `x-ratelimit-reset`; `null` when no reset is known.
    pub reset_source: Option<String>,
    /// `true` only when the vendor enforced a limit and reported `remaining: 0`; a policy reading of
    /// `remaining: 0` from the key endpoint does not set this.
    pub blocked: bool,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri3_specta::command]
pub async fn provider_quota_query(app: AppHandle, provider_id: String) -> Result<ProviderQuota, String> {
    let credential = credential_for(&app, &provider_id)?;
    let id = provider_id.clone();
    // The blocking client owns its own runtime, so it must never run on an async worker thread.
    let fetched = tauri::async_runtime::spawn_blocking(move || resolve_quota(&id, &credential))
        .await
        .map_err(|error| format!("额度查询任务失败: {error}"))?;
    let now = now_unix();
    // The settings page asks for one provider per card, so several queries overlap: the lock keeps
    // the read-modify-write of the whole cache file from dropping a sibling's entry.
    let snapshot = {
        let _guard = cache_lock();
        let mut cache = read_cache(&app);
        let snapshot = preserve_recent_success(&cache, &provider_id, fetched, now);
        cache.items.insert(provider_id, snapshot.clone());
        if let Err(error) = write_cache(&app, &cache) {
            log::warn!("Provider quota cache: could not persist: {error}");
        }
        snapshot
    };
    Ok(snapshot)
}

#[tauri3_specta::command]
pub async fn provider_quota_cached(app: AppHandle) -> Result<Vec<ProviderQuota>, String> {
    // Read-only: the settings page hydrates every card from here without triggering a refresh.
    let _guard = cache_lock();
    Ok(read_cache(&app).items.into_values().collect())
}

#[tauri3_specta::command]
pub async fn provider_quota_clear(app: AppHandle, provider_id: String) -> Result<(), String> {
    let _guard = cache_lock();
    let mut cache = read_cache(&app);
    if cache.items.remove(&provider_id).is_none() {
        // Clearing an absent entry has to stay idempotent: the settings card clears on unmount.
        return Ok(());
    }
    write_cache(&app, &cache)
}

/// Local `:free` usage; no `AppHandle`, because `bridge` needs it off the request path.
#[tauri3_specta::command]
pub async fn openrouter_free_usage() -> Result<FreeUsage, String> {
    Ok(free_usage())
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// The pieces of a stored provider entry the HTTP adapters need. Whether the entry lives in
/// `credentials` or in `custom_providers` does not matter: 哈基米 is a **built-in** id, yet its
/// credential carries a `baseUrl` that points at a New API gateway, so the only real precondition
/// for probing is "we know a key and a base URL".
/// `Clone` only: a derived `Debug` would print the API key the first time anything panicked.
#[derive(Clone)]
struct ApiCredential {
    api_key: String,
    base_url: Option<String>,
    /// `disabled: true` means the user turned this provider off; it must not generate traffic.
    disabled: bool,
}

fn credential_for(app: &AppHandle, provider_id: &str) -> Result<ApiCredential, String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let bytes = std::fs::read(directory.join(PROVIDERS_FILE)).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => "还没有配置任何供应商".to_string(),
        other => format!("读取供应商配置失败: {other}"),
    })?;
    let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| "供应商配置文件不是合法 JSON".to_string())?;
    credential_from_value(&parsed, provider_id)
}

/// `providers.rs` serialises `Saved` without renaming, so the map on disk is `custom_providers`,
/// while `Credential`/`CustomProvider` themselves use `camelCase` fields. Older builds and other
/// tools wrote `customProviders`; both spellings are accepted, as are `api_key`/`apiKey` pairs.
fn credential_from_value(root: &Value, provider_id: &str) -> Result<ApiCredential, String> {
    if let Some(entry) = root.get("credentials").and_then(|map| map.get(provider_id)) {
        return credential_entry(entry);
    }
    let custom_map = root.get("custom_providers").or_else(|| root.get("customProviders"));
    if let Some(entry) = custom_map.and_then(|map| map.get(provider_id)) {
        return credential_entry(entry);
    }
    Err("没有该供应商的凭据".to_string())
}

fn credential_entry(entry: &Value) -> Result<ApiCredential, String> {
    let api_key = text_field(entry, &["apiKey", "api_key"]).unwrap_or_default();
    if api_key.is_empty() {
        return Err("没有该供应商的凭据".to_string());
    }
    Ok(ApiCredential {
        api_key,
        base_url: text_field(entry, &["baseUrl", "base_url"]),
        disabled: entry.get("disabled").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn text_field(value: &Value, names: &[&str]) -> Option<String> {
    for name in names {
        if let Some(text) = value.get(*name).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Adapter selection
// ---------------------------------------------------------------------------

/// How a provider will be asked for its quota. Split out from the request itself so the selection
/// (which needs no network) is testable on its own.
#[derive(Clone, Debug, PartialEq)]
enum Plan {
    OpenRouter,
    QwenConsole,
    /// An OpenAI-compatible gateway: probe `{origin}/api/usage/token/`, then the billing API.
    Relay(String),
    /// Nothing to ask: the machine token the card branches on, plus the prose for diagnostics.
    Unsupported(&'static str, &'static str),
}

const DISABLED_DETAIL: &str = "该供应商已关闭，跳过额度查询";

fn plan_for(provider_id: &str, credential: &ApiCredential) -> Plan {
    let base_url = credential.base_url.as_deref().unwrap_or_default();
    let lower = base_url.to_ascii_lowercase();
    if provider_id == "openrouter" || lower.contains("openrouter.ai") {
        // A vendor we recognise by name needs no base URL: the credential alone is enough.
        if credential.disabled {
            return Plan::Unsupported(UNSUPPORTED_DISABLED, DISABLED_DETAIL);
        }
        return Plan::OpenRouter;
    }
    if is_qwen_plan(provider_id, &lower) {
        // Qwen is answered without any request, so a closed credential still gets the honest answer.
        return Plan::QwenConsole;
    }
    if credential.disabled {
        // Closed by the user: no probe, no traffic.
        return Plan::Unsupported(UNSUPPORTED_DISABLED, DISABLED_DETAIL);
    }
    if base_url.trim().is_empty() {
        // Never invent an endpoint for a vendor we do not know.
        return Plan::Unsupported(UNSUPPORTED_NO_BASE_URL, "该供应商没有配置 baseUrl，无法查询额度");
    }
    match origin_of(base_url) {
        Some(origin) => Plan::Relay(origin),
        // Same remedy as a missing one — go and fix the address — so the card gets the same token.
        // Only the diagnostic prose differs.
        None => Plan::Unsupported(UNSUPPORTED_NO_BASE_URL, "该供应商的 baseUrl 无法解析，无法查询额度"),
    }
}

fn resolve_quota(provider_id: &str, credential: &ApiCredential) -> ProviderQuota {
    let now = now_unix();
    let base_url = credential.base_url.as_deref().unwrap_or_default();
    match plan_for(provider_id, credential) {
        Plan::OpenRouter => openrouter_quota(provider_id, base_url, &credential.api_key, now),
        Plan::QwenConsole => qwen_console(provider_id, now),
        Plan::Relay(origin) => relay_quota(provider_id, &origin, &credential.api_key, now),
        Plan::Unsupported(reason, detail) => ProviderQuota::unsupported(provider_id, reason, detail, now),
    }
}

fn is_qwen_plan(provider_id: &str, lower_base_url: &str) -> bool {
    provider_id == "qwen"
        || lower_base_url.contains("dashscope")
        || lower_base_url.contains("token-plan")
        || lower_base_url.contains("qianwenaiapi")
}

/// DashScope / Qwen Token Plan usage is an Aliyun OpenAPI call signed with an AccessKey.
/// A bearer API key is not accepted by it, so there is nothing to fetch — say so instead of
/// showing an invented number.
fn qwen_console(provider_id: &str, now: i64) -> ProviderQuota {
    ProviderQuota::failure(
        provider_id,
        STATUS_CONSOLE,
        KIND_QWEN_PLAN,
        "Token Plan 用量没有 API Key 可调用的接口，只能在控制台查看",
        now,
    )
}

/// `scheme://host[:port]` — the base URL may carry `/v1`, `/api/v1` or a path prefix we must drop.
fn origin_of(base_url: &str) -> Option<String> {
    let (scheme, rest) = base_url.trim().split_once("://")?;
    if scheme.is_empty() {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() {
        return None;
    }
    Some(format!("{}://{authority}", scheme.to_ascii_lowercase()))
}

fn host_of(origin: &str) -> &str {
    origin.split_once("://").map(|(_, host)| host).unwrap_or(origin)
}

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------

fn openrouter_quota(provider_id: &str, base_url: &str, api_key: &str, now: i64) -> ProviderQuota {
    let origin = origin_of(base_url).unwrap_or_else(|| DEFAULT_OPENROUTER_ORIGIN.to_string());
    let url = format!("{origin}/api/v1/key");
    let reply = match http_get(&url, api_key) {
        Ok(reply) => reply,
        Err(reason) => {
            return ProviderQuota::failure(
                provider_id,
                STATUS_UNREACHABLE,
                KIND_OPENROUTER,
                format!("{}: {reason}", host_of(&origin)),
                now,
            );
        }
    };
    match reply.status {
        200..=299 => {
            let mut quota = openrouter_snapshot(provider_id, &reply.body, now);
            if quota.status == STATUS_OK {
                seed_free_budget(&reply.body);
                // `/api/v1/key` describes the **key's** spend cap, not the account's balance. A key
                // with no cap set reports `limit: 0`, which is why the card used to read
                // 「$0.00 / $0.00」 on an account holding $10 of purchased credits. The account's
                // own balance lives in `/api/v1/credits` (`total_credits` / `total_usage`), so it
                // is read whenever the key publishes no usable cap — and only then: a key with a
                // real cap is the tighter, more truthful number.
                if !key_declares_limit(&quota) {
                    apply_openrouter_credits(&mut quota, &origin, api_key);
                }
            }
            quota
        }
        401 | 403 => ProviderQuota::failure(
            provider_id,
            STATUS_UNAUTHORIZED,
            KIND_OPENROUTER,
            format!("{}: HTTP {}", host_of(&origin), reply.status),
            now,
        ),
        status => ProviderQuota::failure(
            provider_id,
            STATUS_ERROR,
            KIND_OPENROUTER,
            format!("{}: HTTP {status}", host_of(&origin)),
            now,
        ),
    }
}

/// `GET /api/v1/key` → `{"data": {"limit": 10.0 | null, "usage": 0.5, "limit_remaining": 9.5,
/// "is_free_tier": false, "rate_limit": {"requests": -1, "interval": "10s"}}}`.
///
/// Verified against the live endpoint: `limit` is `0` (not null) for a key without a purchased
/// allowance, and `limit_remaining` is present, so the reported numbers are exactly the API's.
fn openrouter_snapshot(provider_id: &str, body: &str, now: i64) -> ProviderQuota {
    let parsed: Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => {
            return ProviderQuota::failure(provider_id, STATUS_ERROR, KIND_OPENROUTER, "响应不是合法 JSON", now);
        }
    };
    let data = parsed.get("data").filter(|value| value.is_object()).unwrap_or(&parsed);
    let limit = number(data.get("limit"));
    let used = number(data.get("usage"));
    let declared_remaining = number(data.get("limit_remaining"));
    let remaining = match (declared_remaining, limit, used) {
        (Some(remaining), _, _) => Some(remaining),
        (None, Some(limit), Some(used)) => Some(limit - used),
        (None, Some(limit), None) => Some(limit),
        (None, None, _) => None,
    };
    let mut notes: Vec<String> = Vec::new();
    if data.get("is_free_tier").and_then(Value::as_bool) == Some(true) {
        notes.push("free tier".to_string());
    }
    if let Some(rate) = data.get("rate_limit").filter(|value| value.is_object()) {
        let requests = rate.get("requests").and_then(Value::as_i64);
        let interval = rate.get("interval").and_then(Value::as_str);
        // A negative `requests` is the deprecated field's "no per-window cap"; it is not news.
        if let (Some(requests), Some(interval)) = (requests, interval)
            && requests >= 0
        {
            notes.push(format!("rate limit {requests}/{interval}"));
        }
    }
    let detail = if limit.is_none() {
        notes.insert(0, "unlimited".to_string());
        Some(notes.join("; "))
    } else if notes.is_empty() {
        None
    } else {
        Some(notes.join("; "))
    };
    ProviderQuota {
        limit,
        used,
        remaining,
        expires_at: data.get("expires_at").and_then(Value::as_str).and_then(iso8601_to_unix),
        detail,
        ..ProviderQuota::ok(provider_id, KIND_OPENROUTER, "usd", now)
    }
}

/// `true` when `/api/v1/key` published a cap that can honestly be read as a budget.
///
/// `limit: 0` is how the endpoint spells "this key has no spend cap", and it is **not** a $0
/// balance: the account may hold purchased credits that the key is allowed to spend. Treating the
/// zero as a real limit is what printed 「$0.00 / $0.00」 over a funded account, so a zero or
/// negative cap means "ask the credits endpoint instead".
fn key_declares_limit(quota: &ProviderQuota) -> bool {
    matches!(quota.limit, Some(limit) if limit > 0.0)
}

/// `GET /api/v1/credits` → `{"data": {"total_credits": 10.0, "total_usage": 0.5}}`.
///
/// This is the account's own purchased balance, which is the number a reader means by 「额度」.
/// It is only consulted when the key publishes no cap, and it never overwrites a published one.
/// A failed or unreadable answer leaves the key's numbers untouched — a missing balance is not a
/// zero balance, and this module does not invent one.
fn apply_openrouter_credits(quota: &mut ProviderQuota, origin: &str, api_key: &str) {
    let url = format!("{origin}/api/v1/credits");
    let Ok(reply) = http_get(&url, api_key) else { return };
    if !(200..=299).contains(&reply.status) {
        return;
    }
    apply_openrouter_credits_body(quota, &reply.body);
}

/// The pure half of the credits read, so the parsing rule is testable without a network stub.
fn apply_openrouter_credits_body(quota: &mut ProviderQuota, body: &str) {
    let Ok(parsed) = serde_json::from_str::<Value>(body) else { return };
    let data = parsed.get("data").filter(|value| value.is_object()).unwrap_or(&parsed);
    // Both fields are required: a `total_credits` with no `total_usage` cannot say what is left.
    let (Some(total), Some(used)) = (number(data.get("total_credits")), number(data.get("total_usage"))) else {
        return;
    };
    quota.kind = KIND_OPENROUTER_CREDITS.to_string();
    quota.unit = Some("usd".to_string());
    quota.limit = Some(total);
    quota.used = Some(used);
    quota.remaining = Some(total - used);
    // The key's prose described an uncapped key ("unlimited"), which is no longer the verdict once
    // the account balance is on screen: leaving it would draw 「不限量」 next to a real number.
    quota.detail = None;
}

/// `data.free_model_daily_requests` is OpenRouter's own free-model counter for the current **UTC**
/// day — `{"used": 23, "limit": 1000, "remaining": 977}` — and the vendor's documented way to check
/// the budget before hitting a limit. It is therefore the authoritative number for display, not a
/// gap filler: `adopt_vendor_daily_budget` overwrites whatever the local tally and the header window
/// had. One tier of `limit` is chosen by all-time credits purchased (50 below 9 credits, 1000 at or
/// above), independently of `is_free_tier`, so the tier is never re-derived here.
fn seed_free_budget(body: &str) {
    let Ok(parsed) = serde_json::from_str::<Value>(body) else { return };
    let data = parsed.get("data").filter(|value| value.is_object()).unwrap_or(&parsed);
    let Some(budget) = data.get("free_model_daily_requests").filter(|value| value.is_object()) else {
        return;
    };
    let (Some(limit), Some(remaining)) = (count(budget.get("limit")), count(budget.get("remaining"))) else {
        return;
    };
    adopt_vendor_daily_budget(limit, remaining);
}

// ---------------------------------------------------------------------------
// OpenAI-compatible relays: New API / One API, then the legacy billing API
// ---------------------------------------------------------------------------

/// What one probe learned. The distinction between `Missing` and `Failed` is the difference between
/// "this gateway has no such API" and "it has one and answered badly", which decides between the
/// calm `unsupported` verdict and an `error` the user would read as our malfunction.
enum Probe {
    /// Numbers we can show.
    Snapshot(ProviderQuota),
    /// No such endpoint here: 404/405/410, an HTML page, or JSON without quota fields.
    Missing(String),
    /// The endpoint exists and answered badly, or refused the key: the snapshot says why.
    Failed(ProviderQuota),
}

/// Both probes are guesses about someone else's gateway, so the first shape that yields a balance
/// wins. When nothing works, a refusal (`unauthorized`) outranks a broken answer, which in turn
/// outranks "this gateway simply does not publish a balance" — the last one is not an error.
fn relay_quota(provider_id: &str, origin: &str, api_key: &str, now: i64) -> ProviderQuota {
    let newapi = probe_newapi(provider_id, origin, api_key, now);
    let billing = probe_billing(provider_id, origin, api_key, now);
    combine_probes(provider_id, newapi, billing, now)
}

/// Pure merge of two probe results, so the verdict rules can be tested without a network.
fn combine_probes(provider_id: &str, newapi: Probe, billing: Probe, now: i64) -> ProviderQuota {
    let (mut snapshots, mut failures, mut missing) = (Vec::new(), Vec::new(), Vec::new());
    for probe in [newapi, billing] {
        match probe {
            Probe::Snapshot(quota) => snapshots.push(quota),
            Probe::Failed(quota) => failures.push(quota),
            Probe::Missing(note) => missing.push(note),
        }
    }
    if let Some(quota) = snapshots.into_iter().next() {
        return quota;
    }
    let detail = |parts: &[String]| if parts.is_empty() { None } else { Some(parts.join("; ")) };
    if failures.iter().any(|quota| quota.status == STATUS_UNAUTHORIZED) {
        let notes: Vec<String> = failures.iter().filter_map(|quota| quota.detail.clone()).chain(missing).collect();
        return ProviderQuota {
            status: STATUS_UNAUTHORIZED.to_string(),
            detail: detail(&notes),
            ..ProviderQuota::blank(provider_id, STATUS_UNAUTHORIZED, KIND_NEWAPI, now)
        };
    }
    if let Some(quota) = failures.into_iter().next() {
        return ProviderQuota { detail: detail(&missing).or(quota.detail), ..quota };
    }
    // Nothing exists to ask: a relay without a quota API is unsupported, not broken.
    ProviderQuota::unsupported(
        provider_id,
        UNSUPPORTED_NO_API,
        format!("该网关没有公开的额度接口（{}）", missing.join("; ")),
        now,
    )
}

fn probe_newapi(provider_id: &str, origin: &str, api_key: &str, now: i64) -> Probe {
    let url = format!("{origin}/api/usage/token/");
    let host = host_of(origin);
    let reply = match http_get(&url, api_key) {
        Ok(reply) => reply,
        Err(reason) => {
            return Probe::Failed(ProviderQuota::failure(
                provider_id,
                STATUS_UNREACHABLE,
                KIND_NEWAPI,
                format!("{host}: {reason}"),
                now,
            ));
        }
    };
    match reply.status {
        200..=299 => {
            // New API reports a bad token inside a 200 body (`success: false`), so this has to be
            // read as a refusal before the payload is tried as a quota answer.
            if body_refuses_credentials(&reply.body) {
                return Probe::Failed(ProviderQuota::failure(
                    provider_id,
                    STATUS_UNAUTHORIZED,
                    KIND_NEWAPI,
                    format!("{host}: 网关在响应体里拒绝了该凭据"),
                    now,
                ));
            }
            match newapi_snapshot(provider_id, &reply.body, now) {
                Ok(quota) => Probe::Snapshot(quota),
                Err(reason) => Probe::Missing(format!("New API {host}: {reason}")),
            }
        }
        401 | 403 => Probe::Failed(ProviderQuota::failure(
            provider_id,
            STATUS_UNAUTHORIZED,
            KIND_NEWAPI,
            format!("{host}: HTTP {}", reply.status),
            now,
        )),
        404 | 405 | 410 => Probe::Missing(format!("New API {host}: HTTP {}", reply.status)),
        status => Probe::Failed(ProviderQuota::failure(
            provider_id,
            STATUS_ERROR,
            KIND_NEWAPI,
            format!("{host}: HTTP {status}"),
            now,
        )),
    }
}

/// `{"success": false}` / `{"code": false}` with a message: the gateway understood us and said no.
/// The vendor's own wording is not copied into `detail`, because a gateway is free to echo whatever
/// it likes back and that includes the key.
fn body_refuses_credentials(body: &str) -> bool {
    let Ok(parsed) = serde_json::from_str::<Value>(body) else { return false };
    if parsed.get("data").is_some_and(|data| data.is_object()) {
        return false;
    }
    let refused_flag = parsed.get("success").and_then(Value::as_bool) == Some(false)
        || parsed.get("code").and_then(Value::as_bool) == Some(false);
    refused_flag && parsed.get("message").is_some()
}

/// New API answers `/api/usage/token/` in two historical shapes: the newer
/// `total_granted`/`total_used`/`total_available` triple, and the older
/// `remain_quota`/`used_quota` pair. Both are tried; unknown field names fall back to the other shape.
fn newapi_snapshot(provider_id: &str, body: &str, now: i64) -> Result<ProviderQuota, &'static str> {
    let parsed: Value = serde_json::from_str(body).map_err(|_| "响应不是合法 JSON")?;
    let mut data = parsed.get("data").filter(|value| value.is_object()).unwrap_or(&parsed);
    // A few gateways wrap the payload twice (`{"data": {"data": {...}}}`).
    if let Some(inner) = data.get("data").filter(|value| value.is_object()) {
        data = inner;
    }
    let unlimited = data.get("unlimited_quota").and_then(Value::as_bool) == Some(true);
    let limit = number(data.get("total_granted"));
    let used = number(data.get("total_used")).or_else(|| number(data.get("used_quota")));
    let remaining = number(data.get("total_available")).or_else(|| number(data.get("remain_quota")));
    if !unlimited && limit.is_none() && used.is_none() && remaining.is_none() {
        return Err("响应里没有额度字段");
    }
    let expires_at = data.get("expires_at").and_then(as_i64).filter(|seconds| *seconds > 0);
    let plan = text_field(data, &["name"]);
    let (limit, remaining, detail) = if unlimited {
        (None, None, Some("unlimited".to_string()))
    } else {
        let remaining = remaining.or(match (limit, used) {
            (Some(limit), Some(used)) => Some(limit - used),
            _ => None,
        });
        (limit, remaining, None)
    };
    Ok(ProviderQuota {
        limit,
        used,
        remaining,
        expires_at,
        plan,
        detail,
        ..ProviderQuota::ok(provider_id, KIND_NEWAPI, "credits", now)
    })
}

/// Same contract as `probe_newapi`, on OpenAI's legacy billing endpoints.
fn probe_billing(provider_id: &str, origin: &str, api_key: &str, now: i64) -> Probe {
    let host = host_of(origin);
    let subscription_url = format!("{origin}/v1/dashboard/billing/subscription");
    let subscription = match http_get(&subscription_url, api_key) {
        Ok(reply) => reply,
        Err(reason) => {
            return Probe::Failed(ProviderQuota::failure(
                provider_id,
                STATUS_UNREACHABLE,
                KIND_BILLING,
                format!("{host}: {reason}"),
                now,
            ));
        }
    };
    match subscription.status {
        200..=299 => {}
        401 | 403 => {
            return Probe::Failed(ProviderQuota::failure(
                provider_id,
                STATUS_UNAUTHORIZED,
                KIND_BILLING,
                format!("{host}: HTTP {}", subscription.status),
                now,
            ));
        }
        404 | 405 | 410 => return Probe::Missing(format!("billing {host}: HTTP {}", subscription.status)),
        status => {
            return Probe::Failed(ProviderQuota::failure(
                provider_id,
                STATUS_ERROR,
                KIND_BILLING,
                format!("{host}: HTTP {status}"),
                now,
            ));
        }
    }
    let (year, month, day) = local_civil(now);
    let usage_url = format!(
        "{origin}/v1/dashboard/billing/usage?start_date={year:04}-{month:02}-01&end_date={year:04}-{month:02}-{day:02}"
    );
    let usage = match http_get(&usage_url, api_key) {
        Ok(reply) => reply,
        Err(reason) => {
            return Probe::Failed(ProviderQuota::failure(
                provider_id,
                STATUS_UNREACHABLE,
                KIND_BILLING,
                format!("{host}: {reason}"),
                now,
            ));
        }
    };
    match usage.status {
        200..=299 => match billing_snapshot(provider_id, &subscription.body, &usage.body, now) {
            Ok(quota) => Probe::Snapshot(quota),
            Err(reason) => Probe::Missing(format!("billing {host}: {reason}")),
        },
        401 | 403 => Probe::Failed(ProviderQuota::failure(
            provider_id,
            STATUS_UNAUTHORIZED,
            KIND_BILLING,
            format!("{host}: HTTP {}", usage.status),
            now,
        )),
        404 | 405 | 410 => Probe::Missing(format!("billing {host}: HTTP {}", usage.status)),
        status => Probe::Failed(ProviderQuota::failure(
            provider_id,
            STATUS_ERROR,
            KIND_BILLING,
            format!("{host}: HTTP {status}"),
            now,
        )),
    }
}

/// `/dashboard/billing/subscription` gives `hard_limit_usd`/`soft_limit_usd`/`access_until`, and
/// `/dashboard/billing/usage` gives `total_usage` **in cents**. Both are OpenAI's legacy shapes.
fn billing_snapshot(
    provider_id: &str, subscription: &str, usage: &str, now: i64,
) -> Result<ProviderQuota, &'static str> {
    let subscription: Value = serde_json::from_str(subscription).map_err(|_| "订阅响应不是合法 JSON")?;
    let usage: Value = serde_json::from_str(usage).map_err(|_| "用量响应不是合法 JSON")?;
    let hard_limit = number(subscription.get("hard_limit_usd"));
    let spent_cents = number(usage.get("total_usage")).or_else(|| number(usage.get("total_usage_usd")));
    if hard_limit.is_none() && spent_cents.is_none() {
        return Err("响应里没有额度字段");
    }
    // New API-family relays answer these OpenAI endpoints with placeholder numbers: the live
    // 哈基米 gateway reports `hard_limit_usd: 100000000` ($100M) and a `total_usage` in its own
    // quota units rather than cents. Reporting either would be a fabricated balance, so an
    // implausible limit means "this gateway has no real billing API" instead of a number.
    if let Some(limit) = hard_limit
        && !(0.0..=1.0e7).contains(&limit)
    {
        return Err("该网关的 billing 额度数值不合理，未采用");
    }
    let used = spent_cents.map(|cents| cents / 100.0);
    let remaining = match (hard_limit, used) {
        (Some(limit), Some(used)) => Some(limit - used),
        (Some(limit), None) => Some(limit),
        (None, _) => None,
    };
    let plan = number(subscription.get("soft_limit_usd")).map(|soft| format!("soft limit {soft}"));
    Ok(ProviderQuota {
        limit: hard_limit,
        used,
        remaining,
        expires_at: subscription.get("access_until").and_then(as_i64).filter(|seconds| *seconds > 0),
        plan,
        // Cents were converted; say so, because the raw number would be 100x off.
        detail: Some("total_usage 是美分，已换算成美元".to_string()),
        ..ProviderQuota::ok(provider_id, KIND_BILLING, "usd", now)
    })
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

struct HttpReply {
    status: u16,
    body: String,
}

fn http_get(url: &str, api_key: &str) -> Result<HttpReply, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|error| format!("无法创建 HTTP 客户端: {error}"))?;
    let response = client
        .get(url)
        .bearer_auth(api_key)
        .header("Accept", "application/json")
        .send()
        .map_err(describe_transport_error)?;
    let status = response.status().as_u16();
    let body = response.text().map_err(|error| format!("读取响应失败: {error}"))?;
    Ok(HttpReply { status, body })
}

/// Deliberately coarse: the caller puts this in `detail`, so it must stay readable and must never
/// carry the request's `Authorization` header or the key itself.
fn describe_transport_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        return "请求超时".to_string();
    }
    if error.is_connect() {
        return "无法连接".to_string();
    }
    if error.is_decode() {
        return "响应无法解码".to_string();
    }
    "网络请求失败".to_string()
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct QuotaCache {
    #[serde(default)]
    items: BTreeMap<String, ProviderQuota>,
}

/// Serialises every read-modify-write of `provider-quota.json`; the network part of a query runs
/// outside it, so a slow provider never blocks the other cards.
fn cache_lock() -> MutexGuard<'static, ()> {
    static CACHE: OnceLock<Mutex<()>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|error| error.into_inner())
}

fn read_cache(app: &AppHandle) -> QuotaCache {
    match app.path().app_data_dir() {
        Ok(directory) => read_cache_at(&directory.join(CACHE_FILE)),
        Err(error) => {
            log::warn!("Provider quota cache: no app data dir: {error}");
            QuotaCache::default()
        }
    }
}

fn read_cache_at(path: &Path) -> QuotaCache {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            log::warn!("Provider quota cache: ignoring unreadable file: {error}");
            QuotaCache::default()
        }),
        Err(_) => QuotaCache::default(),
    }
}

fn write_cache(app: &AppHandle, cache: &QuotaCache) -> Result<(), String> {
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?;
    write_cache_at(&directory.join(CACHE_FILE), cache)
}

fn write_cache_at(path: &Path, cache: &QuotaCache) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(cache).map_err(|error| error.to_string())?;
    std::fs::write(path, bytes).map_err(|error| error.to_string())
}

/// A failed refresh must not blank the card: a successful snapshot younger than the stale window
/// is served again, marked `stale`, with every number intact.
fn preserve_recent_success(cache: &QuotaCache, provider_id: &str, fetched: ProviderQuota, now: i64) -> ProviderQuota {
    if fetched.status == STATUS_OK {
        return fetched;
    }
    let Some(previous) = cache.items.get(provider_id) else { return fetched };
    if previous.status != STATUS_OK {
        return fetched;
    }
    let age = now - previous.fetched_at;
    if !(0..STALE_WINDOW_SECONDS).contains(&age) {
        return fetched;
    }
    log::info!("Provider quota {provider_id}: refresh failed ({}), serving the {age}s old snapshot", fetched.status);
    ProviderQuota { detail: Some("stale".to_string()), ..previous.clone() }
}

// ---------------------------------------------------------------------------
// Free `:free` usage (shared with `bridge`, so it stays thread-safe and cheap)
// ---------------------------------------------------------------------------

/// What we know about the free-model allowance. Two *different* sources land here and they must
/// never be conflated:
///
/// * `daily_*` — `GET /api/v1/key` → `data.free_model_daily_requests`. This is the documented,
///   authoritative counter ("requests recorded / allowed / left in the current **UTC** day"), and
///   OpenRouter's own recommendation for checking the budget before hitting a limit. It is a
///   *policy* statement, so it is what the card displays — and it may not block anything.
/// * `window_*` — `X-RateLimit-*` from a routed response. Success responses carry none of these
///   (only 429 does), so a value here is evidence that the vendor enforced a limit right now.
///   That makes it the only source allowed to set `blocked`.
///
/// The local `calls` tally exists because `bridge` counts this machine's `:free` calls; it is a
/// fallback for display when the key endpoint has never answered, and it never outranks it.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct FreeState {
    /// Local `yyyy-mm-dd` the `calls` tally belongs to.
    #[serde(default)]
    date: String,
    #[serde(default)]
    calls: u32,
    #[serde(default)]
    daily_limit: Option<u32>,
    #[serde(default)]
    daily_remaining: Option<u32>,
    /// When the key endpoint supplied the three fields above.
    #[serde(default)]
    daily_at: Option<i64>,
    #[serde(default)]
    window_limit: Option<u32>,
    #[serde(default)]
    window_remaining: Option<u32>,
    /// The window end the vendor itself reported in `x-ratelimit-reset`.
    #[serde(default)]
    window_reset_at: Option<i64>,
    /// When the window numbers were last reported. Without it a `remaining: 0` seen once would
    /// keep the account "exhausted" for good: no successful call means no new header to correct it.
    #[serde(default)]
    window_at: Option<i64>,
}

fn free_mutex() -> &'static Mutex<FreeState> {
    static FREE: OnceLock<Mutex<FreeState>> = OnceLock::new();
    FREE.get_or_init(|| Mutex::new(load_free_state(now_unix())))
}

/// A poisoned lock only means a previous holder panicked mid-update; the counters are trivial to
/// keep using, so recover instead of propagating the panic into every request thread.
fn lock_free() -> MutexGuard<'static, FreeState> {
    free_mutex().lock().unwrap_or_else(|error| error.into_inner())
}

fn home_directory() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn free_store_path() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(path) = test_free_path() {
        return Some(path);
    }
    home_directory().map(|home| home.join(FREE_STORE))
}

fn load_free_state(now: i64) -> FreeState {
    let Some(path) = free_store_path() else { return FreeState::default() };
    let mut state = match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<FreeState>(&bytes) {
            Ok(state) => state,
            Err(error) => {
                log::warn!("OpenRouter free usage: ignoring unreadable counters: {error}");
                FreeState::default()
            }
        },
        Err(_) => FreeState::default(),
    };
    // The stored day may be behind today, in which case today starts from zero.
    roll_day(&mut state, now);
    state
}

fn save_free_state(state: &FreeState) {
    let Some(path) = free_store_path() else { return };
    if let Some(parent) = path.parent()
        && let Err(error) = std::fs::create_dir_all(parent)
    {
        log::warn!("OpenRouter free usage: cannot create {}: {error}", parent.display());
        return;
    }
    match serde_json::to_vec_pretty(state) {
        Ok(bytes) => {
            if let Err(error) = std::fs::write(&path, bytes) {
                log::warn!("OpenRouter free usage: cannot write {}: {error}", path.display());
            }
        }
        Err(error) => log::warn!("OpenRouter free usage: cannot serialise counters: {error}"),
    }
}

/// Moves the counter to today's local date and zeroes `calls` when the day changed. The upstream
/// window (`limit`/`remaining`/`reset_at`) is left alone: it belongs to a rolling provider window,
/// not to our calendar day.
fn roll_day(state: &mut FreeState, now: i64) -> bool {
    let today = date_string(local_civil(now));
    if state.date == today {
        return false;
    }
    state.date = today;
    state.calls = 0;
    true
}

/// `X-RateLimit-*` from a routed response. These are a **per-window** counter, not the UTC-day free
/// budget, and success responses do not carry them at all — so they are recorded as enforcement
/// evidence and never shown as the daily allowance.
///
/// Called on `bridge`'s request thread, so it only holds the lock for an in-memory update; the write
/// to disk happens under the same lock but is best effort and never panics.
pub fn record_openrouter_headers(headers: &[(String, String)]) {
    if headers.is_empty() {
        return;
    }
    let now = now_unix();
    let mut state = lock_free();
    let before = state.clone();
    roll_day(&mut state, now);
    let mut reported = false;
    for (name, value) in headers {
        match name.trim().to_ascii_lowercase().as_str() {
            "x-ratelimit-limit" => {
                if let Some(limit) = header_count(value) {
                    state.window_limit = Some(limit);
                    reported = true;
                }
            }
            "x-ratelimit-remaining" => {
                if let Some(remaining) = header_count(value) {
                    state.window_remaining = Some(remaining);
                    reported = true;
                }
            }
            "x-ratelimit-reset" => {
                if let Some(reset_at) = header_reset_at(value, now) {
                    state.window_reset_at = Some(reset_at);
                }
            }
            _ => {}
        }
    }
    if reported {
        state.window_at = Some(now);
    }
    if *state != before {
        save_free_state(&state);
    }
}

/// Counts one local `:free` call. Only models whose id contains `:free` are free models, so the
/// suffix decides — `openrouter/auto` and paid variants never increment.
pub fn record_free_call(model: &str) {
    if !is_free_model(model) {
        return;
    }
    let now = now_unix();
    let mut state = lock_free();
    let before = state.clone();
    roll_day(&mut state, now);
    state.calls = state.calls.saturating_add(1);
    if *state != before {
        save_free_state(&state);
    }
}

pub fn is_free_model(model: &str) -> bool {
    model.to_ascii_lowercase().contains(":free")
}

/// `true` only on enforcement evidence: the vendor answered a routed request with
/// `x-ratelimit-remaining: 0`, and that reading is still datable.
///
/// Deliberately **not** driven by `free_model_daily_requests.remaining`. Per OpenRouter's docs that
/// counter reflects the tier policy, and accounts, endpoints and BYOK requests exempt from free-model
/// limits are not gated by it — so `remaining: 0` there is not proof of a refusal. `free_usage()`
/// reports that number; this function decides whether `bridge` may answer a 429 without asking the
/// vendor. Two different sources on purpose: do not "unify" them.
pub fn free_quota_blocked() -> bool {
    let now = now_unix();
    let mut state = lock_free();
    let before = state.clone();
    let blocked = blocked_of(&mut state, now);
    if *state != before {
        save_free_state(&state);
    }
    blocked
}

fn blocked_of(state: &mut FreeState, now: i64) -> bool {
    roll_day(state, now);
    if let Some(reset_at) = state.window_reset_at
        && now > reset_at
    {
        // The window the counter described is over; the next call starts a fresh one.
        state.window_remaining = None;
        state.window_reset_at = None;
        state.window_at = None;
        return false;
    }
    // A reading we can no longer date must not keep the account blocked forever: after the TTL a
    // real refusal surfaces from the upstream's own 429 instead of a stale zero.
    if !window_is_current(state, now) {
        return false;
    }
    state.window_remaining == Some(0)
}

fn window_is_current(state: &FreeState, now: i64) -> bool {
    if let Some(reset_at) = state.window_reset_at
        && reset_at > now
    {
        return true;
    }
    match state.window_at {
        Some(window_at) => now.saturating_sub(window_at) <= REPORTED_TTL_SECONDS,
        None => false,
    }
}

/// Unix seconds the allowance comes back; `None` when nothing is known.
///
/// `bridge` prints this in the "quota exhausted" 429 body. The vendor's own window end
/// (`x-ratelimit-reset`) is preferred, and the next 00:00 UTC is used otherwise — that is when the
/// daily free-model counter rolls over, so it is a real instant, just not one the vendor sent us.
pub fn free_quota_reset_at() -> Option<i64> {
    let now = now_unix();
    let state = lock_free();
    if let Some(reset_at) = state.window_reset_at
        && reset_at > now
    {
        return Some(reset_at);
    }
    if state.daily_at.is_some() {
        return Some(next_utc_midnight(now));
    }
    state.window_reset_at
}

/// Midnight UTC after `now`, unix seconds: `free_model_daily_requests` is a **UTC-day** counter and
/// carries no reset timestamp of its own.
fn next_utc_midnight(now: i64) -> i64 {
    (now.div_euclid(86_400) + 1) * 86_400
}

pub fn free_usage() -> FreeUsage {
    let now = now_unix();
    let mut state = lock_free();
    let before = state.clone();
    let blocked = blocked_of(&mut state, now);
    // The vendor's UTC-day counter wins wherever the key endpoint has answered — that is the
    // documented source and the one OpenRouter recommends for this check. The header window (and,
    // failing both, nothing at all) is only a display fallback.
    let counters = daily_counters(&state, now);
    let usage = FreeUsage {
        date: state.date.clone(),
        calls: state.calls,
        limit: counters.limit,
        remaining: counters.remaining,
        reset_at: counters.reset_at,
        reset_source: counters.source.map(str::to_string),
        blocked,
    };
    if *state != before {
        save_free_state(&state);
    }
    usage
}

struct DisplayCounters {
    limit: Option<u32>,
    remaining: Option<u32>,
    reset_at: Option<i64>,
    source: Option<&'static str>,
}

fn daily_counters(state: &FreeState, now: i64) -> DisplayCounters {
    if let Some(daily_at) = state.daily_at {
        let same_utc_day = daily_at.div_euclid(86_400) == now.div_euclid(86_400);
        // A counter from an earlier UTC day has rolled over: the tier limit still stands, but how
        // much of it is left is unknown until the card is refreshed again. Report the limit only.
        let remaining = if same_utc_day { state.daily_remaining } else { None };
        return DisplayCounters {
            limit: state.daily_limit,
            remaining,
            reset_at: Some(next_utc_midnight(now)),
            source: Some("utcDay"),
        };
    }
    if state.window_at.is_some() {
        return DisplayCounters {
            limit: state.window_limit,
            remaining: state.window_remaining,
            reset_at: state.window_reset_at,
            source: Some("vendor"),
        };
    }
    DisplayCounters { limit: None, remaining: None, reset_at: None, source: None }
}

/// Adopts OpenRouter's own `free_model_daily_requests` numbers, but only where we have nothing
/// current: a value that came from `x-ratelimit-remaining` on a real request keeps priority until
/// it ages out, so the settings card shows the upstream budget instead of a number frozen at the
/// first launch.
/// Records the vendor's UTC-day free-model counter from `GET /api/v1/key`.
///
/// It always overwrites: this is the documented counter, `bridge`'s local tally counts one machine
/// on a local calendar day, and the header window counts a different one. Display reads this first;
/// blocking ignores it entirely (see `free_quota_blocked`).
fn adopt_vendor_daily_budget(limit: u32, remaining: u32) {
    let now = now_unix();
    let mut state = lock_free();
    let before = state.clone();
    roll_day(&mut state, now);
    state.daily_limit = Some(limit);
    state.daily_remaining = Some(remaining);
    state.daily_at = Some(now);
    if *state != before {
        save_free_state(&state);
    }
}

/// `20` → 20, `20, 20;w=60` → 20 (the first token is the count). Anything else is ignored.
fn header_count(raw: &str) -> Option<u32> {
    let token = first_token(raw)?;
    if !token.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    token.parse::<u32>().ok()
}

/// Absolute unix seconds when the value looks like a timestamp (≥ 1e9), otherwise a delay from now.
fn header_reset_at(raw: &str, now: i64) -> Option<i64> {
    let token = first_token(raw)?;
    if !token.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value: i64 = token.parse().ok()?;
    if value >= 1_000_000_000 {
        return Some(value);
    }
    now.checked_add(value)
}

fn first_token(raw: &str) -> Option<&str> {
    let token = raw.split([',', ';']).next().unwrap_or_default().trim();
    if token.is_empty() { None } else { Some(token) }
}

// ---------------------------------------------------------------------------
// Clock helpers
// ---------------------------------------------------------------------------

fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs() as i64).unwrap_or(0)
}

fn date_string(civil: (i32, u32, u32)) -> String {
    let (year, month, day) = civil;
    format!("{year:04}-{month:02}-{day:02}")
}

/// Local calendar date. The platform C runtime owns the timezone rules, so DST is whatever the OS
/// says; a missing/unreadable timezone falls back to UTC rather than inventing an offset.
fn local_civil(now: i64) -> (i32, u32, u32) {
    platform_local_civil(now).unwrap_or_else(|| utc_civil(now))
}

fn utc_civil(now: i64) -> (i32, u32, u32) {
    civil_from_days(now.div_euclid(86_400))
}

/// Howard Hinnant's `civil_from_days`: days since 1970-01-01 → (year, month, day).
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    ((y + i64::from(month <= 2)) as i32, month as u32, day as u32)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = i64::from(year) - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = i64::from(month);
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `2027-05-05T14:03:51.357Z` → unix seconds. Only the shapes OpenRouter emits are accepted.
fn iso8601_to_unix(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    let bytes = raw.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let year: i32 = raw.get(0..4)?.parse().ok()?;
    let month: u32 = raw.get(5..7)?.parse().ok()?;
    let day: u32 = raw.get(8..10)?.parse().ok()?;
    let hour: i64 = raw.get(11..13)?.parse().ok()?;
    let minute: i64 = raw.get(14..16)?.parse().ok()?;
    let second: i64 = raw.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Broken-down local time as the C runtime lays it out. Only the date fields are read; the tail
/// only makes our struct at least as large as the platform's `struct tm`, which never overflows it.
#[repr(C)]
#[derive(Default)]
#[allow(dead_code)]
struct LocalTime {
    tm_sec: i32,
    tm_min: i32,
    tm_hour: i32,
    tm_mday: i32,
    tm_mon: i32,
    tm_year: i32,
    tm_wday: i32,
    tm_yday: i32,
    tm_isdst: i32,
    tail: [i64; 4],
}

#[cfg(unix)]
unsafe extern "C" {
    fn localtime_r(timep: *const i64, result: *mut LocalTime) -> *mut LocalTime;
}

#[cfg(windows)]
unsafe extern "C" {
    fn _localtime64_s(result: *mut LocalTime, timep: *const i64) -> i32;
}

#[cfg(unix)]
fn platform_local_civil(now: i64) -> Option<(i32, u32, u32)> {
    let mut local = LocalTime::default();
    // SAFETY: `localtime_r` reads the pointer we hand it and fills our buffer; both outlive the
    // call, and the struct's first nine fields match `struct tm` on every unix we ship.
    let written = unsafe { localtime_r(&now, &mut local) };
    if written.is_null() {
        return None;
    }
    sane_civil(&local)
}

#[cfg(windows)]
fn platform_local_civil(now: i64) -> Option<(i32, u32, u32)> {
    let mut local = LocalTime::default();
    // SAFETY: same contract as `localtime_r`; `_localtime64_s` returns 0 on success.
    let status = unsafe { _localtime64_s(&mut local, &now) };
    if status != 0 {
        return None;
    }
    sane_civil(&local)
}

#[cfg(not(any(unix, windows)))]
fn platform_local_civil(_now: i64) -> Option<(i32, u32, u32)> {
    None
}

fn sane_civil(local: &LocalTime) -> Option<(i32, u32, u32)> {
    let year = local.tm_year + 1_900;
    let month = local.tm_mon + 1;
    let day = local.tm_mday;
    if (1..=12).contains(&month) && (1..=31).contains(&day) { Some((year, month as u32, day as u32)) } else { None }
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn as_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64().or_else(|| number.as_f64().map(|float| float as i64)),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn count(value: Option<&Value>) -> Option<u32> {
    let parsed = number(value)?;
    if !parsed.is_finite() || parsed < 0.0 || parsed > f64::from(u32::MAX) {
        return None;
    }
    Some(parsed as u32)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
static FREE_TEST_PATH: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

#[cfg(test)]
fn test_free_path() -> Option<PathBuf> {
    FREE_TEST_PATH.get_or_init(|| Mutex::new(None)).lock().ok().and_then(|slot| slot.clone())
}

#[cfg(test)]
fn set_test_free_path(path: Option<PathBuf>) {
    if let Ok(mut slot) = FREE_TEST_PATH.get_or_init(|| Mutex::new(None)).lock() {
        *slot = path;
    }
}

#[cfg(test)]
fn reset_free_state() {
    *lock_free() = FreeState::default();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed clock: every snapshot below is deterministic.
    const NOW: i64 = 1_763_000_000;

    fn openrouter_body(limit: Value, usage: Value, limit_remaining: Value) -> String {
        serde_json::json!({
            "data": {
                "limit": limit,
                "usage": usage,
                "limit_remaining": limit_remaining,
                "is_free_tier": false
            }
        })
        .to_string()
    }

    #[test]
    fn openrouter_snapshot_reads_credit_fields() {
        let quota = openrouter_snapshot(
            "openrouter",
            &openrouter_body(Value::from(10.0), Value::from(0.5), Value::from(9.5)),
            NOW,
        );
        assert_eq!(quota.status, STATUS_OK);
        assert_eq!(quota.kind, KIND_OPENROUTER);
        assert_eq!(quota.unit.as_deref(), Some("usd"));
        assert_eq!(quota.limit, Some(10.0));
        assert_eq!(quota.used, Some(0.5));
        assert_eq!(quota.remaining, Some(9.5));
        assert_eq!(quota.fetched_at, NOW);
        assert!(quota.detail.is_none());
    }

    #[test]
    fn openrouter_snapshot_derives_remaining_when_the_field_is_missing() {
        let quota =
            openrouter_snapshot("openrouter", &openrouter_body(Value::from(10.0), Value::from(3.0), Value::Null), NOW);
        assert_eq!(quota.remaining, Some(7.0));
    }

    #[test]
    fn openrouter_snapshot_treats_a_null_limit_as_unlimited() {
        let quota =
            openrouter_snapshot("openrouter", &openrouter_body(Value::Null, Value::from(0.42), Value::Null), NOW);
        assert_eq!(quota.status, STATUS_OK);
        assert_eq!(quota.limit, None);
        assert_eq!(quota.remaining, None);
        assert_eq!(quota.used, Some(0.42));
        assert_eq!(quota.detail.as_deref(), Some("unlimited"));
    }

    #[test]
    fn openrouter_snapshot_keeps_a_zero_limit_zero_remaining_answer() {
        // The live API reports `limit: 0` for a key without a purchased allowance; that is the
        // truth and must not be rounded into "unlimited".
        let quota = openrouter_snapshot(
            "openrouter",
            &openrouter_body(Value::from(0.0), Value::from(0.000774), Value::from(0.0)),
            NOW,
        );
        assert_eq!(quota.limit, Some(0.0));
        assert_eq!(quota.remaining, Some(0.0));
        assert!(quota.detail.is_none());
    }

    #[test]
    fn openrouter_snapshot_notes_free_tier_and_rate_limit() {
        let body = serde_json::json!({
            "data": {
                "limit": Value::Null,
                "usage": 0.0,
                "is_free_tier": true,
                "rate_limit": { "requests": 20, "interval": "10s" }
            }
        })
        .to_string();
        let quota = openrouter_snapshot("openrouter", &body, NOW);
        assert_eq!(quota.detail.as_deref(), Some("unlimited; free tier; rate limit 20/10s"));
    }

    #[test]
    fn openrouter_snapshot_keeps_the_key_expiry_in_unix_seconds() {
        let body = serde_json::json!({
            "data": { "limit": 5.0, "usage": 0.0, "expires_at": "2027-05-05T14:03:51.357Z" }
        })
        .to_string();
        let quota = openrouter_snapshot("openrouter", &body, NOW);
        let expires_at = quota.expires_at.expect("expiry parsed");
        assert_eq!(utc_civil(expires_at), (2027, 5, 5));
        assert_eq!(expires_at % 86_400, 14 * 3_600 + 3 * 60 + 51);
    }

    #[test]
    fn openrouter_snapshot_reports_garbage_instead_of_a_guess() {
        let quota = openrouter_snapshot("openrouter", "<html>", NOW);
        assert_eq!(quota.status, STATUS_ERROR);
        assert_eq!(quota.remaining, None);
        assert_eq!(quota.limit, None);
    }

    #[test]
    fn a_key_without_a_cap_is_not_a_zero_balance() {
        // `limit: 0` means "this key has no spend cap", so the credits endpoint is the number to
        // read. What used to happen: the card printed 「$0.00 / $0.00」 over a funded account.
        let key = openrouter_snapshot(
            "openrouter",
            &openrouter_body(Value::from(0.0), Value::from(0.0), Value::from(0.0)),
            NOW,
        );
        assert!(!key_declares_limit(&key));

        let mut quota = key;
        apply_openrouter_credits_body(&mut quota, r#"{"data":{"total_credits":10.0,"total_usage":0.42}}"#);
        assert_eq!(quota.status, STATUS_OK);
        assert_eq!(quota.kind, KIND_OPENROUTER_CREDITS);
        assert_eq!(quota.unit.as_deref(), Some("usd"));
        assert_eq!(quota.limit, Some(10.0));
        assert_eq!(quota.used, Some(0.42));
        assert_eq!(quota.remaining, Some(9.58));
        // The key called itself unlimited; a real balance replaces that verdict rather than joining it.
        assert_eq!(quota.detail, None);
    }

    #[test]
    fn a_real_key_cap_outranks_the_account_balance() {
        let quota = openrouter_snapshot(
            "openrouter",
            &openrouter_body(Value::from(5.0), Value::from(1.0), Value::from(4.0)),
            NOW,
        );
        assert!(key_declares_limit(&quota));
        // Untouched: a $5 key cap is the tighter, more honest number for that key.
        assert_eq!(quota.limit, Some(5.0));
        assert_eq!(quota.remaining, Some(4.0));
    }

    #[test]
    fn a_credits_answer_missing_usage_leaves_the_key_numbers_alone() {
        let mut quota = openrouter_snapshot(
            "openrouter",
            &openrouter_body(Value::from(0.0), Value::from(0.0), Value::from(0.0)),
            NOW,
        );
        // No `total_usage`: total_credits alone cannot say what is left, so nothing is written.
        apply_openrouter_credits_body(&mut quota, r#"{"data":{"total_credits":10.0}}"#);
        assert_eq!(quota.limit, Some(0.0));
        assert_eq!(quota.remaining, Some(0.0));
        assert_eq!(quota.kind, KIND_OPENROUTER);
    }

    #[test]
    fn newapi_snapshot_reads_the_granted_triple() {
        let body = serde_json::json!({
            "code": true,
            "data": {
                "name": "tok-abcd",
                "total_granted": 10_000_000.0,
                "total_used": 2_500_000.0,
                "total_available": 7_500_000.0,
                "unlimited_quota": false,
                "expires_at": 1_800_000_000
            }
        })
        .to_string();
        let quota = newapi_snapshot("custom_x", &body, NOW).expect("recognised");
        assert_eq!(quota.status, STATUS_OK);
        assert_eq!(quota.kind, KIND_NEWAPI);
        assert_eq!(quota.unit.as_deref(), Some("credits"));
        assert_eq!(quota.limit, Some(10_000_000.0));
        assert_eq!(quota.used, Some(2_500_000.0));
        assert_eq!(quota.remaining, Some(7_500_000.0));
        assert_eq!(quota.expires_at, Some(1_800_000_000));
        assert_eq!(quota.plan.as_deref(), Some("tok-abcd"));
    }

    #[test]
    fn newapi_snapshot_reads_the_older_remain_pair() {
        let body = serde_json::json!({
            "success": true,
            "data": { "remain_quota": 4_200, "used_quota": 800, "expires_at": -1 }
        })
        .to_string();
        let quota = newapi_snapshot("custom_x", &body, NOW).expect("recognised");
        assert_eq!(quota.remaining, Some(4_200.0));
        assert_eq!(quota.used, Some(800.0));
        assert_eq!(quota.limit, None);
        // `expires_at: -1` is New API's "never expires"; it must not surface as 1969.
        assert_eq!(quota.expires_at, None);
    }

    #[test]
    fn newapi_snapshot_honours_unlimited_quota() {
        let body = serde_json::json!({
            "data": { "unlimited_quota": true, "remain_quota": 0, "used_quota": 10 }
        })
        .to_string();
        let quota = newapi_snapshot("custom_x", &body, NOW).expect("recognised");
        assert_eq!(quota.limit, None);
        assert_eq!(quota.remaining, None);
        assert_eq!(quota.used, Some(10.0));
        assert_eq!(quota.detail.as_deref(), Some("unlimited"));
    }

    #[test]
    fn newapi_snapshot_rejects_a_payload_without_quota_fields() {
        let body = serde_json::json!({ "data": { "models": ["gpt-4o"] } }).to_string();
        assert!(newapi_snapshot("custom_x", &body, NOW).is_err());
    }

    #[test]
    fn billing_snapshot_converts_cents_to_dollars() {
        let subscription = serde_json::json!({
            "hard_limit_usd": 120.0,
            "soft_limit_usd": 120.0,
            "access_until": 1_800_000_000
        })
        .to_string();
        let usage = serde_json::json!({ "total_usage": 1_234.5 }).to_string();
        let quota = billing_snapshot("custom_x", &subscription, &usage, NOW).expect("recognised");
        assert_eq!(quota.kind, KIND_BILLING);
        assert_eq!(quota.unit.as_deref(), Some("usd"));
        assert_eq!(quota.limit, Some(120.0));
        assert_eq!(quota.used, Some(12.345));
        assert_eq!(quota.remaining, Some(107.655));
        assert_eq!(quota.expires_at, Some(1_800_000_000));
    }

    #[test]
    fn billing_snapshot_rejects_a_payload_without_quota_fields() {
        assert!(billing_snapshot("custom_x", "{}", "{}", NOW).is_err());
    }

    #[test]
    fn billing_snapshot_refuses_the_placeholder_numbers_relays_send() {
        // Verbatim shape of the live 哈基米 gateway: $100M "limit" and a `total_usage` in quota
        // units. Dividing that by 100 would print a six-figure dollar balance that does not exist.
        let subscription = serde_json::json!({
            "object": "billing_subscription",
            "has_payment_method": true,
            "soft_limit_usd": 100_000_000,
            "hard_limit_usd": 100_000_000,
            "system_hard_limit_usd": 100_000_000,
            "access_until": 1_799_565_597
        })
        .to_string();
        let usage = serde_json::json!({ "object": "list", "total_usage": 25_072_589.897339996 }).to_string();
        assert!(billing_snapshot("custom_x", &subscription, &usage, NOW).is_err());
    }

    #[test]
    fn origin_drops_api_paths_and_keeps_the_port() {
        assert_eq!(origin_of("https://openrouter.ai/api/v1").as_deref(), Some("https://openrouter.ai"));
        assert_eq!(origin_of("https://vip.aipro.love/v1").as_deref(), Some("https://vip.aipro.love"));
        assert_eq!(origin_of("HTTP://localhost:8787/v1").as_deref(), Some("http://localhost:8787"));
        assert_eq!(origin_of("openrouter.ai"), None);
        assert_eq!(origin_of("https://"), None);
        assert_eq!(host_of("https://vip.aipro.love"), "vip.aipro.love");
    }

    #[test]
    fn qwen_is_detected_by_id_and_by_base_url() {
        assert!(is_qwen_plan("qwen", ""));
        assert!(is_qwen_plan("custom_q", "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1"));
        assert!(is_qwen_plan("custom_q", "https://dashscope.aliyuncs.com/compatible-mode/v1"));
        assert!(!is_qwen_plan("openrouter", "https://openrouter.ai/api/v1"));
    }

    #[test]
    fn qwen_never_queries_the_network() {
        let quota = qwen_console("qwen", NOW);
        assert_eq!(quota.status, STATUS_CONSOLE);
        assert_eq!(quota.kind, KIND_QWEN_PLAN);
        assert_eq!(quota.remaining, None);
        assert_eq!(quota.detail.as_deref(), Some("Token Plan 用量没有 API Key 可调用的接口，只能在控制台查看"));
    }

    #[test]
    fn credentials_are_read_from_both_file_spellings() {
        let custom = serde_json::json!({
            "customProviders": {
                "custom_x": { "id": "custom_x", "name": "哈基米", "baseUrl": "https://vip.aipro.love/v1", "apiKey": "sk-test" }
            }
        });
        let credential = credential_from_value(&custom, "custom_x").expect("custom provider found");
        assert!(!credential.disabled);
        assert_eq!(credential.api_key, "sk-test");
        assert_eq!(credential.base_url.as_deref(), Some("https://vip.aipro.love/v1"));

        // What `providers.rs` actually writes: `Saved` is serialised without renaming, and a
        // *built-in* provider may carry a baseUrl — that is the 哈基米 case.
        let built_in = serde_json::json!({
            "revision": 3,
            "custom_providers": {},
            "credentials": {
                "openrouter": { "apiKey": "sk-or-test", "protocol": "responses", "region": null },
                "hakimi": { "apiKey": "sk-test", "baseUrl": "https://vip.aipro.love/v1", "region": null, "disabled": false },
                "deepseek": { "apiKey": "sk-test", "region": null, "disabled": true }
            }
        });
        let credential = credential_from_value(&built_in, "openrouter").expect("credential found");
        assert!(!credential.disabled);
        assert_eq!(credential.api_key, "sk-or-test");
        assert_eq!(credential.base_url, None);

        let credential = credential_from_value(&built_in, "hakimi").expect("built-in gateway found");
        assert_eq!(credential.base_url.as_deref(), Some("https://vip.aipro.love/v1"));
        assert!(!credential.disabled);
        assert!(credential_from_value(&built_in, "deepseek").expect("disabled still resolves").disabled);
    }

    #[test]
    fn a_built_in_id_with_a_base_url_is_probed_like_a_custom_gateway() {
        let gateway = ApiCredential {
            api_key: "sk-test".to_string(),
            base_url: Some("https://vip.aipro.love/v1".to_string()),
            disabled: false,
        };
        // 哈基米 is built into the catalog; the base URL, not the origin of the entry, decides.
        assert_eq!(plan_for("hakimi", &gateway), Plan::Relay("https://vip.aipro.love".to_string()));
        // The recognised vendor keeps its dedicated adapter, with or without a base URL.
        assert_eq!(plan_for("openrouter", &gateway), Plan::OpenRouter);
        let bare = ApiCredential { base_url: None, ..gateway.clone() };
        assert_eq!(plan_for("openrouter", &bare), Plan::OpenRouter);
        assert!(matches!(plan_for("qwen", &gateway), Plan::QwenConsole));
    }

    #[test]
    fn a_credential_without_a_base_url_stays_unsupported() {
        let kimi = ApiCredential { api_key: "sk-test".to_string(), base_url: None, disabled: false };
        match plan_for("kimi", &kimi) {
            Plan::Unsupported(reason, detail) => {
                assert_eq!(reason, UNSUPPORTED_NO_BASE_URL);
                assert!(detail.contains("baseUrl"), "detail: {detail}");
            }
            other => panic!("kimi must not be probed, got {other:?}"),
        }
        // A base URL that is not a URL is refused rather than guessed at — same token, because the
        // reader's remedy (fix the address) is the same in both cases.
        let broken = ApiCredential { base_url: Some("vip.aipro.love/v1".to_string()), ..kimi.clone() };
        assert!(matches!(plan_for("custom_x", &broken), Plan::Unsupported(UNSUPPORTED_NO_BASE_URL, _)));
    }

    #[test]
    fn a_disabled_credential_is_never_probed() {
        let off = ApiCredential {
            api_key: "sk-test".to_string(),
            base_url: Some("https://vip.aipro.love/v1".to_string()),
            disabled: true,
        };
        assert_eq!(plan_for("hakimi", &off), Plan::Unsupported(UNSUPPORTED_DISABLED, DISABLED_DETAIL));
        assert_eq!(plan_for("openrouter", &off), Plan::Unsupported(UNSUPPORTED_DISABLED, DISABLED_DETAIL));
        // Qwen answers without a request, so a closed credential still gets the truthful answer.
        assert_eq!(plan_for("qwen", &off), Plan::QwenConsole);
    }

    /// The card switches on `unsupportedReason`; a wrong token tells the reader to fix something
    /// that is not broken, or hides a fix that is one click away.
    #[test]
    fn every_unsupported_path_carries_a_reason_and_nothing_else_does() {
        let now = NOW;
        let no_base =
            resolve_quota("kimi", &ApiCredential { api_key: "sk-test".to_string(), base_url: None, disabled: false });
        assert_eq!(no_base.status, STATUS_UNSUPPORTED);
        assert_eq!(no_base.unsupported_reason.as_deref(), Some(UNSUPPORTED_NO_BASE_URL));

        let off = resolve_quota(
            "hakimi",
            &ApiCredential {
                api_key: "sk-test".to_string(),
                base_url: Some("https://vip.aipro.love/v1".to_string()),
                disabled: true,
            },
        );
        assert_eq!(off.unsupported_reason.as_deref(), Some(UNSUPPORTED_DISABLED));

        // Both probes missing is the one case where the vendor really has no quota API.
        let no_api = combine_probes("relay", Probe::Missing("404".to_string()), Probe::Missing("404".to_string()), now);
        assert_eq!(no_api.status, STATUS_UNSUPPORTED);
        assert_eq!(no_api.unsupported_reason.as_deref(), Some(UNSUPPORTED_NO_API));

        // Nothing that is not `unsupported` may carry a reason: the card treats its presence as
        // "explain why we did not ask", and a stray token on an `ok` row would hide real numbers.
        let ok = ProviderQuota::ok("p", KIND_NEWAPI, "usd", now);
        assert!(ok.unsupported_reason.is_none());
        let console = qwen_console("qwen", now);
        assert!(console.unsupported_reason.is_none());
    }

    #[test]
    fn a_gateway_without_a_quota_api_is_unsupported_not_an_error() {
        let now = 1_763_000_000;
        let unsupported = combine_probes(
            "custom_x",
            Probe::Missing("New API vip.example: HTTP 404".to_string()),
            Probe::Missing("billing vip.example: HTTP 404".to_string()),
            now,
        );
        assert_eq!(unsupported.status, STATUS_UNSUPPORTED);
        assert_eq!(unsupported.kind, KIND_NONE);
        let detail = unsupported.detail.expect("detail keeps the diagnostics");
        assert!(detail.contains("404"), "detail: {detail}");

        // An endpoint that exists and answers badly is still an error.
        let broken = combine_probes(
            "custom_x",
            Probe::Failed(ProviderQuota::failure("custom_x", STATUS_ERROR, KIND_NEWAPI, "HTTP 500", now)),
            Probe::Missing("billing vip.example: HTTP 404".to_string()),
            now,
        );
        assert_eq!(broken.status, STATUS_ERROR);

        // A refusal outranks everything, and keeps both diagnostics.
        let refused = combine_probes(
            "custom_x",
            Probe::Missing("New API vip.example: HTTP 404".to_string()),
            Probe::Failed(ProviderQuota::failure("custom_x", STATUS_UNAUTHORIZED, KIND_BILLING, "HTTP 401", now)),
            now,
        );
        assert_eq!(refused.status, STATUS_UNAUTHORIZED);

        // A usable answer ends the search whichever probe produced it.
        let mut good = ProviderQuota::ok("custom_x", KIND_NEWAPI, "credits", now);
        good.remaining = Some(4_200.0);
        let snapshot = combine_probes("custom_x", Probe::Missing("no".to_string()), Probe::Snapshot(good), now);
        assert_eq!(snapshot.status, STATUS_OK);
        assert_eq!(snapshot.remaining, Some(4_200.0));
    }

    #[test]
    fn a_gateway_refusal_inside_a_200_body_is_unauthorized() {
        // New API answers a bad key with HTTP 200 and `success: false`.
        assert!(body_refuses_credentials(r#"{"success":false,"message":"access token 无效"}"#));
        assert!(body_refuses_credentials(r#"{"code":false,"message":"invalid token"}"#));
        // A real quota payload is never mistaken for a refusal.
        assert!(!body_refuses_credentials(
            r#"{"code":true,"data":{"remain_quota":100,"used_quota":5},"message":"ok"}"#
        ));
        assert!(!body_refuses_credentials(r#"{"code":false}"#));
        assert!(!body_refuses_credentials("<html>not json</html>"));
    }

    #[test]
    fn missing_credentials_error_names_no_key() {
        let value = serde_json::json!({ "credentials": {} });
        // No `Debug` on `ApiCredential` on purpose: a derived one would print the key on a panic.
        let error = match credential_from_value(&value, "openrouter") {
            Ok(credential) => panic!("resolved {} bytes of key for a provider that has none", credential.api_key.len()),
            Err(error) => error,
        };
        assert_eq!(error, "没有该供应商的凭据");
        assert!(credential_from_value(&serde_json::json!({}), "anything").is_err());
    }

    #[test]
    fn civil_dates_round_trip() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        for days in [-20_000_i64, -1, 0, 1, 12_345, 19_782, 20_000, 40_000] {
            let (year, month, day) = civil_from_days(days);
            assert_eq!(days_from_civil(year, month, day), days);
        }
        assert_eq!(date_string((2024, 2, 9)), "2024-02-09");
    }

    #[test]
    fn iso_timestamps_parse_and_their_junk_is_rejected() {
        assert_eq!(iso8601_to_unix("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso8601_to_unix("1970-01-02T00:00:01Z"), Some(86_401));
        assert_eq!(iso8601_to_unix("2027-13-05T00:00:00Z"), None);
        assert_eq!(iso8601_to_unix("2027-05-05"), None);
        assert_eq!(iso8601_to_unix(""), None);
    }

    #[test]
    fn local_date_is_a_valid_day_near_utc() {
        let now = now_unix();
        let local = date_string(local_civil(now));
        assert_eq!(local.len(), 10);
        let bytes = local.as_bytes();
        assert_eq!(bytes[4], b'-');
        assert_eq!(bytes[7], b'-');
        let utc = date_string(utc_civil(now));
        let local_days =
            days_from_civil(local[0..4].parse().unwrap(), local[5..7].parse().unwrap(), local[8..10].parse().unwrap());
        let utc_days =
            days_from_civil(utc[0..4].parse().unwrap(), utc[5..7].parse().unwrap(), utc[8..10].parse().unwrap());
        // A timezone can only ever shift the calendar date by one day.
        assert!((local_days - utc_days).abs() <= 1, "local {local} vs utc {utc}");
    }

    #[test]
    fn cache_round_trips_through_the_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(CACHE_FILE);
        let mut cache = QuotaCache::default();
        let mut quota = ProviderQuota::ok("openrouter", KIND_OPENROUTER, "usd", NOW);
        quota.limit = Some(10.0);
        quota.remaining = Some(9.5);
        cache.items.insert("openrouter".to_string(), quota);
        write_cache_at(&path, &cache).unwrap();

        let restored = read_cache_at(&path);
        let restored = restored.items.get("openrouter").expect("entry kept");
        assert_eq!(restored.limit, Some(10.0));
        assert_eq!(restored.remaining, Some(9.5));
        assert_eq!(restored.fetched_at, NOW);

        // A corrupt file must read as empty instead of failing the command.
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(read_cache_at(&path).items.is_empty());
        assert!(read_cache_at(&directory.path().join("absent.json")).items.is_empty());
    }

    #[test]
    fn a_recent_success_survives_a_failed_refresh() {
        let mut cache = QuotaCache::default();
        let mut previous = ProviderQuota::ok("openrouter", KIND_OPENROUTER, "usd", NOW - 60);
        previous.limit = Some(10.0);
        previous.remaining = Some(4.0);
        cache.items.insert("openrouter".to_string(), previous);

        let failure = ProviderQuota::failure("openrouter", STATUS_UNREACHABLE, KIND_OPENROUTER, "timeout", NOW);
        let kept = preserve_recent_success(&cache, "openrouter", failure, NOW);
        assert_eq!(kept.status, STATUS_OK);
        assert_eq!(kept.remaining, Some(4.0));
        assert_eq!(kept.detail.as_deref(), Some("stale"));
        assert_eq!(kept.fetched_at, NOW - 60);

        // Older than the window: the failure is what the user sees.
        let old = ProviderQuota { fetched_at: NOW - STALE_WINDOW_SECONDS, ..cache.items["openrouter"].clone() };
        let mut stale_cache = QuotaCache::default();
        stale_cache.items.insert("openrouter".to_string(), old);
        let failure = ProviderQuota::failure("openrouter", STATUS_UNREACHABLE, KIND_OPENROUTER, "timeout", NOW);
        assert_eq!(preserve_recent_success(&stale_cache, "openrouter", failure, NOW).status, STATUS_UNREACHABLE);

        // A fresh success always wins, and an unknown provider just reports the failure.
        let success = ProviderQuota::ok("openrouter", KIND_OPENROUTER, "usd", NOW);
        assert_eq!(preserve_recent_success(&cache, "openrouter", success, NOW).status, STATUS_OK);
        let failure = ProviderQuota::failure("nobody", STATUS_UNSUPPORTED, KIND_NONE, "nope", NOW);
        assert_eq!(preserve_recent_success(&cache, "nobody", failure, NOW).status, STATUS_UNSUPPORTED);
    }

    #[test]
    fn counter_headers_accept_absolute_and_relative_reset() {
        assert_eq!(header_reset_at("1800000000", NOW), Some(1_800_000_000));
        assert_eq!(header_reset_at("120", NOW), Some(NOW + 120));
        assert_eq!(header_reset_at(" 120 , 120;w=60", NOW), Some(NOW + 120));
        assert_eq!(header_reset_at("soon", NOW), None);
        assert_eq!(header_reset_at("-5", NOW), None);
        assert_eq!(header_count("20"), Some(20));
        assert_eq!(header_count("977 , 1000;w=60"), Some(977));
        assert_eq!(header_count("1.5"), None);
        assert_eq!(header_count(""), None);
    }

    /// Live probe of a New API relay (the 哈基米 gateway). Same opt-in rules as the OpenRouter one:
    /// `ALWITH_RELAY_KEY=sk-... cargo test --lib live_relay -- --include-ignored --nocapture`
    /// Optional `ALWITH_RELAY_BASE` points it at another gateway (default: `https://vip.aipro.love/v1`).
    #[test]
    #[ignore = "network + real key; run manually"]
    fn live_relay_usage_endpoint() {
        let Ok(api_key) = std::env::var("ALWITH_RELAY_KEY") else {
            panic!("set ALWITH_RELAY_KEY to the gateway's API key");
        };
        let base_url = std::env::var("ALWITH_RELAY_BASE").unwrap_or_else(|_| "https://vip.aipro.love/v1".to_string());
        let credential = ApiCredential { api_key, base_url: Some(base_url), disabled: false };
        let quota = resolve_quota("hakimi", &credential);
        println!(
            "live relay: status={} kind={} limit={:?} used={:?} remaining={:?} unit={:?} plan={:?} expires_at={:?} detail={:?}",
            quota.status,
            quota.kind,
            quota.limit,
            quota.used,
            quota.remaining,
            quota.unit,
            quota.plan,
            quota.expires_at,
            quota.detail
        );
        assert!(
            matches!(quota.status.as_str(), STATUS_OK | STATUS_UNAUTHORIZED | STATUS_UNSUPPORTED),
            "an unreachable or broken gateway is a finding, not a pass: {:?}",
            quota.detail
        );
    }

    /// Not part of the default run: it hits the network and needs a real key. `#[ignore]` keeps
    /// CI hermetic while still letting us confirm the adapter against the live endpoint:
    /// `ALWITH_OPENROUTER_KEY=sk-or-... cargo test --lib live_openrouter -- --ignored --nocapture`
    #[test]
    #[ignore = "network + real key; run manually"]
    fn live_openrouter_key_endpoint() {
        let Ok(api_key) = std::env::var("ALWITH_OPENROUTER_KEY") else {
            panic!("set ALWITH_OPENROUTER_KEY to a real OpenRouter key");
        };
        let quota = openrouter_quota("openrouter", "", &api_key, now_unix());
        println!(
            "live openrouter: status={} limit={:?} used={:?} remaining={:?} detail={:?} expires_at={:?}",
            quota.status, quota.limit, quota.used, quota.remaining, quota.detail, quota.expires_at
        );
        assert_eq!(quota.status, STATUS_OK, "detail: {:?}", quota.detail);
        assert_eq!(quota.kind, KIND_OPENROUTER);
        assert_eq!(quota.unit.as_deref(), Some("usd"));
        // The endpoint always answers with `usage`; a key without allowance reports `limit: 0`.
        assert!(quota.used.is_some() || quota.limit.is_none(), "usage field missing");
    }

    /// The three free-usage tests share one process-wide state, so they take this lock instead of
    /// racing each other inside `cargo test`'s parallel threads.
    fn free_test_lock() -> MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|error| error.into_inner())
    }

    #[test]
    fn free_state_counters_and_blocking() {
        let _serial = free_test_lock();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("openrouter-free.json");
        set_test_free_path(Some(path.clone()));
        reset_free_state();
        let today = date_string(local_civil(now_unix()));

        // Only `:free` models are counted, and each call is written through to disk.
        record_free_call("gpt-4o");
        record_free_call("openrouter/anthropic/claude-sonnet-4");
        assert_eq!(free_usage().calls, 0);
        record_free_call("meta-llama/llama-3.1-8b-instruct:free");
        record_free_call("DeepSeek/DeepSeek-R1:free");
        let usage = free_usage();
        assert_eq!(usage.calls, 2);
        assert!(!usage.blocked);
        // Nothing but the local tally is known yet: no vendor number has been adopted.
        assert_eq!((usage.limit, usage.remaining, usage.reset_at), (None, None, None));
        assert_eq!(usage.reset_source, None);
        let stored: FreeState = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored.calls, 2);
        assert_eq!(stored.date, today);

        // Rate-limit headers are per-window evidence. With no key-endpoint number on record they
        // are also the only thing there is to display.
        record_openrouter_headers(&[
            ("X-RateLimit-Limit".to_string(), "20".to_string()),
            ("x-ratelimit-remaining".to_string(), "19".to_string()),
            ("x-unrelated".to_string(), "1".to_string()),
        ]);
        let usage = free_usage();
        assert_eq!((usage.limit, usage.remaining), (Some(20), Some(19)));
        assert_eq!(usage.reset_source.as_deref(), Some("vendor"));
        assert!(!usage.blocked);

        // Condition 1: the vendor enforced the limit and reports nothing left.
        record_openrouter_headers(&[("x-ratelimit-remaining".to_string(), "0".to_string())]);
        assert!(free_quota_blocked());

        // A window end the vendor sent keeps that reading current without any timestamp of ours.
        let window_end = now_unix() + 60;
        let mut state = lock_free();
        state.window_reset_at = Some(window_end);
        drop(state);
        assert!(free_quota_blocked());
        assert_eq!(free_quota_reset_at(), Some(window_end));

        // Condition 2: the window is over, so the evidence is cleared and nothing blocks.
        let mut state = lock_free();
        state.window_reset_at = Some(now_unix() - 1);
        drop(state);
        assert!(!free_quota_blocked());
        let usage = free_usage();
        assert_eq!((usage.remaining, usage.reset_at), (None, None));
        assert!(!usage.blocked);

        // A reading we cannot date must not block, and must not be invented into one.
        reset_free_state();
        let mut state = lock_free();
        *state = FreeState {
            date: today.clone(),
            window_limit: Some(1_000),
            window_remaining: Some(0),
            window_at: Some(now_unix() - REPORTED_TTL_SECONDS - 1),
            ..FreeState::default()
        };
        drop(state);
        assert!(!free_quota_blocked(), "an undated zero never blocks");
        assert_eq!(free_usage().remaining, Some(0), "but the display keeps what was reported");

        // A day boundary clears the local tally and leaves the vendor numbers alone.
        reset_free_state();
        record_free_call("model:free");
        let mut state = lock_free();
        state.date = "1999-01-01".to_string();
        state.calls = 99;
        state.daily_limit = Some(1_000);
        state.daily_remaining = Some(5);
        state.daily_at = Some(now_unix());
        drop(state);
        let usage = free_usage();
        assert_eq!(usage.calls, 0);
        assert_eq!(usage.date, today);
        assert_eq!(usage.remaining, Some(5), "the UTC-day budget survives our local midnight");

        // A corrupt counter file reads as a fresh day instead of failing the getter.
        std::fs::write(&path, b"{ broken").unwrap();
        let recovered = load_free_state(now_unix());
        assert_eq!(recovered.calls, 0);
        assert_eq!(recovered.date, today);
        // A stored local day that is behind today restarts our tally but keeps the vendor numbers.
        let stored = FreeState {
            date: "1999-01-01".to_string(),
            calls: 7,
            daily_limit: Some(1_000),
            daily_remaining: Some(3),
            daily_at: Some(now_unix()),
            ..FreeState::default()
        };
        std::fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
        let restored = load_free_state(now_unix());
        assert_eq!(restored.calls, 0);
        assert_eq!(restored.daily_remaining, Some(3));

        set_test_free_path(None);
        reset_free_state();
    }

    /// The precedence rule: `free_model_daily_requests` from `GET /api/v1/key` is the vendor's own
    /// UTC-day counter and the documented source, so it outranks both the local tally and the
    /// per-window header numbers.
    #[test]
    fn vendor_daily_counter_outranks_the_local_tally() {
        let _serial = free_test_lock();
        let directory = tempfile::tempdir().unwrap();
        set_test_free_path(Some(directory.path().join("openrouter-free.json")));
        reset_free_state();
        // Three local calls today, and a header window saying 7 of 20 are left…
        for _ in 0..3 {
            record_free_call("vendor/model:free");
        }
        record_openrouter_headers(&[
            ("x-ratelimit-limit".to_string(), "20".to_string()),
            ("x-ratelimit-remaining".to_string(), "7".to_string()),
        ]);
        // …then the key endpoint answers with the documented UTC-day counter.
        let body = serde_json::json!({
            "data": {
                "limit": 0,
                "usage": 0.000774,
                "is_free_tier": false,
                "free_model_daily_requests": { "used": 12, "limit": 1000, "remaining": 988 }
            }
        })
        .to_string();
        seed_free_budget(&body);

        let usage = free_usage();
        assert_eq!(usage.limit, Some(1_000), "the vendor's tier limit wins over the 20/request window");
        assert_eq!(usage.remaining, Some(988), "the vendor's remaining wins over the header window");
        assert_eq!(usage.calls, 3, "the local tally is still reported, it just no longer outranks");
        assert_eq!(usage.reset_source.as_deref(), Some("utcDay"), "computed rollover, not a vendor timestamp");
        let midnight = (now_unix().div_euclid(86_400) + 1) * 86_400;
        assert_eq!(usage.reset_at, Some(midnight));
        assert_eq!(midnight % 86_400, 0, "the instant we expose is midnight UTC");
        assert!(!usage.blocked, "a policy reading of 988 is not a refusal");
        assert_eq!(free_quota_reset_at(), Some(midnight));

        // The policy number may never block, but a real 429 header still can — and it must not
        // rewrite what the card displays.
        record_openrouter_headers(&[("x-ratelimit-remaining".to_string(), "0".to_string())]);
        assert!(free_quota_blocked(), "enforcement evidence still blocks");
        assert_eq!(free_usage().remaining, Some(988), "blocking never overwrites the displayed budget");

        // A `remaining: 0` that is *only* policy must not block either.
        reset_free_state();
        let exhausted = serde_json::json!({
            "data": { "free_model_daily_requests": { "used": 1000, "limit": 1000, "remaining": 0 } }
        })
        .to_string();
        seed_free_budget(&exhausted);
        let usage = free_usage();
        assert_eq!(usage.remaining, Some(0));
        assert!(!usage.blocked, "the key endpoint's zero is a policy statement, not proof of refusal");
        assert!(!free_quota_blocked());

        // A counter read on an earlier UTC day has rolled over: the tier limit still stands, but how
        // much of today's allowance is left is unknown until the card is refreshed again.
        reset_free_state();
        let mut state = lock_free();
        state.daily_limit = Some(1_000);
        state.daily_remaining = Some(988);
        state.daily_at = Some(now_unix() - 86_400);
        drop(state);
        let usage = free_usage();
        assert_eq!(usage.limit, Some(1_000));
        assert_eq!(usage.remaining, None, "yesterday's remainder is not today's remainder");
        assert_eq!(usage.reset_at, Some((now_unix().div_euclid(86_400) + 1) * 86_400));

        set_test_free_path(None);
        reset_free_state();
    }

    /// Cross-check for `bridge`: a paid call carries no free-model accounting. Nothing it passes here
    /// may move the tally, and an empty header list must be a no-op rather than a reset.
    #[test]
    fn a_paid_response_does_not_touch_the_free_tally() {
        let _serial = free_test_lock();
        let directory = tempfile::tempdir().unwrap();
        set_test_free_path(Some(directory.path().join("openrouter-free.json")));
        reset_free_state();

        for model in ["openrouter/anthropic/claude-sonnet-4", "openrouter/openai/gpt-4o", "openrouter/auto"] {
            assert!(!is_free_model(model), "{model} must never be counted as a free call");
            record_free_call(model);
        }
        record_openrouter_headers(&[]);

        let usage = free_usage();
        assert_eq!(usage.calls, 0);
        assert_eq!((usage.limit, usage.remaining, usage.reset_at), (None, None, None));
        assert_eq!(usage.reset_source, None);
        assert!(!usage.blocked);
        assert_eq!(free_quota_reset_at(), None);

        set_test_free_path(None);
        reset_free_state();
    }
}
