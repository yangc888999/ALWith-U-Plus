use std::io::{self, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::AppHandle;
use tiny_http::{Header, Request, Response, StatusCode};

use super::{Turn, TurnEvent, antigravity_status, catalog, start_turn};
use crate::bridge::{ChatResponsesStream, chat_to_responses};

const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const TURN_TIMEOUT: Duration = Duration::from_secs(900);
const KEEP_ALIVE: Duration = Duration::from_secs(2);
static ACTIVE_TURNS: AtomicUsize = AtomicUsize::new(0);

struct TurnSlot;

impl TurnSlot {
    fn try_acquire() -> Option<Self> {
        ACTIVE_TURNS
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| (count < 2).then_some(count + 1))
            .ok()
            .map(|_| Self)
    }
}

impl Drop for TurnSlot {
    fn drop(&mut self) {
        ACTIVE_TURNS.fetch_sub(1, Ordering::Relaxed);
    }
}

fn request_prompt(body: &Value) -> Result<Vec<Value>, &'static str> {
    let mut prompt = vec![json!({"type":"text", "text":concat!(
        "You are answering in an existing conversation. The labeled messages below are its history. ",
        "Reply to the latest user message directly. Use the supplied context; do not run tools or access files."
    )})];
    let input = &body["input"];
    if let Some(text) = input.as_str().filter(|text| !text.trim().is_empty()) {
        prompt.push(json!({"type":"text", "text":text}));
        return Ok(prompt);
    }
    let messages = input.as_array().ok_or("Antigravity expects a conversation or a text prompt.")?;
    let last_user = messages
        .iter()
        .rposition(|message| message["role"] == "user")
        .ok_or("Antigravity needs a user message in the conversation.")?;
    for (index, message) in messages.iter().enumerate() {
        if !matches!(message["type"].as_str(), None | Some("message")) {
            continue;
        }
        let role = match message["role"].as_str() {
            Some("user") if index == last_user => "Latest user message",
            Some("user") => "Earlier user message",
            Some("assistant") => "Earlier assistant reply",
            _ => continue,
        };
        let content = &message["content"];
        if let Some(text) = content.as_str() {
            prompt.push(json!({"type":"text", "text":format!("{role}:\n{text}")}));
            continue;
        }
        let Some(parts) = content.as_array() else { continue };
        prompt.push(json!({"type":"text", "text":format!("{role}:")}));
        for part in parts {
            match part["type"].as_str() {
                Some("input_text" | "output_text" | "text") => {
                    if let Some(text) = part["text"].as_str() {
                        prompt.push(json!({"type":"text", "text":text}));
                    }
                }
                Some("input_image") => {
                    let inline = part["image_url"]
                        .as_str()
                        .and_then(|value| value.strip_prefix("data:"))
                        .and_then(|value| value.split_once(";base64,"))
                        .filter(|(mime, data)| {
                            matches!(*mime, "image/png" | "image/jpeg" | "image/webp" | "image/gif") && !data.is_empty()
                        });
                    if let Some((mime, data)) = inline {
                        prompt.push(json!({"type":"image", "mimeType":mime,"data":data}));
                    } else if index == last_user {
                        return Err("Antigravity requires an inline image attachment, not an image URL.");
                    }
                }
                Some("input_file" | "input_audio") if index == last_user => {
                    return Err("Antigravity supports text and inline images. Attach other content as text instead.");
                }
                _ => {}
            }
        }
    }
    Ok(prompt)
}

fn reply_json(request: Request, status: u16, value: &Value) -> Result<(), String> {
    request
        .respond(
            Response::from_data(value.to_string())
                .with_status_code(StatusCode(status))
                .with_header(Header::from_bytes("Content-Type", "application/json").unwrap()),
        )
        .map_err(|error| error.to_string())
}

fn error_reply(request: Request, status: u16, kind: &str, message: &str) -> Result<(), String> {
    reply_json(request, status, &json!({"error":{"type":kind,"message":message}}))
}

fn finish_reason(stop_reason: &str) -> &str {
    match stop_reason {
        "max_tokens" => "length",
        "refusal" => "content_filter",
        _ => "stop",
    }
}

struct TurnUpdates {
    turn: Turn,
    deadline: Instant,
    last_update: Instant,
}

impl TurnUpdates {
    fn new(turn: Turn) -> Self {
        let now = Instant::now();
        Self { turn, deadline: now + TURN_TIMEOUT, last_update: now }
    }

    fn wait_for_event(&mut self) -> Option<TurnEvent> {
        let now = Instant::now();
        let deadline = self.deadline.min(self.last_update + IDLE_TIMEOUT);
        if now >= deadline {
            return Some(TurnEvent::Error {
                message: "Antigravity timed out. Check the Google sign-in and network, then try again.".into(),
            });
        }
        match self.turn.events.recv_timeout(KEEP_ALIVE.min(deadline - now)) {
            Ok(event) => {
                self.last_update = Instant::now();
                Some(event)
            }
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => {
                Some(TurnEvent::Error { message: "Antigravity stopped before replying.".into() })
            }
        }
    }
}

fn stream_events(mut writer: impl Write, mut next: impl FnMut() -> Option<TurnEvent>) -> io::Result<()> {
    writer.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\n\r\n")?;
    writer.flush()?;
    let mut translator = ChatResponsesStream::new();
    loop {
        let event = next();
        let finished = matches!(event, Some(TurnEvent::Done { .. } | TurnEvent::Error { .. }));
        let payload = match event {
            Some(TurnEvent::Delta { text }) => Some(json!({"choices":[{"delta":{"content":text}}]})),
            Some(TurnEvent::Done { stop_reason }) => {
                Some(json!({"choices":[{"delta":{},"finish_reason":finish_reason(&stop_reason)}]}))
            }
            Some(TurnEvent::Error { message }) => Some(json!({"error":{"code":"antigravity_error","message":message}})),
            // Gateway turns never request tools; skip any stray tool event without finishing.
            Some(TurnEvent::ToolCall { .. } | TurnEvent::ToolCallUpdate { .. }) | None => None,
        };
        let mut frame = payload.map_or_else(
            || b": antigravity\n\n".to_vec(),
            |payload| translator.translate(format!("data: {payload}\n\n").as_bytes()),
        );
        if finished {
            frame.extend(translator.translate(b"data: [DONE]\n\n"));
        }
        if !frame.is_empty() {
            write!(writer, "{:x}\r\n", frame.len())?;
            writer.write_all(&frame)?;
            writer.write_all(b"\r\n")?;
            writer.flush()?;
        }
        if finished {
            writer.write_all(b"0\r\n\r\n")?;
            return writer.flush();
        }
    }
}

pub(crate) fn respond_to_turn(
    app: Option<&AppHandle>, request: Request, model: &str, body: &Value,
) -> Result<(), String> {
    let authorization = format!("Bearer {}", crate::providers::ROUTER_TOKEN);
    if request.headers().iter().any(|header| header.field.equiv("Origin"))
        || !request
            .headers()
            .iter()
            .any(|header| header.field.equiv("Authorization") && header.value.as_str() == authorization)
    {
        return error_reply(
            request,
            403,
            "antigravity_forbidden",
            "Antigravity is only available to the local conversation engine.",
        );
    }
    let Some(app) = app.filter(|_| cfg!(target_os = "macos")) else {
        return error_reply(
            request,
            400,
            "antigravity_unavailable",
            "Antigravity is not available on this installation.",
        );
    };
    let known = catalog()["models"].as_array().is_some_and(|models| models.iter().any(|row| row["id"] == model));
    if !known {
        return error_reply(request, 400, "antigravity_model_invalid", "This Antigravity model is not available.");
    }
    let Some(_slot) = TurnSlot::try_acquire() else {
        return error_reply(
            request,
            429,
            "antigravity_busy",
            "Two Antigravity turns are already running. Wait for one to finish, then retry.",
        );
    };
    if !antigravity_status().signed_in {
        return error_reply(
            request,
            400,
            "antigravity_sign_in_required",
            "请先在「设置 → 大模型 → Google Antigravity」连接 Google 账号，再重试。 Sign in to Google in Settings → Models → Google Antigravity, then retry.",
        );
    }
    let prompt = match request_prompt(body) {
        Ok(prompt) => prompt,
        Err(error) => return error_reply(request, 400, "antigravity_input", error),
    };
    let effort = body.pointer("/reasoning/effort").and_then(Value::as_str).filter(|effort| {
        catalog()["efforts"].as_array().is_some_and(|efforts| efforts.iter().any(|level| level == *effort))
    });
    let turn = match start_turn(app, model, effort, prompt) {
        Ok(turn) => turn,
        Err(error) => return error_reply(request, 400, "antigravity_unavailable", &error),
    };
    let mut stream = TurnUpdates::new(turn);
    if body["stream"].as_bool() == Some(true) {
        return stream_events(request.into_writer(), || stream.wait_for_event()).map_err(|error| error.to_string());
    }
    let mut text = String::new();
    loop {
        match stream.wait_for_event() {
            Some(TurnEvent::Delta { text: delta }) => text.push_str(&delta),
            Some(TurnEvent::Done { stop_reason }) => {
                let value = json!({"id":stream.turn.id,"choices":[{"message":{"content":text},"finish_reason":finish_reason(&stop_reason)}]});
                return reply_json(request, 200, &chat_to_responses(&value));
            }
            Some(TurnEvent::Error { message }) => return error_reply(request, 400, "antigravity_error", &message),
            Some(TurnEvent::ToolCall { .. } | TurnEvent::ToolCallUpdate { .. }) | None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replays_visible_history_without_sending_codex_instructions_or_tool_outputs() {
        let prompt = request_prompt(&json!({"instructions":"Codex internal instructions","input":[
            {"role":"developer","content":"not conversation history"},
            {"role":"user","content":[{"type":"input_text","text":"The project is Orchid."}]},
            {"role":"assistant","content":[{"type":"output_text","text":"I will remember Orchid."}]},
            {"type":"function_call_output","output":"private tool output"},
            {"role":"user","content":[{"type":"input_text","text":"What is its name?"},{"type":"input_image","image_url":"data:image/png;base64,AQID"}]}
        ]})).unwrap();
        let wire = json!(prompt).to_string();
        assert!(wire.contains("The project is Orchid."));
        assert!(wire.contains("I will remember Orchid."));
        assert!(wire.contains("What is its name?"));
        assert!(!wire.contains("internal instructions"));
        assert!(!wire.contains("not conversation history"));
        assert!(!wire.contains("private tool output"));
        assert_eq!(prompt.last().unwrap(), &json!({"type":"image","mimeType":"image/png","data":"AQID"}));
    }

    #[test]
    fn refuses_unforwardable_attachments_without_fetching_the_url() {
        let body = json!({"input":[{"role":"user","content":[{"type":"input_image","image_url":"https://example.invalid/image"}]}]});
        assert!(request_prompt(&body).is_err());
    }

    #[test]
    fn streams_text_lifecycle_and_flushes_before_the_turn_completes() {
        #[derive(Default)]
        struct Sink {
            bytes: Vec<u8>,
            flushes: usize,
        }
        impl Write for Sink {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.bytes.write(bytes)
            }
            fn flush(&mut self) -> io::Result<()> {
                self.flushes += 1;
                Ok(())
            }
        }
        let mut sink = Sink::default();
        let mut events = [
            None,
            Some(TurnEvent::Delta { text: "Gemini reply".into() }),
            Some(TurnEvent::Done { stop_reason: "end_turn".into() }),
        ]
        .into_iter();
        stream_events(&mut sink, || events.next().expect("end of test turn")).unwrap();
        let wire = String::from_utf8(sink.bytes).unwrap();
        assert!(wire.contains(": antigravity"));
        assert!(wire.contains("response.output_item.added"));
        assert!(wire.contains("response.output_text.delta"));
        assert!(wire.contains("Gemini reply"));
        assert!(wire.contains("response.output_item.done"));
        assert!(wire.contains("response.completed"));
        assert!(wire.ends_with("0\r\n\r\n"));
        assert_eq!(sink.flushes, 5);
    }

    #[test]
    fn an_upstream_error_ends_the_turn_without_marking_it_completed() {
        let mut wire = Vec::new();
        stream_events(&mut wire, || Some(TurnEvent::Error { message: "Google refused the turn".into() })).unwrap();
        let wire = String::from_utf8(wire).unwrap();
        assert!(wire.contains("response.failed"));
        assert!(wire.contains("Google refused the turn"));
        assert!(!wire.contains("response.completed"));
    }
}
