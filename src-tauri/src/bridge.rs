//! Local request-sanitizing proxy for gateways that reject `reasoning` history items with a
//! non-empty `content` array (aipro.love answers
//! `Invalid 'input[N].content': array too long. Expected ... maximum length 0` and then, on the
//! streaming path, closes the SSE stream after two metadata events — which Codex reports as
//! `stream disconnected before completion`).
//!
//! Threads written by OpenAI-family models keep plain-text `reasoning.content` in the rollout;
//! Codex replays those items verbatim on every later turn. The proxy strips exactly that field
//! from the outgoing request body and forwards everything else — status codes, headers and the
//! SSE byte stream — unchanged.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

use crate::model_identity::ModelIdentity;

/// Set once at startup so a bridge worker can tell the webview that the backend refused a turn.
/// The engine itself swallows this error into a silent `retry-after` sleep.
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// The single Codex provider that every gateway shares.
///
/// Codex pins a thread to the provider that created it and rejects `thread/resume` under any
/// other name, so switching vendors inside one conversation used to require recreating the
/// thread. Routing every model through one provider makes the vendor invisible to Codex; the
/// bridge then dispatches on the model name (`<gateway>/<model>`) to the real endpoint.
pub(crate) const ROUTER_ID: &str = "alwith";

/// Where Codex sends its own models when it is signed in with ChatGPT rather than an API key.
const CHATGPT_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";

#[derive(Clone)]
struct RouterRoute {
    base_url: String,
    bearer_token: String,
    /// Some gateways reject the `reasoning.content` that OpenAI-family rollouts carry.
    sanitize: bool,
    protocol: crate::providers::Protocol,
}

fn router_routes() -> &'static RwLock<HashMap<String, RouterRoute>> {
    static ROUTER: OnceLock<RwLock<HashMap<String, RouterRoute>>> = OnceLock::new();
    ROUTER.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Teaches the router where one gateway actually lives. Keyed by the gateway id that prefixes
/// routed model names, so two vendors may offer the same model id without colliding.
pub(crate) fn register_router_route(gateway_id: &str, base_url: &str, bearer_token: &str, sanitize: bool) {
    register_protocol_route(gateway_id, base_url, bearer_token, sanitize, crate::providers::Protocol::Responses);
}

pub(crate) fn register_protocol_route(
    gateway_id: &str, base_url: &str, bearer_token: &str, sanitize: bool, protocol: crate::providers::Protocol,
) {
    let protocol = if gateway_id == "openrouter" { protocol } else { crate::providers::Protocol::Responses };
    if let Ok(mut map) = router_routes().write() {
        map.insert(
            gateway_id.to_string(),
            RouterRoute { base_url: base_url.to_string(), bearer_token: bearer_token.to_string(), sanitize, protocol },
        );
    }
}

/// Revoke a shared-provider route, not the separate legacy provider map.
/// Enterprise callers serialize publication and revocation with their gate lock.
pub(crate) fn unregister_router_route(gateway_id: &str) {
    if let Ok(mut map) = router_routes().write() {
        map.remove(gateway_id);
    }
}

#[cfg(test)]
pub(crate) fn router_route_matches(gateway_id: &str, base_url: &str, bearer_token: &str) -> bool {
    router_routes()
        .read()
        .unwrap()
        .get(gateway_id)
        .is_some_and(|route| route.base_url == base_url && route.bearer_token == bearer_token && !route.sanitize)
}

/// The base URL Codex should use for the shared provider: `<loopback>/<ROUTER_ID>`.
pub(crate) fn router_base_url() -> Option<String> {
    Some(format!("http://127.0.0.1:{}/{ROUTER_ID}", *PORT.get()?))
}

/// Runtime provider id -> upstream base URL. Written by `reconcile`, read by bridge threads.
fn routes() -> &'static RwLock<HashMap<String, String>> {
    static ROUTES: OnceLock<RwLock<HashMap<String, String>>> = OnceLock::new();
    ROUTES.get_or_init(|| RwLock::new(HashMap::new()))
}

pub fn register_route(runtime_id: &str, upstream_base_url: &str) {
    if let Ok(mut map) = routes().write() {
        map.insert(runtime_id.to_string(), upstream_base_url.to_string());
    }
}

/// Removing a provider drops its route; the proxy then answers 404 until re-registered.
#[allow(dead_code)]
pub fn unregister_route(runtime_id: &str) {
    if let Ok(mut map) = routes().write() {
        map.remove(runtime_id);
    }
}

static PORT: OnceLock<u16> = OnceLock::new();

/// The loopback base URL Codex should use for a sanitized gateway: `/{runtime_id}/responses`.
pub fn gateway_base_url(runtime_id: &str) -> Option<String> {
    let port = *PORT.get()?;
    Some(format!("http://127.0.0.1:{port}/{runtime_id}"))
}

/// Pushed by the UI through `set_overload_mute`. Default false keeps today's behaviour: an
/// overload reaches the user as a notice. When the user flips the mute switch, `relay` swallows
/// `server_is_overloaded` and replays the same request without a ceiling until a real response
/// comes back or the stream ends — the 60-minute whole-request timeout is the only backstop.
/// `relay` reads it for every upstream request, so a settings change takes effect immediately —
/// no engine restart required.
static OVERLOAD_MUTE: AtomicBool = AtomicBool::new(false);

/// Whether the user has asked to mute every overload notice and replay in silence.
pub fn set_overload_mute(mute: bool) {
    let previous = OVERLOAD_MUTE.swap(mute, Ordering::Relaxed);
    // 开关状态写一行日志：用户报「设了没重试」时，先确认桥接层到底有没有armed，
    // 再看日志里有没有 `muted overload, immediate replay`（真正发生重放的证据）。
    if previous != mute {
        log::info!("bridge: overload mute -> {mute}");
    }
}

/// Whether `relay` should swallow `server_is_overloaded` and replay immediately.
pub fn overload_mute() -> bool {
    OVERLOAD_MUTE.load(Ordering::Relaxed)
}

/// Pushed by the UI through `set_overload_429_mute`. Default false keeps today's behaviour: an
/// upstream HTTP 429 reaches the engine and the UI as `error.providerRateLimited`. When the user
/// switches the OpenRouter「模型异常提醒」off, `relay` treats a 429 as a transient hiccup and
/// re-sends the same request instead of answering with the refusal. `relay` reads it for every
/// upstream request, so a settings change takes effect immediately — no engine restart required.
static OVERLOAD_429_MUTE: AtomicBool = AtomicBool::new(false);

/// Whether `relay` should swallow an upstream HTTP 429 and replay immediately.
pub fn set_overload_429_mute(mute: bool) {
    OVERLOAD_429_MUTE.store(mute, Ordering::Relaxed);
}

pub fn overload_429_mute() -> bool {
    OVERLOAD_429_MUTE.load(Ordering::Relaxed)
}

/// Whether a gateway route may re-send a turn whose connection dropped before the first byte.
///
/// Default **on**. A gateway request leaves through the user's tunnel to a vendor that is often
/// reached through a company relay, so a handshake that dies between the two is an infrastructure
/// flake, not an answer — and the user's only manual remedy is retyping the prompt. A second and
/// third attempt cost at most 800ms. The switch exists because a gateway the user knows to be slow
/// should not be probed twice before the real error is reported.
static GATEWAY_RETRY: AtomicBool = AtomicBool::new(true);

/// Sets the gateway retry preference. Read per request, so a settings change applies immediately.
pub fn set_gateway_retry(enabled: bool) {
    GATEWAY_RETRY.store(enabled, Ordering::Relaxed);
}

/// Whether a gateway route gets the extra transport attempt.
pub fn gateway_retry_enabled() -> bool {
    GATEWAY_RETRY.load(Ordering::Relaxed)
}

/// The UI-facing reader for the same switch. Named apart from the plain accessor above because a
/// tauri command and a plain function cannot share a name in one module.
#[tauri3_specta::command]
pub async fn gateway_retry_get() -> bool {
    gateway_retry_enabled()
}

/// The UI-facing writer for the same switch.
#[tauri3_specta::command]
pub async fn gateway_retry_set(enabled: bool) {
    set_gateway_retry(enabled);
}

/// Starts the bridge once; later calls are no-ops. Returns the bound port.
pub fn start(app: tauri::AppHandle) -> Result<u16, String> {
    let _ = APP_HANDLE.set(app);
    if let Some(port) = PORT.get() {
        return Ok(*port);
    }
    let server = tiny_http::Server::http(("127.0.0.1", 0)).map_err(|error| format!("bridge listen: {error}"))?;
    let port = server.server_addr().to_ip().map(|addr| addr.port()).ok_or("bridge port")?;
    let server = Arc::new(server);
    // A handful of workers: each holds one live streaming turn while Codex awaits it, and a
    // user can realistically have a few concurrent chats plus model-list refreshes.
    for _ in 0..6 {
        let server = Arc::clone(&server);
        std::thread::spawn(move || {
            loop {
                match server.recv() {
                    Ok(request) => {
                        if let Err(error) = handle(request) {
                            log::warn!("bridge: request failed: {error}");
                        }
                    }
                    Err(error) => {
                        log::warn!("bridge: server closed: {error}");
                        return;
                    }
                }
            }
        });
    }
    let _ = PORT.set(port);
    log::info!("bridge: sanitizing proxy listening on 127.0.0.1:{port}");
    Ok(port)
}

fn handle(request: tiny_http::Request) -> Result<(), String> {
    let method = request.method().as_str().to_ascii_lowercase();
    let path = request.url().split('?').next().unwrap_or_default().trim_matches('/').to_string();
    let Some((runtime_id, action)) = path.split_once('/') else {
        return respond(request, 404, "application/json", br#"{"error":{"message":"bridge: unknown route"}}"#);
    };
    // The shared provider: the vendor is carried by the model name instead of the URL.
    if runtime_id == ROUTER_ID {
        return match (method.as_str(), action) {
            ("post", "responses") => forward_routed(request),
            // An outside agent discovers what it may ask for by listing models. An empty list made
            // every alias unusable there, so answer with the aliases the user configured — and with
            // an empty list only when there are none.
            ("get", "models") => respond(request, 200, "application/json", &crate::external_models::model_list_json()),
            _ => respond(request, 404, "application/json", br#"{"error":{"message":"bridge: unsupported path"}}"#),
        };
    }
    let upstream_base = routes().read().ok().and_then(|map| map.get(runtime_id).cloned());
    let Some(upstream_base) = upstream_base else {
        // 1.3.0 之前每条会话绑在自己那个 provider 上（`openai` / `openrouter` / `kimi` …），
        // Codex 因此把请求打到 `/<provider>/responses`。合并成共享路由后这些路径不再注册，
        // 于是一条老会话只要换了模型就永远 404 —— 而这一支在写日志之前就 return，现场连一行
        // 痕迹都不留，日志里只能看到「模型厂商返回了 404」，把人引去核对模型 ID 和 Base URL。
        //
        // 交给共享路由重新分派：裸模型名（原生 GPT）走 chatgpt.com；`网关/模型` 查得到就转发，
        // 查不到由 missing_gateway_response 给出带厂商名的 404，UI 能翻成「厂商 X 还没有配置」。
        // 模型列表的 GET 不属于这条路径，维持原判并留下记录。
        log::warn!("bridge: unregistered gateway {runtime_id} ({method} /{action}), delegating to the shared router");
        if method == "post" && action == "responses" {
            return forward_routed(request);
        }
        return respond(request, 404, "application/json", br#"{"error":{"message":"bridge: unregistered gateway"}}"#);
    };
    let authorization = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Authorization"))
        .map(|header| header.value.as_str().to_string());

    match (method.as_str(), action) {
        ("post", "responses") => forward_responses(request, &upstream_base, authorization.as_deref()),
        ("get", "models") => {
            forward_plain(request, &upstream_endpoint(&upstream_base, "models"), "GET", authorization.as_deref())
        }
        _ => respond(request, 404, "application/json", br#"{"error":{"message":"bridge: unsupported path"}}"#),
    }
}

/// The ChatGPT backend validates every `input` item's `id` against that item's `type` and answers
/// `Invalid 'input[74].id': 'msg_…'. Expected an ID that begins with 'rs'.` when a thread crosses
/// vendors. A turn written through a gateway can carry ids minted under a different convention, so
/// switching such a chat to a native model used to be impossible: the same history the gateway
/// accepted was refused here, and every retry replayed the same item.
///
/// The repair is to drop the id, not the item. Measured against the live backend: an item with no
/// `id` is accepted (`200`) for every type below, while dropping a reasoning item loses context the
/// turn was already paid for.
const ID_PREFIX_BY_TYPE: &[(&str, &str)] = &[("reasoning", "rs"), ("message", "msg"), ("function_call", "fc")];

/// Removes the `id` from any input item whose prefix does not match its own type. Returns how many
/// were dropped, so the caller can log a real repair instead of a silent rewrite.
fn normalize_item_ids(parsed: &mut Value) -> usize {
    let Some(input) = parsed.get_mut("input").and_then(Value::as_array_mut) else {
        return 0;
    };
    let mut dropped = 0usize;
    for item in input {
        let Some(kind) = item.get("type").and_then(Value::as_str) else {
            continue;
        };
        let Some((_, prefix)) = ID_PREFIX_BY_TYPE.iter().find(|(kind_name, _)| *kind_name == kind) else {
            continue;
        };
        let mismatched = item.get("id").and_then(Value::as_str).is_some_and(|id| !id.starts_with(prefix));
        if mismatched && let Some(object) = item.as_object_mut() {
            object.remove("id");
            dropped += 1;
        }
    }
    dropped
}

/// The Responses API validates every historical `function_call.name` against
/// `^[a-zA-Z0-9_.-]+$`. Codex namespaces tools with `::` (`multi_agent_v1::spawn_agent`), which
/// Codex accepts but the backend refuses on every replay. One such item poisons the whole thread
/// at a fixed input index, so every later turn fails before the model can answer.
///
/// The name is descriptive in replayed history; the executable link is `call_id`, which is left
/// untouched. Turn `::` into a dot and map other unsafe characters to an underscore.
fn normalize_tool_call_names(parsed: &mut Value) -> usize {
    let Some(input) = parsed.get_mut("input").and_then(Value::as_array_mut) else {
        return 0;
    };
    let mut repaired = 0usize;
    for item in input {
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            continue;
        }
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let normalized = portable_function_name(name);
        if normalized != name
            && let Some(object) = item.as_object_mut()
        {
            object.insert("name".into(), Value::String(normalized));
            repaired += 1;
        }
    }
    repaired
}

fn portable_function_name(name: &str) -> String {
    let mut normalized = String::with_capacity(name.len());
    let mut chars = name.chars().peekable();
    while let Some(character) = chars.next() {
        if character == ':' && chars.peek() == Some(&':') {
            chars.next();
            normalized.push('.');
            continue;
        }
        let safe = character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-');
        normalized.push(if safe { character } else { '_' });
    }
    if normalized.is_empty() { "tool".to_string() } else { normalized }
}

/// True for the "wrong id prefix for this item type" refusal. Kept separate from
/// `is_invalid_encrypted_content`: the two have different repairs.
fn is_id_prefix_mismatch(body: &str) -> bool {
    body.contains("Expected an ID that begins with")
}

/// The index the backend named in `{"param":"input[74].id"}`, when it is present.
fn refused_input_index(body: &str) -> Option<usize> {
    let marker = "input[";
    let at = body.find(marker)? + marker.len();
    let rest = &body[at..];
    let end = rest.find(']')?;
    rest[..end].parse().ok()
}

/// Last-resort repair for an id prefix we do not have a rule for: remove that one item's `id`.
/// Returns `None` when the body or the index does not line up, so the real error still surfaces.
fn drop_item_id(body: &[u8], index: usize) -> Option<Vec<u8>> {
    let mut parsed: Value = serde_json::from_slice(body).ok()?;
    let input = parsed.get_mut("input")?.as_array_mut()?;
    let item = input.get_mut(index)?;
    item.as_object_mut()?.remove("id")?;
    log::info!("bridge: dropped the id of input[{index}] after an id-prefix refusal");
    serde_json::to_vec(&parsed).ok()
}

/// The same history with everything a switching vendor cannot own removed: reasoning items and
/// item ids. Used once, only after a gateway refused the original payload.
/// 一次拒绝最多用掉几级「削弱请求」的补救。每级只试一次，且只在响应体没有可执行语义时启动。
///
/// 上限存在的理由：补救是**试错**，不该让一次拒绝换来一串请求。真正的语义错误必须原样到达读者，
/// 不能被重试掩盖成一串无意义的等待。
const RECOVERY_MAX_STEPS: u32 = 2;

/// 裁历史时最多保留多少条 input 项。
///
/// 2026-11-19 的一次真实失败：一条开了十天的对话重放出 7.8MB / 10,690 条 input，chatgpt.com
/// 回了**空 body 的 404**。同一个账号发 8MB 的单条文本是 200，所以不是单纯的体积上限，而是条目
/// 数量与结构（海量 function_call_output + 加密 reasoning + 压缩摘要混在一起）撞上了后端的边界。
const TRIM_MAX_ITEMS: usize = 400;

/// 裁历史时的字节预算。条目上限之外再压一道：单条超长输出也能把包撑到不该有的体积。
const TRIM_BUDGET_BYTES: usize = 4 * 1024 * 1024;

/// 小于这个体积的请求不做裁剪 —— 小对话被拒是别的原因，裁了只会白丢上下文。
const TRIM_MIN_PAYLOAD: usize = 1024 * 1024;

/// True when this refusal carries nothing a reader could act on.
///
/// 只有「上游什么也没说」才值得用削弱请求的方式去试。空 body 是最典型的一种：边缘层
/// （Cloudflare、用户自己的隧道）拒绝时不会带业务语义，chatgpt.com 对这个重放包回的正是空 404。
///
/// 反过来，只要 body 里有 `{"error":{...}}`、`{"message":...}` 或任何非空文本，就说明厂商指名了
/// 某个问题（模型不存在、参数不合法、地区受限）。这时重试只会多花一次额度，还会把真实原因埋到
/// 第二次请求的错误里 —— 那正是这一版要根除的「换个说法继续失败」。
fn refusal_is_opaque(body: &str) -> bool {
    body.trim().is_empty()
}

/// 把对话历史裁到「最近的一段」，用于上游以体积或条目数拒绝整个请求的时候。
///
/// 三条不变量，破任何一条都会让下一轮换成另一种方式失败：
///   * 只从最老的一端裁，最近的上下文完整保留 —— 读者要接着问的是最近发生的事；
///   * 裁完的第一条必须是 user 消息 —— 以 assistant 或工具输出开头的历史会被上游直接拒；
///   * 不留孤儿的工具调用 —— 只有 `function_call` 没有对应的 `function_call_output`（或反过来）
///     是硬错误，比超限更难恢复。
///
/// 返回 `None` 表示「没什么可裁」，调用方据此不再重试。
fn trim_history(body: &[u8], max_items: usize, budget: usize) -> Option<Vec<u8>> {
    let mut parsed: Value = serde_json::from_slice(body).ok()?;
    let input = parsed.get_mut("input")?.as_array_mut()?;
    let total = input.len();
    if total <= 1 {
        return None;
    }
    let size_of = |item: &Value| serde_json::to_vec(item).map(|bytes| bytes.len()).unwrap_or(0);
    // 两道闸门都是**上限**，谁更紧谁说话：条目数先切出尾巴，字节预算再往里收一次。
    // 早先写成「按预算往前吃」，预算宽时会把起点一直吃到 0 —— 于是「条目太多」这种拒绝反而
    // 裁不动，而那正是最需要它的一种。
    let mut start = total.saturating_sub(max_items);
    let mut bytes: usize = 0;
    let mut cut = total;
    while cut > start {
        let size = size_of(&input[cut - 1]);
        if bytes + size > budget {
            break;
        }
        bytes += size;
        cut -= 1;
    }
    start = cut;
    if start == 0 {
        return None;
    }
    // 对齐到一个用户回合的开头：裁出来的片段不能以半截工具链或助手发言开头。
    while start < total {
        let item = &input[start];
        let is_user_message = item.get("type").and_then(Value::as_str) == Some("message")
            && item.get("role").and_then(Value::as_str) == Some("user");
        if is_user_message {
            break;
        }
        start += 1;
    }
    if start >= total {
        return None;
    }
    let mut kept: Vec<Value> = input[start..].to_vec();
    // 边界上被截断的调用/输出成对删掉。`call_id` 是两个方向唯一的关联键。
    let call_ids = |wanted: &str| -> std::collections::HashSet<String> {
        kept.iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some(wanted))
            .filter_map(|item| item.get("call_id").and_then(Value::as_str).map(str::to_string))
            .collect()
    };
    let calls = call_ids("function_call");
    let outputs = call_ids("function_call_output");
    kept.retain(|item| match item.get("type").and_then(Value::as_str) {
        Some("function_call") => item.get("call_id").and_then(Value::as_str).is_some_and(|id| outputs.contains(id)),
        Some("function_call_output") => {
            item.get("call_id").and_then(Value::as_str).is_some_and(|id| calls.contains(id))
        }
        _ => true,
    });
    let dropped = total - start;
    log::warn!(
        "bridge: trimmed {dropped} of {total} history item(s) (kept {}, about {bytes} bytes) after the upstream refused it",
        kept.len()
    );
    parsed["input"] = Value::Array(kept);
    serde_json::to_vec(&parsed).ok()
}

/// 一份被拒请求的体检摘要，只在上游拒绝时计算。
///
/// 这一行是这一整类故障的教训换来的：2026-11-19 那个 7.8MB 的重放包被 chatgpt.com 回了空
/// body，日志只留下「upstream answered 404 (7832870 bytes in): 」——体积有了，但**发的到底是
/// 什么**没有：多少条、哪一类占了多少字节。于是定位只能靠猜，猜错两次。
///
/// 现在拒绝时会写出条目数、体积，以及按字节排序的前三类 item。下一次出现同样的 404，日志自己
/// 就说明了触发条件，不必再现、不必再猜。
fn describe_payload(payload: &[u8]) -> String {
    let Ok(parsed) = serde_json::from_slice::<Value>(payload) else {
        return format!("payload={} bytes (not JSON)", payload.len());
    };
    let Some(input) = parsed.get("input").and_then(Value::as_array) else {
        return format!("payload={} bytes (no input array)", payload.len());
    };
    let mut by_type: std::collections::BTreeMap<&str, (usize, usize)> = std::collections::BTreeMap::new();
    for item in input {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("?");
        let size = serde_json::to_vec(item).map(|bytes| bytes.len()).unwrap_or(0);
        let entry = by_type.entry(kind).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += size;
    }
    let mut ranked: Vec<(&str, usize, usize)> =
        by_type.into_iter().map(|(kind, (count, bytes))| (kind, count, bytes)).collect();
    ranked.sort_by_key(|entry| std::cmp::Reverse(entry.2));
    let top: Vec<String> =
        ranked.iter().take(3).map(|(kind, count, bytes)| format!("{kind}={count} items/{bytes}B")).collect();
    format!("payload={} bytes, items={}, top: {}", payload.len(), input.len(), top.join(", "))
}

fn portable_history(body: &[u8]) -> Option<Vec<u8>> {
    let mut parsed: Value = serde_json::from_slice(body).ok()?;
    let input = parsed.get_mut("input")?.as_array_mut()?;
    let before = input.len();
    input.retain(|item| item.get("type").and_then(Value::as_str) != Some("reasoning"));
    let mut removed = before - input.len();
    for item in input.iter_mut() {
        if let Some(object) = item.as_object_mut()
            && object.remove("id").is_some()
        {
            removed += 1;
        }
    }
    if removed == 0 {
        return None;
    }
    log::info!("bridge: portable retry drops {removed} vendor-owned field(s) from the history");
    serde_json::to_vec(&parsed).ok()
}

/// Drops `web_search` / `web_search_preview` declarations. Codex attaches one to the remote
/// compaction request, and no third-party gateway can execute it — most answer 400
/// `unsupported_parameter` with `param: tools`, which the user sees as「上下文压缩失败」. The
/// gateway catalog's `web_search: "disabled"` only covers the direct-provider path; the shared
/// router never carries that switch, so it has to be enforced here.
fn strip_web_search_tools(parsed: &mut Value) -> usize {
    let mut dropped = 0usize;
    let mut left = 0usize;
    if let Some(tools) = parsed.get_mut("tools").and_then(Value::as_array_mut) {
        let before = tools.len();
        tools.retain(|tool| !tool.get("type").and_then(Value::as_str).unwrap_or_default().starts_with("web_search"));
        dropped = before - tools.len();
        left = tools.len();
    }
    if dropped > 0
        && left == 0
        && let Some(object) = parsed.as_object_mut()
    {
        object.remove("tools");
    }
    dropped
}

/// Qwen's plan endpoint rejects any tool schema that carries JSON Schema `$defs`/`$ref`
/// (`InternalError.Algo … Invalid request parameters`, a fast 400 the UI shows as「连接中断」).
/// Codex attaches such schemas through plugins/MCP (e.g. the `chatgpt_space` namespace), so the
/// router expands them into their equivalent inline form before forwarding — a lossless rewrite
/// verified against the live endpoint: the same request answers 200 once inlined. Only the qwen
/// gateway needs this; OpenAI-family routes accept `$defs` and stay untouched.
fn inline_tool_schema_refs(parsed: &mut Value) -> usize {
    let Some(tools) = parsed.get_mut("tools").and_then(Value::as_array_mut) else { return 0 };
    let mut expanded = 0usize;
    for tool in tools.iter_mut() {
        expanded += inline_refs_in_tool(tool);
    }
    expanded
}

fn inline_refs_in_tool(tool: &mut Value) -> usize {
    let kind = tool.get("type").and_then(Value::as_str).unwrap_or_default();
    if kind == "namespace" {
        let Some(children) = tool.get_mut("tools").and_then(Value::as_array_mut) else { return 0 };
        return children.iter_mut().map(inline_refs_in_tool).sum();
    }
    let Some(parameters) = tool.get_mut("parameters") else { return 0 };
    inline_schema_refs(parameters)
}

/// Replaces every local `{"$ref":"#/$defs/<Name>"}` with a deep copy of its definition and drops
/// the `$defs` block. Returns the number of references expanded; schemas without `$defs`/`$ref`
/// are left byte-for-byte alone. Unresolvable or cyclic references are kept as-is rather than
/// looping forever — the upstream refusal then still surfaces with its real message.
fn inline_schema_refs(schema: &mut Value) -> usize {
    let Some(defs) = schema.get("$defs").and_then(Value::as_object).cloned() else {
        return expand_refs(schema, &serde_json::Map::new(), 0);
    };
    if let Some(object) = schema.as_object_mut() {
        object.remove("$defs");
    }
    expand_refs(schema, &defs, 0)
}

fn expand_refs(node: &mut Value, defs: &serde_json::Map<String, Value>, depth: usize) -> usize {
    const MAX_DEPTH: usize = 64;
    if depth > MAX_DEPTH {
        return 0;
    }
    match node {
        Value::Object(object) => {
            if let Some(reference) = object.get("$ref").and_then(Value::as_str)
                && let Some(name) = reference.strip_prefix("#/$defs/")
                && let Some(definition) = defs.get(name)
            {
                let mut replacement = definition.clone();
                let expanded = 1 + expand_refs(&mut replacement, defs, depth + 1);
                *node = replacement;
                return expanded;
            }
            object.values_mut().map(|child| expand_refs(child, defs, depth + 1)).sum()
        }
        Value::Array(items) => items.iter_mut().map(|child| expand_refs(child, defs, depth + 1)).sum(),
        _ => 0,
    }
}

/// POST /responses: sanitize the body, then stream the upstream answer straight back.
fn upstream_endpoint(base_url: &str, path: &str) -> String {
    format!("{}/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'))
}

fn forward_responses(
    mut request: tiny_http::Request, upstream_base: &str, authorization: Option<&str>,
) -> Result<(), String> {
    let mut body = Vec::new();
    request.as_reader().read_to_end(&mut body).map_err(|error| format!("read body: {error}"))?;
    let mut parsed: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => {
            return relay(
                request,
                "",
                &upstream_endpoint(upstream_base, "responses"),
                authorization,
                &[],
                body,
                false,
                false,
                false,
                // 老版本按 provider 直连的路径也走同一张补救阶梯：任何一层代理都可能用空 body
                // 拒绝一个包，而路由长什么样与「这个包能不能被发出去」无关。
                true,
                // A legacy per-provider route, not the shared gateway router.
                false,
            );
        }
    };
    if strip_web_search_tools(&mut parsed) > 0 {
        log::info!("bridge: dropped web_search tool declaration(s) the gateway cannot run");
    }
    let renamed = normalize_tool_call_names(&mut parsed);
    if renamed > 0 {
        log::warn!("bridge: normalized {renamed} tool call name(s) for the Responses schema");
    }
    let payload = serde_json::to_vec(&parsed).unwrap_or(body);
    relay(
        request,
        parsed.get("model").and_then(Value::as_str).unwrap_or(""),
        &upstream_endpoint(upstream_base, "responses"),
        authorization,
        &[],
        sanitize(&payload),
        false,
        false,
        false,
        // Same recovery ladder as every other route — see `forward_responses`'s other call.
        true,
        // Same as above: a single vendor's own route, never the shared gateway router.
        false,
    )
}

/// Converts the Responses request Codex emits into OpenRouter's Chat Completions request.
/// The local wire stays Responses; only the selected OpenRouter upstream uses this translation.
fn responses_to_chat(parsed: &Value) -> Value {
    let mut chat = serde_json::Map::new();
    for key in ["model", "temperature", "top_p", "max_output_tokens", "stream", "parallel_tool_calls", "service_tier"] {
        if let Some(value) = parsed.get(key) {
            chat.insert(if key == "max_output_tokens" { "max_tokens" } else { key }.to_string(), value.clone());
        }
    }
    if let Some(effort) = parsed.pointer("/reasoning/effort").and_then(Value::as_str) {
        chat.insert("reasoning_effort".into(), json!(effort));
    }
    let mut messages = Vec::new();
    if let Some(instructions) = parsed.get("instructions").and_then(Value::as_str) {
        messages.push(json!({"role":"system", "content":instructions}));
    }
    for item in parsed.get("input").and_then(Value::as_array).into_iter().flatten() {
        match item.get("type").and_then(Value::as_str).unwrap_or("message") {
            "message" => {
                let role = item.get("role").and_then(Value::as_str).unwrap_or("user");
                let content = item.get("content").cloned().unwrap_or(Value::String(String::new()));
                let content = if let Some(parts) = content.as_array() {
                    Value::Array(
                        parts
                            .iter()
                            .filter_map(|part| {
                                let text = part.get("text").and_then(Value::as_str)?;
                                Some(json!({"type":"text", "text":text}))
                            })
                            .collect(),
                    )
                } else {
                    content
                };
                messages.push(json!({"role":role, "content":content}));
            }
            "function_call" => messages.push(json!({
                "role":"assistant", "tool_calls":[{"id":item.get("call_id").and_then(Value::as_str).unwrap_or("call"),
                "type":"function", "function":{"name":item.get("name").and_then(Value::as_str).unwrap_or(""),
                "arguments":item.get("arguments").and_then(Value::as_str).unwrap_or("{}")}}]
            })),
            "function_call_output" => messages.push(json!({"role":"tool",
                "tool_call_id":item.get("call_id").and_then(Value::as_str).unwrap_or("call"),
                "content":item.get("output").and_then(Value::as_str).unwrap_or("")})),
            _ => {}
        }
    }
    chat.insert("messages".to_string(), Value::Array(messages));
    if let Some(tools) = parsed.get("tools").and_then(Value::as_array) {
        let tools: Vec<Value> = tools
            .iter()
            .filter_map(|tool| {
                if tool.get("type").and_then(Value::as_str) != Some("function") {
                    return None;
                }
                Some(json!({"type":"function", "function":{"name":tool.get("name"),
                "description":tool.get("description"), "parameters":tool.get("parameters")}}))
            })
            .collect();
        if !tools.is_empty() {
            chat.insert("tools".to_string(), Value::Array(tools));
        }
    }
    Value::Object(chat)
}

/// One assistant turn item, in the shape the Responses API returns. Text and each tool call become
/// separate output items, exactly as the native Responses backend emits them.
fn chat_output_items(message: &Value) -> Vec<Value> {
    let mut output = Vec::new();
    if let Some(text) = message.get("content").and_then(Value::as_str).filter(|text| !text.is_empty()) {
        output.push(json!({"id":format!("msg_{}", CHAT_ITEM_SEQ.fetch_add(1, Ordering::Relaxed)), "type":"message", "role":"assistant",
            "status":"completed", "content":[{"type":"output_text", "text":text, "annotations":[]}]}));
    }
    for call in message.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
        let function = call.get("function").cloned().unwrap_or(Value::Null);
        output.push(json!({"id":format!("fc_{}", CHAT_ITEM_SEQ.fetch_add(1, Ordering::Relaxed)), "type":"function_call", "status":"completed",
            "call_id":call.get("id").and_then(Value::as_str).unwrap_or("call"),
            "name":function.get("name").and_then(Value::as_str).unwrap_or(""),
            "arguments":function.get("arguments").and_then(Value::as_str).unwrap_or("{}")}));
    }
    output
}

/// Maps Chat Completions token counts onto the Responses `usage` names.
fn chat_usage(usage: &Value) -> Value {
    if !usage.is_object() {
        return Value::Null;
    }
    json!({
        "input_tokens": usage.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
        "output_tokens": usage.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
        "total_tokens": usage.get("total_tokens").and_then(Value::as_u64).unwrap_or(0),
    })
}

fn chat_response_shell(id: &str, status: &str) -> Value {
    json!({"id":id, "object":"response", "status":status, "error":Value::Null, "output":[],
        "model":Value::Null, "usage":Value::Null})
}

/// Converts a complete (non-streaming) Chat Completions answer into the Responses object Codex
/// consumes. `finish_reason` decides the terminal status so a length-capped turn is not reported
/// as a completed one.
fn chat_to_responses(value: &Value) -> Value {
    let id = value.get("id").and_then(Value::as_str).unwrap_or("chatcmpl");
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .cloned()
        .unwrap_or(Value::Null);
    let status = match choice.get("finish_reason").and_then(Value::as_str) {
        Some("length") => "incomplete",
        Some("content_filter") => "failed",
        _ => "completed",
    };
    let mut response = chat_response_shell(id, status);
    response["output"] = Value::Array(chat_output_items(&choice.get("message").cloned().unwrap_or(Value::Null)));
    response["usage"] = chat_usage(&value.get("usage").cloned().unwrap_or(Value::Null));
    if status == "incomplete" {
        response["incomplete_details"] = json!({"reason":"max_output_tokens"});
    }
    response
}

/// A monotonically increasing suffix for synthesized item ids. Codex keys replayed history on these,
/// so they must not collide across turns within one process.
static CHAT_ITEM_SEQ: AtomicU32 = AtomicU32::new(0);

/// Stateful Chat Completions SSE → Responses SSE translation.
///
/// Codex reads a strict event sequence: `response.created`, then per item
/// `output_item.added` → deltas → `*.done` → `output_item.done`, then `response.completed`. Emitting
/// only deltas leaves the engine waiting for items it never sees, so every item is opened and closed
/// here. Chunk boundaries are arbitrary: a frame split across two reads is buffered until its
/// terminating blank line arrives.
struct ChatResponsesStream {
    id: String,
    buffer: Vec<u8>,
    sequence: u64,
    started: bool,
    /// Open message item: (output index, item id, accumulated text).
    text: Option<(usize, String, String)>,
    /// Open tool calls keyed by the Chat Completions `index`: (output index, item id, call id, name, arguments).
    calls: HashMap<usize, (usize, String, String, String, String)>,
    next_index: usize,
    usage: Value,
    finish_reason: Option<String>,
    done: bool,
}

impl ChatResponsesStream {
    fn new() -> Self {
        Self {
            id: format!("resp_{}", CHAT_ITEM_SEQ.fetch_add(1, Ordering::Relaxed)),
            buffer: Vec::new(),
            sequence: 0,
            started: false,
            text: None,
            calls: HashMap::new(),
            next_index: 0,
            usage: Value::Null,
            finish_reason: None,
            done: false,
        }
    }

    fn event(&mut self, kind: &str, mut body: Value) -> Vec<u8> {
        body["type"] = json!(kind);
        body["sequence_number"] = json!(self.sequence);
        self.sequence += 1;
        format!("event: {kind}\ndata: {}\n\n", body).into_bytes()
    }

    fn take_index(&mut self) -> usize {
        let index = self.next_index;
        self.next_index += 1;
        index
    }

    /// Closes the open message item, if any. Called before a tool call opens and at end of stream so
    /// items never interleave.
    fn close_text(&mut self, out: &mut Vec<u8>) {
        let Some((index, item_id, text)) = self.text.take() else { return };
        let content = json!([{"type":"output_text", "text":text, "annotations":[]}]);
        out.extend(self.event(
            "response.output_text.done",
            json!({"item_id":item_id, "output_index":index, "content_index":0, "text":text}),
        ));
        out.extend(self.event(
            "response.content_part.done",
            json!({"item_id":item_id, "output_index":index, "content_index":0,
                "part":{"type":"output_text", "text":text, "annotations":[]}}),
        ));
        out.extend(self.event(
            "response.output_item.done",
            json!({"output_index":index, "item":{"id":item_id, "type":"message", "role":"assistant",
                "status":"completed", "content":content}}),
        ));
    }

    fn close_calls(&mut self, out: &mut Vec<u8>) {
        let mut open: Vec<_> = self.calls.drain().collect();
        open.sort_by_key(|(chat_index, _)| *chat_index);
        for (_, (index, item_id, call_id, name, arguments)) in open {
            out.extend(self.event(
                "response.function_call_arguments.done",
                json!({"item_id":item_id, "output_index":index, "arguments":arguments}),
            ));
            out.extend(self.event(
                "response.output_item.done",
                json!({"output_index":index, "item":{"id":item_id, "type":"function_call",
                    "status":"completed", "call_id":call_id, "name":name, "arguments":arguments}}),
            ));
        }
    }

    fn complete(&mut self, out: &mut Vec<u8>) {
        if self.done {
            return;
        }
        self.done = true;
        self.close_text(out);
        self.close_calls(out);
        let status = match self.finish_reason.as_deref() {
            Some("length") => "incomplete",
            Some("content_filter") => "failed",
            _ => "completed",
        };
        let mut response = chat_response_shell(&self.id, status);
        response["usage"] = self.usage.clone();
        if status == "incomplete" {
            response["incomplete_details"] = json!({"reason":"max_output_tokens"});
        }
        out.extend(self.event("response.completed", json!({"response":response})));
    }

    fn chunk(&mut self, value: &Value, out: &mut Vec<u8>) {
        if !self.started {
            self.started = true;
            if let Some(id) = value.get("id").and_then(Value::as_str) {
                self.id = id.to_string();
            }
            out.extend(
                self.event("response.created", json!({"response":chat_response_shell(&self.id, "in_progress")})),
            );
        }
        if let Some(usage) = value.get("usage").filter(|usage| usage.is_object()) {
            self.usage = chat_usage(usage);
        }
        let Some(choice) = value.get("choices").and_then(Value::as_array).and_then(|choices| choices.first()) else {
            return;
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        let delta = choice.get("delta").cloned().unwrap_or(Value::Null);
        if let Some(text) = delta.get("content").and_then(Value::as_str).filter(|text| !text.is_empty()) {
            if self.text.is_none() {
                let index = self.take_index();
                let item_id = format!("msg_{}", CHAT_ITEM_SEQ.fetch_add(1, Ordering::Relaxed));
                out.extend(self.event(
                    "response.output_item.added",
                    json!({"output_index":index, "item":{"id":item_id, "type":"message",
                        "role":"assistant", "status":"in_progress", "content":[]}}),
                ));
                out.extend(self.event(
                    "response.content_part.added",
                    json!({"item_id":item_id, "output_index":index, "content_index":0,
                        "part":{"type":"output_text", "text":"", "annotations":[]}}),
                ));
                self.text = Some((index, item_id, String::new()));
            }
            if let Some((index, item_id, accumulated)) = self.text.as_mut() {
                accumulated.push_str(text);
                let (index, item_id) = (*index, item_id.clone());
                out.extend(self.event(
                    "response.output_text.delta",
                    json!({"item_id":item_id, "output_index":index, "content_index":0, "delta":text}),
                ));
            }
        }
        for call in delta.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
            let chat_index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let function = call.get("function").cloned().unwrap_or(Value::Null);
            if !self.calls.contains_key(&chat_index) {
                // A tool call ends any open text item: the two must not share an output index.
                self.close_text(out);
                let index = self.take_index();
                let item_id = format!("fc_{}", CHAT_ITEM_SEQ.fetch_add(1, Ordering::Relaxed));
                let call_id = call.get("id").and_then(Value::as_str).unwrap_or("call").to_string();
                let name = function.get("name").and_then(Value::as_str).unwrap_or("").to_string();
                out.extend(self.event(
                    "response.output_item.added",
                    json!({"output_index":index, "item":{"id":item_id, "type":"function_call",
                        "status":"in_progress", "call_id":call_id, "name":name, "arguments":""}}),
                ));
                self.calls.insert(chat_index, (index, item_id, call_id, name, String::new()));
            }
            let Some((index, item_id, call_id, name, arguments)) = self.calls.get_mut(&chat_index) else { continue };
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                *call_id = id.to_string();
            }
            if let Some(part) = function.get("name").and_then(Value::as_str) {
                name.push_str(part);
            }
            if let Some(part) = function.get("arguments").and_then(Value::as_str).filter(|part| !part.is_empty()) {
                arguments.push_str(part);
                let (index, item_id) = (*index, item_id.clone());
                out.extend(self.event(
                    "response.function_call_arguments.delta",
                    json!({"item_id":item_id, "output_index":index, "delta":part}),
                ));
            }
        }
    }

    /// Feeds raw upstream bytes; returns the Responses SSE bytes ready to write downstream.
    fn translate(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.buffer.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(end) = sse_frame_length(&self.buffer) {
            let frame = self.buffer.drain(..end).collect::<Vec<_>>();
            let text = String::from_utf8_lossy(&frame);
            let Some(data) = text.lines().find_map(|line| line.trim().strip_prefix("data:")) else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                self.complete(&mut out);
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(data) else { continue };
            // An in-band error frame must reach Codex as an error, not as an empty completed turn.
            if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
                out.extend(self.event(
                    "response.failed",
                    json!({"response":{
                    "id":self.id, "object":"response", "status":"failed",
                    "error":{"code":error.get("code").cloned().unwrap_or(json!("upstream_error")),
                        "message":error.get("message").cloned().unwrap_or(json!("upstream error"))}}}),
                ));
                self.done = true;
                continue;
            }
            self.chunk(&value, &mut out);
        }
        out
    }

    /// Upstream closed without `[DONE]`. Close whatever is open so the turn terminates instead of
    /// leaving Codex waiting on an item that never finishes.
    fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        if self.finish_reason.is_some() {
            self.complete(&mut out);
        } else if !self.done {
            self.done = true;
            out.extend(self.event("response.failed", json!({"response":{
                "id":self.id, "status":"failed", "error":{"code":"stream_disconnected", "message":"upstream disconnected before completion"}
            }})));
        }
        out
    }
}

fn sse_frame_length(bytes: &[u8]) -> Option<usize> {
    bytes.iter().enumerate().find_map(|(index, byte)| {
        if *byte != b'\n' {
            return None;
        }
        let tail = &bytes[index + 1..];
        if tail.starts_with(b"\n") {
            Some(index + 2)
        } else if tail.starts_with(b"\r\n") {
            Some(index + 3)
        } else {
            None
        }
    })
}

#[derive(Debug, PartialEq)]
enum Prelude {
    Wait,
    Forward,
    Reconnect,
}

fn stream_prelude(bytes: &[u8], chat: bool) -> Prelude {
    if bytes.len() >= FIRST_EVENT_CAP {
        return Prelude::Forward;
    }
    let mut rest = bytes;
    while let Some(end) = sse_frame_length(rest) {
        for line in rest[..end].split(|byte| *byte == b'\n') {
            let Some(data) = line.strip_prefix(b"data:") else { continue };
            let Ok(value) = serde_json::from_slice::<Value>(data) else { return Prelude::Forward };
            let failure = value.get("error").or_else(|| value.pointer("/response/error"));
            if failure.is_some_and(|error| {
                matches!(
                    error["code"].as_str(),
                    Some("stream_disconnected" | "connection_reset" | "upstream_connection_error")
                )
            }) {
                return Prelude::Reconnect;
            }
            if chat {
                let Some(choices) = value["choices"].as_array() else { return Prelude::Forward };
                if value.get("error").is_some()
                    || !choices.iter().all(|choice| {
                        choice["finish_reason"].is_null()
                            && choice["delta"].as_object().is_some_and(|delta| {
                                delta.iter().all(|(key, value)| {
                                    key == "role"
                                        || (key == "content" && (value.is_null() || value.as_str() == Some("")))
                                })
                            })
                    })
                {
                    return Prelude::Forward;
                }
            } else if !matches!(value["type"].as_str(), Some("response.created" | "response.in_progress" | "ping")) {
                return Prelude::Forward;
            }
        }
        rest = &rest[end..];
    }
    Prelude::Wait
}

/// The answer for a routed model whose gateway is not configured.
///
/// A company gateway that was never published looks identical to a typo from here, but the two
/// need different remedies: an enterprise model is reachable only after the account is signed in,
/// and telling that user "gateway X is not configured" sends them looking for a setting that is
/// not the problem. Everything else keeps the old 404 wording, which the engine already shows for
/// an unknown vendor.
fn missing_gateway_response(gateway: &str, requested: &str) -> (u16, String) {
    let enterprise =
        gateway.contains("enterprise") || requested.contains("enterprise/") || requested.contains("enterprise:");
    if enterprise {
        let body = serde_json::json!({"error":{
            "message":"enterprise_model_not_ready: 企业模型未就绪，请先在「设置 → 账号」登录企业账号，然后重试。",
            "type":"enterprise_model_not_ready"
        }});
        return (409, body.to_string());
    }
    (404, format!(r#"{{"error":{{"message":"router: gateway {gateway} is not configured"}}}}"#))
}

/// POST /<router>/responses: pick the vendor from the model name, then forward as that vendor.
fn forward_routed(mut request: tiny_http::Request) -> Result<(), String> {
    let mut body = Vec::new();
    request.as_reader().read_to_end(&mut body).map_err(|error| format!("read body: {error}"))?;
    let Ok(mut parsed) = serde_json::from_slice::<Value>(&body) else {
        return respond(request, 400, "application/json", br#"{"error":{"message":"router: body is not JSON"}}"#);
    };
    let renamed = normalize_tool_call_names(&mut parsed);
    if renamed > 0 {
        log::warn!("bridge: normalized {renamed} tool call name(s) for the Responses schema");
    }
    let Some(requested) = parsed.get("model").and_then(Value::as_str).map(str::to_string) else {
        return respond(request, 400, "application/json", br#"{"error":{"message":"router: missing model"}}"#);
    };
    // An outside agent only ever knows the name the user published for it. Resolve that name to a
    // real model *before* the vendor is read out of it, so an alias behaves exactly like the model
    // it stands for — same routing, same relays, same error handling. A selection that is not an
    // alias is used verbatim, which keeps every existing model name working unchanged.
    let selection = match crate::external_models::resolve(&requested) {
        Some(target) => crate::external_models::routed_target(&target),
        None => requested.clone(),
    };
    // All three model spellings go through one parser. A malformed `gateway:` value must never be
    // mistaken for a native id, because that is how an external model once reached ChatGPT.
    let identity = ModelIdentity::parse(&selection);
    let (gateway, upstream_model) = match &identity {
        ModelIdentity::Gateway { gateway_id, model_id, .. } => (gateway_id.as_str(), model_id.as_str()),
        ModelIdentity::Native { .. } => {
            // An alias may point at one of Codex's own models as well. The backend validates the
            // name it receives, so the resolved model has to replace the alias id here too.
            if selection != requested {
                parsed["model"] = Value::String(selection.clone());
            }
            return forward_chatgpt(request, &parsed);
        }
        ModelIdentity::Invalid(_) => {
            let body = json!({"error":{
                "message":"model_route_required: gateway model names need a provider route",
                "type":"model_route_required"
            }});
            return respond(request, 400, "application/json", body.to_string().as_bytes());
        }
    };
    let Some(route) = router_routes().read().ok().and_then(|map| map.get(gateway).cloned()) else {
        let (status, body) = missing_gateway_response(gateway, &requested);
        return respond(request, status, "application/json", body.as_bytes());
    };
    parsed["model"] = Value::String(upstream_model.to_string());
    if parsed.get("tools").is_none()
        && let Some(input) = parsed.get_mut("input").and_then(Value::as_array_mut)
        && input.first().is_some_and(|item| item["type"] == "additional_tools" && item["tools"].is_array())
    {
        let mut declaration = input.remove(0);
        parsed["tools"] = declaration["tools"].take();
    }
    let dropped = strip_web_search_tools(&mut parsed);
    if dropped > 0 {
        log::info!("bridge: dropped {dropped} web_search tool declaration(s) the gateway cannot run");
    }
    if gateway == "qwen" {
        let expanded = inline_tool_schema_refs(&mut parsed);
        if expanded > 0 {
            log::info!("bridge: inlined {expanded} tool schema $ref(s) the qwen endpoint cannot parse");
        }
    }
    let chat_protocol = route.protocol == crate::providers::Protocol::ChatCompletions;
    let upstream_payload = if chat_protocol { responses_to_chat(&parsed) } else { parsed };
    let Ok(payload) = serde_json::to_vec(&upstream_payload) else {
        return respond(request, 500, "application/json", br#"{"error":{"message":"router: encode failed"}}"#);
    };
    let payload = if route.sanitize { sanitize(&payload) } else { payload };
    let authorization = format!("Bearer {}", route.bearer_token);
    let endpoint = upstream_endpoint(&route.base_url, if chat_protocol { "chat/completions" } else { "responses" });
    // Name the destination on every request. Without it a 429 whose body is a vendor's own JSON
    // could not be attributed to a route: the log said "upstream answered 429" and nothing about
    // which upstream, so a native-vs-gateway question had to be answered by reading config files
    // (2026-11-19). The host is enough to identify the vendor; the path never is.
    log::info!(
        "bridge: routed model={selection} gateway={gateway} upstream={}",
        endpoint.split("://").nth(1).unwrap_or(&endpoint).split('/').next().unwrap_or("unknown")
    );
    relay(
        request,
        &selection,
        &endpoint,
        Some(&authorization),
        &[],
        payload,
        // Gateway vendors neither emit ChatGPT's `server_is_overloaded` nor share its retry
        // behaviour. Watching stalls here is what made a DeepSeek turn that merely quoted the
        // phrase look overloaded, and a slow gateway answer look like a ChatGPT capacity wait.
        false,
        // Only OpenRouter documents this 429 / error.code=10000 pair. Other gateway 429s must
        // retain their own error handling and are never swallowed by this preference.
        gateway == "openrouter",
        chat_protocol,
        // A chat switched to another vendor replays ids and reasoning that vendor never issued.
        true,
        // A gateway sits behind its own tunnel, its own upstream and often a company relay; a
        // dropped connection there is the flake the user cannot retry by hand without retyping.
        true,
    )
}

/// POST /<router>/responses for a model Codex owns itself: sign it with the ChatGPT token and
/// hand it to the backend Codex would have called directly.
fn forward_chatgpt(request: tiny_http::Request, parsed: &Value) -> Result<(), String> {
    let Some(credentials) = crate::chatgpt_auth::read() else {
        return respond(
            request,
            401,
            "application/json",
            br#"{"error":{"message":"router: native models need a ChatGPT sign-in"}}"#,
        );
    };
    let Ok(payload) = serde_json::to_vec(parsed) else {
        return respond(request, 500, "application/json", br#"{"error":{"message":"router: encode failed"}}"#);
    };
    // A chat written under a gateway carries plain-text `reasoning.content` items, and the backend
    // refuses them (`Invalid 'input[n].content': array too long`). That is what made switching such
    // a chat to a native model look like an unreplayable history: the same rollout the gateway
    // accepted was rejected here untouched. Sanitize this hop as well, so a model switch no longer
    // depends on which vendor happened to write the earlier turns.
    let payload = sanitize(&payload);
    // Same story for ids: the backend checks each item's prefix against its type, and a gateway may
    // have minted `msg_…` ids for reasoning items. Repair before sending, so a model switch does not
    // fail with `Invalid 'input[n].id'` on a history that is otherwise perfectly replayable.
    let payload = match serde_json::from_slice::<Value>(&payload) {
        Ok(mut parsed) => {
            let repaired = normalize_item_ids(&mut parsed);
            if repaired > 0 {
                log::info!("bridge: dropped {repaired} cross-vendor item id(s) before the native model call");
            }
            serde_json::to_vec(&parsed).unwrap_or(payload)
        }
        Err(_) => payload,
    };
    let authorization = format!("Bearer {}", credentials.access_token);
    let model = parsed.get("model").and_then(Value::as_str).unwrap_or("");
    // Same reason as the routed hop: the destination has to be on the record, because a bare model
    // name is the one case where "which vendor answered" is not obvious from the model string.
    log::info!("bridge: native model={model} upstream=chatgpt.com");
    let mut headers = vec![
        ("chatgpt-account-id", credentials.account_id.as_str()),
        ("OpenAI-Beta", "responses=experimental"),
        ("originator", "codex_cli_rs"),
        ("Accept", "text/event-stream"),
    ];
    let lite = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("x-openai-internal-codex-responses-lite"))
        .map(|header| header.value.as_str().to_owned());
    if let Some(value) = lite.as_deref() {
        headers.push(("x-openai-internal-codex-responses-lite", value));
    }
    relay(
        request,
        parsed.get("model").and_then(Value::as_str).unwrap_or(""),
        CHATGPT_RESPONSES_URL,
        Some(&authorization),
        &headers,
        payload,
        // The only route whose backend speaks `server_is_overloaded`. Read the mute switch per
        // request so a settings change applies without restarting the engine.
        true,
        false,
        false,
        // 历史补救对原生链路同样成立。开着它，一个被 chatgpt.com 拒掉的重放包还能退到「去掉
        // 跨组织不可解密的 reasoning + 所有 item id」，再不行退到「裁掉最老的历史」；关着它，
        // 这类拒绝就只剩一句空 body 的 404。注释里原本写的「原生后端会重试一次握手」说的是
        // 握手，与历史无关 —— 2026-11-19 的 7.8MB 重放包正是被这条判断漏掉的。
        true,
        // The native backend already retries a dropped handshake once in the engine's own loop;
        // the extra gateway attempt below belongs to gateways only.
        false,
    )
}

/// True when the upstream refused the turn because a replayed reasoning item could not be
/// decrypted: OpenAI ties `encrypted_content` to the organization that minted it, so a thread that
/// has been served by two credentials (or two vendors) replays a blob the new endpoint cannot read.
/// The body arrives as `{"error":{"message":"The encrypted content rs_… could not be verified…"}}`
/// or with `"code": "invalid_encrypted_content"`.
fn is_invalid_encrypted_content(body: &str) -> bool {
    body.contains("invalid_encrypted_content") || (body.contains("encrypted content") && body.contains("could not be"))
}

/// Drops every `reasoning` item from the request `input`.
///
/// Retrying with the reasoning items gone is the documented recovery: the encrypted blob is only
/// reusable by the organization that produced it, while the user/assistant turns and tool calls are
/// plain and replay fine. Losing one turn's private thinking is cheaper than losing the thread.
/// Returns `None` when there was nothing to drop, so the caller does not retry a hopeless request.
fn drop_reasoning_items(body: &[u8]) -> Option<Vec<u8>> {
    let mut parsed: Value = serde_json::from_slice(body).ok()?;
    let input = parsed.get_mut("input")?.as_array_mut()?;
    let before = input.len();
    input.retain(|item| item.get("type").and_then(Value::as_str) != Some("reasoning"));
    let removed = before - input.len();
    if removed == 0 {
        return None;
    }
    log::info!("bridge: dropped {removed} reasoning item(s) after invalid_encrypted_content");
    serde_json::to_vec(&parsed).ok()
}

/// The ChatGPT backend answers capacity dips with a 200 OK whose SSE body contains
/// `code: "server_is_overloaded"` and `retry-after: 300`-odd seconds. The engine honors that by
/// sleeping and retrying **without emitting a single event**, so the reader sits at「正在思考」
/// for five minutes with no way to know a different model would answer right now. Watching the
/// bytes as they pass through costs nothing and lets the UI offer a switch.
///
/// This code belongs to that backend alone. Only a complete JSON `data:` event with that
/// `error.code` counts, and both stall watches are armed only on the native ChatGPT route — see
/// `overload_error_line` and `relay`'s `watch_stall` argument.
const OVERLOAD_MARKER: &[u8] = b"server_is_overloaded";

/// How long an upstream turn may accept the request without emitting **one byte** before the UI
/// is told the upstream never acknowledged it.
///
/// This is the only signal that justifies "the model is not answering". Everything else that looks
/// like silence is not silence: a tool call ends the upstream response, so while Codex runs a shell
/// command (a query, a build, a download) there is *no request in flight at all* — and during a long
/// reasoning pass the stream still starts with `response.created` within a second or two. So the
/// test is "accepted, then quiet" vs "never accepted", and only the latter is a stall.
const NO_ACK_TIMEOUT: Duration = Duration::from_secs(120);

/// The one SSE data line that actually is a backend capacity error, if any.
///
/// `server_is_overloaded` is a ChatGPT error *code*, not a phrase. It also appears in model output
/// (a reader asking about it), tool results and replayed transcripts. Matching the raw bytes made a
/// DeepSeek turn that merely quoted the phrase look like a five-minute capacity wait while its
/// tokens were still being billed. Require the whole line to be a JSON `data:` event whose
/// `error.code` is the marker before reporting anything.
fn overload_error_line(tail: &[u8]) -> Option<&[u8]> {
    for line in tail.split(|byte| *byte == b'\n') {
        if !line.windows(OVERLOAD_MARKER.len()).any(|window| window == OVERLOAD_MARKER) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(line) else { continue };
        let Some(body) = text.trim().strip_prefix("data:") else { continue };
        let Ok(value) = serde_json::from_str::<Value>(body.trim()) else { continue };
        let code = value.get("error").and_then(|error| error.get("code")).and_then(Value::as_str);
        if code == Some("server_is_overloaded") {
            return Some(line);
        }
    }
    None
}

/// OpenRouter answers a burst with an HTTP 429, or — when the request is malformed or the
/// upstream is rate-limiting mid-stream — with a JSON error injected into the SSE stream
/// carrying `error.code: 10000`. Both are transient: re-sending the same request usually works.
/// When the user has switched the OpenRouter「模型异常提醒」off, treat either as a hiccup and
/// replay instead of answering with the refusal.
///
/// Structured like `overload_error_line`: a bare `10000` anywhere in the stream is not enough —
/// a model can output that number in a tool result — so require the whole line to be a JSON
/// `data:` event whose `error.code` is the marker.
const OPENROUTER_ERROR_CODE: u64 = 10000;

fn openrouter_error_line(tail: &[u8]) -> Option<&[u8]> {
    for line in tail.split(|byte| *byte == b'\n') {
        let Ok(text) = std::str::from_utf8(line) else { continue };
        let Some(body) = text.trim().strip_prefix("data:") else { continue };
        let Ok(value) = serde_json::from_str::<Value>(body.trim()) else { continue };
        let code = value.get("error").and_then(|error| error.get("code"));
        let matched = match code {
            Some(Value::String(s)) => s.parse::<u64>().ok() == Some(OPENROUTER_ERROR_CODE),
            Some(Value::Number(n)) => n.as_u64() == Some(OPENROUTER_ERROR_CODE),
            _ => false,
        };
        if matched {
            return Some(line);
        }
    }
    None
}

/// Reads `retry-after` from that same structured error event — never from the first number that
/// happens to follow the marker somewhere in the stream.
fn retry_after_seconds(event_line: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(event_line).ok()?.trim();
    let body = text.strip_prefix("data:")?.trim();
    let value: Value = serde_json::from_str(body).ok()?;
    let raw = value.get("error")?.get("headers")?.get("retry-after")?;
    match raw {
        Value::String(seconds) => seconds.parse().ok(),
        Value::Number(seconds) => seconds.as_u64(),
        _ => None,
    }
}

/// Why a turn is producing nothing, as far as the upstream is concerned.
///
/// `Overloaded` is the backend saying so explicitly; `NoAck` is it saying nothing at all. The UI
/// treats them the same way (offer another model) but words them differently, and **neither** can
/// fire while the turn is running a local tool — that window has no upstream request in flight.
const REASON_OVERLOADED: &str = "overloaded";
const REASON_NO_ACK: &str = "no_ack";

/// The bridge used to arm `reqwest`'s request timeout at 600s. That clock runs from the first
/// connect byte until the **response body ends**, so on an SSE turn it was a ten-minute wall-clock
/// cap, not an idle cap: a measured healthy `gpt-6.1-sol` turn ran 853s, and the backend can
/// legitimately sleep `retry-after: 300` without emitting a byte. When it fired, the read error
/// propagated through `OverloadWatch::read` into `tiny_http`, which logged
/// `respond: request or response body error` and dropped the socket — the engine then reported
/// `stream disconnected`. These two limits are the bridge's half of the UI's own contract in
/// `client.ts#promptWithTimeout`: silence, not elapsed wall time, ends a stream.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const STREAM_HARD_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// Marker the UI localizes when the bridge ends a stream on its own clocks.
const STREAM_TIMEOUT_CODE: &str = "bridge_stream_timeout";

/// An upstream can accept the TCP connection and then never send response headers. The client
/// below has only a 15s connect timeout and a 60min whole-request timeout, so a bare `.send()`
/// could hold one of the six workers for the entire hour. Bound **only** the wait for headers;
/// the established stream keeps STREAM_IDLE_TIMEOUT / STREAM_HARD_TIMEOUT untouched.
const HEADER_TIMEOUT: Duration = Duration::from_secs(60);

/// Short, increasing id the frontend uses as a dedup key for `model:stalled` events of one
/// upstream request. Generated once per relay below.
static STALL_REQUEST_SEQ: AtomicU32 = AtomicU32::new(0);
/// Process-wide diagnostic count of *real* `server_is_overloaded` events. The no-ack timer never
/// increments it. This is NOT a per-turn index: the frontend owns turn identity and counts real
/// events per turn, using `requestId` to dedupe; `attempt` is only a log/telemetry field.
static OVERLOAD_ATTEMPT_SEQ: AtomicU32 = AtomicU32::new(0);

fn next_request_id() -> String {
    format!("r{}", STALL_REQUEST_SEQ.fetch_add(1, Ordering::Relaxed) + 1)
}

fn next_overload_attempt() -> u32 {
    OVERLOAD_ATTEMPT_SEQ.fetch_add(1, Ordering::Relaxed) + 1
}

/// Builds the `model:stalled` payload. Kept pure so the new `attempt`/`requestId` fields are
/// unit-testable without a Tauri app handle.
fn stall_payload(model: &str, reason: &str, retry_after: Option<u64>, attempt: u32, request_id: &str) -> Value {
    serde_json::json!({
        "model": model,
        "reason": reason,
        "retryAfter": retry_after,
        "attempt": attempt,
        "requestId": request_id,
    })
}

/// How many silent retries one request absorbs before the reader is told.
///
/// With the switch on, a gateway keeps retrying without a ceiling. That is what the user asked for,
/// but it also means a turn can sit behind a dead upstream for minutes with nothing on screen to
/// distinguish it from a slow model. Ten retries is long enough that a normal flake never trips it
/// and short enough that a real outage is reported while the reader is still waiting.
const RETRY_ALERT_AFTER: u32 = 10;

/// Tells the UI that this request has now been retried `RETRY_ALERT_AFTER` times.
///
/// Emitted once per request, on the retry that crosses the line — not on every retry after it, or
/// the reader would get a fresh toast every ten seconds for the rest of the window. The payload
/// carries the model (the only handle the bridge has on a conversation) and the request id so the
/// frontend can attach the notice to one turn and dedupe a repeat of the same request.
fn publish_retrying(model: &str, retries: u32, request_id: &str) {
    log::warn!("bridge: still retrying model={model} retries={retries} request={request_id}");
    if let Some(app) = APP_HANDLE.get() {
        let payload = serde_json::json!({
            "model": model,
            "retries": retries,
            "requestId": request_id,
        });
        let _ = app.emit("model:retrying", payload);
    }
}

/// Increments the running silent-retry tally and, the first time it crosses `RETRY_ALERT_AFTER`,
/// tells the UI a turn has been retrying silently for a while. `alerted` makes it one notice per
/// request: afterwards it stays true and no further event is emitted, so a dead upstream produces a
/// single toast instead of one every few seconds for the rest of the retry window.
fn note_retry(silent_retries: &mut u32, alerted: &mut bool, model: &str, request_id: &str) {
    *silent_retries += 1;
    if !*alerted && *silent_retries > RETRY_ALERT_AFTER {
        publish_retrying(model, *silent_retries, request_id);
        *alerted = true;
    }
}

fn publish_stall(model: &str, reason: &str, retry_after: Option<u64>, attempt: u32, request_id: &str) {
    log::warn!(
        "bridge: turn stalled model={model} reason={reason} retry-after={retry_after:?}s attempt={attempt} request={request_id}"
    );
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit("model:stalled", stall_payload(model, reason, retry_after, attempt, request_id));
    }
}

/// One piece of the upstream SSE stream, or the reason it stopped.
enum StreamChunk {
    Data(Vec<u8>),
    End,
    Failed(String),
}

fn stream_io_kind(error: &std::io::Error) -> Option<std::io::ErrorKind> {
    use std::error::Error;
    use std::io::ErrorKind;

    let mut cause: Option<&(dyn Error + 'static)> = Some(error);
    while let Some(current) = cause {
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            if io.kind() != ErrorKind::Other {
                return Some(io.kind());
            }
            cause = io.get_ref().map(|inner| inner as &dyn Error);
        } else {
            if current.downcast_ref::<reqwest::Error>().is_some_and(reqwest::Error::is_timeout) {
                return Some(ErrorKind::TimedOut);
            }
            cause = current.source();
        }
    }
    None
}

/// Feeds `tiny_http` from a dedicated upstream reader thread.
///
/// Keeping the blocking `reqwest` read on its own thread lets us wait for the *next chunk* with a
/// timeout instead of letting a whole-request timeout cut off a live turn. When either clock
/// expires, or the upstream read fails, one structured error event is written before EOF; the
/// old behaviour dropped the socket mid-response and reached the screen as a generic "连接中断".
struct StreamReader {
    rx: std::sync::mpsc::Receiver<StreamChunk>,
    pending: Vec<u8>,
    position: usize,
    idle: Duration,
    deadline: Instant,
    finished: bool,
    /// Set when tiny_http is done with this reader (the client disconnected or the stream ended),
    /// so the upstream reader thread stops pulling bytes the moment it finishes its current read.
    client_gone: Arc<AtomicBool>,
}

impl StreamReader {
    fn new(
        rx: std::sync::mpsc::Receiver<StreamChunk>, idle: Duration, hard: Duration, client_gone: Arc<AtomicBool>,
    ) -> Self {
        Self {
            rx,
            pending: Vec::new(),
            position: 0,
            idle,
            deadline: Instant::now() + hard,
            finished: false,
            client_gone,
        }
    }

    /// A final SSE event that says *why* the stream ended. Without it the client only sees a
    /// truncated response and can offer nothing but "重试".
    ///
    /// Shape matters: codex 0.164 only understands the Responses API's `response.failed` event
    /// (the binary carries `response.failed event received`; it has no handler for a bare
    /// `type: "error"`). An `event: error` frame parses fine and is then ignored, so the engine
    /// still ends the turn with `stream closed before response.completed` and our reason never
    /// reaches the UI. `code`/`message` stay in the payload because error-text.ts matches the
    /// `bridge_stream_timeout` reason there.
    fn fail(&mut self, reason: &str) {
        log::warn!("bridge: ending stream: {reason}");
        let event = serde_json::json!({
            "type": "response.failed",
            "response": {
                "status": "failed",
                "error": {
                    "code": STREAM_TIMEOUT_CODE,
                    "message": format!("{STREAM_TIMEOUT_CODE}: {reason}")
                }
            }
        })
        .to_string();
        // A blank line first: the upstream may have stopped in the middle of an event, and an
        // event frame glued onto a half-written `data:` line is invalid JSON. An empty event is
        // legal SSE, so the separator is harmless when the stream did end on a boundary.
        self.pending = format!("\n\nevent: response.failed\ndata: {event}\n\n").into_bytes();
        self.position = 0;
        // The pending event still has to be delivered; the read after it returns EOF.
        self.finished = true;
    }
}

impl Drop for StreamReader {
    fn drop(&mut self) {
        self.client_gone.store(true, Ordering::Relaxed);
    }
}

impl Read for StreamReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            if self.position < self.pending.len() {
                let count = buf.len().min(self.pending.len() - self.position);
                buf[..count].copy_from_slice(&self.pending[self.position..self.position + count]);
                self.position += count;
                return Ok(count);
            }
            if self.finished {
                return Ok(0);
            }
            self.pending.clear();
            self.position = 0;
            let now = Instant::now();
            if now >= self.deadline {
                self.fail("本次请求已达到 60 分钟总上限");
                continue;
            }
            let wait = self.idle.min(self.deadline - now);
            match self.rx.recv_timeout(wait) {
                Ok(StreamChunk::Data(bytes)) => self.pending = bytes,
                Ok(StreamChunk::End) => {
                    self.finished = true;
                    return Ok(0);
                }
                Ok(StreamChunk::Failed(reason)) => self.fail(&format!("上游读取失败：{reason}")),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => self.fail("上游超过 20 分钟没有输出"),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    // The reader thread went away without even an `End` marker: the socket was
                    // lost underneath us. A silent EOF here reads as a truncated answer; name it.
                    self.fail("上游连接被关闭，没有收到结束标记")
                }
            }
        }
    }
}

/// A pass-through reader: every byte still reaches Codex unchanged, we only look at a bounded
/// tail so an SSE event split across two reads is still recognized.
struct OverloadWatch<R> {
    inner: R,
    model: String,
    /// Shared with the no-ack watcher; the frontend uses it as the dedup key for this request.
    request_id: String,
    tail: Vec<u8>,
    fired: bool,
    /// `server_is_overloaded` belongs to the ChatGPT backend. Gateway turns (DeepSeek, Qwen,
    /// Kimi, …) have their own error vocabularies, and a gateway response merely containing that
    /// phrase is never a capacity report — so the watch is only armed on the native route.
    enabled: bool,
    /// Set on the first byte the upstream emits. `NoAckWatch` reads it to tell "accepted, then
    /// thinking" apart from "never accepted at all".
    acked: Arc<AtomicBool>,
    /// Set when the upstream stream ends, so the no-ack timer stops caring about a finished turn.
    closed: Arc<AtomicBool>,
    /// Armed only on a gateway route: every byte that passes updates it, and the idle watchdog
    /// names a stream that stopped mid-flight. `None` keeps every other route untouched.
    activity: Option<Arc<GatewayActivity>>,
}

/// The one condition that may be reported as "the upstream is not answering": the request is still
/// open and not a single byte has come back. Kept pure so it can be tested without waiting 120s.
fn no_ack_expired(acked: bool, closed: bool, elapsed: Duration) -> bool {
    !acked && !closed && elapsed >= NO_ACK_TIMEOUT
}

/// Fires once if a request is accepted by the transport but the upstream never emits a byte.
///
/// Deliberately separate from `OverloadWatch`: that one needs bytes to notice an error, and an
/// upstream that sends nothing can never hand it any. Checking `acked` from a timer thread is the
/// only way to observe an absence.
fn watch_no_ack(model: &str, acked: Arc<AtomicBool>, closed: Arc<AtomicBool>, request_id: String) {
    let model = model.to_string();
    std::thread::spawn(move || {
        let start = Instant::now();
        loop {
            let ack = acked.load(Ordering::Relaxed);
            let done = closed.load(Ordering::Relaxed);
            if no_ack_expired(ack, done, start.elapsed()) {
                // No real overload event fired, so `attempt` stays 0; `requestId` still tags the
                // upstream request. The frontend counts attempts from real overload events only.
                publish_stall(&model, REASON_NO_ACK, None, 0, &request_id);
                return;
            }
            // Acknowledged or finished: this turn is accounted for, stop looking at it.
            if ack || done {
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
}

/// How long a **gateway** response may stop producing bytes before the UI is told it went quiet.
///
/// Shorter than the native `NO_ACK_TIMEOUT` because it measures something else: not "the request
/// was never accepted" but "bytes were flowing and then stopped". A gateway that sends its first
/// event and then nothing is a real, observable silence, and two minutes of it is worth naming —
/// the local tool-execution caveat does not apply mid-stream, because a tool call ends the upstream
/// response outright.
const GATEWAY_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// Byte-flow bookkeeping shared between the streaming reader and the gateway idle watchdog.
///
/// One atomic millisecond stamp, so the hot read path never takes a lock and the watchdog can read
/// the same value from its own thread.
struct GatewayActivity {
    start: Instant,
    /// Milliseconds since `start` when the last byte arrived; 0 before the first one.
    last_ms: AtomicU64,
}

impl GatewayActivity {
    fn new() -> Self {
        Self { start: Instant::now(), last_ms: AtomicU64::new(0) }
    }

    /// Records that a byte just arrived.
    fn touch(&self) {
        let elapsed = u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last_ms.store(elapsed, Ordering::Relaxed);
    }

    /// Time since the last observed byte (or since the request started, before the first one).
    fn idle(&self) -> Duration {
        let last = Duration::from_millis(self.last_ms.load(Ordering::Relaxed));
        self.start.elapsed().saturating_sub(last)
    }
}

/// Pure test seam: "the gateway has been silent for two minutes and the stream is still open".
fn gateway_idle_expired(idle: Duration, closed: bool) -> bool {
    !closed && idle >= GATEWAY_IDLE_TIMEOUT
}

/// The `model:stalled` payload for a gateway that went quiet mid-stream.
///
/// The reason is `no_ack` — the same one the native route uses when nothing ever came back. That is
/// deliberate: it is the only "the upstream has stopped answering" vocabulary the notice layer
/// accepts (`model-overload-alert.ts` ignores reasons it does not know), and an OpenRouter free
/// model that trails off after a few tokens is exactly the case the user wants to be told about
/// instead of watching a silent screen. The gateway-specific detail lives in the log line.
fn gateway_idle_payload(model: &str, request_id: &str) -> Value {
    stall_payload(model, REASON_NO_ACK, None, 0, request_id)
}

/// Reports a gateway that stopped mid-stream, once, without touching the stream itself.
///
/// Deliberately separate from `watch_no_ack`: that one watches the *absence* of a first byte on the
/// native route, this one watches a stream that went quiet after it started. Neither aborts
/// anything — the 20-minute idle clock in `StreamReader` still owns ending a dead stream, and a
/// gateway that resumes after the report keeps streaming into the same turn.
fn watch_gateway_idle(model: &str, activity: Arc<GatewayActivity>, closed: Arc<AtomicBool>, request_id: String) {
    let model = model.to_string();
    std::thread::spawn(move || {
        loop {
            if closed.load(Ordering::Relaxed) {
                return;
            }
            if gateway_idle_expired(activity.idle(), false) {
                log::warn!(
                    "bridge: gateway stream went quiet for {}s model={model} request={request_id}",
                    GATEWAY_IDLE_TIMEOUT.as_secs()
                );
                if let Some(app) = APP_HANDLE.get() {
                    let _ = app.emit("model:stalled", gateway_idle_payload(&model, &request_id));
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}

impl<R: Read> Read for OverloadWatch<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let count = self.inner.read(buf)?;
        if count == 0 {
            self.closed.store(true, Ordering::Relaxed);
        } else {
            self.acked.store(true, Ordering::Relaxed);
            // Feed the gateway idle watchdog: silence is only meaningful after a byte arrived.
            if let Some(activity) = self.activity.as_ref() {
                activity.touch();
            }
        }
        if self.fired || !self.enabled {
            return Ok(count);
        }
        // A stream that ended without a structured error event is simply finished. The old code
        // published an overload here whenever the phrase had been seen anywhere, which is exactly
        // how a quoted phrase in normal output turned into a "model at capacity" row.
        if count == 0 {
            return Ok(count);
        }
        self.tail.extend_from_slice(&buf[..count]);
        if self.tail.len() > 32_768 {
            let excess = self.tail.len() - 32_768;
            self.tail.drain(..excess);
        }
        if let Some(line) = overload_error_line(&self.tail) {
            self.fired = true;
            // Count only real, structured overload events (deduped by `fired`), never the no-ack
            // timer. The number is process-wide telemetry; the frontend keeps the per-turn budget.
            let attempt = next_overload_attempt();
            publish_stall(&self.model, REASON_OVERLOADED, retry_after_seconds(line), attempt, &self.request_id);
        }
        Ok(count)
    }
}

/// Both stall observers are armed together, and only for the native ChatGPT route.
///
/// `server_is_overloaded` is a ChatGPT error code and the two-minute no-ack clock describes
/// ChatGPT's own retry behaviour. Gateway vendors have their own error vocabulary and retry
/// policy; watching half of a gateway request used to publish `model:stalled` for a vendor that
/// had said nothing of the kind, and the UI then attached that notice to whichever turn happened
/// to be running. Keeping the decision in one place makes a half-watched route impossible.
fn stall_observers(native_route: bool) -> (bool, bool) {
    (native_route, native_route)
}

/// Result of waiting for upstream response headers on a detached `.send()` thread.
enum HeaderWait {
    Response(reqwest::blocking::Response),
    Error(reqwest::Error),
    Timeout,
}

/// Runs `.send()` on its own thread and waits only `timeout` for the response headers. A slow
/// upstream that never answers otherwise pins one of the six workers for the whole 60min client
/// timeout. On success the `Response` is handed back to the caller — `reqwest::blocking::Response`
/// is `Send` (the existing streaming thread already moves one across threads) — and streamed under
/// the unchanged idle/hard clocks. Only the header phase is bounded.
fn send_with_header_timeout(builder: reqwest::blocking::RequestBuilder, timeout: Duration) -> HeaderWait {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(builder.send());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(response)) => HeaderWait::Response(response),
        Ok(Err(error)) => HeaderWait::Error(error),
        // Timeout, or a sender that disconnected without answering: no headers arrived in time.
        Err(_) => HeaderWait::Timeout,
    }
}

/// Streams one upstream turn back to Codex, preserving status codes and the SSE byte stream.
///
/// A capacity refusal is replayed at once; this tiny gap only keeps five attempts from hitting
/// the backend in the same millisecond. It deliberately ignores the backend's `retry-after`.
const REPLAY_GAP: Duration = Duration::from_millis(200);
/// How many silent HTTP-429 replays one request may make. `REPLAY_GAP * 2^n` caps the wait at 6.4s,
/// so eight attempts span roughly half a minute — enough for a transient burst, short enough that a
/// genuinely blocked key still surfaces the refusal instead of hanging until the 60-minute cap.
const MAX_429_REPLAYS: u32 = 8;
/// How many silent replays one request may make after a 502/503/504. The company relay answers
/// 502 "Enterprise gateway request failed" when its own upstream hiccups; the request never left
/// the building, so re-sending it is safe and usually succeeds on the second try. Two replays
/// (400ms then 800ms) cover a transient blip without holding a genuinely dead gateway for long.
const MAX_GATEWAY_REPLAYS: u32 = 2;
/// Buffer cap for the first SSE event. A healthy first event is small; a huge one is simply
/// forwarded as-is instead of being held while we look for a capacity refusal.
const FIRST_EVENT_CAP: usize = 16 * 1024;

/// Gap between two transport attempts after the connection dropped or the header phase went
/// silent. Deliberately short and fixed: the user is watching a spinner, and the upstream never
/// asked for a specific wait (a `retry-after` belongs to a real answer, not to a dead socket).
const RETRY_GAP: Duration = Duration::from_millis(400);

/// Ceiling for the widening gap between gateway retries. An uncounted retry loop at a fixed 400ms
/// would send ~9,000 requests an hour at an upstream that is already failing; backing off to 10s
/// still retries forever, it just stops being a flood.
const MAX_RETRY_GAP: Duration = Duration::from_secs(10);

/// How long a gateway request may keep retrying transport failures while the switch is on.
///
/// The switch promises "keep trying until it works", so nothing counts attempts. This window is the
/// only thing that ends the loop, and it exists because each retry pins a bridge worker out of six:
/// an upstream that is down all afternoon must eventually hand the turn back as a visible failure
/// instead of holding a slot until the process exits. It matches the stream's whole-request ceiling,
/// so a request never outlives the clock the UI already reasons about.
const GATEWAY_RETRY_WINDOW: Duration = STREAM_HARD_TIMEOUT;

/// Transport attempts a **gateway** route is allowed. `None` means "no count at all — retry until
/// the window closes".
///
/// On: `None`. The switch is labelled「连接中断自动重试」and the user asked for a system that keeps
/// trying on its own; a ceiling of three gave up after roughly a second of outage, which is exactly
/// the "it still stops by itself" behaviour the setting was meant to remove. A refused turn is
/// cheap to retry because the request never ran anywhere.
///
/// Off: **exactly one** attempt. "Off" has to mean a dropped gateway connection is reported to the
/// user untouched — not retried once behind their back. An off switch that still retries is
/// indistinguishable from an on switch, which leaves the user no way to tell the two apart.
///
/// The native route is unaffected either way: its single retry predates this switch and the switch
/// is scoped to gateway models. Kept pure so both meanings are provable without opening a socket.
fn gateway_attempts(retry_enabled: bool) -> Option<u32> {
    if retry_enabled { None } else { Some(1) }
}

/// Transport attempts for one upstream request. Only a gateway route is ever widened: the native
/// ChatGPT route keeps the single retry it has always had, and the legacy per-provider routes with
/// it.
fn route_attempts(gateway: bool, retry_enabled: bool) -> Option<u32> {
    if gateway { gateway_attempts(retry_enabled) } else { Some(2) }
}

/// Whether one more transport attempt is allowed. `transport_retries` is how many retries this
/// request already spent on a dead connection, whichever kind it was.
///
/// A counted route allows `total - 1` retries so its `.send()` threads stay bounded. An uncounted
/// one is bounded by time instead — checked here rather than after the sleep, so the deadline is
/// never overshot by a whole retry cycle.
fn may_retry_transport(transport_retries: u32, attempts: Option<u32>, deadline: Instant, now: Instant) -> bool {
    match attempts {
        Some(total) => transport_retries + 1 < total,
        None => now < deadline,
    }
}

/// The wait before retry number `retries` (0-based): 400ms, 800ms, 1.6s … capped at `MAX_RETRY_GAP`.
///
/// Only the first gap matches the old fixed one, so the native route's single retry behaves exactly
/// as it did before this function existed.
fn retry_gap(retries: u32) -> Duration {
    let factor = 1u32 << retries.min(6);
    RETRY_GAP.saturating_mul(factor).min(MAX_RETRY_GAP)
}

/// Whether a 502/503/504 may be replayed.
///
/// A gateway failure the relay itself reports is the same class of event as a dropped handshake:
/// the turn never ran, so re-sending the identical request cannot duplicate anything. What the
/// switch promises therefore applies here too — **on** means keep replaying until the retry window
/// closes, **off** means surface the vendor's own error untouched, not replay twice behind the
/// user's back. Routes outside the gateway (the native ChatGPT route and the legacy per-provider
/// ones) keep the historical counted budget, because the switch is scoped to gateway models.
fn may_replay_5xx(gateway: bool, retry_enabled: bool, replays: u32, deadline: Instant, now: Instant) -> bool {
    if !gateway {
        return replays < MAX_GATEWAY_REPLAYS;
    }
    if !retry_enabled {
        return false;
    }
    now < deadline
}

/// The wait before 5xx replay number `replays` (0-based), capped like the transport gaps.
fn replay_5xx_gap(replays: u32) -> Duration {
    let factor = 1u32 << replays.min(6);
    REPLAY_GAP.saturating_mul(factor).min(MAX_RETRY_GAP)
}

/// Whether today's OpenRouter **free** budget has any bearing on this request.
///
/// Three conditions, all necessary. `gateway`/`openrouter` keep native and other vendors out. The
/// `:free` suffix is the one that is easy to forget and expensive to get wrong: OpenRouter's
/// `x-ratelimit-*` frequently describes a short per-key window (a `10s` burst limit), so a **paid**
/// model refused for a few seconds would otherwise be reported as "今日免费额度已用完" — a wrong
/// diagnosis that also throws the turn away instead of letting the normal replay decide.
fn free_quota_applies(gateway: bool, openrouter: bool, model: &str) -> bool {
    gateway && openrouter && model.contains(":free")
}

/// Whether a 429 must be *answered* with the spent-free-quota refusal instead of being replayed.
///
/// Both inputs are already scoped: `quota_blocked` is only ever true for a model that passed
/// `free_quota_applies`, so a paid model can never reach the refusal however the vendor's counter
/// reads — it falls through to `should_replay_429` and, at the end of its budget, to the vendor's
/// own 429 body.
fn free_quota_refusal(muted: bool, quota_blocked: bool) -> bool {
    muted && quota_blocked
}

/// Whether a 429 may be swallowed and the same request replayed.
///
/// The mute switch is the user's own choice, so it stays the outer condition. The free-quota
/// ceiling is a fact about today's budget: once it is spent, replaying can only spend more of it
/// and cannot succeed, so the refusal has to reach the user instead of looking like a stall.
fn should_replay_429(muted: bool, replays: u32, quota_blocked: bool) -> bool {
    muted && !quota_blocked && replays < MAX_429_REPLAYS
}

/// Whether a 429 says a **request-count window is spent**, not that a burst is being throttled.
///
/// The company gateway (new-api) answers a spent window with a self-describing refusal:
/// `{"error":{"code":"rate_limit_exceeded","message":"已达到速率上限：3小时内最多250次请求，当前
/// 已使用258次，预计133分钟后（10:11）恢复","type":"new_api_error"}}`. That is a different animal
/// from a transient burst limit: no replay inside the window can succeed, and — measured
/// 2026-11-19 — the eight silent replays were themselves charged to the same counter, taking the
/// account from its 250 ceiling to 258 while it was already closed. The refusal has to reach the
/// reader at once; the vendor's own message already names the reset time.
///
/// The test is deliberately narrow: a limit *and* a used count *and* a recovery statement. A
/// plain 429 from any other vendor carries none of the three, so it keeps its existing path.
fn quota_window_spent(text: &str) -> bool {
    if !text.contains("rate_limit_exceeded") {
        return false;
    }
    let states_limit = text.contains("已达到速率上限") || text.contains("超出速率限制");
    let states_usage = text.contains("已使用") || text.contains("已用");
    let states_recovery = text.contains("恢复") || text.contains("重置");
    states_limit && states_usage && states_recovery
}

/// Append the upstream host to a vendor's refusal, so the banner names who refused.
///
/// A bare model name in the conversation says nothing about the route a request took, and a 429
/// body is shown verbatim. That is how, on 2026-11-19, the company gateway's「已达到速率上限：3小时
/// 内最多250次请求」came to be read as the ChatGPT model's own error — the reader had switched to
/// `gpt-6.1-sol`, which never touches that gateway, and concluded the switch had failed. The
/// vendor's wording and reset time are left exactly as sent; only the source is added.
///
/// Anything that is not the vendor's `{"error":{"message":…}}` shape passes through untouched: a
/// rewritten body would be a worse lie than an unattributed one.
fn name_upstream(body: &[u8], url: &str) -> Vec<u8> {
    let host = url.split("://").nth(1).and_then(|rest| rest.split('/').next()).unwrap_or("");
    if host.is_empty() {
        return body.to_vec();
    }
    let Ok(mut parsed) = serde_json::from_slice::<Value>(body) else {
        return body.to_vec();
    };
    let Some(message) =
        parsed.get("error").and_then(|error| error.get("message")).and_then(Value::as_str).map(str::to_string)
    else {
        return body.to_vec();
    };
    if let Some(slot) = parsed.get_mut("error").and_then(|error| error.get_mut("message")) {
        *slot = Value::String(format!("{message}（来源：{host}）"));
    }
    serde_json::to_vec(&parsed).unwrap_or_else(|_| body.to_vec())
}

/// How the spent-quota refusal says when the budget comes back.
///
/// Returns a whole clause that already ends in `。`, so the message never has to guess punctuation
/// or produce "今日额度后重置" nonsense. Relative, not a clock time: the bridge does not know the
/// user's timezone, and "3 小时 20 分钟后" is true in every one of them.
///
/// Two cases must not be smoothed over: a `reset_at` that already passed — the quota module keeps a
/// `remaining: 0` stamp that may be older than the window it describes, and a negative countdown
/// would be a lie — and no window at all, which is the normal state on a fresh install.
///
/// A long clause is not a bug: the value may be the free model's next UTC-day rollover, so
/// "23 小时后重置。" is a legitimate reading. Always a duration, never a clock time — only a
/// duration stays true without knowing the user's timezone.
fn quota_reset_clause_from(now_seconds: i64, reset_at: Option<i64>) -> String {
    let Some(reset_at) = reset_at else {
        return "重置时间未知，请稍后再试。".to_string();
    };
    let remaining = reset_at - now_seconds;
    if remaining <= 0 {
        return "即将重置。".to_string();
    }
    let minutes_total = (remaining + 59) / 60;
    let hours = minutes_total / 60;
    let minutes = minutes_total % 60;
    match (hours, minutes) {
        (0, minutes) => format!("{} 分钟后重置。", minutes.max(1)),
        (hours, 0) => format!("{hours} 小时后重置。"),
        (hours, minutes) => format!("{hours} 小时 {minutes} 分钟后重置。"),
    }
}

fn quota_reset_clause(reset_at: Option<i64>) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    quota_reset_clause_from(now, reset_at)
}

/// The refusal returned when today's OpenRouter free quota is already spent: replaying the 429
/// would only burn the rest of the budget, so the user gets a reason and the reset time instead.
fn free_quota_exhausted_body(reset_at: Option<i64>) -> String {
    let reset = quota_reset_clause(reset_at);
    serde_json::json!({"error":{
        "message": format!("openrouter_free_quota_exhausted: 今日免费额度已用完，{reset}"),
        "type": "openrouter_free_quota_exhausted",
        "resetAt": reset_at,
    }})
    .to_string()
}

/// Flattens response headers into owned pairs so the quota module never borrows the response the
/// streaming hand-off still owns.
fn header_pairs(response: &reqwest::blocking::Response) -> Vec<(String, String)> {
    response
        .headers()
        .iter()
        .map(|(name, value)| (name.as_str().to_string(), value.to_str().unwrap_or_default().to_string()))
        .collect()
}

/// Re-sends the exact same upstream request. The engine never sees the capacity refusal, so it
/// cannot honour `retry-after` and sleep. A non-2xx replay is reported as a failure instead of
/// being spliced into the SSE stream.
fn replay_upstream(
    client: &reqwest::blocking::Client, url: &str, authorization: Option<&str>, headers: &[(String, String)],
    payload: &[u8],
) -> Result<reqwest::blocking::Response, String> {
    let mut builder = client.post(url).header("Content-Type", "application/json");
    if let Some(authorization) = authorization {
        builder = builder.header("Authorization", authorization);
    }
    for (name, value) in headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let response = builder.body(payload.to_vec()).send().map_err(|error| format!("http client: {error}"))?;
    if !(200..=299).contains(&response.status().as_u16()) {
        return Err(format!("upstream answered {}", response.status()));
    }
    Ok(response)
}

/// `watch_stall` is true only for `forward_chatgpt`. It gates **both** the structured overload
/// reader and the no-ack timer; see `stall_observers`. When the user has muted overload notices,
/// `relay` swallows `server_is_overloaded` and replays the same request without a ceiling — the
/// 60-minute whole-request timeout is the only backstop.
///
/// `gateway` marks the shared router's path (`forward_routed`). It enables the wider transport
/// retry budget, the OpenRouter quota accounting and the gateway idle watchdog; every other caller
/// passes false and keeps the behaviour it always had.
#[allow(clippy::too_many_arguments)]
fn relay(
    request: tiny_http::Request, model: &str, url: &str, authorization: Option<&str>, headers: &[(&str, &str)],
    payload: Vec<u8>, watch_stall: bool, watch_openrouter_errors: bool, chat_protocol: bool, portable_fallback: bool,
    gateway: bool,
) -> Result<(), String> {
    // `forward_routed` computes this exactly once, for the one gateway that documents the
    // 429 / error.code=10000 pair. Reusing it keeps "this route is OpenRouter" in a single place
    // instead of threading a second near-identical flag through the signature.
    let openrouter = watch_openrouter_errors;
    let attempts = route_attempts(gateway, gateway_retry_enabled());
    // Only consulted when `attempts` is `None`; computed unconditionally because a `Instant` costs
    // nothing and threading a second optional through the loop would be worse than one unused value.
    let retry_deadline = Instant::now() + GATEWAY_RETRY_WINDOW;
    let client = reqwest::blocking::Client::builder()
        // A route that silently swallows packets would otherwise hold the connect until the OS
        // gives up (75s on macOS), and the user reads that as "正在思考" with nothing happening.
        .connect_timeout(std::time::Duration::from_secs(15))
        // Absolute last resort only, aligned with the UI's 60-minute hard cap. This is NOT an
        // idle limit — `StreamReader` owns silence detection. A 600s timeout here used to cut
        // off healthy long turns at ten minutes and surface as "与模型的连接中断了".
        .timeout(STREAM_HARD_TIMEOUT)
        .build()
        .map_err(|error| format!("http client: {error}"))?;
    let mut request_builder = client.post(url).header("Content-Type", "application/json");
    if let Some(authorization) = authorization {
        request_builder = request_builder.header("Authorization", authorization);
    }
    for (name, value) in headers {
        request_builder = request_builder.header(*name, *value);
    }
    let mut payload = payload;
    // 每一级补救各有自己的闸门。以前三种修复共用同一个 `attempted_recovery`，谁先命中就把机会
    // 用光，另一种本该能救的修复永远轮不到 —— 这也是一种「换个说法继续失败」。
    let mut attempted_reasoning_drop = false;
    let mut attempted_id_drop = false;
    let mut attempted_portable = false;
    let mut attempted_trim = false;
    let mut recovery_steps = 0u32;
    // One budget shared by both transport failures. Two separate counters would let a connect
    // failure and a header timeout take turns and spawn more `.send()` threads than either route
    // is allowed; this counter makes the ceiling "retries in total", which is what it means.
    let mut transport_retries = 0u32;
    let mut replays_429 = 0u32;
    let mut replays_gateway = 0u32;
    // Total silent retries across every category (transport / 429 / 5xx). One alert per request,
    // fired the first time this crosses `RETRY_ALERT_AFTER`, so a turn stuck behind a dead upstream
    // is reported without a fresh toast every few seconds for the rest of the retry window.
    let mut silent_retries = 0u32;
    let mut alerted_retrying = false;
    // One id for the whole relay attempt. Shared by the stall watchers and the retry alert so the
    // UI can tie the two together; generated up front because the retry loop needs it too.
    let request_id = next_request_id();
    let response = loop {
        let attempt = request_builder
            .try_clone()
            .ok_or_else(|| "http client: request not cloneable".to_string())?
            .body(payload.clone());
        let response = match send_with_header_timeout(attempt, HEADER_TIMEOUT) {
            HeaderWait::Response(response) => response,
            // The native ChatGPT route rides whatever tunnel/proxy the user runs; a single dropped
            // handshake there is common and used to surface as a turn that sat at 正在思考 until
            // the watchdog fired. One quick retry covers the transient case. A gateway with the
            // retry switch on is not counted at all — it keeps going until the window closes, which
            // is what the switch promises and what an outage longer than a second requires.
            HeaderWait::Error(error)
                if error.is_connect()
                    && may_retry_transport(transport_retries, attempts, retry_deadline, Instant::now()) =>
            {
                let gap = retry_gap(transport_retries);
                transport_retries += 1;
                note_retry(&mut silent_retries, &mut alerted_retrying, model, &request_id);
                log::warn!(
                    "bridge: retrying after connect failure (retry {transport_retries}, next in {}ms): {error}",
                    gap.as_millis()
                );
                std::thread::sleep(gap);
                continue;
            }
            // An upstream that never accepted the connection used to be only a log line: the
            // request was dropped without a reply, so Codex kept waiting on a socket that would
            // never speak and the composer stayed at "正在思考" until its own 90s watchdog fired.
            // Answer with the failure instead — the turn then ends with a reason the user can act
            // on (switch model, check the proxy) in the same second the connection failed.
            HeaderWait::Error(error) => {
                log::warn!("bridge: upstream unreachable: {error}");
                let body = upstream_error_body(&error);
                return respond(request, 502, "application/json", body.as_bytes());
            }
            // Headers never arrived. The native ChatGPT route rides whatever tunnel/proxy the user
            // runs, and a single dropped handshake there is common (the TCP connect succeeds but the
            // first response byte stalls). One quick retry covers the transient case, just like the
            // connect-failure path above — a stalled header phase is the same class of flake. A
            // gateway with the switch on keeps going until the retry window closes.
            HeaderWait::Timeout if may_retry_transport(transport_retries, attempts, retry_deadline, Instant::now()) => {
                let gap = retry_gap(transport_retries);
                transport_retries += 1;
                note_retry(&mut silent_retries, &mut alerted_retrying, model, &request_id);
                log::warn!(
                    "bridge: retrying after header timeout ({}s, retry {transport_retries}, next in {}ms)",
                    HEADER_TIMEOUT.as_secs(),
                    gap.as_millis()
                );
                std::thread::sleep(gap);
                continue;
            }
            // Headers never arrived after the retry too: free this worker (and one of the six
            // slots) with a 504 now instead of holding it until the 60min whole-request timeout.
            // Only the header phase is cut; a stream that already started keeps its 20min idle /
            // 60min hard clocks.
            HeaderWait::Timeout => {
                log::warn!("bridge: upstream response headers timed out after {}s", HEADER_TIMEOUT.as_secs());
                return respond(
                    request,
                    504,
                    "application/json",
                    br#"{"error":{"message":"bridge: upstream did not send response headers in time","type":"header_timeout"}}"#,
                );
            }
        };
        let status = response.status().as_u16();
        // Only a 2xx counts as a successful upstream answer. A 1xx (e.g. 100 Continue) or any
        // other sub-400 status must not be passed through as success to the client.
        if (200..=299).contains(&status) {
            // Count the call and capture the rate-limit headers while the response is still ours:
            // after the hand-off to the streaming thread nobody can read them any more. Scoped to a
            // free model because the numbers those headers carry are the free-model budget — a paid
            // call's burst window must not overwrite it (see `free_quota_applies`).
            if free_quota_applies(gateway, openrouter, model) {
                crate::provider_quota::record_openrouter_headers(&header_pairs(&response));
                crate::provider_quota::record_free_call(model);
            }
            break response;
        }
        // A 429 carries `x-ratelimit-*` too (that is where "remaining: 0" actually comes from), so
        // record them before deciding whether to replay. Without this the bridge would only learn
        // the account is spent from a *successful* call, which by definition never happens while
        // the budget is exhausted — it would replay its whole 8-attempt budget first and then show
        // the vendor's raw 429. Headers must be read here: `response.bytes()` below consumes it.
        // Same `:free` scope as above: a paid model's short burst limit is not the free budget.
        if free_quota_applies(gateway, openrouter, model) && status == 429 {
            crate::provider_quota::record_openrouter_headers(&header_pairs(&response));
        }
        let body = response.bytes().map_err(|error| format!("upstream body: {error}"))?;
        let text = String::from_utf8_lossy(&body);
        // ── 一次拒绝怎么补救 ────────────────────────────────────────────────────
        //
        // 上游拒绝的形状不止一种，而每一种新形状过去都是一个新的用户可见死局：加密推理跨组织
        // 不可解密、跨厂商 item id 前缀不符、公司网关只说一句 `upstream request was rejected`。
        // 2026-11-19 出现第四种：chatgpt.com 对一个 7.8MB / 万条历史的重放包回了**空 body 的
        // 404**，桥里三条补救一条都不匹配，整轮只能报「厂商返回了 404」——而模型本身是好的。
        //
        // 现在收成一张阶梯，从「不丢一个字」到「裁掉最老的历史」，每级只试一次：
        //   1. 命中语义的定向修复（加密推理 / id 前缀）—— 只在该语义出现时触发；
        //   2. 可移植历史（去掉 reasoning 与所有 item id）—— 内容一个字不丢；
        //   3. 裁历史（保留最近 400 条 / 4MB）—— 唯一能真正缩小包的一级。
        //
        // 2、3 只在**上游什么也没说**时启动（`refusal_is_opaque`），或者状态码本身就是体积信号
        // （413）。有语义的错误原样传给读者，绝不靠试错掩盖。
        let refused_by_size = status == 413;
        let opaque = refusal_is_opaque(&text);
        let may_probe = opaque || refused_by_size;

        // One recovery attempt only: if the retry fails for the same reason there is nothing left
        // to strip and the caller must see the real error. The blob is only reusable by the
        // organization that produced it, so this repair has no alternative shape to try.
        if !attempted_reasoning_drop
            && is_invalid_encrypted_content(&text)
            && let Some(stripped) = drop_reasoning_items(&payload)
        {
            attempted_reasoning_drop = true;
            recovery_steps += 1;
            payload = stripped;
            log::warn!("bridge: retrying after invalid_encrypted_content ({status})");
            continue;
        }
        // Fallback for an item type `normalize_item_ids` has no rule for: drop exactly the id the
        // backend named and try once. Anything else is passed through untouched.
        if !attempted_id_drop
            && is_id_prefix_mismatch(&text)
            && let Some(index) = refused_input_index(&text)
            && let Some(fixed) = drop_item_id(&payload, index)
        {
            attempted_id_drop = true;
            recovery_steps += 1;
            payload = fixed;
            log::warn!("bridge: retrying after an id-prefix refusal on input[{index}]");
            continue;
        }
        // A thread written by another vendor replays ids and encrypted reasoning that only that
        // vendor can interpret. Some upstreams refuse the whole request without naming a field —
        // the company relay answers `upstream request was rejected`, and chatgpt.com answers an
        // empty 404 for a large replayed thread. One retry with a portable history decides it: if
        // the refusal was about the history it goes through, otherwise the real error still
        // surfaces. Enabled for the native route too — it used to be gateway-only, on the theory
        // that "the native backend retries a dropped handshake once", which says nothing about a
        // refused *history*.
        if portable_fallback
            && !attempted_portable
            && recovery_steps < RECOVERY_MAX_STEPS
            && (matches!(status, 400 | 422) || may_probe)
            && let Some(stripped) = portable_history(&payload)
        {
            attempted_portable = true;
            recovery_steps += 1;
            payload = stripped;
            log::warn!("bridge: retrying after {status} with a portable history");
            continue;
        }
        // 包大到一定程度，条目数和体积本身就会成为拒绝理由 —— 而这类拒绝常常连一句解释都没有
        // （空 body 的 404/413）。这是唯一能真正把包缩小的补救：保留最近的回合，丢掉最老的历史。
        // 只在包确实很大时做（`TRIM_MIN_PAYLOAD`）：小对话被拒是别的原因，裁了只会白丢上下文。
        if !attempted_trim
            && recovery_steps < RECOVERY_MAX_STEPS
            && may_probe
            && payload.len() >= TRIM_MIN_PAYLOAD
            && let Some(trimmed) = trim_history(&payload, TRIM_MAX_ITEMS, TRIM_BUDGET_BYTES)
        {
            attempted_trim = true;
            recovery_steps += 1;
            payload = trimmed;
            log::warn!("bridge: retrying after {status} with the oldest history trimmed ({} bytes)", payload.len());
            continue;
        }
        // OpenRouter answers a burst with HTTP 429 instead of the structured `server_is_overloaded`
        // SSE event ChatGPT emits. When the user has switched the OpenRouter「模型异常提醒」off,
        // treat it as a transient hiccup and re-send the same request instead of answering with the
        // refusal — the turn then either completes or fails on its own merits, without a
        // `请求太频繁` toast in between. A short exponential backoff keeps a real rate limit from
        // being hammered; after `MAX_429_REPLAYS` the refusal is passed through so a genuinely
        // blocked key still ends with a reason instead of hanging.
        //
        // The one exception is a spent free budget: replaying cannot succeed today, so the user
        // gets the reset time instead of a spinner that burns the rest of the allowance.
        if status == 429 {
            // A spent request-count window is not a burst. Replaying inside it cannot succeed, and
            // on the company gateway every rejected attempt is charged to that same window — on
            // 2026-11-19 the eight replays moved the account from 250 to 258 while it was already
            // over its ceiling. Pass the vendor's message (it names the reset time) straight on.
            if quota_window_spent(&text) {
                log::warn!("bridge: 429 with the request window spent, answering instead of replaying");
                return respond(request, status, "application/json", &name_upstream(&body, url));
            }
            // The 429 replay belongs to OpenRouter's documented `error.code:10000` contract. A
            // Hakimi 429 is a real server-side limit and must be surfaced, never replayed.
            let muted = openrouter && overload_429_mute();
            // The ceiling only ever applies to a free model (see `free_quota_applies`): a paid model
            // refused by a short burst window must fall through to the normal replay below, never be
            // answered with「免费额度已用完」.
            let quota_blocked =
                free_quota_applies(gateway, openrouter, model) && crate::provider_quota::free_quota_blocked();
            if free_quota_refusal(muted, quota_blocked) {
                // Note what this instant is *not*: it is when the budget comes back, which
                // `provider_quota` may have derived from the daily counter's UTC rollover rather
                // than read from a vendor header — so it can legitimately be ~24h out. Never
                // describe it in the UI as "the time OpenRouter told us".
                let reset_at = crate::provider_quota::free_quota_reset_at();
                log::warn!("bridge: 429 with the free quota spent, answering instead of replaying");
                let body = free_quota_exhausted_body(reset_at);
                return respond(request, 429, "application/json", body.as_bytes());
            }
            if should_replay_429(muted, replays_429, quota_blocked) {
                let delay = REPLAY_GAP * u32::pow(2, replays_429.min(5));
                replays_429 += 1;
                note_retry(&mut silent_retries, &mut alerted_retrying, model, &request_id);
                log::warn!(
                    "bridge: upstream answered 429, silent replay {replays_429}/{MAX_429_REPLAYS} in {}ms",
                    delay.as_millis()
                );
                std::thread::sleep(delay);
                continue;
            }
        }
        // A 502/503/504 from the relay means the relay itself could not reach its upstream — the
        // turn never ran, so re-sending the identical request cannot duplicate anything. The
        // company gateway's "Enterprise gateway request failed" 502 used to surface as a dead
        // turn the user had to retype. What happens next is the switch's call: on means keep going
        // until the retry window closes, off means the vendor's error reaches the reader at once.
        if matches!(status, 502..=504)
            && may_replay_5xx(gateway, gateway_retry_enabled(), replays_gateway, retry_deadline, Instant::now())
        {
            let delay = replay_5xx_gap(replays_gateway);
            replays_gateway += 1;
            note_retry(&mut silent_retries, &mut alerted_retrying, model, &request_id);
            log::warn!(
                "bridge: upstream answered {status}, silent replay {replays_gateway} in {}ms",
                delay.as_millis()
            );
            std::thread::sleep(delay);
            continue;
        }
        log::warn!(
            "bridge: upstream answered {status} ({} bytes in): {}",
            payload.len(),
            text.chars().take(300).collect::<String>()
        );
        // 拒绝的时候才付这份体检的成本，而它正是定位这一整类故障唯一缺的东西。
        log::warn!("bridge: refused request was {}", describe_payload(&payload));
        return respond(request, status, "application/json", &body);
    };
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("text/event-stream")
        .to_string();
    // A Chat Completions upstream answers in its own dialect — either one JSON object or
    // `chat.completion.chunk` SSE frames. Codex only reads Responses, so the selected OpenRouter
    // route is translated on the way back, not merely pointed at a different path.
    if chat_protocol && !content_type.contains("text/event-stream") {
        let body = response.bytes().map_err(|error| format!("upstream body: {error}"))?;
        let translated = match serde_json::from_slice::<Value>(&body) {
            Ok(value) => serde_json::to_vec(&chat_to_responses(&value)).unwrap_or_else(|_| body.to_vec()),
            Err(_) => body.to_vec(),
        };
        return respond(request, status, "application/json", &translated);
    }
    let content_type = if chat_protocol { "text/event-stream".to_string() } else { content_type };
    // Stream: hand the reader to tiny_http; it writes bytes as the upstream produces them.
    let response_headers = vec![
        tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap(),
        tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-cache"[..]).unwrap(),
        tiny_http::Header::from_bytes(&b"Connection"[..], &b"keep-alive"[..]).unwrap(),
    ];
    // Read the upstream on its own thread so a silent socket can be timed out per chunk. A bounded
    // channel gives us back-pressure, and dropping the receiver makes every later `send` fail
    // immediately. `client_gone` additionally stops the loop after the current read, so an active
    // upstream does not keep streaming into a channel nobody reads. A read that is *already*
    // blocked while the upstream is silent cannot be interrupted (reqwest's blocking reader has no
    // cancellation); that one still ends at the 60-minute whole-request timeout, not forever.
    let (tx, rx) = std::sync::mpsc::sync_channel::<StreamChunk>(64);
    let client_gone = Arc::new(AtomicBool::new(false));
    let upstream_stop = Arc::clone(&client_gone);
    // The relay owns the immediate replay loop. Give the reader thread owned copies of everything
    // it needs to re-send the request, without moving the borrows the observers below still use.
    let replay_client = client.clone();
    let replay_url = url.to_string();
    let replay_authorization = authorization.map(str::to_string);
    let replay_headers: Vec<(String, String)> =
        headers.iter().map(|(name, value)| ((*name).to_string(), (*value).to_string())).collect();
    let replay_payload = payload.clone();
    // Two independent mute switches, both read per request so a settings change applies without
    // restarting the engine. The overload mute only arms on the native ChatGPT route; the 429
    // mute is deliberately restricted to OpenRouter, whose documented 429 / `error.code:10000`
    // contract the setting names. Other provider errors pass through untouched.
    let replay_mute = watch_stall && overload_mute();
    let replay_429 = watch_openrouter_errors && overload_429_mute();
    let retry_prelude = gateway
        && gateway_retry_enabled()
        && content_type.split(';').next().is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/event-stream"))
        && matches!(ModelIdentity::parse(model),
        ModelIdentity::Gateway { gateway_id, .. } if gateway_id == "hakimi");
    let retry_model = model.to_owned();
    let retry_request_id = request_id.clone();
    std::thread::spawn(move || {
        let stream_started = Instant::now();
        let mut upstream = response;
        let mut chunk = [0u8; 8192];
        // Hold the first SSE event until it is complete. Only then can a capacity refusal be
        // replayed before the engine sees it. Once any byte has gone downstream, replay is no
        // longer safe — two response streams would be spliced together — so later events pass
        // through untouched.
        //
        // When a mute switch is on, the matching first event is swallowed and the same request is
        // re-sent on a fresh connection, with no ceiling: the only backstop is the 60-minute
        // whole-request timeout. When muted, the event is passed through untouched and the engine
        // (and the UI) see the refusal exactly as before.
        let mut head: Vec<u8> = Vec::new();
        let mut sent_any = false;
        // Only the OpenRouter Chat Completions route needs dialect translation; every other route
        // keeps forwarding the upstream bytes untouched.
        let mut translator = if chat_protocol { Some(ChatResponsesStream::new()) } else { None };
        // `data` is what the mute/replay inspection sees; `outgoing` is what actually goes downstream.
        let emit = |tx: &std::sync::mpsc::SyncSender<StreamChunk>,
                    translator: &mut Option<ChatResponsesStream>,
                    data: Vec<u8>|
         -> bool {
            let Some(translator) = translator.as_mut() else {
                return tx.send(StreamChunk::Data(data)).is_ok();
            };
            let translated = translator.translate(&data);
            if translated.is_empty() {
                return true;
            }
            tx.send(StreamChunk::Data(translated)).is_ok()
        };
        loop {
            if upstream_stop.load(Ordering::Relaxed) {
                break;
            }
            let mut read = upstream.read(&mut chunk);
            if retry_prelude
                && !sent_any
                && let Ok(count) = read
                && count > 0
            {
                head.extend_from_slice(&chunk[..count]);
                match stream_prelude(&head, chat_protocol) {
                    Prelude::Wait => continue,
                    Prelude::Forward => {}
                    Prelude::Reconnect => read = Err(std::io::Error::from(std::io::ErrorKind::ConnectionReset)),
                }
            }
            if retry_prelude && !sent_any && (read.is_err() || matches!(read, Ok(0))) {
                // The switch promises "keep reconnecting"; this stream path used to stop after
                // three attempts, which is shorter than a normal Hakimi outage. Reuse the same
                // uncounted gateway budget as the connect/header paths. `stream_prelude` returns
                // `Forward` for a rate-limit/quota event, so a real server-side limit never
                // reaches this branch and is surfaced instead of retried.
                if gateway_retry_enabled()
                    && may_retry_transport(transport_retries, attempts, retry_deadline, Instant::now())
                {
                    let gap = retry_gap(transport_retries);
                    transport_retries += 1;
                    note_retry(&mut silent_retries, &mut alerted_retrying, &retry_model, &retry_request_id);
                    log::info!("bridge: retrying Hakimi stream before first output (attempt {transport_retries})");
                    if tx.send(StreamChunk::Data(b": reconnecting\n\n".to_vec())).is_err() {
                        break;
                    }
                    std::thread::sleep(gap);
                    if upstream_stop.load(Ordering::Relaxed) {
                        break;
                    }
                    match replay_upstream(
                        &replay_client,
                        &replay_url,
                        replay_authorization.as_deref(),
                        &replay_headers,
                        &replay_payload,
                    ) {
                        Ok(next) => {
                            upstream = next;
                            head.clear();
                            continue;
                        }
                        Err(error) => {
                            let _ = tx.send(StreamChunk::Failed(error));
                            break;
                        }
                    }
                }
                let _ = tx.send(StreamChunk::Failed("Hakimi disconnected before first output".into()));
                break;
            }
            match read {
                Ok(0) => {
                    if !head.is_empty() && !emit(&tx, &mut translator, std::mem::take(&mut head)) {
                        break;
                    }
                    if let Some(translator) = translator.as_mut() {
                        let tail = translator.finish();
                        if !tail.is_empty() && tx.send(StreamChunk::Data(tail)).is_err() {
                            break;
                        }
                    }
                    let _ = tx.send(StreamChunk::End);
                    break;
                }
                Ok(count) => {
                    if !sent_any && (replay_mute || replay_429) {
                        head.extend_from_slice(&chunk[..count]);
                        let complete = head.windows(2).any(|pair| pair == b"\n\n") || head.len() >= FIRST_EVENT_CAP;
                        if !complete {
                            continue;
                        }
                        let end = head.windows(2).position(|pair| pair == b"\n\n");
                        let first_event = match end {
                            Some(index) => &head[..index + 2],
                            None => &head[..],
                        };
                        // Two markers, two switches. A line that is neither is forwarded as usual.
                        let mut replayed = false;
                        if replay_mute && overload_error_line(first_event).is_some() {
                            replayed = true;
                            log::warn!("bridge: muted overload, immediate replay");
                        } else if replay_429 && openrouter_error_line(first_event).is_some() {
                            replayed = true;
                            log::warn!("bridge: muted openrouter error, immediate replay");
                        }
                        if replayed {
                            // No request id in the log: every replay is logged with its own line and
                            // the id was only ever a debug correlation aid.
                            std::thread::sleep(REPLAY_GAP);
                            match replay_upstream(
                                &replay_client,
                                &replay_url,
                                replay_authorization.as_deref(),
                                &replay_headers,
                                &replay_payload,
                            ) {
                                Ok(next) => {
                                    upstream = next;
                                    head.clear();
                                    continue;
                                }
                                Err(error) => {
                                    log::warn!("bridge: muted replay failed: {error}");
                                    let _ = tx.send(StreamChunk::Failed(format!("bridge replay: {error}")));
                                    break;
                                }
                            }
                        }
                    }
                    let data = if head.is_empty() { chunk[..count].to_vec() } else { std::mem::take(&mut head) };
                    if !emit(&tx, &mut translator, data) {
                        break;
                    }
                    sent_any = true;
                }
                Err(error) => {
                    log::warn!(
                        "bridge: upstream stream read failed: {error}; request={retry_request_id} model={retry_model} stream_ms={} forwarded={sent_any} io_kind={:?}",
                        stream_started.elapsed().as_millis(),
                        stream_io_kind(&error)
                    );
                    let _ = tx.send(StreamChunk::Failed(error.to_string()));
                    break;
                }
            }
        }
    });
    let acked = Arc::new(AtomicBool::new(false));
    let closed = Arc::new(AtomicBool::new(false));
    let (watch_overload, watch_no_ack_enabled) = stall_observers(watch_stall);
    // `request_id` is generated up front (before the retry loop) so the stall observers and the
    // retry alert share one id and the UI can tie a `model:stalled` to its `model:retrying`.
    // Start the no-ack clock with the request, not with the UI: only the bridge knows whether a turn
    // is waiting on the upstream or on this machine's own tool execution. Gateway routes are not
    // watched — a vendor that never answers is that vendor's business, not a ChatGPT capacity
    // report, and an unmatched event would be attached to some other model's turn.
    if watch_no_ack_enabled {
        watch_no_ack(model, acked.clone(), closed.clone(), request_id.clone());
    }
    // A gateway route gets the quieter watchdog instead: not "never acknowledged" but "started,
    // then went silent". It only reports; the stream keeps running under its own clocks.
    let activity = if gateway {
        let activity = Arc::new(GatewayActivity::new());
        watch_gateway_idle(model, Arc::clone(&activity), closed.clone(), request_id.clone());
        Some(activity)
    } else {
        None
    };
    let watched = OverloadWatch {
        inner: StreamReader::new(rx, STREAM_IDLE_TIMEOUT, STREAM_HARD_TIMEOUT, client_gone),
        model: model.to_string(),
        request_id,
        tail: Vec::new(),
        fired: false,
        enabled: watch_overload,
        acked,
        closed,
        activity,
    };
    let response = tiny_http::Response::new(tiny_http::StatusCode(status), response_headers, watched, None, None);
    request.respond(response).map_err(|error| format!("respond: {error}"))
}

/// GET passthrough (model discovery through the gateway).
fn forward_plain(
    request: tiny_http::Request, url: &str, method: &str, authorization: Option<&str>,
) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("http client: {error}"))?;
    let mut builder =
        client.request(reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET), url);
    if let Some(authorization) = authorization {
        builder = builder.header("Authorization", authorization);
    }
    builder = builder.header("Accept", "application/json");
    let sent = builder.send();
    let response = match sent {
        Ok(response) => response,
        // Same rule as `relay`: a model list that cannot be fetched is an answer, not silence.
        Err(error) => {
            log::warn!("bridge: model list unreachable: {error}");
            let body = upstream_error_body(&error);
            return respond(request, 502, "application/json", body.as_bytes());
        }
    };
    let status = response.status().as_u16();
    let payload = response.bytes().map_err(|error| format!("upstream body: {error}"))?;
    respond(request, status, "application/json", &payload)
}

fn upstream_error(error: &reqwest::Error) -> (&'static str, &'static str) {
    if error.is_timeout() {
        ("bridge_upstream_timeout", "连接模型服务超时，请稍后重试或切换模型。")
    } else if error.is_connect() {
        ("bridge_upstream_unreachable", "无法连接模型服务，请检查网络、代理或 VPN 后重试。")
    } else {
        ("bridge_upstream_request_failed", "模型服务请求失败，请稍后重试或切换模型。")
    }
}

fn upstream_error_body(error: &reqwest::Error) -> String {
    let (code, message) = upstream_error(error);
    serde_json::json!({"error": {"message": format!("{code}: {message}"), "type": code}}).to_string()
}

fn respond(request: tiny_http::Request, status: u16, content_type: &str, payload: &[u8]) -> Result<(), String> {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes())
        .map_err(|_| "content-type header")?;
    let response = tiny_http::Response::from_data(payload.to_vec())
        .with_status_code(tiny_http::StatusCode(status))
        .with_header(header);
    request.respond(response).map_err(|error| format!("respond: {error}"))
}

/// Strips `content` from every `reasoning` item in the `input` array of a Responses payload.
/// `encrypted_content` and `summary` stay: replay tests showed the gateway only rejects a
/// non-empty `content` array ("Expected an array with maximum length 0").
fn sanitize(body: &[u8]) -> Vec<u8> {
    let mut parsed: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => return body.to_vec(),
    };
    let Some(input) = parsed.get_mut("input").and_then(Value::as_array_mut) else {
        return body.to_vec();
    };
    let mut stripped = 0usize;
    for item in input.iter_mut() {
        let is_reasoning = item.get("type").and_then(Value::as_str) == Some("reasoning");
        if !is_reasoning {
            continue;
        }
        if let Some(object) = item.as_object_mut()
            && object.contains_key("content")
        {
            object.insert("content".to_string(), Value::Array(Vec::new()));
            stripped += 1;
        }
    }
    if stripped > 0 {
        log::info!("bridge: cleared reasoning content on {stripped} history item(s)");
    }
    serde_json::to_vec(&parsed).unwrap_or_else(|_| body.to_vec())
}

#[cfg(test)]
mod tests {
    #[test]
    fn enterprise_router_forwards_to_native_relay_and_revokes_shared_not_legacy_route() {
        use super::*;
        // Same logical ID encoding used by enterprise catalog/model selection.
        let gateway = "custom-637573746f6d5f616c776974685f656e74657270726973655f687474705f74657374";
        let upstream = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let upstream_addr = upstream.server_addr().to_ip().unwrap();
        register_route(gateway, "http://legacy.invalid");
        register_router_route(gateway, &format!("http://{upstream_addr}/v1"), "native-relay-secret", false);
        let relay = std::thread::spawn(move || {
            let mut request = upstream.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
            assert_eq!(request.url(), "/v1/responses");
            assert!(
                request.headers().iter().any(|header| header.field.equiv("Authorization")
                    && header.value.as_str() == "Bearer native-relay-secret")
            );
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body).unwrap();
            let body: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(body["model"], "issued/model");
            assert_eq!(body["input"][0]["content"][0]["text"], "kept");
            assert_eq!(body["tools"][0]["name"], "local_tool");
            assert_eq!(body["tools"].as_array().unwrap().len(), 1);
            assert!(
                !request.headers().iter().any(|header| header.field.equiv("x-openai-internal-codex-responses-lite"))
            );
            request.respond(tiny_http::Response::from_string("relay-ok").with_status_code(202)).unwrap();
        });
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let client =
            std::thread::spawn(move || {
                reqwest::blocking::Client::new().post(format!("http://{address}/alwith/responses"))
                .bearer_auth("alwith-router")
                .header("x-openai-internal-codex-responses-lite", "1")
                .json(&serde_json::json!({"model":format!("{gateway}/issued/model"),"input":[
                    {"type":"additional_tools","tools":[{"type":"function","name":"local_tool"},{"type":"web_search"}]},
                    {"type":"reasoning","content":[{"text":"kept"}]}
                ]}))
                .send().unwrap()
            });
        handle(server.recv_timeout(Duration::from_secs(5)).unwrap().unwrap()).unwrap();
        let response = client.join().unwrap();
        assert_eq!(response.status().as_u16(), 202);
        assert_eq!(response.text().unwrap(), "relay-ok");
        relay.join().unwrap();
        unregister_router_route(gateway);
        assert!(!router_routes().read().unwrap().contains_key(gateway));
        assert!(routes().read().unwrap().contains_key(gateway));
        let rejected = std::thread::spawn(move || {
            reqwest::blocking::Client::new()
                .post(format!("http://{address}/alwith/responses"))
                .json(&serde_json::json!({"model":format!("{gateway}/issued/model")}))
                .send()
                .unwrap()
                .status()
                .as_u16()
        });
        handle(server.recv_timeout(Duration::from_secs(5)).unwrap().unwrap()).unwrap();
        assert_eq!(rejected.join().unwrap(), 404, "legacy registration must not bypass shared-route revocation");
        unregister_route(gateway);
    }
    use super::*;

    #[test]
    fn a_thread_pinned_to_a_retired_provider_reaches_the_shared_router() {
        // 老会话绑在旧 provider 上，Codex 打的是 `/<provider>/responses`；这些路径在共享路由之后
        // 不再注册。直接 404 会让「换个模型」变成永久失败，而这一支在写日志之前就 return，现场
        // 连一行痕迹都没有。改成交给共享路由：网关名照常转发，内层也没注册时回带厂商名的 404，
        // UI 才能说清楚是谁没配，而不是让人去核对 Base URL。
        let gateway = "legacy-probe";
        let upstream = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let upstream_addr = upstream.server_addr().to_ip().unwrap();
        register_router_route(gateway, &format!("http://{upstream_addr}/v1"), "probe-secret", false);
        let relay = std::thread::spawn(move || {
            let mut request = upstream.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
            assert_eq!(request.url(), "/v1/responses");
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body).unwrap();
            let body: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(body["model"], "kept", "the gateway prefix is stripped before the vendor sees it");
            request.respond(tiny_http::Response::from_string("ok").with_status_code(200)).unwrap();
        });
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let client = std::thread::spawn(move || {
            reqwest::blocking::Client::new()
                .post(format!("http://{address}/openai/responses"))
                .json(&serde_json::json!({"model": format!("{gateway}/kept"), "input": []}))
                .send()
                .unwrap()
                .status()
                .as_u16()
        });
        handle(server.recv_timeout(Duration::from_secs(5)).unwrap().unwrap()).unwrap();
        assert_eq!(client.join().unwrap(), 200, "a retired provider path must be re-dispatched, not refused");
        relay.join().unwrap();
        unregister_router_route(gateway);

        let client = std::thread::spawn(move || {
            let response = reqwest::blocking::Client::new()
                .post(format!("http://{address}/openai/responses"))
                .json(&serde_json::json!({"model": "nobody/anything", "input": []}))
                .send()
                .unwrap();
            (response.status().as_u16(), response.text().unwrap())
        });
        handle(server.recv_timeout(Duration::from_secs(5)).unwrap().unwrap()).unwrap();
        let (status, body) = client.join().unwrap();
        assert_eq!(status, 404);
        assert!(body.contains("gateway nobody is not configured"), "got: {body}");
    }

    #[test]
    fn web_search_tools_are_dropped_before_the_gateway_sees_them() {
        // The remote-compaction request carries a web_search declaration; gateways answer it with
        // 400 unsupported_parameter, which surfaced as 「上下文压缩失败」.
        let mut body: Value = serde_json::from_slice(
            br#"{"model":"m","input":[],"tools":[
                {"type":"web_search"},
                {"type":"web_search_preview"},
                {"type":"function","name":"shell","parameters":{}}
            ]}"#,
        )
        .unwrap();
        assert_eq!(strip_web_search_tools(&mut body), 2);
        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1, "only the callable tool survives");
        assert_eq!(tools[0]["name"], "shell");
    }

    #[test]
    fn an_all_web_search_tool_list_is_removed_entirely() {
        let mut body: Value =
            serde_json::from_slice(br#"{"model":"m","input":[],"tools":[{"type":"web_search"}]}"#).unwrap();
        assert_eq!(strip_web_search_tools(&mut body), 1);
        assert!(body.get("tools").is_none(), "an empty tools array is not sent");
    }

    #[test]
    fn a_body_without_tools_is_untouched() {
        let mut body: Value = serde_json::from_slice(br#"{"model":"m","input":[]}"#).unwrap();
        assert_eq!(strip_web_search_tools(&mut body), 0);
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn qwen_tool_schema_refs_are_inlined_for_top_level_functions() {
        // The live refusal: any `$defs`/`$ref` in a tool schema answers 400 on the plan endpoint.
        let mut body: Value = serde_json::from_slice(
            br##"{"model":"qwen/qwen4-max-preview","tools":[
                {"type":"function","name":"find_pages","parameters":{
                    "type":"object",
                    "properties":{"query":{"$ref":"#/$defs/Query"}},
                    "$defs":{"Query":{"type":"object","properties":{"text":{"type":"string"}}}}
                }}
            ]}"##,
        )
        .unwrap();
        assert_eq!(inline_tool_schema_refs(&mut body), 1);
        let parameters = &body["tools"][0]["parameters"];
        assert!(parameters.get("$defs").is_none(), "the definitions block is gone");
        assert_eq!(parameters["properties"]["query"]["type"], "object");
        assert_eq!(parameters["properties"]["query"]["properties"]["text"]["type"], "string");
        assert!(!body.to_string().contains("$ref"), "no reference survives");
    }

    #[test]
    fn qwen_namespace_subtools_are_inlined_recursively() {
        // chatgpt_space arrives as a namespace whose subtools carry the offending schemas.
        let mut body: Value = serde_json::from_slice(
            br##"{"model":"qwen/qwen4-max-preview","tools":[
                {"type":"namespace","name":"mcp__codex_apps__chatgpt_space","tools":[
                    {"type":"function","name":"_find_pages","parameters":{
                        "type":"object",
                        "properties":{"a":{"$ref":"#/$defs/A"}},
                        "$defs":{"A":{"type":"object","properties":{"b":{"$ref":"#/$defs/B"}}},
                                  "B":{"type":"string"}}
                    }},
                    {"type":"function","name":"_create_space","parameters":{"type":"object"}}
                ]}
            ]}"##,
        )
        .unwrap();
        assert_eq!(inline_tool_schema_refs(&mut body), 2, "nested references expand transitively");
        let subtool = &body["tools"][0]["tools"][0]["parameters"];
        assert_eq!(subtool["properties"]["a"]["properties"]["b"]["type"], "string");
        assert!(!body.to_string().contains("$defs"));
        assert!(!body.to_string().contains("$ref"));
        assert_eq!(body["tools"][0]["tools"][1]["name"], "_create_space", "clean subtools stay intact");
    }

    #[test]
    fn schemas_without_refs_are_untouched_and_unresolvable_refs_do_not_loop() {
        let original = br#"{"tools":[{"type":"function","name":"shell","parameters":{"type":"object","properties":{"cmd":{"type":"string"}}}}]}"#;
        let mut body: Value = serde_json::from_slice(original).unwrap();
        assert_eq!(inline_tool_schema_refs(&mut body), 0);
        assert_eq!(serde_json::to_vec(&body).unwrap(), original.to_vec(), "no rewrite without $defs/$ref");
        // A dangling reference is kept (the upstream error still surfaces) instead of hanging.
        let mut dangling: Value = serde_json::from_slice(
            br##"{"tools":[{"type":"function","name":"x","parameters":{"$ref":"#/$defs/Missing","$defs":{}}}]}"##,
        )
        .unwrap();
        assert_eq!(inline_tool_schema_refs(&mut dangling), 0);
        assert_eq!(dangling["tools"][0]["parameters"]["$ref"], "#/$defs/Missing");
        // A cyclic definition terminates at the depth guard rather than recursing forever.
        let mut cyclic: Value = serde_json::from_slice(
            br##"{"tools":[{"type":"function","name":"x","parameters":{"$ref":"#/$defs/Loop","$defs":{"Loop":{"$ref":"#/$defs/Loop"}}}}]}"##,
        )
        .unwrap();
        let _ = inline_tool_schema_refs(&mut cyclic);
    }

    #[test]
    fn endpoint_join_trims_both_sides() {
        assert_eq!(upstream_endpoint("https://api.example.com", "responses"), "https://api.example.com/responses");
        assert_eq!(upstream_endpoint("https://api.example.com///", "/responses"), "https://api.example.com/responses");
    }

    /// Collects the `event:` names a translation emitted, in order.
    fn event_names(bytes: &[u8]) -> Vec<String> {
        String::from_utf8_lossy(bytes)
            .lines()
            .filter_map(|line| line.strip_prefix("event: ").map(str::to_string))
            .collect()
    }

    fn event_payloads(bytes: &[u8]) -> Vec<Value> {
        String::from_utf8_lossy(bytes)
            .lines()
            .filter_map(|line| line.strip_prefix("data: "))
            .filter_map(|data| serde_json::from_str::<Value>(data).ok())
            .collect()
    }

    #[test]
    fn responses_request_becomes_a_chat_request_with_history_and_tools() {
        let request = json!({
            "model": "vendor/model:free",
            "instructions": "be brief",
            "reasoning": {"effort":"high"},
            "service_tier":"priority",
            "max_output_tokens": 256,
            "stream": true,
            "input": [
                {"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},
                {"type":"reasoning","id":"r1","summary":[],"encrypted_content":"enc"},
                {"type":"function_call","call_id":"c1","name":"shell","arguments":"{\"cmd\":\"ls\"}"},
                {"type":"function_call_output","call_id":"c1","output":"file.txt"}
            ],
            "tools": [{"type":"function","name":"shell","description":"run","parameters":{"type":"object"}},
                      {"type":"web_search"}]
        });
        let chat = responses_to_chat(&request);
        assert_eq!(chat["reasoning_effort"], "high");
        assert_eq!(chat["service_tier"], "priority");
        assert_eq!(chat["model"], "vendor/model:free");
        assert_eq!(chat["max_tokens"], 256, "the token cap is renamed, not dropped");
        assert!(chat.get("max_output_tokens").is_none());
        assert!(chat.get("instructions").is_none(), "instructions become a system message");
        let messages = chat["messages"].as_array().unwrap();
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], "be brief");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"][0]["text"], "hi");
        assert_eq!(messages[2]["tool_calls"][0]["id"], "c1");
        assert_eq!(messages[2]["tool_calls"][0]["function"]["name"], "shell");
        assert_eq!(messages[3]["role"], "tool");
        assert_eq!(messages[3]["tool_call_id"], "c1");
        assert_eq!(messages[3]["content"], "file.txt");
        assert_eq!(messages.len(), 4, "reasoning items have no chat equivalent and are skipped");
        let tools = chat["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1, "only function tools survive");
        assert_eq!(tools[0]["function"]["name"], "shell");
        assert_eq!(tools[0]["function"]["parameters"]["type"], "object");
    }

    #[test]
    fn a_chat_answer_becomes_responses_output_items_and_usage() {
        let answer = json!({
            "id": "chatcmpl-7",
            "choices": [{"finish_reason":"tool_calls","message":{"content":"looking",
                "tool_calls":[{"id":"call_9","type":"function","function":{"name":"shell","arguments":"{}"}}]}}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 5, "total_tokens": 16}
        });
        let response = chat_to_responses(&answer);
        assert_eq!(response["object"], "response");
        assert_eq!(response["id"], "chatcmpl-7");
        assert_eq!(response["status"], "completed");
        let output = response["output"].as_array().unwrap();
        assert_eq!(output[0]["type"], "message");
        assert_eq!(output[0]["content"][0]["type"], "output_text");
        assert_eq!(output[0]["content"][0]["text"], "looking");
        assert_eq!(output[1]["type"], "function_call");
        assert_eq!(output[1]["call_id"], "call_9");
        assert_eq!(output[1]["name"], "shell");
        assert_eq!(response["usage"]["input_tokens"], 11);
        assert_eq!(response["usage"]["output_tokens"], 5);
    }

    #[test]
    fn a_length_capped_chat_answer_is_not_reported_as_completed() {
        let answer = json!({"id":"c","choices":[{"finish_reason":"length","message":{"content":"half"}}]});
        let response = chat_to_responses(&answer);
        assert_eq!(response["status"], "incomplete");
        assert_eq!(response["incomplete_details"]["reason"], "max_output_tokens");
    }

    #[test]
    fn a_chat_stream_emits_the_full_responses_item_lifecycle() {
        let mut stream = ChatResponsesStream::new();
        let mut out = stream.translate(
            br#"data: {"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant","content":"Hel"}}]}

data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}

data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}

data: [DONE]

"#,
        );
        out.extend(stream.finish());
        assert_eq!(
            event_names(&out),
            vec![
                "response.created",
                "response.output_item.added",
                "response.content_part.added",
                "response.output_text.delta",
                "response.output_text.delta",
                "response.output_text.done",
                "response.content_part.done",
                "response.output_item.done",
                "response.completed",
            ]
        );
        let payloads = event_payloads(&out);
        let text: String = payloads
            .iter()
            .filter(|value| value["type"] == "response.output_text.delta")
            .map(|value| value["delta"].as_str().unwrap())
            .collect();
        assert_eq!(text, "Hello");
        let done = payloads.iter().find(|value| value["type"] == "response.output_text.done").unwrap();
        assert_eq!(done["text"], "Hello", "the done event carries the accumulated text");
        let completed = payloads.last().unwrap();
        assert_eq!(completed["response"]["status"], "completed");
        assert_eq!(completed["response"]["usage"]["input_tokens"], 3);
        // Every event is numbered so the engine can detect a gap.
        let numbers: Vec<u64> = payloads.iter().map(|value| value["sequence_number"].as_u64().unwrap()).collect();
        assert_eq!(numbers, (0..numbers.len() as u64).collect::<Vec<_>>());
    }

    #[test]
    fn a_frame_split_across_reads_is_buffered_until_it_is_complete() {
        let mut stream = ChatResponsesStream::new();
        let frame = "data: {\"id\":\"c\",\"choices\":[{\"delta\":{\"content\":\"split\"}}]}\n\n";
        // Cut mid-JSON: the first read must produce nothing rather than a parse failure.
        let first = stream.translate(&frame.as_bytes()[..24]);
        assert!(first.is_empty(), "a partial frame must not emit a half event");
        let mut out = stream.translate(&frame.as_bytes()[24..]);
        out.extend(stream.translate(b"data: [DONE]\n\n"));
        out.extend(stream.finish());
        let payloads = event_payloads(&out);
        let text: String = payloads
            .iter()
            .filter(|value| value["type"] == "response.output_text.delta")
            .map(|value| value["delta"].as_str().unwrap())
            .collect();
        assert_eq!(text, "split");
        assert_eq!(payloads.last().unwrap()["type"], "response.completed");
    }

    #[test]
    fn streamed_tool_arguments_are_reassembled_and_the_text_item_is_closed_first() {
        let mut stream = ChatResponsesStream::new();
        let mut out = stream.translate(
            br#"data: {"id":"c","choices":[{"delta":{"content":"ok"}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\"cm"}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"d\":\"ls\"}"}}]}}]}

data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]

"#,
        );
        out.extend(stream.finish());
        let names = event_names(&out);
        let text_done = names.iter().position(|name| name == "response.output_item.done").unwrap();
        let call_added = names.iter().position(|name| name == "response.output_item.added").unwrap();
        assert!(text_done > call_added, "the message item closes before the call item opens");
        let payloads = event_payloads(&out);
        let arguments: String = payloads
            .iter()
            .filter(|value| value["type"] == "response.function_call_arguments.delta")
            .map(|value| value["delta"].as_str().unwrap())
            .collect();
        assert_eq!(arguments, "{\"cmd\":\"ls\"}");
        let call_done = payloads.iter().rfind(|value| value["type"] == "response.output_item.done").unwrap();
        assert_eq!(call_done["item"]["type"], "function_call");
        assert_eq!(call_done["item"]["call_id"], "call_1");
        assert_eq!(call_done["item"]["arguments"], "{\"cmd\":\"ls\"}");
        // Distinct output indices: two items must never share one.
        let indices: Vec<u64> = payloads
            .iter()
            .filter(|value| value["type"] == "response.output_item.added")
            .map(|value| value["output_index"].as_u64().unwrap())
            .collect();
        assert_eq!(indices, vec![0, 1]);
    }

    #[test]
    fn a_truncated_chat_stream_is_not_reported_as_a_completed_turn() {
        let mut stream = ChatResponsesStream::new();
        let mut out = stream.translate(b"data: {\"id\":\"c\",\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
        out.extend(stream.finish());
        assert_eq!(event_names(&out).last().unwrap(), "response.failed");
        // A second finish must not emit a duplicate terminal event.
        assert!(stream.finish().is_empty());
    }

    #[test]
    fn metadata_and_heartbeats_are_safe_to_replay_but_errors_and_output_are_not() {
        assert_eq!(
            stream_prelude(b": ping\r\n\r\ndata: {\"type\":\"response.created\"}\r\n\r\ndata: {\"typ", false),
            Prelude::Wait
        );
        assert_eq!(
            stream_prelude(b"data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n", true),
            Prelude::Wait
        );
        assert_eq!(stream_prelude(b"data: {\"type\":\"response.output_item.added\"}\r\n\r\n", false), Prelude::Forward);
        assert_eq!(stream_prelude(b"data: {\"error\":{\"code\":401}}\n\n", true), Prelude::Forward);
        assert_eq!(
            stream_prelude(b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{}]}}]}\n\n", true),
            Prelude::Forward
        );
        assert_eq!(
            stream_prelude(
                b"data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"stream_disconnected\"}}}\n\n",
                false
            ),
            Prelude::Reconnect
        );
        // A server-side limit is a final answer, not a transport failure: never reconnect into it.
        for limit in ["rate_limit_exceeded", "insufficient_quota", "usage_limit_reached", "quota_exceeded"] {
            let frame = format!(
                "data: {{\"type\":\"response.failed\",\"response\":{{\"error\":{{\"code\":\"{limit}\"}}}}}}\n\n"
            );
            assert_eq!(stream_prelude(frame.as_bytes(), false), Prelude::Forward, "{limit}");
        }
        let mut stream = ChatResponsesStream::new();
        stream.translate(b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\r\n\r\n");
        assert_eq!(event_names(&stream.finish()).last().unwrap(), "response.completed");
    }

    #[test]
    fn hakimi_recovers_after_a_metadata_only_disconnect_without_leaking_the_abandoned_response() {
        let _lock = GATEWAY_SWITCH_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let _restore = SwitchRestore(gateway_retry_enabled());
        set_gateway_retry(true);
        let upstream = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/responses", upstream.server_addr());
        let vendor = std::thread::spawn(move || {
            for body in [
                "data: {\"type\":\"response.created\",\"id\":\"abandoned\"}\r\n\r\n",
                "data: {\"type\":\"response.completed\"}\n\n",
            ] {
                let mut request = upstream.recv_timeout(Duration::from_secs(5)).unwrap().expect("expected request");
                let mut payload = String::new();
                request.as_reader().read_to_string(&mut payload).unwrap();
                assert_eq!(payload, "{\"model\":\"m\"}");
                request
                    .respond(
                        tiny_http::Response::from_string(body)
                            .with_header("Content-Type: text/event-stream".parse::<tiny_http::Header>().unwrap()),
                    )
                    .unwrap();
            }
        });
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let local = format!("http://{}/responses", server.server_addr());
        let consumer = std::thread::spawn(move || {
            reqwest::blocking::Client::new().post(local).timeout(Duration::from_secs(7)).send().unwrap().text().unwrap()
        });
        relay(
            server.recv().unwrap(),
            "hakimi/m",
            &endpoint,
            None,
            &[],
            br#"{"model":"m"}"#.to_vec(),
            false,
            false,
            false,
            false,
            true,
        )
        .unwrap();
        vendor.join().unwrap();
        let stream = consumer.join().unwrap();
        assert!(stream.contains("response.completed"));
        assert!(!stream.contains("abandoned"));
    }

    #[test]
    fn an_in_band_chat_error_is_forwarded_as_a_failure_not_an_empty_answer() {
        let mut stream = ChatResponsesStream::new();
        let out = stream.translate(b"data: {\"error\":{\"code\":10000,\"message\":\"rate limited\"}}\n\n");
        let payloads = event_payloads(&out);
        assert_eq!(payloads.last().unwrap()["type"], "response.failed");
        assert_eq!(payloads.last().unwrap()["response"]["error"]["message"], "rate limited");
        assert!(stream.finish().is_empty(), "a failed turn is not also completed");
    }

    #[test]
    fn sanitize_clears_only_reasoning_content() {
        let body = br#"{"model":"m","input":[
            {"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},
            {"type":"reasoning","id":"r1","summary":[],"content":[{"type":"reasoning_text","text":"secret thoughts"}],"encrypted_content":"enc"},
            {"type":"reasoning","id":"r2","summary":[]},
            {"type":"function_call","call_id":"c1","name":"shell","arguments":"{}"}
        ]}"#;
        let out: Value = serde_json::from_slice(&sanitize(body)).unwrap();
        let input = out["input"].as_array().unwrap();
        assert_eq!(input[0]["content"].as_array().unwrap().len(), 1, "message content untouched");
        assert_eq!(input[1]["content"].as_array().unwrap().len(), 0, "reasoning content emptied");
        assert_eq!(input[1]["encrypted_content"], "enc", "encrypted reasoning kept");
        assert!(input[2].get("content").is_none(), "already-empty item untouched");
        assert_eq!(input[3]["name"], "shell", "tool calls untouched");
    }

    #[test]
    fn sanitize_passes_through_invalid_bodies() {
        assert_eq!(sanitize(b"not json"), b"not json".to_vec());
    }

    #[test]
    fn invalid_encrypted_content_is_recognised() {
        let wall = r#"{"error":{"message":"The encrypted content rs_0db2 could not be verified. Reason: Encrypted content could not be decrypted or parsed.","code":"invalid_encrypted_content"}}"#;
        assert!(is_invalid_encrypted_content(wall));
        // The code alone is enough: the message may be localized upstream.
        assert!(is_invalid_encrypted_content(r#"{"code":"invalid_encrypted_content"}"#));
        assert!(!is_invalid_encrypted_content(r#"{"error":{"message":"rate limited"}}"#));
    }

    #[test]
    fn recovery_drops_reasoning_but_keeps_the_conversation() {
        let body = br#"{"model":"m","input":[
            {"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},
            {"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"opaque"},
            {"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]},
            {"type":"function_call","call_id":"c1","name":"shell","arguments":"{}"}
        ]}"#;
        let stripped = drop_reasoning_items(body).expect("a reasoning item was present");
        let out: Value = serde_json::from_slice(&stripped).unwrap();
        let input = out["input"].as_array().unwrap();
        assert_eq!(input.len(), 3, "only the reasoning item is gone");
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[1]["role"], "assistant");
        assert_eq!(input[2]["name"], "shell");
    }

    #[test]
    fn recovery_is_skipped_when_there_is_nothing_to_drop() {
        assert!(drop_reasoning_items(br#"{"model":"m","input":[{"type":"message","role":"user"}]}"#).is_none());
        assert!(drop_reasoning_items(b"not json").is_none());
    }

    fn watched(stream: Vec<u8>, enabled: bool) -> OverloadWatch<std::io::Cursor<Vec<u8>>> {
        OverloadWatch {
            inner: std::io::Cursor::new(stream),
            model: "gpt-6.1-sol".to_string(),
            request_id: "r-test".to_string(),
            tail: Vec::new(),
            fired: false,
            enabled,
            acked: Arc::new(AtomicBool::new(false)),
            closed: Arc::new(AtomicBool::new(false)),
            activity: None,
        }
    }

    fn drain(reader: &mut OverloadWatch<std::io::Cursor<Vec<u8>>>) -> Vec<u8> {
        let mut received = Vec::new();
        // Small reads prove a split SSE event is still recognized as a whole line.
        let mut chunk = [0u8; 7];
        loop {
            let count = reader.read(&mut chunk).unwrap();
            if count == 0 {
                break;
            }
            received.extend_from_slice(&chunk[..count]);
        }
        received
    }

    fn stream_reader(
        chunks: Vec<StreamChunk>, idle: Duration, hard: Duration,
    ) -> (StreamReader, std::sync::mpsc::SyncSender<StreamChunk>) {
        let (tx, rx) = std::sync::mpsc::sync_channel::<StreamChunk>(64);
        for chunk in chunks {
            tx.send(chunk).unwrap();
        }
        (StreamReader::new(rx, idle, hard, Arc::new(AtomicBool::new(false))), tx)
    }

    #[test]
    fn dropping_the_reader_tells_the_upstream_thread_to_stop() {
        let (tx, rx) = std::sync::mpsc::sync_channel::<StreamChunk>(1);
        let flag = Arc::new(AtomicBool::new(false));
        let reader = StreamReader::new(rx, Duration::from_secs(60), Duration::from_secs(60), Arc::clone(&flag));
        assert!(!flag.load(Ordering::Relaxed), "a live stream is not cancelled");
        drop(reader);
        assert!(flag.load(Ordering::Relaxed), "the upstream loop stops once tiny_http is done");
        drop(tx);
    }

    fn drain_stream(reader: &mut StreamReader) -> Vec<u8> {
        let mut received = Vec::new();
        // Small reads prove a chunk spanning several reads is delivered in order.
        let mut chunk = [0u8; 7];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => received.extend_from_slice(&chunk[..count]),
                Err(error) => panic!("a stream must never surface a read error: {}", error),
            }
        }
        received
    }

    #[test]
    fn stream_reader_delivers_upstream_bytes_untouched() {
        let (mut reader, _tx) = stream_reader(
            vec![
                StreamChunk::Data(b"data: {\"type\":\"a\"}\n\n".to_vec()),
                StreamChunk::Data(b"data: {\"type\":\"b\"}\n\n".to_vec()),
                StreamChunk::End,
            ],
            Duration::from_secs(60),
            Duration::from_secs(60),
        );
        let text = String::from_utf8(drain_stream(&mut reader)).unwrap();
        assert_eq!(text, "data: {\"type\":\"a\"}\n\ndata: {\"type\":\"b\"}\n\n");
    }

    #[test]
    fn a_silent_upstream_gets_a_reason_instead_of_a_dropped_socket() {
        let (mut reader, _tx) = stream_reader(vec![], Duration::from_millis(10), Duration::from_secs(60));
        let text = String::from_utf8(drain_stream(&mut reader)).unwrap();
        // `response.failed` is the only failure event codex 0.164 acts on; a bare `event: error`
        // parses and is then ignored, leaving the generic "stream closed" message on screen.
        assert!(text.starts_with("\n\n"), "an event frame must not glue onto a half-written one: {text}");
        assert!(text.contains("event: response.failed"), "{}", text);
        assert!(text.contains("\"type\":\"response.failed\""), "{}", text);
        assert!(text.contains("\"status\":\"failed\""), "{}", text);
        assert!(text.contains(STREAM_TIMEOUT_CODE), "{}", text);
    }

    #[test]
    fn a_lost_upstream_thread_is_named_instead_of_ending_silently() {
        let (mut reader, tx) = stream_reader(vec![], Duration::from_secs(60), Duration::from_secs(60));
        drop(tx);
        let text = String::from_utf8(drain_stream(&mut reader)).unwrap();
        assert!(text.contains("event: response.failed"), "{}", text);
        assert!(text.contains("上游连接被关闭"), "{}", text);
    }

    #[test]
    fn stream_io_diagnostics_only_identify_known_transport_causes() {
        use std::io::{Error, ErrorKind};

        let wrapped = Error::other(Error::from(ErrorKind::ConnectionReset));
        assert_eq!(super::stream_io_kind(&wrapped), Some(ErrorKind::ConnectionReset));
        assert_eq!(super::stream_io_kind(&Error::other("request or response body error")), None);
    }

    #[test]
    fn an_upstream_read_error_becomes_a_structured_event() {
        let (mut reader, _tx) = stream_reader(
            vec![StreamChunk::Failed("connection reset".to_string())],
            Duration::from_secs(60),
            Duration::from_secs(60),
        );
        let text = String::from_utf8(drain_stream(&mut reader)).unwrap();
        assert!(text.contains("connection reset"), "{}", text);
        assert!(text.contains(STREAM_TIMEOUT_CODE), "{}", text);
    }

    #[test]
    fn the_hard_cap_ends_a_stream_that_never_stops_emitting() {
        let (mut reader, _tx) = stream_reader(vec![], Duration::from_secs(60), Duration::from_millis(0));
        let text = String::from_utf8(drain_stream(&mut reader)).unwrap();
        assert!(text.contains(STREAM_TIMEOUT_CODE), "{}", text);
    }

    #[test]
    fn overload_error_yields_its_retry_after() {
        let event = br#"data: {"type":"error","error":{"code":"server_is_overloaded","headers":{"retry-after": "316","retry-after-ms":"316000"}}}"#;
        assert_eq!(retry_after_seconds(event), Some(316));
        assert_eq!(retry_after_seconds(br#"data: {"type":"response.created"}"#), None);
        assert_eq!(overload_error_line(event).map(<[u8]>::len), Some(event.len()));
    }

    #[test]
    fn openrouter_error_10000_is_a_structured_line_not_a_bare_number() {
        // OpenRouter injects `{"error":{"code":10000,…}}` into the SSE stream when it rate-limits.
        let numeric = br#"data: {"error":{"code":10000,"message":"rate limited"}}"#;
        assert!(openrouter_error_line(numeric).is_some());
        // The code also arrives as a string on some endpoints.
        let stringy = br#"data: {"error":{"code":"10000","message":"rate limited"}}"#;
        assert!(openrouter_error_line(stringy).is_some());
        // A model quoting the number in normal output is not an error event.
        let quoted = br#"data: {"type":"response.output_text.delta","delta":"error code 10000 means rate limited"}"#;
        assert!(openrouter_error_line(quoted).is_none());
        // Other error codes are not ours.
        let other = br#"data: {"error":{"code":10001,"message":"something else"}}"#;
        assert!(openrouter_error_line(other).is_none());
    }

    #[test]
    fn the_429_mute_switch_defaults_to_false_and_round_trips() {
        // Both mute switches start off: today's behaviour is unchanged until the user opts in.
        let previous = overload_429_mute();
        set_overload_429_mute(false);
        assert!(!overload_429_mute());
        set_overload_429_mute(true);
        assert!(overload_429_mute());
        set_overload_429_mute(previous);
    }

    #[test]
    fn a_model_quoting_the_phrase_is_not_an_overload() {
        // The reader asked about the error code; a gateway model answered with the phrase in normal
        // output while its tokens were being billed. No error event, so no capacity notice.
        let stream = b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"the backend replied server_is_overloaded with retry-after 316\"}\n\n".to_vec();
        let mut watch = watched(stream.clone(), true);
        assert_eq!(drain(&mut watch), stream, "the engine must still see the untouched SSE bytes");
        assert!(!watch.fired);
        assert!(overload_error_line(&watch.tail).is_none());
    }

    #[test]
    fn a_gateway_stream_is_never_watched_for_a_chatgpt_error_code() {
        let stream = b"data: {\"type\":\"error\",\"error\":{\"code\":\"server_is_overloaded\",\"headers\":{\"retry-after\":\"324\"}}}\n\n".to_vec();
        let mut watch = watched(stream.clone(), false);
        assert_eq!(drain(&mut watch), stream);
        assert!(!watch.fired, "gateway vendors have their own error vocabulary");
    }

    #[test]
    fn both_stall_observers_are_armed_together_and_only_on_the_native_route() {
        // The overload reader alone used to be gated while the no-ack timer still ran for every
        // vendor. A slow gateway turn then published `model:stalled` with a ChatGPT reason and
        // the UI attached it to whichever GPT turn was open.
        assert_eq!(stall_observers(false), (false, false));
        assert_eq!(stall_observers(true), (true, true));
    }

    #[test]
    fn overload_watch_passes_every_byte_through_and_fires_once() {
        let stream = b"data: {\"type\":\"error\",\"error\":{\"code\":\"server_is_overloaded\",\"headers\":{\"retry-after\":\"324\"}}}\n\n".to_vec();
        let mut watch = watched(stream.clone(), true);
        assert_eq!(drain(&mut watch), stream, "the engine must still see the untouched SSE bytes");
        assert!(watch.fired);
        assert_eq!(retry_after_seconds(overload_error_line(&watch.tail).unwrap()), Some(324));
        // Bytes arrived, so the no-ack clock must have been cancelled for this request.
        assert!(watch.acked.load(Ordering::Relaxed));
        assert!(watch.closed.load(Ordering::Relaxed));
    }

    #[test]
    fn an_acknowledged_stream_is_never_reported_as_a_stall() {
        // A turn that has emitted `response.created` and then thinks for two minutes is a reasoning
        // model doing its job, not an upstream that never answered.
        assert!(!no_ack_expired(true, false, NO_ACK_TIMEOUT * 10));
        assert!(no_ack_expired(false, false, NO_ACK_TIMEOUT + Duration::from_secs(1)));
        // A finished request has nothing left to wait on, whatever the clock says.
        assert!(!no_ack_expired(false, true, NO_ACK_TIMEOUT * 10));
        assert!(!no_ack_expired(false, false, Duration::from_secs(30)));
    }

    #[test]
    fn the_no_ack_threshold_leaves_room_for_a_slow_first_event() {
        // Measured first-event latency against ChatGPT is 0.8–2s; two minutes cannot be reasoning.
        assert!(NO_ACK_TIMEOUT >= Duration::from_secs(60));
    }

    #[test]
    fn cross_vendor_ids_are_dropped_but_correct_ones_survive() {
        // A thread written through a gateway can carry `msg_…` ids on reasoning items. The backend
        // refuses the whole turn, so the id — not the item — has to go.
        let body = br#"{"model":"m","input":[
            {"type":"message","role":"user","id":"msg_1","content":[]},
            {"type":"reasoning","id":"msg_2","summary":[]},
            {"type":"reasoning","id":"rs_3","summary":[]},
            {"type":"message","role":"assistant","id":"rs_4","content":[]},
            {"type":"function_call","id":"msg_5","call_id":"c1","name":"shell","arguments":"{}"}
        ]}"#;
        let mut parsed: Value = serde_json::from_slice(body).unwrap();
        assert_eq!(normalize_item_ids(&mut parsed), 3);
        let input = parsed["input"].as_array().unwrap();
        assert_eq!(input[0]["id"], "msg_1", "a message keeps its msg_ id");
        assert!(input[1].get("id").is_none(), "reasoning loses its msg_ id");
        assert_eq!(input[2]["id"], "rs_3", "reasoning keeps its rs_ id");
        assert!(input[3].get("id").is_none(), "a message loses an rs_ id");
        assert!(input[4].get("id").is_none(), "a function call loses a msg_ id");
    }

    #[test]
    fn a_repairable_history_needs_no_change() {
        let body = br#"{"model":"m","input":[{"type":"message","id":"msg_1"},{"type":"reasoning","id":"rs_2"}]}"#;
        let mut parsed: Value = serde_json::from_slice(body).unwrap();
        assert_eq!(normalize_item_ids(&mut parsed), 0);
    }

    #[test]
    fn namespaced_tool_calls_are_made_replayable() {
        // Codex's own multi-agent namespace uses `::`; the Responses API only accepts
        // `[a-zA-Z0-9_.-]`. A single historical call otherwise poisons every later turn.
        let body = br#"{"model":"m","input":[
            {"type":"function_call","call_id":"c1","name":"multi_agent_v1::spawn_agent","arguments":"{}"},
            {"type":"function_call","call_id":"c2","name":"mcp__apps__space/_patch_page","arguments":"{}"},
            {"type":"function_call","call_id":"c3","name":"shell","arguments":"{}"},
            {"type":"function_call_output","call_id":"c1","output":"ok"}
        ]}"#;
        let mut parsed: Value = serde_json::from_slice(body).unwrap();
        assert_eq!(normalize_tool_call_names(&mut parsed), 2);
        let input = parsed["input"].as_array().unwrap();
        assert_eq!(input[0]["name"], "multi_agent_v1.spawn_agent");
        assert_eq!(input[1]["name"], "mcp__apps__space__patch_page");
        assert_eq!(input[2]["name"], "shell", "valid names stay untouched");
        assert_eq!(input[0]["call_id"], "c1", "the executable call id is preserved");
        assert_eq!(input[3]["output"], "ok");
    }

    #[test]
    fn an_already_portable_tool_name_is_not_rewritten() {
        assert_eq!(portable_function_name("multi_agent_v1.spawn_agent"), "multi_agent_v1.spawn_agent");
        assert_eq!(portable_function_name("mcp__apps__space._patch_page"), "mcp__apps__space._patch_page");
        assert_eq!(portable_function_name(""), "tool");
    }

    #[test]
    fn the_refusal_names_the_item_to_repair() {
        let body = r#"{"error":{"message":"Invalid 'input[74].id': 'msg_2540f66c-e563-4b51-8d77-ae28e3f0529d'. Expected an ID that begins with 'rs'.","type":"invalid_request_error","param":"input[74].id","code":"invalid_value"}}"#;
        assert!(is_id_prefix_mismatch(body));
        assert_eq!(refused_input_index(body), Some(74));
        // The encrypted-content refusal is a different repair and must not be mistaken for this one.
        assert!(!is_id_prefix_mismatch(r#"{"code":"invalid_encrypted_content"}"#));
        assert_eq!(refused_input_index(r#"{"error":{"message":"no index here"}}"#), None);
    }

    #[test]
    fn the_fallback_drops_exactly_one_id() {
        let body = br#"{"model":"m","input":[{"type":"message","id":"msg_1","content":[]},{"type":"item_reference","id":"msg_2"}]}"#;
        let fixed = drop_item_id(body, 1).expect("the named item is repairable");
        let parsed: Value = serde_json::from_slice(&fixed).unwrap();
        assert_eq!(parsed["input"][0]["id"], "msg_1", "other items are untouched");
        assert!(parsed["input"][1].get("id").is_none());
        assert!(drop_item_id(body, 9).is_none(), "an out-of-range index is not a repair");
    }

    #[test]
    fn overload_mute_defaults_to_false_and_round_trips() {
        // A plain bool has no clamp to prove; the point is the global switch is off by default
        // (today's behaviour: an overload reaches the user as a notice) and survives a toggle.
        let previous = overload_mute();
        set_overload_mute(false);
        assert!(!overload_mute(), "default keeps today's notice behaviour");
        set_overload_mute(true);
        assert!(overload_mute(), "a muted switch is read back immediately");
        set_overload_mute(false);
        assert!(!overload_mute(), "the switch clears cleanly");
        set_overload_mute(previous);
    }

    #[test]
    fn stall_payload_carries_attempt_request_id_and_original_fields() {
        let payload = stall_payload("gpt-6.1-sol", REASON_OVERLOADED, Some(316), 3, "r42");
        assert_eq!(payload["model"], "gpt-6.1-sol");
        assert_eq!(payload["reason"], REASON_OVERLOADED);
        assert_eq!(payload["retryAfter"], 316);
        assert_eq!(payload["attempt"], 3);
        assert_eq!(payload["requestId"], "r42");
        // A no-ack stall is not an overload event: attempt 0, requestId still present.
        let no_ack = stall_payload("gpt-6.1-sol", REASON_NO_ACK, None, 0, "r43");
        assert_eq!(no_ack["attempt"], 0);
        assert!(no_ack["requestId"].is_string());
    }

    #[test]
    fn request_ids_increase_and_attempts_count_real_events_only() {
        let a = next_request_id();
        let b = next_request_id();
        assert_ne!(a, b, "each upstream request gets a fresh dedup key");
        // `next_overload_attempt` is called only from OverloadWatch on a real, deduped event.
        // Use a tolerant comparison: another test may fire a real event in parallel.
        let first = next_overload_attempt();
        let second = next_overload_attempt();
        assert!(second > first, "attempts increase with each real event");
    }

    #[test]
    fn header_timeout_frees_the_worker_on_a_silent_upstream() {
        // An upstream that accepts the connection but never writes response headers.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let (_stream, _) = listener.accept().unwrap();
            // Hold the accepted socket open, never send headers, until the test releases it.
            let _ = stop_rx.recv();
        });
        // A short client timeout lets the detached `.send()` thread terminate quickly after we
        // release the listener, so the test cannot hang.
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let builder = client.post(format!("http://{addr}/")).body(Vec::<u8>::new());
        let start = Instant::now();
        // Production uses HEADER_TIMEOUT (60s); a short wait keeps this test fast.
        let outcome = send_with_header_timeout(builder, Duration::from_millis(200));
        let elapsed = start.elapsed();
        assert!(matches!(outcome, HeaderWait::Timeout), "a silent upstream must time out");
        assert!(
            elapsed < Duration::from_secs(2),
            "worker must be freed by the header timeout, not the 5s client timeout: {elapsed:?}"
        );
        // Release the silent listener; the detached `.send()` then errors out and exits.
        let _ = stop_tx.send(());
        let _ = holder.join();
    }

    #[test]
    fn only_an_overload_is_swallowed_by_the_replay_buffer() {
        use std::io::Write;
        use std::net::{TcpListener, TcpStream};
        use std::sync::atomic::AtomicUsize;

        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_in_thread = Arc::clone(&hits);
        let upstream_thread = std::thread::spawn(move || {
            // A healthy first event, deliberately split so the relay has to buffer it.
            const FIRST: &str = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n";
            const REST: &str = "\n";
            let (mut stream, _) = upstream.accept().unwrap();
            let mut scratch = [0u8; 1024];
            let _ = stream.read(&mut scratch);
            hits_in_thread.fetch_add(1, Ordering::Relaxed);
            let body = format!("{FIRST}{REST}");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                FIRST
            )
            .unwrap();
            stream.flush().unwrap();
            std::thread::sleep(Duration::from_millis(80));
            stream.write_all(REST.as_bytes()).unwrap();
            stream.flush().unwrap();
        });

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let bridge_addr = server.server_addr().to_ip().unwrap();
        let client_thread = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(bridge_addr).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            stream
                .write_all(b"POST /alwith/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}")
                .unwrap();
            let mut body = Vec::new();
            let mut scratch = [0u8; 4096];
            loop {
                match stream.read(&mut scratch) {
                    Ok(0) => break,
                    Ok(count) => body.extend_from_slice(&scratch[..count]),
                    Err(_) => break,
                }
            }
            String::from_utf8_lossy(&body).to_string()
        });

        let request = server.recv().unwrap();
        // Mute is a global switch, so arm it for this test and restore it afterwards. Without it
        // the relay passes the healthy first event straight through and there is nothing to prove.
        let previous = overload_mute();
        set_overload_mute(true);
        let result = relay(
            request,
            "gpt-6.1-sol",
            &format!("http://{upstream_addr}/responses"),
            None,
            &[],
            b"{}".to_vec(),
            true,
            false,
            false,
            false,
            // The native route: no gateway retry, no gateway watchdog.
            false,
        );
        set_overload_mute(previous);
        let body = client_thread.join().unwrap();
        let _ = upstream_thread.join();

        assert!(result.is_ok(), "relay failed: {result:?}");
        assert_eq!(hits.load(Ordering::Relaxed), 1, "a non-overload event must never be replayed");
        assert!(body.contains("response.output_text.delta"), "the buffered event must reach the engine intact: {body}");
        assert!(body.contains("hello"), "the complete first event must be forwarded: {body}");
    }

    #[test]
    fn overloaded_requests_are_replayed_immediately_without_honouring_retry_after() {
        use std::io::Write;
        use std::net::{TcpListener, TcpStream};
        use std::sync::atomic::AtomicUsize;

        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_in_thread = Arc::clone(&hits);
        let upstream_thread = std::thread::spawn(move || {
            const CAPACITY: &str = "data: {\"type\":\"error\",\"error\":{\"code\":\"server_is_overloaded\",\"headers\":{\"retry-after\":\"300\"}}}\n\n";
            const SUCCESS: &str = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\"}}\n\n";
            for _ in 0..3 {
                let (mut stream, _) = upstream.accept().unwrap();
                let mut scratch = [0u8; 1024];
                let _ = stream.read(&mut scratch);
                let hit = hits_in_thread.fetch_add(1, Ordering::Relaxed) + 1;
                let body = if hit < 3 { CAPACITY } else { SUCCESS };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
            }
        });

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let bridge_addr = server.server_addr().to_ip().unwrap();
        let client_thread = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(bridge_addr).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            stream
                .write_all(b"POST /alwith/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}")
                .unwrap();
            let mut body = Vec::new();
            let mut scratch = [0u8; 4096];
            loop {
                match stream.read(&mut scratch) {
                    Ok(0) => break,
                    Ok(count) => body.extend_from_slice(&scratch[..count]),
                    Err(_) => break,
                }
            }
            String::from_utf8_lossy(&body).to_string()
        });

        let request = server.recv().unwrap();
        let start = Instant::now();
        let previous = overload_mute();
        set_overload_mute(true);
        let result = relay(
            request,
            "gpt-6.1-sol",
            &format!("http://{upstream_addr}/responses"),
            None,
            &[],
            b"{}".to_vec(),
            true,
            false,
            false,
            false,
            false,
        );
        set_overload_mute(previous);
        let elapsed = start.elapsed();
        let body = client_thread.join().unwrap();
        let _ = upstream_thread.join();

        assert!(result.is_ok(), "relay failed: {result:?}");
        assert_eq!(hits.load(Ordering::Relaxed), 3, "one request plus two immediate replays");
        assert!(!body.contains("server_is_overloaded"), "the engine must never see the refusal: {body}");
        assert!(body.contains("response.completed"), "the successful replay must reach the engine: {body}");
        assert!(elapsed < Duration::from_secs(5), "retry-after must be ignored: {elapsed:?}");
    }

    #[test]
    fn an_openrouter_sse_10000_error_is_replayed_only_when_the_switch_is_off() {
        use std::io::Write;
        use std::net::{TcpListener, TcpStream};
        use std::sync::atomic::AtomicUsize;

        // The first answer is the injected 10000 error; the replay returns a healthy stream.
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_in_thread = Arc::clone(&hits);
        let upstream_thread = std::thread::spawn(move || {
            const REFUSAL: &str = "data: {\"error\":{\"code\":10000,\"message\":\"rate limited\"}}\n\n";
            const SUCCESS: &str = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\"}}\n\n";
            for _ in 0..2 {
                let (mut stream, _) = upstream.accept().unwrap();
                let mut scratch = [0u8; 1024];
                let _ = stream.read(&mut scratch);
                let hit = hits_in_thread.fetch_add(1, Ordering::Relaxed) + 1;
                let body = if hit < 2 { REFUSAL } else { SUCCESS };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
            }
        });

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let bridge_addr = server.server_addr().to_ip().unwrap();
        let client_thread = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(bridge_addr).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            stream
                .write_all(b"POST /alwith/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}")
                .unwrap();
            let mut body = Vec::new();
            let mut scratch = [0u8; 4096];
            loop {
                match stream.read(&mut scratch) {
                    Ok(0) => break,
                    Ok(count) => body.extend_from_slice(&scratch[..count]),
                    Err(_) => break,
                }
            }
            String::from_utf8_lossy(&body).to_string()
        });

        let request = server.recv().unwrap();
        let previous = overload_429_mute();
        set_overload_429_mute(true);
        let result = relay(
            request,
            "openrouter/vendor-model",
            &format!("http://{upstream_addr}/responses"),
            None,
            &[],
            b"{}".to_vec(),
            // Gateway route: the native overload watch is off, but this test explicitly arms the
            // OpenRouter 429/10000 contract.
            false,
            true,
            false,
            false,
            // Kept off so the free-quota bookkeeping of the real gateway path never leaks into the
            // 429-replay assertion.
            false,
        );
        set_overload_429_mute(previous);
        let body = client_thread.join().unwrap();
        let _ = upstream_thread.join();

        assert!(result.is_ok(), "relay failed: {result:?}");
        assert_eq!(hits.load(Ordering::Relaxed), 2, "one request plus one silent replay");
        assert!(!body.contains("\"code\":10000"), "the engine must never see the injected error: {body}");
        assert!(body.contains("response.completed"), "the replay must reach the engine: {body}");
    }

    #[test]
    fn an_empty_refusal_is_the_only_one_worth_probing() {
        // 空 body = 上游什么也没说。只有这种才值得用削弱请求的方式试。
        assert!(refusal_is_opaque(""));
        assert!(refusal_is_opaque("   \n\t "));
        // 任何一句有语义的话都不许碰：重试只会多花一次额度，还把真实原因埋到第二次请求里。
        assert!(!refusal_is_opaque(r#"{"error":{"message":"model not found"}}"#));
        assert!(!refusal_is_opaque(r#"{"path":"/v4/responses"}"#));
        assert!(!refusal_is_opaque("<html><body>Request Entity Too Large</body></html>"));
    }

    #[test]
    fn trimming_keeps_the_newest_turns_and_never_leaves_an_orphan_call() {
        // 真实形状：压缩摘要 + 成对的工具调用 + 助手发言 + 用户提问，共 40 回合。
        let mut input: Vec<Value> = Vec::new();
        for round in 0..40 {
            input.push(
                json!({"type":"message","role":"user","content":[{"type":"input_text","text":format!("q{round}")}]}),
            );
            input.push(json!({"type":"reasoning","id":format!("rs_{round}"),"summary":[]}));
            input.push(json!({"type":"function_call","call_id":format!("c{round}"),"name":"shell","arguments":"{}"}));
            input.push(json!({"type":"function_call_output","call_id":format!("c{round}"),"output":"ok"}));
            input.push(json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":format!("a{round}")}]}));
        }
        let body = serde_json::to_vec(&json!({"model":"gpt-6.2-sol","input":input})).unwrap();
        let trimmed = trim_history(&body, 11, usize::MAX).expect("40 rounds must be trimmable to 11 items");
        let parsed: Value = serde_json::from_slice(&trimmed).unwrap();
        let kept = parsed["input"].as_array().unwrap();

        assert!(kept.len() <= 11, "the item cap is an upper bound, got {}", kept.len());
        assert!(kept.len() >= 5, "the newest round must survive whole, got {}", kept.len());
        // 第一条必须是 user 消息：以助手发言或工具输出开头的历史会被直接拒。
        assert_eq!(kept[0]["type"], "message");
        assert_eq!(kept[0]["role"], "user");
        // 末条一字不动 —— 那是读者正在等的那一轮。
        assert_eq!(kept.last().unwrap()["content"][0]["text"], "a39");
        // 边界上的半个工具链必须成对消失，否则下一轮会以另一种方式失败。
        let calls: Vec<&str> =
            kept.iter().filter(|i| i["type"] == "function_call").filter_map(|i| i["call_id"].as_str()).collect();
        let outputs: Vec<&str> =
            kept.iter().filter(|i| i["type"] == "function_call_output").filter_map(|i| i["call_id"].as_str()).collect();
        assert_eq!(calls, outputs, "every kept call has its output and vice versa");
        // 原文没被改动。
        assert_eq!(parsed["model"], "gpt-6.2-sol");
    }

    #[test]
    fn trimming_a_short_history_is_a_no_op() {
        // 小对话被拒是别的原因；裁了只会白丢上下文，所以必须返回 None 让真实错误到达读者。
        let body = br#"{"model":"m","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}]}"#;
        assert!(trim_history(body, 400, TRIM_BUDGET_BYTES).is_none());

        let mut long: Vec<Value> = Vec::new();
        for round in 0..3 {
            long.push(
                json!({"type":"message","role":"user","content":[{"type":"input_text","text":format!("q{round}")}]}),
            );
            long.push(json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":format!("a{round}")}]}));
        }
        let body = serde_json::to_vec(&json!({"model":"m","input":long})).unwrap();
        assert!(trim_history(&body, 400, TRIM_BUDGET_BYTES).is_none(), "under the cap: nothing to trim");
    }

    #[test]
    fn a_refused_request_reports_its_own_shape() {
        // 这一行是整类故障的定位手段：上一次只有体积，没有「发的是什么」。
        let body = serde_json::to_vec(&json!({"model":"m","input":[
            {"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]},
            {"type":"function_call","call_id":"c1","name":"shell","arguments":"{}"},
            {"type":"function_call_output","call_id":"c1","output":"ok"},
            {"type":"reasoning","id":"rs_1","summary":[]}
        ]}))
        .unwrap();
        let described = describe_payload(&body);
        assert!(described.contains("items=4"), "got: {described}");
        assert!(described.contains("function_call"), "got: {described}");
        assert!(described.contains("bytes"), "got: {described}");
    }

    #[test]
    fn a_malformed_gateway_selection_never_falls_through_to_chatgpt() {
        let payload = serde_json::to_vec(&json!({"model":"gateway:deepseek","input":[]})).unwrap();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let client = std::thread::spawn(move || {
            reqwest::blocking::Client::new()
                .post(format!("http://{address}/alwith/responses"))
                .body(payload)
                .send()
                .unwrap()
                .text()
                .unwrap()
        });
        handle(server.recv_timeout(Duration::from_secs(5)).unwrap().unwrap()).unwrap();
        let body = client.join().unwrap();
        assert!(body.contains("model_route_required"), "got: {body}");
        assert!(!body.contains("native models need a ChatGPT sign-in"), "must not reach native dispatch");
    }

    #[test]
    fn an_opaque_404_recovers_by_trimming_the_oldest_history() {
        // 2026-11-19 的真实事故：一条开了十天的对话重放出 7.8MB / 万条历史，chatgpt.com 回了
        // 空 body 的 404，桥里三条补救一条都不匹配，整轮只能报「厂商返回了 404」——而模型是好的。
        //
        // 这条测试走完整链路：上游第一次空 404，桥自己换成裁过的历史再发一次，第二次 200。
        // 断言的是「读者最终拿到 200」以及「第二次发出去的确实更小、且以用户消息开头、没有孤儿
        // 工具调用」，而不是某个内部函数的返回值。
        let gateway = "trim-probe";
        let upstream = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let upstream_addr = upstream.server_addr().to_ip().unwrap();
        register_router_route(gateway, &format!("http://{upstream_addr}/v1"), "probe-secret", false);
        let first_len = Arc::new(std::sync::Mutex::new(0usize));
        let seen_first_len = Arc::clone(&first_len);
        let relay = std::thread::spawn(move || {
            // 第一次：读一遍就拒绝，body 为空 —— 这正是那个 404 的形态。
            let mut first = upstream.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
            let mut body = String::new();
            first.as_reader().read_to_string(&mut body).unwrap();
            *seen_first_len.lock().unwrap() = body.len();
            first.respond(tiny_http::Response::from_string("").with_status_code(404)).unwrap();

            // 第二次：留下来自桥的请求，并允许它通过。
            let mut second = upstream.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
            let mut body = String::new();
            second.as_reader().read_to_string(&mut body).unwrap();
            let parsed: Value = serde_json::from_str(&body).unwrap();
            let input = parsed["input"].as_array().unwrap();
            assert!(input.len() < RETRIED_ITEM_COUNT, "the retry must be smaller, got {}", input.len());
            assert_eq!(input[0]["type"], "message");
            assert_eq!(input[0]["role"], "user", "a trimmed window cannot start mid-turn");
            let calls: Vec<&str> =
                input.iter().filter(|i| i["type"] == "function_call").filter_map(|i| i["call_id"].as_str()).collect();
            let outputs: Vec<&str> = input
                .iter()
                .filter(|i| i["type"] == "function_call_output")
                .filter_map(|i| i["call_id"].as_str())
                .collect();
            assert_eq!(calls, outputs, "no orphan tool call may survive the cut");
            second
                .respond(tiny_http::Response::from_string("event: response.created\n\n").with_header(
                    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/event-stream"[..]).unwrap(),
                ))
                .unwrap();
        });

        // 一条没有 reasoning、没有 item id 的历史：可移植历史那一级无事可做，只能靠裁剪。
        // 体积要过 TRIM_MIN_PAYLOAD，否则「小对话不裁」那条闸门会拦住它（那是刻意的）。
        let filler = "x".repeat(2400);
        let mut input: Vec<Value> = Vec::new();
        for round in 0..RETRIED_ITEM_COUNT {
            input.push(json!({"type":"message","role":"user","content":[{"type":"input_text","text":format!("q{round}{filler}")}]}));
            input.push(json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":format!("a{round}")}]}));
        }
        let payload = serde_json::to_vec(&json!({"model": format!("{gateway}/any"), "input": input})).unwrap();
        assert!(payload.len() >= TRIM_MIN_PAYLOAD, "fixture must clear the size gate");

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let client = std::thread::spawn(move || {
            reqwest::blocking::Client::new()
                .post(format!("http://{address}/alwith/responses"))
                .body(payload)
                .send()
                .unwrap()
                .status()
                .as_u16()
        });
        handle(server.recv_timeout(Duration::from_secs(10)).unwrap().unwrap()).unwrap();
        assert_eq!(client.join().unwrap(), 200, "the turn must recover instead of dying on an opaque 404");
        relay.join().unwrap();
        assert!(*first_len.lock().unwrap() > 0, "the first attempt carried the full history");
        unregister_router_route(gateway);
    }

    /// 上面那条测试用的历史条数：越过 TRIM_MAX_ITEMS（400）才会触发条目上限那一级。
    const RETRIED_ITEM_COUNT: usize = 420;

    #[test]
    fn portable_history_strips_foreign_reasoning_and_item_ids() {
        let body = br#"{"model":"m","input":[
            {"type":"message","role":"user","id":"msg_1","content":[{"type":"input_text","text":"hi"}]},
            {"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"enc"},
            {"type":"function_call","id":"fc_1","call_id":"c1","name":"shell","arguments":"{}"}
        ]}"#;
        let stripped: Value = serde_json::from_slice(&portable_history(body).unwrap()).unwrap();
        let input = stripped["input"].as_array().unwrap();
        assert_eq!(input.len(), 2, "reasoning items belong to the vendor that minted them");
        assert!(input[0].get("id").is_none(), "message ids belong to the vendor too");
        assert_eq!(input[1]["call_id"], "c1", "a tool call keeps the id its result references");
        assert!(portable_history(br#"{"model":"m","input":[]}"#).is_none(), "nothing to strip, no retry");
    }

    #[test]
    fn a_gateway_that_rejects_a_foreign_history_gets_one_portable_replay() {
        use std::io::Write;
        use std::net::{TcpListener, TcpStream};
        use std::sync::atomic::AtomicUsize;

        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let bodies = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let hits_in_thread = Arc::clone(&hits);
        let bodies_in_thread = Arc::clone(&bodies);
        let upstream_thread = std::thread::spawn(move || {
            const REFUSAL: &str = r#"{"error":{"message":"upstream request was rejected"}}"#;
            const SUCCESS: &str = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\"}}\n\n";
            for _ in 0..2 {
                let (mut stream, _) = upstream.accept().unwrap();
                let mut scratch = [0u8; 8192];
                let count = stream.read(&mut scratch).unwrap_or(0);
                bodies_in_thread.lock().unwrap().push(String::from_utf8_lossy(&scratch[..count]).to_string());
                let hit = hits_in_thread.fetch_add(1, Ordering::Relaxed) + 1;
                if hit == 1 {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        REFUSAL.len(),
                        REFUSAL
                    );
                } else {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        SUCCESS.len(),
                        SUCCESS
                    );
                }
            }
        });

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let bridge_addr = server.server_addr().to_ip().unwrap();
        let client_thread = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(bridge_addr).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            stream
                .write_all(b"POST /alwith/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}")
                .unwrap();
            let mut body = Vec::new();
            let mut scratch = [0u8; 4096];
            loop {
                match stream.read(&mut scratch) {
                    Ok(0) => break,
                    Ok(count) => body.extend_from_slice(&scratch[..count]),
                    Err(_) => break,
                }
            }
            String::from_utf8_lossy(&body).to_string()
        });

        let request = server.recv().unwrap();
        let payload = json!({"model":"custom-x/m","input":[
            {"type":"message","role":"user","id":"msg_1","content":[{"type":"input_text","text":"hi"}]},
            {"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"enc"}
        ]});
        let result = relay(
            request,
            "custom-x/m",
            &format!("http://{upstream_addr}/responses"),
            None,
            &[],
            serde_json::to_vec(&payload).unwrap(),
            false,
            false,
            false,
            true,
            false,
        );
        let body = client_thread.join().unwrap();
        let _ = upstream_thread.join();
        let sent = bodies.lock().unwrap().clone();

        assert!(result.is_ok(), "relay failed: {result:?}");
        assert_eq!(hits.load(Ordering::Relaxed), 2, "one refusal plus exactly one portable replay");
        assert!(sent[0].contains("reasoning"), "the first attempt keeps the history it was given");
        assert!(!sent[1].contains("reasoning"), "the replay drops foreign reasoning: {}", sent[1]);
        assert!(!sent[1].contains("\"id\":\"msg_1\""), "the replay drops foreign ids: {}", sent[1]);
        assert!(!body.contains("upstream request was rejected"), "the refusal must not reach the engine: {body}");
        assert!(body.contains("response.completed"), "the replay must reach the engine: {body}");
    }

    /// The company relay's transient 502 must be absorbed by a silent replay, and a gateway that
    /// stays down must surface its own error. What "absorbed" means is `retry_on`'s call: on is
    /// uncounted, off is immediate.
    fn gateway_502_replays_then_surfaces(
        start: u16, fail_times: usize, expected_hits: usize, expect_success: bool, retry_on: bool,
    ) {
        use std::io::Write;
        use std::net::{TcpListener, TcpStream};
        use std::sync::atomic::AtomicUsize;

        // Held for the whole test: `relay` reads this flag itself, so it must not move under us.
        let _switch = GATEWAY_SWITCH_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let _restore = SwitchRestore(gateway_retry_enabled());
        set_gateway_retry(retry_on);

        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_addr = upstream.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_in_thread = Arc::clone(&hits);
        let upstream_thread = std::thread::spawn(move || {
            const REFUSAL: &str = r#"{"error":{"message":"Enterprise gateway request failed"}}"#;
            const SUCCESS: &str = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\"}}\n\n";
            for _ in 0..expected_hits {
                let (mut stream, _) = upstream.accept().unwrap();
                let mut scratch = [0u8; 8192];
                let _ = stream.read(&mut scratch).unwrap_or(0);
                let hit = hits_in_thread.fetch_add(1, Ordering::Relaxed) + 1;
                if hit <= fail_times {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {start} Bad Gateway\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        REFUSAL.len(),
                        REFUSAL
                    );
                } else {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        SUCCESS.len(),
                        SUCCESS
                    );
                }
            }
        });

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let bridge_addr = server.server_addr().to_ip().unwrap();
        let client_thread = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(bridge_addr).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            stream
                .write_all(b"POST /alwith/responses HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}")
                .unwrap();
            let mut body = Vec::new();
            let mut scratch = [0u8; 4096];
            loop {
                match stream.read(&mut scratch) {
                    Ok(0) => break,
                    Ok(count) => body.extend_from_slice(&scratch[..count]),
                    Err(_) => break,
                }
            }
            String::from_utf8_lossy(&body).to_string()
        });

        let request = server.recv().unwrap();
        let result = relay(
            request,
            "custom-x/m",
            &format!("http://{upstream_addr}/responses"),
            None,
            &[],
            br#"{"model":"custom-x/m","input":[]}"#.to_vec(),
            false,
            false,
            false,
            false,
            // A gateway route: that is the only route the retry switch governs, and the only one
            // whose 5xx replay is uncounted. Passing `false` here would have quietly tested the
            // native budget instead — which is exactly how the old "stays down" test kept passing
            // while claiming to cover a gateway.
            true,
        );
        let body = client_thread.join().unwrap();
        let _ = upstream_thread.join();

        assert!(result.is_ok(), "relay failed: {result:?}");
        assert_eq!(hits.load(Ordering::Relaxed), expected_hits);
        if expect_success {
            assert!(body.contains("response.completed"), "the replay must reach the engine: {body}");
            assert!(!body.contains("Enterprise gateway request failed"), "the 502 must not reach the engine: {body}");
        } else {
            assert!(
                body.contains("Enterprise gateway request failed"),
                "a dead gateway must surface its error: {body}"
            );
        }
    }

    /// Serialises the tests that read or write the process-wide retry switch.
    ///
    /// It is a plain `AtomicBool` shared by every test thread, so one test flipping it while another
    /// relays silently changes what that relay does. With an uncounted loop the wrong value does not
    /// fail a test — it hangs it for the whole retry window, which is a far worse failure mode.
    static GATEWAY_SWITCH_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Puts the process-wide switch back even when an assertion panics the test.
    ///
    /// Without it a failed assertion leaves the flag flipped for every later test in the process,
    /// which turns one real failure into a pile of confusing ones.
    struct SwitchRestore(bool);

    impl Drop for SwitchRestore {
        fn drop(&mut self) {
            set_gateway_retry(self.0);
        }
    }

    #[test]
    fn a_transient_gateway_502_is_replayed_silently() {
        // Two hits: the first is refused, the replay succeeds. The switch stays on, which is what
        // makes the replay uncounted — it terminates because the upstream recovers, not because a
        // counter ran out.
        gateway_502_replays_then_surfaces(502, 1, 2, true, true);
    }

    #[test]
    fn a_gateway_that_stays_down_surfaces_at_once_when_the_switch_is_off() {
        // This is the regression guard for "off means off": one attempt, one hit, and the vendor's
        // own 502 reaches the reader instead of being replayed twice behind their back.
        gateway_502_replays_then_surfaces(502, 1, 1, false, false);
    }

    #[test]
    fn a_gateway_is_uncounted_while_the_native_route_keeps_its_single_retry() {
        let _switch = GATEWAY_SWITCH_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        // Default: the switch is on, so a gateway is not counted at all — it retries until the
        // window closes. A ceiling is what the user was complaining about: three attempts gave up
        // after about a second of outage.
        assert!(gateway_retry_enabled(), "gateway retry must default to on");
        assert_eq!(gateway_attempts(true), None);
        assert_eq!(route_attempts(true, true), None);
        // Switched off, 「连接中断自动重试」 must mean **no** retry: one attempt, nothing hidden.
        assert_eq!(gateway_attempts(false), Some(1));
        assert_eq!(route_attempts(true, false), Some(1));
        // The native route is never widened or narrowed, whichever way the switch is set: its single
        // retry predates the switch, which is scoped to gateway models.
        assert_eq!(route_attempts(false, true), Some(2));
        assert_eq!(route_attempts(false, false), Some(2));
    }

    #[test]
    fn the_gateway_retry_switch_round_trips() {
        let _switch = GATEWAY_SWITCH_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let _restore = SwitchRestore(gateway_retry_enabled());
        set_gateway_retry(false);
        assert!(!gateway_retry_enabled());
        assert_eq!(route_attempts(true, gateway_retry_enabled()), Some(1), "off means a single attempt");
        set_gateway_retry(true);
        assert!(gateway_retry_enabled());
        assert_eq!(route_attempts(true, gateway_retry_enabled()), None, "on means no ceiling");
    }

    #[test]
    fn the_transport_budget_counts_attempts_not_kinds_of_failure() {
        let start = Instant::now();
        let open = start + GATEWAY_RETRY_WINDOW;
        let closed = start;
        // Gateway with the switch on: time is the only ceiling, so even a large retry count passes
        // while the window is open, and a single check past it does not.
        for retries in [0u32, 1, 2, 7, 100, 5_000] {
            assert!(
                may_retry_transport(retries, route_attempts(true, true), open, start),
                "retry {retries} must still be allowed inside the window"
            );
        }
        assert!(!may_retry_transport(0, route_attempts(true, true), closed, closed));
        // Native: the single retry it always had.
        assert!(may_retry_transport(0, route_attempts(false, true), closed, closed));
        assert!(!may_retry_transport(1, route_attempts(false, true), closed, closed));
        // Switch off, gateway: one attempt, so the predicate in front of the second `.send()` is
        // false — reading the helper, not assuming it: with one attempt budgeted there is no second.
        assert_eq!(route_attempts(true, false), Some(1));
        assert!(
            !may_retry_transport(0, route_attempts(true, false), open, start),
            "off must not re-send, even with an open window"
        );
        assert!(!may_retry_transport(0, gateway_attempts(false), open, start), "off must not re-send");
    }

    #[test]
    fn the_retry_gap_widens_and_stops_at_the_ceiling() {
        // The first gap must stay 400ms so the native route's single retry is unchanged.
        assert_eq!(retry_gap(0), RETRY_GAP);
        assert!(retry_gap(1) > retry_gap(0));
        assert!(retry_gap(2) > retry_gap(1));
        // An uncounted loop runs for an hour; an exponent that keeps doubling would overflow the
        // multiplication, so the cap has to hold for absurd counts too.
        assert_eq!(retry_gap(6), MAX_RETRY_GAP);
        assert_eq!(retry_gap(u32::MAX), MAX_RETRY_GAP);
        assert_eq!(replay_5xx_gap(u32::MAX), MAX_RETRY_GAP);
        assert_eq!(replay_5xx_gap(0), REPLAY_GAP);
    }

    #[test]
    fn a_502_is_replayed_only_in_the_direction_the_switch_points() {
        let start = Instant::now();
        let open = start + GATEWAY_RETRY_WINDOW;
        // On: uncounted, bounded only by the window.
        assert!(may_replay_5xx(true, true, 0, open, start));
        assert!(may_replay_5xx(true, true, 400, open, start), "no count while the window is open");
        assert!(!may_replay_5xx(true, true, 0, start, start), "the window closes it");
        // Off: the vendor's own 502 reaches the reader, not a silent replay behind their back.
        assert!(!may_replay_5xx(true, false, 0, open, start));
        // Other routes keep the historical counted budget.
        assert!(may_replay_5xx(false, true, MAX_GATEWAY_REPLAYS - 1, start, start));
        assert!(!may_replay_5xx(false, true, MAX_GATEWAY_REPLAYS, start, start));
        assert!(may_replay_5xx(false, false, 0, start, start), "the switch is scoped to gateways");
    }

    #[test]
    fn a_spent_free_quota_stops_the_silent_429_replay() {
        // The mute switch alone allows the replay.
        assert!(should_replay_429(true, 0, false));
        // A spent budget never does: replaying cannot succeed before the reset.
        assert!(!should_replay_429(true, 0, true));
        // Unmuted keeps the refusal visible, as before.
        assert!(!should_replay_429(false, 0, false));
        // The replay budget still caps an unmuted-but-unblocked route.
        assert!(!should_replay_429(true, MAX_429_REPLAYS, false));
        assert!(should_replay_429(true, MAX_429_REPLAYS - 1, false));
    }

    #[test]
    fn the_quota_reset_clause_counts_down_instead_of_naming_a_clock_time() {
        let now = 1_700_000_000i64;
        assert_eq!(quota_reset_clause_from(now, Some(now + 3_600)), "1 小时后重置。");
        assert_eq!(quota_reset_clause_from(now, Some(now + 3_600 + 1_200)), "1 小时 20 分钟后重置。");
        assert_eq!(quota_reset_clause_from(now, Some(now + 90)), "2 分钟后重置。");
        // Less than a minute still reads as one, never as "0 分钟后".
        assert_eq!(quota_reset_clause_from(now, Some(now + 5)), "1 分钟后重置。");
        // A stamp that already expired — the quota module can hand one back at a window boundary —
        // must not become a negative countdown.
        assert_eq!(quota_reset_clause_from(now, Some(now - 10)), "即将重置。");
        assert_eq!(quota_reset_clause_from(now, Some(now)), "即将重置。");
        // No `x-ratelimit-reset` seen yet: say so rather than invent a time.
        assert_eq!(quota_reset_clause_from(now, None), "重置时间未知，请稍后再试。");
    }

    #[test]
    fn the_spent_quota_refusal_carries_its_type_and_reset_time() {
        let body = free_quota_exhausted_body(Some(0));
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["error"]["type"], "openrouter_free_quota_exhausted");
        assert_eq!(parsed["error"]["resetAt"], 0);
        let message = parsed["error"]["message"].as_str().unwrap();
        // Prefix first: the frontend matches on it, so nothing may come before it.
        assert!(message.starts_with("openrouter_free_quota_exhausted: "), "{message}");
        assert!(message.contains("今日免费额度已用完"), "{message}");
        // A past stamp reads as an imminent reset, not a negative countdown, and the sentence ends
        // exactly once — the clause owns its own full stop.
        assert!(message.ends_with("即将重置。"), "{message}");
        // An unknown reset time is `null`, not a fabricated timestamp, and the wording says so.
        let unknown_body = free_quota_exhausted_body(None);
        let unknown: Value = serde_json::from_str(&unknown_body).unwrap();
        assert!(unknown["error"]["resetAt"].is_null());
        let unknown_message = unknown["error"]["message"].as_str().unwrap();
        assert!(unknown_message.ends_with("重置时间未知，请稍后再试。"), "{unknown_message}");
        assert!(!unknown_message.contains("后重置。后"), "no doubled full stop: {unknown_message}");
    }

    #[test]
    fn an_enterprise_model_that_is_not_ready_says_so_instead_of_blaming_the_gateway() {
        let (status, body) = missing_gateway_response("custom-enterprise-1", "custom-enterprise-1/m");
        assert_eq!(status, 409);
        let parsed: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["error"]["type"], "enterprise_model_not_ready");
        let message = parsed["error"]["message"].as_str().unwrap();
        assert!(message.starts_with("enterprise_model_not_ready: "), "{message}");
        assert!(message.contains("设置 → 账号"), "{message}");
        // A self-hosted gateway whose *model* path is enterprise-scoped counts too.
        assert_eq!(missing_gateway_response("gw", "gw/enterprise/some-model").0, 409);
        // Every other unknown gateway keeps the existing 404 wording verbatim.
        let (status, body) = missing_gateway_response("custom-abc", "custom-abc/m");
        assert_eq!(status, 404);
        assert_eq!(body, r#"{"error":{"message":"router: gateway custom-abc is not configured"}}"#);
    }

    #[test]
    fn the_free_quota_rules_only_ever_apply_to_a_free_gateway_model() {
        // The documented shape of a free OpenRouter model.
        assert!(free_quota_applies(true, true, "openrouter/inclusionai/ling-1t:free"));
        // A *paid* OpenRouter model can be refused by a short per-key burst window; treating that
        // as "今日免费额度已用完" would both misdiagnose it and throw the turn away.
        assert!(!free_quota_applies(true, true, "openrouter/anthropic/claude-sonnet-4"));
        // Another vendor, and the native route, are never part of this budget.
        assert!(!free_quota_applies(true, false, "custom-abc/m:free"));
        assert!(!free_quota_applies(false, false, "gpt-6.1-sol"));
        assert!(!free_quota_applies(false, true, "openrouter/x:free"));
    }

    /// Both directions of the 429 decision, composed from the same predicates `relay` uses, with the
    /// vendor reporting `x-ratelimit-remaining: 0` and the mute switch on.
    #[test]
    fn a_paid_model_with_a_zero_rate_limit_counter_falls_through_instead_of_blaming_the_free_quota() {
        // The vendor's reading. `free_quota_blocked()` is scope-agnostic by design — it says exactly
        // this and nothing about which budget the counter describes.
        let vendor_reports_zero = true;
        let muted = true;

        // A free model: the budget really is the one that ran out, so answer with the reset time and
        // spend no replay on a request that cannot succeed.
        let free_model = "openrouter/inclusionai/ling-1t:free";
        let free_blocked = free_quota_applies(true, true, free_model) && vendor_reports_zero;
        assert!(free_blocked);
        assert!(free_quota_refusal(muted, free_blocked), "a spent free budget answers the turn");
        assert!(!should_replay_429(muted, 0, free_blocked), "and does not replay into the same wall");

        // A paid model: the `:free` predicate stops the verdict before it is even consulted, so the
        // request goes down its pre-existing replay path and ends with the vendor's verbatim 429.
        let paid_model = "openrouter/anthropic/claude-sonnet-4";
        let paid_blocked = free_quota_applies(true, true, paid_model) && vendor_reports_zero;
        assert!(!paid_blocked, "a paid model's burst limit is not the free budget");
        assert!(!free_quota_refusal(muted, paid_blocked), "no free-quota diagnosis may reach a paid model");
        assert!(should_replay_429(muted, 0, paid_blocked), "it falls through to the silent replay");
        assert!(
            should_replay_429(muted, MAX_429_REPLAYS - 1, paid_blocked),
            "and keeps the whole replay budget before the vendor's own error surfaces"
        );
    }

    /// The company gateway's spent-window refusal is not a burst: replaying it cannot succeed and
    /// costs eight more requests from the very counter that is already over its ceiling. Measured
    /// 2026-11-19 — the account sat at 258 against a 250 limit after exactly `MAX_429_REPLAYS`
    /// silent replays, so the refusal now goes straight through.
    #[test]
    fn a_spent_gateway_request_window_answers_at_once_instead_of_replaying() {
        // Verbatim from `~/Library/Logs/ai.alwith.u/ALWith U⁺.log`.
        let spent = r#"{"error":{"code":"rate_limit_exceeded","message":"已达到速率上限：3小时内最多250次请求，当前已使用258次，预计133分钟后（10:11）恢复 (request id: 2026111823591583828755AKybAUqE)","type":"new_api_error"}}"#;
        assert!(quota_window_spent(spent), "a named window, a used count and a reset time are all present");

        // What every other vendor's 429 looks like. No window, no counter, no reset — it keeps the
        // existing silent-replay path.
        for burst in [
            r#"{"error":{"message":"Rate limit exceeded","type":"tokens"}}"#,
            r#"{"error":{"code":10000,"message":"provider returned an error"}}"#,
        ] {
            assert!(!quota_window_spent(burst), "a bare burst refusal must not be read as a spent window");
        }

        // Half a description is not enough: `rate_limit_exceeded` alone says nothing about whether
        // the window is closed, and guessing "spent" would turn a 7-second burst into a dead turn.
        assert!(!quota_window_spent(r#"{"error":{"code":"rate_limit_exceeded"}}"#));
        assert!(!quota_window_spent(r#"{"error":{"code":"rate_limit_exceeded","message":"已达到速率上限"}}"#));
        assert!(
            !quota_window_spent(r#"{"error":{"code":"rate_limit_exceeded","message":"已使用258次"}}"#),
            "a usage count with no limit and no reset is not a closed window"
        );
    }

    /// A refusal shown verbatim cannot be attributed: the same 429 body looks identical whether it
    /// came from ChatGPT or from the company gateway, and the conversation only shows the model the
    /// reader picked. Naming the host is what stops a gateway refusal from reading as the model's.
    #[test]
    fn a_spent_window_refusal_names_the_upstream_that_sent_it() {
        let spent = r#"{"error":{"code":"rate_limit_exceeded","message":"已达到速率上限：3小时内最多250次请求，当前已使用258次，预计133分钟后（10:11）恢复","type":"new_api_error"}}"#;
        let named: Value =
            serde_json::from_slice(&name_upstream(spent.as_bytes(), "https://vip.aipro.love/v1/responses"))
                .expect("the vendor's JSON survives the annotation");
        let message = named["error"]["message"].as_str().expect("message stays a string");
        // The vendor's own wording and reset time must reach the reader untouched.
        assert!(message.starts_with("已达到速率上限：3小时内最多250次请求"));
        assert!(message.contains("（10:11）恢复"));
        assert!(message.ends_with("（来源：vip.aipro.love）"), "the source is appended, never substituted");
        assert_eq!(named["error"]["code"], "rate_limit_exceeded", "other fields are left alone");

        // Anything that is not the vendor's shape must pass through byte-for-byte: a half-rewritten
        // body would be a worse lie than an unattributed one.
        assert_eq!(
            name_upstream(b"<html>502 Bad Gateway</html>", "https://x.test/v1"),
            b"<html>502 Bad Gateway</html>"
        );
        assert_eq!(name_upstream(br#"{"message":"nope"}"#, "https://x.test/v1"), br#"{"message":"nope"}"#);
        assert_eq!(name_upstream(spent.as_bytes(), ""), spent.as_bytes(), "no host means nothing to name");
    }

    #[test]
    fn a_gateway_stream_that_goes_quiet_is_reported_after_two_minutes() {
        assert!(!gateway_idle_expired(Duration::from_secs(119), false));
        assert!(gateway_idle_expired(GATEWAY_IDLE_TIMEOUT, false));
        assert!(gateway_idle_expired(Duration::from_secs(600), false));
        // A finished stream is not a stall, however long it has been quiet.
        assert!(!gateway_idle_expired(Duration::from_secs(600), true));
    }

    #[test]
    fn a_quiet_gateway_reports_the_reason_the_notice_layer_understands() {
        // `model-overload-alert.ts` drops any reason other than these two, so a gateway that stops
        // mid-stream has to speak `no_ack` to reach the user at all.
        let payload = gateway_idle_payload("custom-abc/claude/opus", "r7");
        assert_eq!(payload["reason"], REASON_NO_ACK);
        assert_eq!(payload["model"], "custom-abc/claude/opus");
        assert_eq!(payload["requestId"], "r7");
        assert!(payload["retryAfter"].is_null());
        // Not a capacity report: the frontend's per-turn overload budget must not move.
        assert_eq!(payload["attempt"], 0);
    }

    #[test]
    fn the_gateway_activity_clock_only_runs_forward() {
        let activity = GatewayActivity::new();
        let before = activity.idle();
        activity.touch();
        // Touching cannot make the observed silence longer than the request itself.
        assert!(activity.idle() <= before + Duration::from_millis(50));
    }

    #[test]
    fn the_alias_name_never_reaches_the_upstream_untouched() {
        // The two steps an aliased request goes through: the stored target is the picker's
        // `gateway:<gateway>:<model>` shape, and the router splits the routed form on the *first*
        // slash only, so a decoded slash inside the model id survives.
        let routed = crate::external_models::routed_target("gateway:custom-abc:claude%2Fopus");
        let (gateway, model) = routed.split_once('/').unwrap();
        assert_eq!(gateway, "custom-abc");
        assert_eq!(model, "claude/opus");
    }
}
