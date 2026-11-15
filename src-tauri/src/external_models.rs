//! External-call model names: the id an outside agent sees, mapped to the real routed model.
//!
//! The map is stored in the app data directory and read by `bridge` on every routed request, so a
//! renamed model never changes what is actually called upstream.
//!
//! Three shapes meet here and must not be confused:
//!
//! * the **selection** an outside agent sends (`my-fast-model`) — user-chosen, otherwise opaque;
//! * the **target** it stands for, stored exactly as the app's model picker writes it
//!   (`gateway:custom-abc:claude%2Fopus`);
//! * the **routed name** the bridge and every gateway understand (`custom-abc/claude/opus`).
//!
//! `resolve` walks the first step and `routed_target` the second, so an alias never has to know
//! how the bridge splits a model name.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use tauri::Manager;

/// One name an outside agent may ask for, and the model it actually calls.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAlias {
    /// What the outside agent sends as `model`. Matched exactly, case included.
    pub id: String,
    /// What the user sees in the settings list. Never empty: an unnamed alias shows its id.
    pub name: String,
    /// The app's own model id, e.g. `gateway:custom-abc:claude%2Fopus`.
    pub target: String,
}

/// File the aliases live in, inside the app data directory.
const FILE_NAME: &str = "external-models.json";

/// On-disk shape. A wrapper object (not a bare array) so later versions can add fields without
/// breaking the parser, and so a truncated write is recognisable instead of silently becoming an
/// empty alias table.
#[derive(Default, Serialize, Deserialize)]
struct AliasesFile {
    #[serde(default)]
    aliases: Vec<ExternalAlias>,
}

/// `None` means "not initialised yet": `list` then answers empty rather than inventing state.
fn cache() -> &'static RwLock<Option<Vec<ExternalAlias>>> {
    static CACHE: OnceLock<RwLock<Option<Vec<ExternalAlias>>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(None))
}

fn file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(FILE_NAME))
        .map_err(|error| format!("没有可用的应用数据目录：{error}"))
}

/// A missing or unreadable file is an empty alias table, not an error: the bridge must keep
/// routing real model names while a user has never configured an alias.
fn read_file(path: &Path) -> Vec<ExternalAlias> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match serde_json::from_str::<AliasesFile>(&text) {
        Ok(file) => file.aliases,
        Err(error) => {
            log::warn!("external models: {path:?} is not a valid alias table, treating it as empty: {error}");
            Vec::new()
        }
    }
}

/// Writes through a temp file in the same directory and then renames, so a crash mid-write leaves
/// the previous table intact instead of a half-written JSON file.
#[allow(dead_code)] // 设置页已下线，写入只发生在测试与外部脚本；契约仍要能被验证。
fn write_file(path: &Path, aliases: &[ExternalAlias]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录 {parent:?}：{error}"))?;
    }
    let text = serde_json::to_string_pretty(&AliasesFile { aliases: aliases.to_vec() })
        .map_err(|error| format!("无法序列化外部模型别名：{error}"))?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, text.as_bytes()).map_err(|error| format!("无法写入 {temporary:?}：{error}"))?;
    std::fs::rename(&temporary, path).map_err(|error| format!("无法保存 {path:?}：{error}"))
}

/// Reads the table once at startup. Called from `lib.rs`'s setup, before the bridge serves traffic.
pub fn init(app: &tauri::AppHandle) {
    let aliases = match file_path(app) {
        Ok(path) => read_file(&path),
        Err(error) => {
            log::warn!("external models: {error}");
            Vec::new()
        }
    };
    log::info!("external models: {} alias(es) loaded", aliases.len());
    if let Ok(mut guard) = cache().write() {
        *guard = Some(aliases);
    }
}

/// The current table. Empty until `init` ran, so a bridge thread can never block on disk.
pub fn list() -> Vec<ExternalAlias> {
    cache()
        .read()
        .map(|guard| guard.clone().unwrap_or_default())
        .unwrap_or_default()
}

/// Reads the cache, initialising from disk on first use — the bridge may serve a request before
/// anything else asked for the list.
#[allow(dead_code)] // 没有 UI 命令调用它了；保留给未来重新接回设置页时直接用。
fn list_ready(app: &tauri::AppHandle) -> Vec<ExternalAlias> {
    if let Ok(guard) = cache().read() {
        if let Some(aliases) = guard.as_ref() {
            return aliases.clone();
        }
    }
    init(app);
    list()
}

/// The model an alias id stands for, or `None` when the selection is a real model name.
///
/// Matching is exact and case-sensitive: `My-Model` and `my-model` are two different names, and a
/// near miss must fall through to the normal routing path instead of silently calling something
/// the user did not choose.
pub fn resolve(selection: &str) -> Option<String> {
    resolve_in(&list(), selection)
}

fn resolve_in(aliases: &[ExternalAlias], selection: &str) -> Option<String> {
    aliases
        .iter()
        .find(|alias| alias.id == selection)
        .map(|alias| alias.target.clone())
}

/// Trims and rejects an edited table. Returns the normalized table so what is stored is exactly
/// what the settings list will show after a reload.
#[allow(dead_code)] // 同上：写入路径不在 App 内了，校验规则由测试守住。
fn validate(aliases: &[ExternalAlias]) -> Result<Vec<ExternalAlias>, String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut normalized = Vec::with_capacity(aliases.len());
    for alias in aliases {
        let id = alias.id.trim().to_string();
        if id.is_empty() {
            return Err("外部模型别名不能为空：每一项都需要一个外部可见的 id。".into());
        }
        if id.contains('\n') || id.contains('\r') {
            return Err(format!("外部模型别名「{id}」含有换行符，请改成单行 id。"));
        }
        if !seen.insert(id.clone()) {
            return Err(format!("外部模型别名「{id}」重复了，每个 id 只能对应一个模型。"));
        }
        let target = alias.target.trim().to_string();
        if target.is_empty() {
            return Err(format!("外部模型别名「{id}」还没有选择实际调用的模型。"));
        }
        let name = alias.name.trim().to_string();
        normalized.push(ExternalAlias {
            name: if name.is_empty() { id.clone() } else { name },
            id,
            target,
        });
    }
    Ok(normalized)
}

/// `GET /v1/models` payload for the outside agent: the alias ids, never the inner model ids.
pub fn model_list_json() -> Vec<u8> {
    model_list_json_for(&list())
}

fn model_list_json_for(aliases: &[ExternalAlias]) -> Vec<u8> {
    let data: Vec<serde_json::Value> = aliases
        .iter()
        .map(|alias| {
            serde_json::json!({"id": alias.id, "object": "model", "owned_by": "alwith"})
        })
        .collect();
    let payload = serde_json::json!({"object": "list", "data": data});
    // The shape is built from plain strings, so serialisation cannot fail; the fallback keeps the
    // function total rather than panicking inside a bridge worker.
    serde_json::to_vec(&payload).unwrap_or_else(|_| br#"{"object":"list","data":[]}"#.to_vec())
}

/// Turns a stored target into the `<gateway>/<model>` name the router splits on.
///
/// The picker encodes a gateway model as `gateway:<gateway>:<model>` with both halves
/// percent-encoded (a model id may itself contain `/`, `:` or spaces). Everything else — a native
/// model, a plain gateway name, an empty string — is returned unchanged, so an alias may also point
/// at a model that needs no rewriting.
pub fn routed_target(target: &str) -> String {
    let Some(rest) = target.strip_prefix("gateway:") else {
        return target.to_string();
    };
    // Split on the first `:` only: the model part keeps any further colons it owns.
    let Some((gateway, model)) = rest.split_once(':') else {
        return target.to_string();
    };
    if gateway.is_empty() || model.is_empty() {
        return target.to_string();
    }
    format!("{}/{}", percent_decode(gateway), percent_decode(model))
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Percent-decodes `%XX` sequences. An invalid sequence (`%ZZ`, a truncated `%A`) is copied through
/// unchanged, so a malformed name still reaches the router instead of being silently mangled.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut decoded: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex_value(bytes[index + 1]), hex_value(bytes[index + 2])) {
                decoded.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    // A decoded id is UTF-8 in practice; a lone invalid byte is replaced rather than dropped.
    String::from_utf8_lossy(&decoded).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alias(id: &str, name: &str, target: &str) -> ExternalAlias {
        ExternalAlias {
            id: id.to_string(),
            name: name.to_string(),
            target: target.to_string(),
        }
    }

    #[test]
    fn an_alias_matches_its_id_exactly_and_case_sensitively() {
        let table = vec![
            alias("fast", "Fast", "gateway:custom-abc:claude%2Fopus"),
            alias("Slow-Model", "Slow", "openrouter/anthropic/claude-sonnet-4"),
        ];
        assert_eq!(
            resolve_in(&table, "fast").as_deref(),
            Some("gateway:custom-abc:claude%2Fopus")
        );
        assert_eq!(
            resolve_in(&table, "Slow-Model").as_deref(),
            Some("openrouter/anthropic/claude-sonnet-4")
        );
        // A real model name, a different case and a prefix must all fall through untouched.
        assert_eq!(resolve_in(&table, "slow-model"), None);
        assert_eq!(resolve_in(&table, "faster"), None);
        assert_eq!(resolve_in(&table, "gateway:custom-abc:claude%2Fopus"), None);
    }

    #[test]
    fn a_duplicate_id_is_refused_with_a_readable_reason() {
        let refused = validate(&[
            alias("fast", "Fast", "gateway:a:m"),
            alias(" fast ", "Fast again", "gateway:a:other"),
        ]);
        let error = refused.expect_err("a repeated id must be refused");
        assert!(error.contains("fast"), "the reason names the id: {error}");

        let empty_id = validate(&[alias("   ", "Nameless", "gateway:a:m")]);
        assert!(empty_id.is_err(), "an id that is only whitespace is not an id");

        let empty_target = validate(&[alias("fast", "Fast", "  ")]);
        assert!(empty_target.is_err(), "an alias must call something");

        let newline = validate(&[alias("fa\nst", "Fast", "gateway:a:m")]);
        assert!(newline.is_err(), "an id must stay on one line");
    }

    #[test]
    fn a_saved_table_is_trimmed_and_an_unnamed_alias_falls_back_to_its_id() {
        let saved = validate(&[alias(" fast ", "  ", " gateway:a:m ")]).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].id, "fast");
        assert_eq!(saved[0].name, "fast");
        assert_eq!(saved[0].target, "gateway:a:m");
    }

    #[test]
    fn a_gateway_target_becomes_the_routed_name_the_bridge_splits() {
        // The model part keeps its decoded slash: `forward_routed` splits on the *first* `/`, so
        // `custom-abc/claude/opus` is gateway `custom-abc`, model `claude/opus`.
        assert_eq!(
            routed_target("gateway:custom-abc:claude%2Fopus"),
            "custom-abc/claude/opus"
        );
        // Extra colons in the model survive because only the first two separators are cut.
        assert_eq!(
            routed_target("gateway:openrouter:inclusionai%2Fling-1t:free"),
            "openrouter/inclusionai/ling-1t:free"
        );
        // Everything that is not the three-part picker shape is passed through untouched.
        assert_eq!(routed_target("gateway:aplicable"), "gateway:aplicable");
        assert_eq!(routed_target("openrouter/anthropic/claude"), "openrouter/anthropic/claude");
        assert_eq!(routed_target("gpt-6.1-sol"), "gpt-6.1-sol");
        assert_eq!(routed_target(""), "");
        assert_eq!(routed_target("gateway::m"), "gateway::m");
    }

    #[test]
    fn an_invalid_percent_sequence_is_kept_as_it_was_written() {
        assert_eq!(routed_target("gateway:gw%ZZ:model%2Fx"), "gw%ZZ/model/x");
        // A truncated escape at the end of the model is not a valid sequence either.
        assert_eq!(routed_target("gateway:gw:model%2"), "gw/model%2");
        // Uppercase and lowercase hex both decode.
        assert_eq!(routed_target("gateway:g%77:m%41"), "gw/mA");
    }

    #[test]
    fn an_empty_table_lists_no_models() {
        assert_eq!(
            String::from_utf8(model_list_json_for(&[])).unwrap(),
            r#"{"object":"list","data":[]}"#
        );
    }

    #[test]
    fn the_model_list_exposes_alias_ids_and_never_the_target() {
        let json = String::from_utf8(model_list_json_for(&[
            alias("fast", "Fast", "gateway:custom-abc:claude%2Fopus"),
        ]))
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["object"], "list");
        assert_eq!(parsed["data"][0]["id"], "fast");
        assert_eq!(parsed["data"][0]["object"], "model");
        assert_eq!(parsed["data"][0]["owned_by"], "alwith");
        assert!(!json.contains("claude"), "the inner model id must not leak: {json}");
    }

    #[test]
    fn the_file_shape_round_trips_through_the_wrapper_object() {
        let path = std::env::temp_dir().join(format!(
            "alwith-external-models-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        let table = vec![alias("fast", "Fast", "gateway:custom-abc:claude%2Fopus")];
        write_file(&path, &table).unwrap();
        assert_eq!(read_file(&path), table);
        // A corrupted file is an empty table, never a panic.
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(read_file(&path).is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
