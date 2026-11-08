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
use std::sync::atomic::{AtomicBool, Ordering};
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
        ("get", "models") => forward_plain(request, &format!("{upstream_base}/models"), "GET", authorization.as_deref()),
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
fn forward_responses(mut request: tiny_http::Request, upstream_base: &str, authorization: Option<&str>) -> Result<(), String> {
    let mut body = Vec::new();
    request
        .as_reader()
        .read_to_end(&mut body)
        .map_err(|error| format!("read body: {error}"))?;
    let mut parsed: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return relay(request, "", &format!("{upstream_base}/responses"), authorization, &[], body),
    };
    if strip_web_search_tools(&mut parsed) > 0 {
        log::info!("bridge: dropped web_search tool declaration(s) the gateway cannot run");
    }
    let payload = serde_json::to_vec(&parsed).unwrap_or(body);
    relay(
        request,
        parsed.get("model").and_then(Value::as_str).unwrap_or(""),
        &format!("{upstream_base}/responses"),
        authorization,
        &[],
        sanitize(&payload)
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
    relay(request, &selection, &format!("{}/responses", route.base_url), Some(&authorization), &[], payload)
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
        payload
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

/// Reads the `retry-after` value out of the same SSE error event (seconds, if present).
fn retry_after_seconds(tail: &[u8]) -> Option<u64> {
    let needle = b"\"retry-after\"";
    let at = tail.windows(needle.len()).rposition(|window| window == needle)?;
    let rest = &tail[at + needle.len()..];
    let start = rest.iter().position(u8::is_ascii_digit)?;
    let end = rest[start..]
        .iter()
        .position(|byte| !byte.is_ascii_digit())
        .map(|offset| start + offset)
        .unwrap_or(rest.len());
    std::str::from_utf8(&rest[start..end]).ok()?.parse().ok()
}

/// Why a turn is producing nothing, as far as the upstream is concerned.
///
/// `Overloaded` is the backend saying so explicitly; `NoAck` is it saying nothing at all. The UI
/// treats them the same way (offer another model) but words them differently, and **neither** can
/// fire while the turn is running a local tool — that window has no upstream request in flight.
const REASON_OVERLOADED: &str = "overloaded";
const REASON_NO_ACK: &str = "no_ack";

fn publish_stall(model: &str, reason: &str, retry_after: Option<u64>) {
    log::warn!("bridge: turn stalled model={model} reason={reason} retry-after={retry_after:?}s");
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit(
            "model:stalled",
            serde_json::json!({ "model": model, "reason": reason, "retryAfter": retry_after }),
        );
    }
}

/// A pass-through reader: every byte still reaches Codex unchanged, we only look at a bounded
/// tail so an SSE event split across two reads is still recognized.
struct OverloadWatch<R> {
    inner: R,
    model: String,
    tail: Vec<u8>,
    fired: bool,
    /// The marker can be seen before the rest of its SSE event arrives, so wait for the event to
    /// finish before publishing — otherwise the reader never learns how long the retry will take.
    pending: bool,
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
fn watch_no_ack(model: &str, acked: Arc<AtomicBool>, closed: Arc<AtomicBool>) {
    let model = model.to_string();
    std::thread::spawn(move || {
        let start = Instant::now();
        loop {
            let ack = acked.load(Ordering::Relaxed);
            let done = closed.load(Ordering::Relaxed);
            if no_ack_expired(ack, done, start.elapsed()) {
                publish_stall(&model, REASON_NO_ACK, None);
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
        if self.fired {
            return Ok(count);
        }
        if count == 0 {
            if self.pending {
                self.fired = true;
                publish_stall(&self.model, REASON_OVERLOADED, None);
            }
            return Ok(count);
        }
        self.tail.extend_from_slice(&buf[..count]);
        if self.tail.len() > 32_768 {
            let excess = self.tail.len() - 32_768;
            self.tail.drain(..excess);
        }
        if !self.pending && self.tail.windows(OVERLOAD_MARKER.len()).any(|window| window == OVERLOAD_MARKER) {
            self.pending = true;
        }
        if self.pending {
            let at = self
                .tail
                .windows(OVERLOAD_MARKER.len())
                .rposition(|window| window == OVERLOAD_MARKER)
                .unwrap_or(0);
            let after = &self.tail[at + OVERLOAD_MARKER.len()..];
            if let Some(seconds) = retry_after_seconds(after) {
                self.fired = true;
                publish_stall(&self.model, REASON_OVERLOADED, Some(seconds));
            } else if after.contains(&b'\n') {
                self.fired = true;
                publish_stall(&self.model, REASON_OVERLOADED, None);
            }
        }
        Ok(count)
    }
}

/// Streams one upstream turn back to Codex, preserving status codes and the SSE byte stream.
fn relay(
    request: tiny_http::Request,
    model: &str,
    url: &str,
    authorization: Option<&str>,
    headers: &[(&str, &str)],
    payload: Vec<u8>,
) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        // A route that silently swallows packets would otherwise hold the connect until the OS
        // gives up (75s on macOS), and the user reads that as "正在思考" with nothing happening.
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(600))
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
    let response = loop {
        let sent = request_builder
            .try_clone()
            .ok_or_else(|| "http client: request not cloneable".to_string())?
            .body(payload.clone())
            .send();
        let response = match sent {
            Ok(response) => response,
            // The native ChatGPT route rides whatever tunnel/proxy the user runs; a single dropped
            // handshake there is common and used to surface as a turn that sat at 正在思考 until
            // the watchdog fired. One quick retry covers the transient case.
            Err(error) if !attempted_connect && error.is_connect() => {
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
            Err(error) => {
                log::warn!("bridge: upstream unreachable: {error}");
                let body = serde_json::json!({
                    "error": {
                        "message": format!("连接模型网关失败：{error}"),
                        "type": "bridge_upstream_unreachable"
                    }
                })
                .to_string();
                return respond(request, 502, "application/json", body.as_bytes());
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
    let headers = vec![
        tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap(),
        tiny_http::Header::from_bytes(&b"Cache-Control"[..], &b"no-cache"[..]).unwrap(),
        tiny_http::Header::from_bytes(&b"Connection"[..], &b"keep-alive"[..]).unwrap(),
    ];
    let acked = Arc::new(AtomicBool::new(false));
    let closed = Arc::new(AtomicBool::new(false));
    // Start the no-ack clock with the request, not with the UI: only the bridge knows whether a turn
    // is waiting on the upstream or on this machine's own tool execution.
    watch_no_ack(model, acked.clone(), closed.clone());
    let watched = OverloadWatch {
        inner: response,
        model: model.to_string(),
        tail: Vec::new(),
        fired: false,
        pending: false,
        acked,
        closed,
    };
    let response = tiny_http::Response::new(tiny_http::StatusCode(status), headers, watched, None, None);
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
            let body = serde_json::json!({
                "error": {
                    "message": format!("连接模型网关失败：{error}"),
                    "type": "bridge_upstream_unreachable"
                }
            })
            .to_string();
            return respond(request, 502, "application/json", body.as_bytes());
        }
    };
    let status = response.status().as_u16();
    let payload = response.bytes().map_err(|error| format!("upstream body: {error}"))?;
    respond(request, status, "application/json", &payload)
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

    #[test]
    fn overload_error_yields_its_retry_after() {
        let event = br#"data: {"type":"error","error":{"code":"server_is_overloaded","headers":{"retry-after": "316","retry-after-ms":"316000"}}}"#;
        assert_eq!(retry_after_seconds(event), Some(316));
        assert_eq!(retry_after_seconds(br#"data: {"type":"response.created"}"#), None);
    }

    #[test]
    fn overload_watch_passes_every_byte_through_and_fires_once() {
        let stream = b"data: {\"type\":\"error\",\"error\":{\"code\":\"server_is_overloaded\",\"headers\":{\"retry-after\":\"324\"}}".to_vec();
        let mut watched = OverloadWatch {
            inner: std::io::Cursor::new(stream.clone()),
            model: "gpt-6.1-sol".to_string(),
            tail: Vec::new(),
            fired: false,
            pending: false,
            acked: Arc::new(AtomicBool::new(false)),
            closed: Arc::new(AtomicBool::new(false)),
        };
        let mut received = Vec::new();
        // Small reads prove the marker is still found when the SSE event is split across chunks.
        let mut chunk = [0u8; 7];
        loop {
            let count = watched.read(&mut chunk).unwrap();
            if count == 0 {
                break;
            }
            received.extend_from_slice(&chunk[..count]);
        }
        assert_eq!(received, stream, "the engine must still see the untouched SSE bytes");
        assert!(watched.fired);
        assert_eq!(retry_after_seconds(&watched.tail), Some(324));
        // Bytes arrived, so the no-ack clock must have been cancelled for this request.
        assert!(watched.acked.load(Ordering::Relaxed));
        assert!(watched.closed.load(Ordering::Relaxed));
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
}
