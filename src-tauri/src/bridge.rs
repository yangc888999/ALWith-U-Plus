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

use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

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
}

fn router_routes() -> &'static RwLock<HashMap<String, RouterRoute>> {
    static ROUTER: OnceLock<RwLock<HashMap<String, RouterRoute>>> = OnceLock::new();
    ROUTER.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Teaches the router where one gateway actually lives. Keyed by the gateway id that prefixes
/// routed model names, so two vendors may offer the same model id without colliding.
pub(crate) fn register_router_route(gateway_id: &str, base_url: &str, bearer_token: &str, sanitize: bool) {
    if let Ok(mut map) = router_routes().write() {
        map.insert(
            gateway_id.to_string(),
            RouterRoute { base_url: base_url.to_string(), bearer_token: bearer_token.to_string(), sanitize },
        );
    }
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
    OVERLOAD_MUTE.store(mute, Ordering::Relaxed);
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
        std::thread::spawn(move || loop {
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
            ("get", "models") => {
                respond(request, 200, "application/json", br#"{"object":"list","data":[]}"#)
            }
            _ => respond(request, 404, "application/json", br#"{"error":{"message":"bridge: unsupported path"}}"#),
        };
    }
    let upstream_base = routes().read().ok().and_then(|map| map.get(runtime_id).cloned());
    let Some(upstream_base) = upstream_base else {
        return respond(request, 404, "application/json", br#"{"error":{"message":"bridge: unregistered gateway"}}"#);
    };
    let authorization = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Authorization"))
        .map(|header| header.value.as_str().to_string());

    match (method.as_str(), action) {
        ("post", "responses") => forward_responses(request, &upstream_base, authorization.as_deref()),
        ("get", "models") => forward_plain(request, &upstream_endpoint(&upstream_base, "models"), "GET", authorization.as_deref()),
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
        let mismatched = item
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.starts_with(prefix));
        if mismatched {
            if let Some(object) = item.as_object_mut() {
                object.remove("id");
                dropped += 1;
            }
        }
    }
    dropped
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
        tools.retain(|tool| {
            !tool
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .starts_with("web_search")
        });
        dropped = before - tools.len();
        left = tools.len();
    }
    if dropped > 0 && left == 0 {
        if let Some(object) = parsed.as_object_mut() {
            object.remove("tools");
        }
    }
    dropped
}

/// POST /responses: sanitize the body, then stream the upstream answer straight back.
fn upstream_endpoint(base_url: &str, path: &str) -> String {
    format!("{}/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'))
}

fn forward_responses(mut request: tiny_http::Request, upstream_base: &str, authorization: Option<&str>) -> Result<(), String> {
    let mut body = Vec::new();
    request
        .as_reader()
        .read_to_end(&mut body)
        .map_err(|error| format!("read body: {error}"))?;
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
            )
        }
    };
    if strip_web_search_tools(&mut parsed) > 0 {
        log::info!("bridge: dropped web_search tool declaration(s) the gateway cannot run");
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
    )
}

/// POST /<router>/responses: pick the vendor from the model name, then forward as that vendor.
fn forward_routed(mut request: tiny_http::Request) -> Result<(), String> {
    let mut body = Vec::new();
    request
        .as_reader()
        .read_to_end(&mut body)
        .map_err(|error| format!("read body: {error}"))?;
    let Ok(mut parsed) = serde_json::from_slice::<Value>(&body) else {
        return respond(request, 400, "application/json", br#"{"error":{"message":"router: body is not JSON"}}"#);
    };
    let Some(selection) = parsed.get("model").and_then(Value::as_str).map(str::to_string) else {
        return respond(request, 400, "application/json", br#"{"error":{"message":"router: missing model"}}"#);
    };
    // Model names arrive as `<gateway>/<model>`; the rest is the vendor's own identifier, which
    // may itself contain slashes, so split on the first one only. A name with no slash is one of
    // Codex's own models: those belong to the ChatGPT backend, not to any gateway.
    let Some((gateway, upstream_model)) = selection.split_once('/') else {
        return forward_chatgpt(request, &parsed);
    };
    let Some(route) = router_routes().read().ok().and_then(|map| map.get(gateway).cloned()) else {
        return respond(
            request,
            404,
            "application/json",
            format!(r#"{{"error":{{"message":"router: gateway {gateway} is not configured"}}}}"#).as_bytes(),
        );
    };
    parsed["model"] = Value::String(upstream_model.to_string());
    let dropped = strip_web_search_tools(&mut parsed);
    if dropped > 0 {
        log::info!("bridge: dropped {dropped} web_search tool declaration(s) the gateway cannot run");
    }
    let Ok(payload) = serde_json::to_vec(&parsed) else {
        return respond(request, 500, "application/json", br#"{"error":{"message":"router: encode failed"}}"#);
    };
    let payload = if route.sanitize { sanitize(&payload) } else { payload };
    let authorization = format!("Bearer {}", route.bearer_token);
    relay(
        request,
        &selection,
        &upstream_endpoint(&route.base_url, "responses"),
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
    let headers = [
        ("chatgpt-account-id", credentials.account_id.as_str()),
        ("OpenAI-Beta", "responses=experimental"),
        ("originator", "codex_cli_rs"),
        ("Accept", "text/event-stream"),
    ];
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
    )
}

/// True when the upstream refused the turn because a replayed reasoning item could not be
/// decrypted: OpenAI ties `encrypted_content` to the organization that minted it, so a thread that
/// has been served by two credentials (or two vendors) replays a blob the new endpoint cannot read.
/// The body arrives as `{"error":{"message":"The encrypted content rs_… could not be verified…"}}`
/// or with `"code": "invalid_encrypted_content"`.
fn is_invalid_encrypted_content(body: &str) -> bool {
    body.contains("invalid_encrypted_content")
        || (body.contains("encrypted content") && body.contains("could not be"))
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
        if !line
            .windows(OVERLOAD_MARKER.len())
            .any(|window| window == OVERLOAD_MARKER)
        {
            continue;
        }
        let Ok(text) = std::str::from_utf8(line) else { continue };
        let Some(body) = text.trim().strip_prefix("data:") else { continue };
        let Ok(value) = serde_json::from_str::<Value>(body.trim()) else { continue };
        let code = value
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(Value::as_str);
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

fn publish_stall(model: &str, reason: &str, retry_after: Option<u64>, attempt: u32, request_id: &str) {
    log::warn!("bridge: turn stalled model={model} reason={reason} retry-after={retry_after:?}s attempt={attempt} request={request_id}");
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
        rx: std::sync::mpsc::Receiver<StreamChunk>,
        idle: Duration,
        hard: Duration,
        client_gone: Arc<AtomicBool>,
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
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    self.fail("上游超过 20 分钟没有输出")
                }
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

impl<R: Read> Read for OverloadWatch<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let count = self.inner.read(buf)?;
        if count == 0 {
            self.closed.store(true, Ordering::Relaxed);
        } else {
            self.acked.store(true, Ordering::Relaxed);
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
/// Buffer cap for the first SSE event. A healthy first event is small; a huge one is simply
/// forwarded as-is instead of being held while we look for a capacity refusal.
const FIRST_EVENT_CAP: usize = 16 * 1024;

/// Re-sends the exact same upstream request. The engine never sees the capacity refusal, so it
/// cannot honour `retry-after` and sleep. A non-2xx replay is reported as a failure instead of
/// being spliced into the SSE stream.
fn replay_upstream(
    client: &reqwest::blocking::Client,
    url: &str,
    authorization: Option<&str>,
    headers: &[(String, String)],
    payload: &[u8],
) -> Result<reqwest::blocking::Response, String> {
    let mut builder = client.post(url).header("Content-Type", "application/json");
    if let Some(authorization) = authorization {
        builder = builder.header("Authorization", authorization);
    }
    for (name, value) in headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let response = builder
        .body(payload.to_vec())
        .send()
        .map_err(|error| format!("http client: {error}"))?;
    if !(200..=299).contains(&response.status().as_u16()) {
        return Err(format!("upstream answered {}", response.status()));
    }
    Ok(response)
}

/// `watch_stall` is true only for `forward_chatgpt`. It gates **both** the structured overload
/// reader and the no-ack timer; see `stall_observers`. When the user has muted overload notices,
/// `relay` swallows `server_is_overloaded` and replays the same request without a ceiling — the
/// 60-minute whole-request timeout is the only backstop.
fn relay(
    request: tiny_http::Request,
    model: &str,
    url: &str,
    authorization: Option<&str>,
    headers: &[(&str, &str)],
    payload: Vec<u8>,
    watch_stall: bool,
    watch_openrouter_errors: bool,
) -> Result<(), String> {
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
    let mut attempted_recovery = false;
    let mut attempted_connect = false;
    let mut replays_429 = 0u32;
    let response = loop {
        let attempt = request_builder
            .try_clone()
            .ok_or_else(|| "http client: request not cloneable".to_string())?
            .body(payload.clone());
        let response = match send_with_header_timeout(attempt, HEADER_TIMEOUT) {
            HeaderWait::Response(response) => response,
            // The native ChatGPT route rides whatever tunnel/proxy the user runs; a single dropped
            // handshake there is common and used to surface as a turn that sat at 正在思考 until
            // the watchdog fired. One quick retry covers the transient case.
            HeaderWait::Error(error) if !attempted_connect && error.is_connect() => {
                attempted_connect = true;
                log::warn!("bridge: retrying after connect failure: {error}");
                std::thread::sleep(std::time::Duration::from_millis(400));
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
            // Headers never arrived: free this worker (and one of the six slots) with a 504 now
            // instead of holding it until the 60min whole-request timeout. Only the header phase
            // is cut; a stream that already started keeps its 20min idle / 60min hard clocks.
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
            break response;
        }
        let body = response.bytes().map_err(|error| format!("upstream body: {error}"))?;
        let text = String::from_utf8_lossy(&body);
        // One recovery attempt only: if the retry fails for the same reason there is nothing left
        // to strip and the caller must see the real error.
        if !attempted_recovery && is_invalid_encrypted_content(&text) {
            if let Some(stripped) = drop_reasoning_items(&payload) {
                attempted_recovery = true;
                payload = stripped;
                log::warn!("bridge: retrying after invalid_encrypted_content ({status})");
                continue;
            }
        }
        // Fallback for an item type `normalize_item_ids` has no rule for: drop exactly the id the
        // backend named and try once. Anything else is passed through untouched.
        if !attempted_recovery && is_id_prefix_mismatch(&text) {
            if let Some(index) = refused_input_index(&text) {
                if let Some(fixed) = drop_item_id(&payload, index) {
                    attempted_recovery = true;
                    payload = fixed;
                    log::warn!("bridge: retrying after an id-prefix refusal on input[{index}]");
                    continue;
                }
            }
        }
        // OpenRouter answers a burst with HTTP 429 instead of the structured `server_is_overloaded`
        // SSE event ChatGPT emits. When the user has switched the OpenRouter「模型异常提醒」off,
        // treat it as a transient hiccup and re-send the same request instead of answering with the
        // refusal — the turn then either completes or fails on its own merits, without a
        // `请求太频繁` toast in between. A short exponential backoff keeps a real rate limit from
        // being hammered; after `MAX_429_REPLAYS` the refusal is passed through so a genuinely
        // blocked key still ends with a reason instead of hanging.
        if status == 429 && overload_429_mute() && replays_429 < MAX_429_REPLAYS {
            let delay = REPLAY_GAP * u32::pow(2, replays_429.min(5));
            replays_429 += 1;
            log::warn!(
                "bridge: upstream answered 429, silent replay {replays_429}/{MAX_429_REPLAYS} in {}ms",
                delay.as_millis()
            );
            std::thread::sleep(delay);
            continue;
        }
        log::warn!("bridge: upstream answered {status}: {}", text.chars().take(300).collect::<String>());
        return respond(request, status, "application/json", &body);
    };
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("text/event-stream")
        .to_string();
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
    let replay_headers: Vec<(String, String)> = headers
        .iter()
        .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
        .collect();
    let replay_payload = payload.clone();
    // Two independent mute switches, both read per request so a settings change applies without
    // restarting the engine. The overload mute only arms on the native ChatGPT route; the 429
    // mute is deliberately restricted to OpenRouter, whose documented 429 / `error.code:10000`
    // contract the setting names. Other provider errors pass through untouched.
    let replay_mute = watch_stall && overload_mute();
    let replay_429 = watch_openrouter_errors && overload_429_mute();
    std::thread::spawn(move || {
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
        loop {
            if upstream_stop.load(Ordering::Relaxed) {
                break;
            }
            match upstream.read(&mut chunk) {
                Ok(0) => {
                    if !head.is_empty() && tx.send(StreamChunk::Data(std::mem::take(&mut head))).is_err() {
                        break;
                    }
                    let _ = tx.send(StreamChunk::End);
                    break;
                }
                Ok(count) => {
                    if !sent_any && (replay_mute || replay_429) {
                        head.extend_from_slice(&chunk[..count]);
                        let complete =
                            head.windows(2).any(|pair| pair == b"\n\n") || head.len() >= FIRST_EVENT_CAP;
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
                                    let _ =
                                        tx.send(StreamChunk::Failed(format!("bridge replay: {error}")));
                                    break;
                                }
                            }
                        }
                    }
                    let data = if head.is_empty() {
                        chunk[..count].to_vec()
                    } else {
                        std::mem::take(&mut head)
                    };
                    if tx.send(StreamChunk::Data(data)).is_err() {
                        break;
                    }
                    sent_any = true;
                }
                Err(error) => {
                    log::warn!("bridge: upstream stream read failed: {error}");
                    let _ = tx.send(StreamChunk::Failed(error.to_string()));
                    break;
                }
            }
        }
    });
    let acked = Arc::new(AtomicBool::new(false));
    let closed = Arc::new(AtomicBool::new(false));
    let (watch_overload, watch_no_ack_enabled) = stall_observers(watch_stall);
    // One short increasing id per upstream request; both stall observers attach it so the UI can
    // dedup `model:stalled` events instead of counting them a second time.
    let request_id = next_request_id();
    // Start the no-ack clock with the request, not with the UI: only the bridge knows whether a turn
    // is waiting on the upstream or on this machine's own tool execution. Gateway routes are not
    // watched — a vendor that never answers is that vendor's business, not a ChatGPT capacity
    // report, and an unmatched event would be attached to some other model's turn.
    if watch_no_ack_enabled {
        watch_no_ack(model, acked.clone(), closed.clone(), request_id.clone());
    }
    let watched = OverloadWatch {
        inner: StreamReader::new(rx, STREAM_IDLE_TIMEOUT, STREAM_HARD_TIMEOUT, client_gone),
        model: model.to_string(),
        request_id,
        tail: Vec::new(),
        fired: false,
        enabled: watch_overload,
        acked,
        closed,
    };
    let response = tiny_http::Response::new(tiny_http::StatusCode(status), response_headers, watched, None, None);
    request.respond(response).map_err(|error| format!("respond: {error}"))
}

/// GET passthrough (model discovery through the gateway).
fn forward_plain(request: tiny_http::Request, url: &str, method: &str, authorization: Option<&str>) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("http client: {error}"))?;
    let mut builder = client.request(reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET), url);
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
        if let Some(object) = item.as_object_mut() {
            if object.contains_key("content") {
                object.insert("content".to_string(), Value::Array(Vec::new()));
                stripped += 1;
            }
        }
    }
    if stripped > 0 {
        log::info!("bridge: cleared reasoning content on {stripped} history item(s)");
    }
    serde_json::to_vec(&parsed).unwrap_or_else(|_| body.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let mut body: Value = serde_json::from_slice(br#"{"model":"m","input":[],"tools":[{"type":"web_search"}]}"#).unwrap();
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
    fn endpoint_join_trims_both_sides() {
        assert_eq!(upstream_endpoint("https://api.example.com", "responses"), "https://api.example.com/responses");
        assert_eq!(upstream_endpoint("https://api.example.com///", "/responses"), "https://api.example.com/responses");
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
        chunks: Vec<StreamChunk>,
        idle: Duration,
        hard: Duration,
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
        assert_eq!(overload_mute(), false, "default keeps today's notice behaviour");
        set_overload_mute(true);
        assert_eq!(overload_mute(), true, "a muted switch is read back immediately");
        set_overload_mute(false);
        assert_eq!(overload_mute(), false, "the switch clears cleanly");
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
        assert!(elapsed < Duration::from_secs(2), "worker must be freed by the header timeout, not the 5s client timeout: {elapsed:?}");
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
        );
        set_overload_mute(previous);
        let body = client_thread.join().unwrap();
        let _ = upstream_thread.join();

        assert!(result.is_ok(), "relay failed: {result:?}");
        assert_eq!(hits.load(Ordering::Relaxed), 1, "a non-overload event must never be replayed");
        assert!(
            body.contains("response.output_text.delta"),
            "the buffered event must reach the engine intact: {body}"
        );
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
        );
        set_overload_429_mute(previous);
        let body = client_thread.join().unwrap();
        let _ = upstream_thread.join();

        assert!(result.is_ok(), "relay failed: {result:?}");
        assert_eq!(hits.load(Ordering::Relaxed), 2, "one request plus one silent replay");
        assert!(!body.contains("\"code\":10000"), "the engine must never see the injected error: {body}");
        assert!(body.contains("response.completed"), "the replay must reach the engine: {body}");
    }
}
