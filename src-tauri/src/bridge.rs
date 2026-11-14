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

use serde_json::{json, Value};
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

pub(crate) fn register_protocol_route(gateway_id: &str, base_url: &str, bearer_token: &str, sanitize: bool, protocol: crate::providers::Protocol) {
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
    router_routes().read().unwrap().get(gateway_id)
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

/// The same history with everything a switching vendor cannot own removed: reasoning items and
/// item ids. Used once, only after a gateway refused the original payload.
fn portable_history(body: &[u8]) -> Option<Vec<u8>> {
    let mut parsed: Value = serde_json::from_slice(body).ok()?;
    let input = parsed.get_mut("input")?.as_array_mut()?;
    let before = input.len();
    input.retain(|item| item.get("type").and_then(Value::as_str) != Some("reasoning"));
    let mut removed = before - input.len();
    for item in input.iter_mut() {
        if let Some(object) = item.as_object_mut() {
            if object.remove("id").is_some() {
                removed += 1;
            }
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
            if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
                if let Some(name) = reference.strip_prefix("#/$defs/") {
                    if let Some(definition) = defs.get(name) {
                        let mut replacement = definition.clone();
                        let expanded = 1 + expand_refs(&mut replacement, defs, depth + 1);
                        *node = replacement;
                        return expanded;
                    }
                }
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
        false,
        false,
    )
}

/// Converts the Responses request Codex emits into OpenRouter's Chat Completions request.
/// The local wire stays Responses; only the selected OpenRouter upstream uses this translation.
fn responses_to_chat(parsed: &Value) -> Value {
    let mut chat = serde_json::Map::new();
    for key in ["model", "temperature", "top_p", "max_output_tokens", "stream", "parallel_tool_calls"] {
        if let Some(value) = parsed.get(key) {
            chat.insert(if key == "max_output_tokens" { "max_tokens" } else { key }.to_string(), value.clone());
        }
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
                    Value::Array(parts.iter().filter_map(|part| {
                        let text = part.get("text").and_then(Value::as_str)?;
                        Some(json!({"type":"text", "text":text}))
                    }).collect())
                } else { content };
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
        let tools: Vec<Value> = tools.iter().filter_map(|tool| {
            if tool.get("type").and_then(Value::as_str) != Some("function") { return None; }
            Some(json!({"type":"function", "function":{"name":tool.get("name"),
                "description":tool.get("description"), "parameters":tool.get("parameters")}}))
        }).collect();
        if !tools.is_empty() { chat.insert("tools".to_string(), Value::Array(tools)); }
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
        let mut open: Vec<(usize, (usize, String, String, String, String))> = self.calls.drain().collect();
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
            out.extend(self.event(
                "response.created",
                json!({"response":chat_response_shell(&self.id, "in_progress")}),
            ));
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
        while let Some(end) = self.buffer.windows(2).position(|pair| pair == b"\n\n") {
            let frame = self.buffer.drain(..end + 2).collect::<Vec<_>>();
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
                out.extend(self.event("response.failed", json!({"response":{
                    "id":self.id, "object":"response", "status":"failed",
                    "error":{"code":error.get("code").cloned().unwrap_or(json!("upstream_error")),
                        "message":error.get("message").cloned().unwrap_or(json!("upstream error"))}}})));
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
        self.complete(&mut out);
        out
    }
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
    relay(
        request,
        &selection,
        &upstream_endpoint(&route.base_url, if chat_protocol { "chat/completions" } else { "responses" }),
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
        false,
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
/// How many silent replays one request may make after a 502/503/504. The company relay answers
/// 502 "Enterprise gateway request failed" when its own upstream hiccups; the request never left
/// the building, so re-sending it is safe and usually succeeds on the second try. Two replays
/// (400ms then 800ms) cover a transient blip without holding a genuinely dead gateway for long.
const MAX_GATEWAY_REPLAYS: u32 = 2;
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
    chat_protocol: bool,
    portable_fallback: bool,
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
    let mut attempted_portable = false;
    let mut attempted_connect = false;
    let mut attempted_header = false;
    let mut replays_429 = 0u32;
    let mut replays_gateway = 0u32;
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
            // Headers never arrived. The native ChatGPT route rides whatever tunnel/proxy the user
            // runs, and a single dropped handshake there is common (the TCP connect succeeds but the
            // first response byte stalls). One quick retry covers the transient case, just like the
            // connect-failure path below — a stalled header phase is the same class of flake.
            HeaderWait::Timeout if !attempted_header => {
                attempted_header = true;
                log::warn!(
                    "bridge: retrying after header timeout ({}s)",
                    HEADER_TIMEOUT.as_secs()
                );
                std::thread::sleep(std::time::Duration::from_millis(400));
                continue;
            }
            // Headers never arrived after the retry too: free this worker (and one of the six
            // slots) with a 504 now instead of holding it until the 60min whole-request timeout.
            // Only the header phase is cut; a stream that already started keeps its 20min idle /
            // 60min hard clocks.
            HeaderWait::Timeout => {
                log::warn!(
                    "bridge: upstream response headers timed out after {}s",
                    HEADER_TIMEOUT.as_secs()
                );
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
        // A thread written by another vendor replays ids and encrypted reasoning that only that
        // vendor can interpret. Some gateways refuse the whole request without naming a field —
        // the company relay answers `upstream request was rejected`, and the thread then looks
        // unusable although its text is fine. One retry with a portable history decides it: if the
        // refusal was about the history it goes through, otherwise the real error still surfaces.
        if portable_fallback && !attempted_portable && matches!(status, 400 | 422) {
            if let Some(stripped) = portable_history(&payload) {
                attempted_portable = true;
                payload = stripped;
                log::warn!("bridge: retrying after {status} with a portable history");
                continue;
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
        // A 502/503/504 from the relay means the relay itself could not reach its upstream — the
        // turn never ran, so re-sending the identical request cannot duplicate anything. The
        // company gateway's "Enterprise gateway request failed" 502 used to surface as a dead
        // turn the user had to retype; two quick replays absorb the transient case, and a gateway
        // that is really down still answers with its own error after ~1.2s.
        if matches!(status, 502 | 503 | 504) && replays_gateway < MAX_GATEWAY_REPLAYS {
            let delay = REPLAY_GAP * u32::pow(2, replays_gateway);
            replays_gateway += 1;
            log::warn!(
                "bridge: upstream answered {status}, silent replay {replays_gateway}/{MAX_GATEWAY_REPLAYS} in {}ms",
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
            match upstream.read(&mut chunk) {
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
                    if !emit(&tx, &mut translator, data) {
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
            assert!(request.headers().iter().any(|header| header.field.equiv("Authorization") && header.value.as_str() == "Bearer native-relay-secret"));
            let mut body = String::new();
            request.as_reader().read_to_string(&mut body).unwrap();
            let body: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(body["model"], "issued/model");
            assert_eq!(body["input"][0]["content"][0]["text"], "kept");
            request.respond(tiny_http::Response::from_string("relay-ok").with_status_code(202)).unwrap();
        });
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let client = std::thread::spawn(move || {
            reqwest::blocking::Client::new().post(format!("http://{address}/alwith/responses"))
                .bearer_auth("alwith-router")
                .json(&serde_json::json!({"model":format!("{gateway}/issued/model"),"input":[{"type":"reasoning","content":[{"text":"kept"}]}]}))
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
            reqwest::blocking::Client::new().post(format!("http://{address}/alwith/responses"))
                .json(&serde_json::json!({"model":format!("{gateway}/issued/model")}))
                .send().unwrap().status().as_u16()
        });
        handle(server.recv_timeout(Duration::from_secs(5)).unwrap().unwrap()).unwrap();
        assert_eq!(rejected.join().unwrap(), 404, "legacy registration must not bypass shared-route revocation");
        unregister_route(gateway);
    }
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
        let call_added = names.iter().position(|name| name == "response.output_item.added" ).unwrap();
        assert!(text_done > call_added, "the message item closes before the call item opens");
        let payloads = event_payloads(&out);
        let arguments: String = payloads
            .iter()
            .filter(|value| value["type"] == "response.function_call_arguments.delta")
            .map(|value| value["delta"].as_str().unwrap())
            .collect();
        assert_eq!(arguments, "{\"cmd\":\"ls\"}");
        let call_done = payloads
            .iter()
            .filter(|value| value["type"] == "response.output_item.done")
            .last()
            .unwrap();
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
    fn an_upstream_that_never_sends_done_still_terminates_the_turn() {
        let mut stream = ChatResponsesStream::new();
        let mut out = stream.translate(b"data: {\"id\":\"c\",\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
        out.extend(stream.finish());
        assert_eq!(event_names(&out).last().unwrap(), "response.completed");
        // A second finish must not emit a duplicate terminal event.
        assert!(stream.finish().is_empty());
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
            false,
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
                bodies_in_thread
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&scratch[..count]).to_string());
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
    /// stays down must still surface its own error after the replay budget is spent.
    fn gateway_502_replays_then_surfaces(start: u16, fail_times: usize, expected_hits: usize, expect_success: bool) {
        use std::io::Write;
        use std::net::{TcpListener, TcpStream};
        use std::sync::atomic::AtomicUsize;

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
        );
        let body = client_thread.join().unwrap();
        let _ = upstream_thread.join();

        assert!(result.is_ok(), "relay failed: {result:?}");
        assert_eq!(hits.load(Ordering::Relaxed), expected_hits);
        if expect_success {
            assert!(body.contains("response.completed"), "the replay must reach the engine: {body}");
            assert!(!body.contains("Enterprise gateway request failed"), "the 502 must not reach the engine: {body}");
        } else {
            assert!(body.contains("Enterprise gateway request failed"), "a dead gateway must surface its error: {body}");
        }
    }

    #[test]
    fn a_transient_gateway_502_is_replayed_silently() {
        gateway_502_replays_then_surfaces(502, 1, 2, true);
    }

    #[test]
    fn a_gateway_that_stays_down_surfaces_after_two_replays() {
        gateway_502_replays_then_surfaces(502, 3, 3, false);
    }
}
