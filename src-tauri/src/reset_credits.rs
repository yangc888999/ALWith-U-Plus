//! ChatGPT「额度重置卡」只读快照。
//!
//! 网页用量页的「使用限额重置」读的是内部接口
//! `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`，用 ChatGPT 的
//! access token 签名（`chatgpt_auth::read()` 拿到的就是 Codex 刷新后的那一份）。这里只取两件事：
//!
//! * `available_count` —— 还有几张可兑换。这是**权威值**：`credits` 数组会被后端截断，
//!   所以拿 `credits.length` 当次数会少报。
//! * 可兑换的卡本身（`status == "available"`），按到期时间升序 —— 先用快到期的，
//!   前端按返回顺序展示即可。
//!
//! 两条设计上的红线：
//!
//! * **不兑换**。兑换不可逆（一张卡换一次限额刷新），所以本模块只有 GET，没有 consume。
//! * **不猜次数**。拿不到权威值就明确说拿不到（`available_count: 0` + 对应 status），
//!   失败时最多回放 24 小时内缓存过的快照并把状态降级为 `stale`。
//!
//! 兑换（[`chatgpt_reset_credit`]）是唯一的状态变更请求：`POST .../consume`，带一个幂等的
//! `redeem_request_id`。它只在用户明确点「立即重置」后发出，且一次点击只发一次 —— 重试会
//! 用掉第二张卡。结果的四种 `code` 原样回传，由前端决定文案。
//!
//! 命令始终返回 `Ok`：未登录、离线、接口 5xx 都是会被渲染的日常状态，
//! 抛 `Err` 只会让面板卡在 loading 上，而不是显示「未登录」。

use serde_json::Value;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

/// 内部接口。与网页用量页同源，没有公开 API 版本，随时可能变。
pub(crate) const ENDPOINT: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

/// 兑换端点。不可逆：一张卡换一次限额刷新。
pub(crate) const CONSUME_ENDPOINT: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";


/// 快照缓存，落在 `app.path().app_data_dir()` 下。
const CACHE_FILE: &str = "chatgpt-reset-credits.json";

/// 接口失败时最多回放多久以内的快照（秒）。超过它宁可显示空，也不显示过期次数。
const STALE_TTL_SECS: i64 = 24 * 60 * 60;

/// 连不上就别让用户盯着转圈：握手阶段 10s 放弃。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// 整个请求（含响应体）15s 上限；这个接口只回几百字节。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// 快照正常。
const STATUS_OK: &str = "ok";
/// 缓存回放：数据是旧的，次数照抄缓存。
const STATUS_STALE: &str = "stale";
/// token 过期/无权限（401/403），提示用户重新登录 ChatGPT。
const STATUS_UNAUTHORIZED: &str = "unauthorized";
/// 网络不可达（离线、代理、防火墙）。
const STATUS_UNREACHABLE: &str = "unreachable";
/// 其他失败（非 2xx、响应不是预期 JSON）。
const STATUS_ERROR: &str = "error";
/// 本机没有 ChatGPT 凭据。
const STATUS_SIGNED_OUT: &str = "signedOut";
/// `status` 字段缺省时的占位值。
const STATUS_UNKNOWN: &str = "unknown";
/// 唯一会被计入可用条目的状态。
const STATUS_AVAILABLE: &str = "available";

/// 一张额度重置卡。日期字段原样保留 RFC3339 字符串，另外附一份解析好的 unix 秒，
/// 免得前端再解析一次、也免得时区各说各话。
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResetCredit {
    pub id: String,
    pub title: Option<String>,
    pub description: Option<String>,
    /// 原样 RFC3339 字符串（UTC），解析失败时为 `None`。
    pub granted_at: Option<String>,
    /// 原样 RFC3339 字符串（UTC），解析失败时为 `None`。
    pub expires_at: Option<String>,
    /// `expires_at` 的 unix 秒；缺失或解析失败为 `None`。
    pub expires_at_unix: Option<i64>,
    pub status: String,
}

/// 一次查询的结果，也是缓存文件的内容。
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResetCredits {
    /// `ok` | `stale` | `unauthorized` | `unreachable` | `error` | `signedOut`
    pub status: String,
    /// 接口给出的权威可用张数。失败且无缓存时为 0 —— 不编造次数。
    pub available_count: u32,
    /// 只含 `available` 的条目，按 `expires_at_unix` 升序，无日期的排最后。
    pub credits: Vec<ResetCredit>,
    /// 本次查询的 unix 秒。
    pub fetched_at: i64,
    /// 失败原因（给日志/调试用），成功时为 `None`；`stale` 时为 `"stale"`。
    pub detail: Option<String>,
}

/// 一次失败的分类结果。`status` 决定前端文案，`detail` 只用于诊断，绝不含 token。
struct Failure {
    status: &'static str,
    detail: String,
}

/// 查询 ChatGPT 额度重置卡（只读）。
///
/// 未登录返回 `signedOut` 而不是 `Err`；接口失败时先尝试 24 小时内的缓存（降级为 `stale`），
/// 没有缓存则返回对应的空状态。任何情况下都不会兑换卡片。
#[tauri3_specta::command]
pub async fn chatgpt_reset_credits(app: tauri::AppHandle) -> Result<ResetCredits, String> {
    let now = now_unix();
    // 读的是 Codex 维护的 auth.json；签出或走 API key 时这里是 None。
    let Some(credentials) = crate::chatgpt_auth::read() else {
        return Ok(empty(STATUS_SIGNED_OUT, now, None));
    };
    let path = app.path().app_data_dir().ok().map(|directory| directory.join(CACHE_FILE));
    // reqwest 的 blocking 客户端不能在 async 上下文里跑，否则会阻塞 runtime worker。
    let fetched = tauri::async_runtime::spawn_blocking(move || fetch(&credentials))
        .await
        .map_err(|error| format!("reset credits task: {error}"))?;
    match fetched {
        Ok(snapshot) => {
            if let Some(path) = path.as_deref() {
                // 缓存写失败不影响本次结果，只是下次离线时少一份兜底。
                let _ = crate::secret_store::write_json(path, &snapshot);
            }
            Ok(snapshot)
        }
        Err(failure) => {
            if let Some(cached) = path.as_deref().and_then(|path| read_cache(path, now)) {
                return Ok(ResetCredits {
                    status: STATUS_STALE.to_string(),
                    detail: Some(STATUS_STALE.to_string()),
                    ..cached
                });
            }
            Ok(empty(failure.status, now, Some(failure.detail)))
        }
    }
}

/// 一次兑换的结果。`code` 是后端的原话，翻译留给前端。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedeemResult {
    /// `reset` | `nothing_to_reset` | `no_credit` | `already_redeemed`
    pub code: String,
    /// 被清零的限额窗口数量；后端没给就是 `None`。
    pub windows_reset: Option<u32>,
    /// 实际被消耗的那张卡。
    pub credit_id: Option<String>,
}

/// 兑换一张额度重置卡。
///
/// `credit_id` 为 `None` 时由后端自己挑。每次调用生成新的 `redeem_request_id`，并且**不重试**：
/// 一次网络抖动后的自动重试会花掉第二张卡。
#[tauri3_specta::command]
pub async fn chatgpt_reset_credit(credit_id: Option<String>) -> Result<RedeemResult, String> {
    let Some(credentials) = crate::chatgpt_auth::read() else {
        return Err(SIGNED_OUT_REASON.to_string());
    };
    tauri::async_runtime::spawn_blocking(move || consume(&credentials, credit_id.as_deref()))
        .await
        .map_err(|error| format!("reset credit task: {error}"))?
}

/// 未登录时给前端的固定文案。前端据此区分「要重新登录」和「这次没换成」。
pub(crate) const SIGNED_OUT_REASON: &str = "未登录 ChatGPT，无法重置额度。";

fn consume(
    credentials: &crate::chatgpt_auth::Credentials,
    credit_id: Option<&str>,
) -> Result<RedeemResult, String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| format!("http client: {error}"))?;
    let mut body = serde_json::Map::new();
    body.insert("redeem_request_id".into(), Value::String(uuid::Uuid::new_v4().to_string()));
    if let Some(id) = credit_id {
        body.insert("credit_id".into(), Value::String(id.to_string()));
    }
    let response = client
        .post(CONSUME_ENDPOINT)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", credentials.access_token))
        .header("ChatGPT-Account-Id", credentials.account_id.as_str())
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&Value::Object(body))
        .send()
        .map_err(|error| format!("request: {error}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("ChatGPT 登录已失效，请重新登录后再试。".into());
    }
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}：{}", status.as_u16(), text.chars().take(200).collect::<String>()));
    }
    let json: Value = serde_json::from_str(&text).map_err(|error| format!("consume JSON: {error}"))?;
    Ok(RedeemResult {
        code: json.get("code").and_then(Value::as_str).unwrap_or("unknown").to_string(),
        windows_reset: json.get("windows_reset").and_then(Value::as_u64).map(|value| value as u32),
        credit_id: json
            .get("credit")
            .and_then(|credit| credit.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

/// 一次 GET。成功即 `status: "ok"` 的快照，失败按 401/403、网络、其他三类归档。
///
/// 请求头里的 token 与 account id 绝不出现在 `detail` 里：它们只会被写进 header。
fn fetch(credentials: &crate::chatgpt_auth::Credentials) -> Result<ResetCredits, Failure> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| Failure { status: STATUS_ERROR, detail: format!("http client: {error}") })?;
    let response = client
        .get(ENDPOINT)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", credentials.access_token))
        .header("ChatGPT-Account-Id", credentials.account_id.as_str())
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .map_err(|error| Failure { status: STATUS_UNREACHABLE, detail: format!("request: {error}") })?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        // 过期或不属于这个账号：让用户重新登录，重试没有意义。
        return Err(Failure { status: STATUS_UNAUTHORIZED, detail: format!("HTTP {}", status.as_u16()) });
    }
    if !status.is_success() {
        return Err(Failure { status: STATUS_ERROR, detail: format!("HTTP {}", status.as_u16()) });
    }
    let text =
        response.text().map_err(|error| Failure { status: STATUS_UNREACHABLE, detail: format!("body: {error}") })?;
    parse_response(&text, now_unix()).map_err(|error| Failure { status: STATUS_ERROR, detail: error })
}

/// 解析接口响应。纯函数，便于单测。
///
/// * `available_count` 缺失、不是整数或为负 → 0；`credits` 缺失或不是数组 → 空列表。
/// * 每条必须有非空 `id`，否则跳过；`status` 缺省 `"unknown"`。
/// * 只有 `status` 等于 `available`（大小写不敏感）的条目进入 `credits`。
/// * 按 `expires_at_unix` 升序，`None` 排最后（同键保持接口给的顺序）。
pub(crate) fn parse_response(text: &str, now: i64) -> Result<ResetCredits, String> {
    let json: Value = serde_json::from_str(text).map_err(|error| format!("reset credits JSON: {error}"))?;
    let available_count = json
        .get("available_count")
        .and_then(Value::as_i64)
        .filter(|count| *count > 0)
        .map(|count| u32::try_from(count).unwrap_or(u32::MAX))
        .unwrap_or(0);
    let mut credits: Vec<ResetCredit> = Vec::new();
    if let Some(entries) = json.get("credits").and_then(Value::as_array) {
        for entry in entries {
            let Some(id) = text_field(entry, "id") else {
                // 没有 id 就没法稳定标识这张卡，UI 也做不了 key。
                continue;
            };
            let status = text_field(entry, "status").unwrap_or_else(|| STATUS_UNKNOWN.to_string());
            if !status.eq_ignore_ascii_case(STATUS_AVAILABLE) {
                // 已兑换 / 已过期的卡后端也会返回，但不是「可用」，不计入也不展示。
                continue;
            }
            let expires_at = text_field(entry, "expires_at");
            let expires_at_unix = expires_at.as_deref().and_then(parse_rfc3339_utc);
            credits.push(ResetCredit {
                id,
                title: text_field(entry, "title"),
                description: text_field(entry, "description"),
                granted_at: text_field(entry, "granted_at"),
                expires_at,
                expires_at_unix,
                status,
            });
        }
    }
    credits.sort_by_key(|credit| match credit.expires_at_unix {
        Some(unix) => (0u8, unix),
        None => (1u8, i64::MAX),
    });
    Ok(ResetCredits { status: STATUS_OK.to_string(), available_count, credits, fetched_at: now, detail: None })
}

/// 读取一个可选字符串字段：缺失、不是字符串、或去空白后为空都算 `None`。
fn text_field(entry: &Value, key: &str) -> Option<String> {
    entry.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

/// 解析 `YYYY-MM-DDTHH:MM:SS(.fff)?Z`（UTC）为 unix 秒；其他格式（含非 Z 时区）一律 `None`。
///
/// 只此一种形态需要支持，所以不引 chrono/time —— 接口给的就是 UTC 的 RFC3339。
fn parse_rfc3339_utc(text: &str) -> Option<i64> {
    let bytes = text.trim().as_bytes();
    // 最短形态 "YYYY-MM-DDTHH:MM:SSZ" 正好 20 字节。
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    if bytes[10] != b'T' && bytes[10] != b't' {
        return None;
    }
    let year = number(&bytes[0..4])?;
    let month = number(&bytes[5..7])?;
    let day = number(&bytes[8..10])?;
    let hour = number(&bytes[11..13])?;
    let minute = number(&bytes[14..16])?;
    let second = number(&bytes[17..19])?;
    // 小数秒可选，精度不保留（unix 秒是秒级）。
    let rest = &bytes[19..];
    let zone = match rest.first() {
        Some(b'.') => {
            let mut index = 1;
            while index < rest.len() && rest[index].is_ascii_digit() {
                index += 1;
            }
            if index == 1 {
                // 有小数点却没数字。
                return None;
            }
            &rest[index..]
        }
        _ => rest,
    };
    // 只接受 UTC 标记；`+08:00` 之类一律当作不认识，宁可没有到期时间。
    if zone != b"Z" && zone != b"z" {
        return None;
    }
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// 定长 ASCII 数字串 → 整数；出现非数字返回 `None`。
fn number(bytes: &[u8]) -> Option<i64> {
    let mut value = 0i64;
    for byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value.checked_mul(10)?.checked_add(i64::from(byte - b'0'))?;
    }
    Some(value)
}

/// 该年该月的天数（含闰年规则）。
fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

/// 公历日期 → 1970-01-01 起的天数（Howard Hinnant 的 days_from_civil）。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// 空/失败的快照。`available_count` 恒为 0：没有权威值就不给数字。
fn empty(status: &str, now: i64, detail: Option<String>) -> ResetCredits {
    ResetCredits { status: status.to_string(), available_count: 0, credits: Vec::new(), fetched_at: now, detail }
}

/// 读回缓存；超过 [`STALE_TTL_SECS`] 或文件损坏当作没有缓存。
fn read_cache(path: &Path, now: i64) -> Option<ResetCredits> {
    let bytes = std::fs::read(path).ok()?;
    let cached: ResetCredits = serde_json::from_slice(&bytes).ok()?;
    let age = now.saturating_sub(cached.fetched_at);
    if age > STALE_TTL_SECS {
        return None;
    }
    Some(cached)
}

/// 当前 unix 秒。
fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: i64 = 1_781_000_000;

    /// 官方响应形态：两张可用卡，一张更早到期（后端给的顺序是反的，好验证排序）。
    fn official_sample() -> String {
        json!({
            "credits": [
                {
                    "id": "RateLimitResetCredit_late",
                    "reset_type": "codex_rate_limits",
                    "status": "available",
                    "granted_at": "2026-06-17T00:00:00Z",
                    "expires_at": "2026-07-17T00:00:00Z",
                    "title": "Full reset (Weekly + 5 hr)",
                    "description": "Ready to redeem"
                },
                {
                    "id": "RateLimitResetCredit_early",
                    "reset_type": "codex_rate_limits",
                    "status": "available",
                    "granted_at": "2026-06-01T00:00:00Z",
                    "expires_at": "2026-06-30T00:00:00Z",
                    "title": "Full reset (Weekly + 5 hr)",
                    "description": "Ready to redeem"
                }
            ],
            "available_count": 2
        })
        .to_string()
    }

    #[test]
    fn official_sample_keeps_both_credits_sorted_by_expiry() {
        let parsed = parse_response(&official_sample(), NOW).unwrap();
        assert_eq!(parsed.status, STATUS_OK);
        assert_eq!(parsed.available_count, 2);
        assert_eq!(parsed.fetched_at, NOW);
        assert_eq!(parsed.detail, None);
        let ids: Vec<&str> = parsed.credits.iter().map(|credit| credit.id.as_str()).collect();
        assert_eq!(ids, vec!["RateLimitResetCredit_early", "RateLimitResetCredit_late"]);
        let first = &parsed.credits[0];
        assert_eq!(first.status, "available");
        assert_eq!(first.title.as_deref(), Some("Full reset (Weekly + 5 hr)"));
        assert_eq!(first.description.as_deref(), Some("Ready to redeem"));
        assert_eq!(first.granted_at.as_deref(), Some("2026-06-01T00:00:00Z"));
        assert_eq!(first.expires_at.as_deref(), Some("2026-06-30T00:00:00Z"));
        assert!(first.expires_at_unix.unwrap() < parsed.credits[1].expires_at_unix.unwrap());
    }

    #[test]
    fn extra_counters_do_not_override_available_count() {
        // 后端还会带 total_earned_count 之类的历史累计，它不是可用张数。
        let body = json!({
            "credits": [],
            "available_count": 2,
            "total_earned_count": 0
        })
        .to_string();
        assert_eq!(parse_response(&body, NOW).unwrap().available_count, 2);
    }

    #[test]
    fn non_available_statuses_are_filtered_out() {
        let body = json!({
            "credits": [
                {"id": "used-1", "status": "redeemed", "expires_at": "2026-07-01T00:00:00Z"},
                {"id": "gone-1", "status": "expired", "expires_at": "2026-01-01T00:00:00Z"},
                {"id": "kept-1", "status": "Available", "expires_at": "2026-08-01T00:00:00Z"},
                {"id": "", "status": "available", "expires_at": "2026-08-02T00:00:00Z"},
                {"status": "available", "expires_at": "2026-08-03T00:00:00Z"}
            ],
            "available_count": 4
        })
        .to_string();
        let parsed = parse_response(&body, NOW).unwrap();
        // available_count 是接口权威值，过滤只影响列表。
        assert_eq!(parsed.available_count, 4);
        let ids: Vec<&str> = parsed.credits.iter().map(|credit| credit.id.as_str()).collect();
        assert_eq!(ids, vec!["kept-1"]);
        assert_eq!(parsed.credits[0].status, "Available");
    }

    #[test]
    fn truncated_credit_list_still_reports_authoritative_count() {
        let body = json!({"available_count": 3}).to_string();
        let parsed = parse_response(&body, NOW).unwrap();
        assert_eq!(parsed.available_count, 3);
        assert!(parsed.credits.is_empty());

        // 非整数 / 负数 / 缺失都按 0 处理。
        for body in [
            json!({"available_count": "3", "credits": []}).to_string(),
            json!({"available_count": -2, "credits": []}).to_string(),
            json!({"credits": []}).to_string(),
        ] {
            assert_eq!(parse_response(&body, NOW).unwrap().available_count, 0, "{body}");
        }
    }

    #[test]
    fn unparsable_expiry_sorts_last_and_keeps_string() {
        let body = json!({
            "credits": [
                {"id": "no-date", "status": "available", "expires_at": "someday"},
                {"id": "no-expiry", "status": "available"},
                {"id": "dated", "status": "available", "expires_at": "2026-09-01T12:00:00.123Z"},
                {"id": "zoned", "status": "available", "expires_at": "2026-09-01T12:00:00+08:00"}
            ],
            "available_count": 4
        })
        .to_string();
        let parsed = parse_response(&body, NOW).unwrap();
        let ids: Vec<&str> = parsed.credits.iter().map(|credit| credit.id.as_str()).collect();
        // 只有带 UTC 日期的那张能排序；其余排后面，保持接口顺序。
        assert_eq!(ids, vec!["dated", "no-date", "no-expiry", "zoned"]);
        assert!(parsed.credits[0].expires_at_unix.is_some());
        assert_eq!(parsed.credits[1].expires_at_unix, None);
        assert_eq!(parsed.credits[1].expires_at.as_deref(), Some("someday"));
        assert_eq!(parsed.credits[2].expires_at, None);
        assert_eq!(parsed.credits[3].expires_at_unix, None);
    }

    #[test]
    fn rfc3339_utc_parsing() {
        // 已知锚点。
        assert_eq!(parse_rfc3339_utc("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_utc("2000-01-01T00:00:00Z"), Some(946_684_800));
        assert_eq!(parse_rfc3339_utc("2024-01-01T00:00:00Z"), Some(1_704_067_200));
        // 闰日。
        assert_eq!(parse_rfc3339_utc("2024-02-29T00:00:00Z"), Some(1_709_164_800));
        assert_eq!(parse_rfc3339_utc("2023-03-01T00:00:00Z"), Some(1_677_628_800));
        // 毫秒小数精度被截断，秒值不变。
        assert_eq!(parse_rfc3339_utc("2024-01-01T00:00:00.123Z"), Some(1_704_067_200));
        assert_eq!(parse_rfc3339_utc("2024-01-01T00:00:00.9Z"), Some(1_704_067_200));
        // 前后空白容忍。
        assert_eq!(parse_rfc3339_utc(" 2024-01-01T00:00:00Z "), Some(1_704_067_200));
        // 非 Z 时区不猜偏移。
        assert_eq!(parse_rfc3339_utc("2024-01-01T00:00:00+08:00"), None);
        assert_eq!(parse_rfc3339_utc("2024-01-01T00:00:00-05:00"), None);
        assert_eq!(parse_rfc3339_utc("2024-01-01T00:00:00"), None);
        // 结构不对。
        assert_eq!(parse_rfc3339_utc(""), None);
        assert_eq!(parse_rfc3339_utc("2024-01-01"), None);
        assert_eq!(parse_rfc3339_utc("2024-01-01T00:00:00.Z"), None);
        assert_eq!(parse_rfc3339_utc("2024-13-01T00:00:00Z"), None);
        assert_eq!(parse_rfc3339_utc("2023-02-29T00:00:00Z"), None);
        assert_eq!(parse_rfc3339_utc("2024-01-01T24:00:00Z"), None);
        assert_eq!(parse_rfc3339_utc("2024-1-1T00:00:00Z"), None);
    }

    #[test]
    fn invalid_json_is_an_error_but_unknown_shape_is_empty() {
        assert!(parse_response("not json", NOW).is_err());
        // 顶层是个数组/别的对象时不算错误：没有可用信息就交空快照，让 UI 照常渲染。
        let parsed = parse_response("[]", NOW).unwrap();
        assert_eq!(parsed.available_count, 0);
        assert!(parsed.credits.is_empty());
    }
}
