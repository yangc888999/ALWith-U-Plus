//! Application-owned provider credentials. Webviews receive only configured/region metadata.
//! Independent provider changes apply under Runtime admission; busy session routing stays pinned.
use alwith_api::{ResponseError, RuntimeClient};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tauri3_specta::Event;

// Account-managed ALwith models, restored from upstream commit 8f7f701e (2026-10-28), which sits
// seven commits after this checkout's baseline `a587d228`. It has no private-crate dependency —
// only `super::*` and std — so it ports as-is.
pub mod managed;

/// Default reasoning level for the account-managed (company) model.
///
/// The company DeepSeek V4.1 Flash exposes `low` / `high` / `max`; the user wants it to think at
/// `max` by default and to be able to change that from 大模型. The value is mirrored into the shared
/// engine catalog (`model-catalogs/alwith/models.json`) by `tune_managed_catalog`, and into the
/// managed provider snapshot by `parse_catalog`, so both the engine's actual thinking and the
/// picker's default agree. Persisted to `company-model.json` so it survives restarts; the frontend
/// pushes its choice here on startup.
const COMPANY_REASONING_LEVELS: &[&str] = &["low", "high", "max"];
static COMPANY_MODEL_REASONING: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(Some("max".to_string())));

/// The configured default reasoning level for the company model, or `Some("max")` when unset.
pub(crate) fn company_reasoning_level() -> Option<String> {
    COMPANY_MODEL_REASONING.lock().unwrap().clone()
}

/// Restores the persisted company-model reasoning level (no-op when the file is absent or invalid).
fn load_company_model_reasoning(directory: &Path) {
    let path = directory.join("company-model.json");
    let Ok(bytes) = std::fs::read(&path) else { return };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { return };
    if let Some(level) = value.get("reasoningLevel").and_then(|level| level.as_str())
        && COMPANY_REASONING_LEVELS.contains(&level)
    {
        *COMPANY_MODEL_REASONING.lock().unwrap() = Some(level.to_string());
    }
}

/// Upstream wire protocol. Codex always talks Responses to the local router.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Protocol {
    #[default]
    Responses,
    ChatCompletions,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Credential {
    api_key: String,
    #[serde(default)]
    protocol: Protocol,
    region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    /// Closing a provider keeps its key so re-enabling does not ask for it again; the flag decides
    /// whether the provider is applied, not whether a key exists.
    #[serde(default)]
    disabled: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomModel {
    label: String,
    #[serde(rename = "api_id")]
    api_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    /// Reasoning efforts accepted by the provider. Omitted uses the conventional levels for
    /// recognizable model families; an empty list is invalid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_levels: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_reasoning_level: Option<String>,
    /// True when the reader changed this model's default effort. Only an explicit choice may
    /// survive a later change to the engine's recommended default; an initial seed must not.
    #[serde(default, skip_serializing_if = "is_false")]
    default_reasoning_level_explicit: bool,
    /// Whether the model is offered in the picker. Omitted (and `true`) means enabled; a switched
    /// off model stays in the settings list so it can be turned back on, but never reaches Codex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl CustomModel {
    fn is_enabled(&self) -> bool {
        self.enabled.unwrap_or(true)
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CustomProvider {
    id: String,
    name: String,
    base_url: String,
    models: Vec<CustomModel>,
    api_key: String,
}
#[derive(Clone, Default, Debug, Deserialize, Serialize)]
struct Saved {
    revision: u64,
    #[serde(default)]
    credentials: BTreeMap<String, Credential>,
    #[serde(default)]
    custom_providers: BTreeMap<String, CustomProvider>,
    /// User overrides for built-in provider model catalogs, keyed by provider id. Absent means the
    /// bundled catalog is used unchanged. Each override fully replaces that provider's model set.
    #[serde(default)]
    built_in_model_overrides: BTreeMap<String, Vec<CustomModel>>,
    /// Account-managed ALwith models (restored from upstream 8f7f701e). Absent until the reader
    /// signs in to an ALwith account; the provider id inside is `litellm`, not the router's
    /// `alwith`, so the two never contend for the same config table.
    #[serde(default)]
    managed: Option<managed::Cache>,
    /// One-shot migration marker: the company stopped offering DeepSeek, so its credential is
    /// closed by default once. Recorded after the flip so a later deliberate re-enable sticks.
    #[serde(default)]
    deepseek_default_closed: bool,
}
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
#[derive(tauri3_specta::Event)]
#[event(name = "providers:changed")]
pub struct Snapshot {
    revision: u64,
    applied_revision: Option<u64>,
    providers: BTreeMap<String, Metadata>,
    custom_providers: Vec<PublicCustomProvider>,
    /// Providers the signed-in ALwith account contributes. Kept apart from `custom_providers` so a
    /// logout never leaves an editable copy of an account-owned provider behind.
    managed_providers: Vec<PublicCustomProvider>,
    /// Effective models for each built-in provider (bundled catalog merged with user overrides),
    /// carrying the context window and reasoning levels the adapter threads through to Codex.
    built_in_models: BTreeMap<String, Vec<CustomModel>>,
    status: &'static str,
    error: Option<String>,
    /// The account catalog could not be refreshed. Displayed as a neutral notice, never as
    /// `status: "failed"` — see the field of the same name on `Inner`.
    managed_error: Option<String>,
}
#[derive(Clone, Serialize, specta::Type)]
pub struct Metadata {
    protocol: Protocol,
    configured: bool,
    /// Closed by the user, but its key is still stored — the switch is off, the credential is not.
    disabled: bool,
    region: Option<String>,
    base_url: Option<String>,
}
#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PublicCustomProvider {
    id: String,
    name: String,
    base_url: String,
    models: Vec<CustomModel>,
}
struct Inner {
    saved: Saved,
    applied: BTreeMap<String, AppliedProvider>,
    applied_revision: Option<u64>,
    error: Option<String>,
    /// Account-owned catalog sync failure. Kept apart from `error` on purpose: `error` means the
    /// saved configuration did not reach the engine, which "立即应用" can fix. A catalog that
    /// failed to download cannot be fixed by re-applying anything, so folding the two together
    /// used to paint a red banner next to a button that did nothing.
    managed_error: Option<String>,
    resource_dir: PathBuf,
    /// True while the engine is routing through the account-managed provider.
    managed_active: bool,
}
pub struct Providers {
    path: PathBuf,
    catalog_dir: PathBuf,
    inner: tokio::sync::Mutex<Inner>,
    /// Account-managed state: the signed-in account, its cached provider, and the admission gate
    /// that pins sessions to it. Restored from upstream 8f7f701e.
    managed: managed::State,
}
#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    #[serde(default)]
    protocol: Option<Protocol>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    region: Option<String>,
    #[serde(default)]
    base_url: Option<String>,
    /// `Some(true)` closes the provider while keeping its key; `None`/`false` enables it.
    #[serde(default)]
    disabled: Option<bool>,
}
#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomInput {
    #[serde(default)]
    id: Option<String>,
    name: String,
    #[serde(default)]
    api_key: Option<String>,
    base_url: String,
    models: Vec<CustomModel>,
}
#[derive(Clone, PartialEq)]
enum AppliedProvider {
    BuiltIn(Credential, Option<Vec<CustomModel>>),
    Custom(CustomProvider),
}

/// Compares two applied providers ignoring the order of a built-in model list.
///
/// Dragging a model in Settings only changes picker order, but `AppliedProvider` derives `PartialEq`
/// over the vector, so the provider used to be re-applied. The adapter rejects a catalog swap that
/// merely reshuffles priorities with `-32603`, leaving 保存模型 in a failing retry loop. The saved
/// order still drives every picker; the engine's catalog does not need the reshuffle.
fn same_applied(left: &AppliedProvider, right: &AppliedProvider) -> bool {
    match (left, right) {
        (AppliedProvider::BuiltIn(left_key, left_models), AppliedProvider::BuiltIn(right_key, right_models)) => {
            if left_key != right_key {
                return false;
            }
            match (left_models, right_models) {
                (None, None) => true,
                (Some(left), Some(right)) => {
                    let mut left = left.clone();
                    let mut right = right.clone();
                    left.sort_by(|a, b| a.api_id.cmp(&b.api_id));
                    right.sort_by(|a, b| a.api_id.cmp(&b.api_id));
                    left == right
                }
                _ => false,
            }
        }
        (AppliedProvider::Custom(left), AppliedProvider::Custom(right)) => left == right,
        _ => false,
    }
}
#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    ok: bool,
    code: &'static str,
    message: String,
    status: Option<u16>,
    latency_ms: Option<u128>,
}
#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoverInput {
    base_url: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    provider_id: Option<String>,
}

impl Providers {
    pub fn load(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let directory = app.path().app_data_dir()?;
        let path = directory.join("runtime-providers.json");
        let mut saved: Saved = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Saved::default(),
            Err(error) => return Err(error.into()),
        };
        if close_deepseek_by_default(&mut saved)
            && let Err(error) = persist(&path, &saved)
        {
            log::warn!("Provider store: could not persist the DeepSeek default close: {error}");
        }
        // 引擎目录是 GPT 模型的唯一真源，先同步再谈别的：`prepare_merged_catalog` 紧随其后，
        // 它写出的 merged.json 是引擎与四处选择器共用的那份清单。顺序颠倒会让新模型晚一个
        // 启动才出现，而中间那段正是「选择器里没有、会话却认」的分裂窗口。
        let directory_for_engine = directory.clone();
        if sync_engine_models(&directory_for_engine, &mut saved) {
            saved.revision = saved.revision.saturating_add(1);
            if let Err(error) = persist(&path, &saved) {
                log::warn!("Provider store: could not persist the engine model sync: {error}");
            }
        }
        // Restore the company model's configured reasoning level before any catalog tuning runs.
        load_company_model_reasoning(&directory);
        // The gate is process memory, so a cached account has to be put back here: without it
        // `check_selection` treats every signed-in model as unavailable after a restart, and the
        // chat refuses to send with "The selected ALwith account model is unavailable".
        let managed_active = saved.managed.is_some();
        let managed = managed::State::default();
        if let Some(cache) = saved.managed.as_ref() {
            let mut gate = managed.gate.lock().unwrap();
            gate.account = Some(cache.account.clone());
            gate.models = managed::model_ids(cache.provider.as_ref());
        }
        Ok(Self {
            path,
            catalog_dir: directory.join("provider-catalogs"),
            inner: tokio::sync::Mutex::new(Inner {
                saved,
                applied: BTreeMap::new(),
                applied_revision: None,
                error: None,
                managed_error: None,
                resource_dir: app.path().resource_dir()?,
                managed_active,
            }),
            managed,
        })
    }
    pub async fn reset(&self) {
        let mut inner = self.inner.lock().await;
        inner.applied.clear();
        inner.applied_revision = None;
        inner.error = None;
    }
}
impl Inner {
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            revision: self.saved.revision,
            applied_revision: self.applied_revision,
            providers: self
                .saved
                .credentials
                .iter()
                .map(|(id, key)| {
                    (
                        id.clone(),
                        Metadata {
                            protocol: key.protocol,
                            configured: !key.disabled,
                            disabled: key.disabled,
                            region: key.region.clone(),
                            base_url: key.base_url.clone(),
                        },
                    )
                })
                .collect(),
            custom_providers: self
                .saved
                .custom_providers
                .values()
                .map(|provider| PublicCustomProvider {
                    id: provider.id.clone(),
                    name: provider.name.clone(),
                    base_url: provider.base_url.clone(),
                    models: provider.models.clone(),
                })
                .collect(),
            managed_providers: self
                .saved
                .managed
                .as_ref()
                .filter(|_| self.managed_active)
                .and_then(|cache| cache.provider.as_ref())
                .map(|provider| {
                    vec![PublicCustomProvider {
                        id: provider.id.clone(),
                        name: provider.name.clone(),
                        base_url: provider.base_url.clone(),
                        models: provider.models.clone(),
                    }]
                })
                .unwrap_or_default(),
            built_in_models: built_in_models(&self.resource_dir, &self.saved.built_in_model_overrides),
            status: if self.error.is_some() {
                "failed"
            } else if self.applied_revision == Some(self.saved.revision) {
                "applied"
            } else {
                "pending"
            },
            error: self.error.clone(),
            managed_error: self.managed_error.clone(),
        }
    }
}
/// Bundled Codex model catalogs of the built-in providers (their `catalog` resource paths). The adapter
/// merges them into Codex's own table at app-server start (`CODEX_ACP_MODEL_CATALOGS`), the only point
/// where Codex reads model metadata.
pub fn bundled_model_catalogs(resources: &std::path::Path) -> Result<Vec<std::path::PathBuf>, String> {
    catalog()
        .iter()
        .filter_map(|provider| provider["catalog"].as_str())
        .map(|relative| {
            let path = resources.join(relative);
            if path.is_file() { Ok(path) } else { Err(format!("Model catalog missing at {}", path.display())) }
        })
        .collect()
}

fn catalog() -> Vec<Value> {
    serde_json::from_str(include_str!("../../src/lib/provider-catalog.json")).expect("bundled provider catalog")
}

/// The company no longer offers DeepSeek: close its credential once so its models leave every
/// picker and the engine catalog. The key (if any) stays on disk. The one-shot marker is persisted
/// even when there is nothing to flip, so a reader who deliberately re-enables DeepSeek later keeps
/// that choice across restarts instead of being closed again on every launch.
fn close_deepseek_by_default(saved: &mut Saved) -> bool {
    if saved.deepseek_default_closed {
        return false;
    }
    saved.deepseek_default_closed = true;
    if let Some(credential) = saved.credentials.get_mut("deepseek") {
        credential.disabled = true;
    }
    true
}
fn definition(id: &str) -> Result<Value, String> {
    catalog().into_iter().find(|v| v["id"] == id).ok_or("Unknown provider".into())
}

/// Effective models for a built-in provider: the bundled Codex catalog enriched with any user
/// overrides. The model picker list and the thread `model_catalog_json` both derive from this.
fn built_in_models(
    resource_dir: &Path, overrides: &BTreeMap<String, Vec<CustomModel>>,
) -> BTreeMap<String, Vec<CustomModel>> {
    catalog()
        .iter()
        .filter_map(|provider| {
            let id = provider["id"].as_str()?;
            // Native providers (OpenAI, Codex sign-in) ship no bundled catalog: their model list
            // is the engine's own, and only the user's overrides are ours to report. Returning
            // early here used to drop them from the snapshot entirely, so a trimmed list was
            // never visible and the picker fell back to the engine's full set.
            let Some(relative) = provider["catalog"].as_str() else {
                return Some((id.to_string(), overrides.get(id).cloned().unwrap_or_default()));
            };
            let bytes = std::fs::read(resource_dir.join(relative)).ok()?;
            let bundled: Value = serde_json::from_slice(&bytes).ok()?;
            let derived: Vec<CustomModel> = bundled["models"]
                .as_array()?
                .iter()
                .map(|entry| CustomModel {
                    label: entry["display_name"].as_str().unwrap_or("").to_string(),
                    api_id: entry["slug"].as_str().unwrap_or("").to_string(),
                    context_window: entry["context_window"].as_u64(),
                    description: entry["description"].as_str().map(str::to_string),
                    reasoning_levels: entry["supported_reasoning_levels"].as_array().map(|levels| {
                        levels.iter().filter_map(|level| level["effort"].as_str().map(str::to_string)).collect()
                    }),
                    default_reasoning_level: entry["default_reasoning_level"].as_str().map(str::to_string),
                    default_reasoning_level_explicit: false,
                    enabled: None,
                })
                .collect();
            let models = overrides.get(id).cloned().unwrap_or(derived);
            Some((id.to_string(), models))
        })
        .collect()
}
fn update(saved: &Saved, id: String, input: Option<Input>, expected_revision: u64) -> Result<Saved, String> {
    if saved.revision != expected_revision {
        return Err("Provider settings changed in another window; reload and retry".into());
    }
    let provider = definition(&id)?;
    let mut credentials = saved.credentials.clone();
    if let Some(input) = input {
        let region = if let Some(regions) = provider["regions"].as_array() {
            let selected = input.region.as_deref().unwrap_or_else(|| regions[0]["id"].as_str().expect("region id"));
            if !regions.iter().any(|r| r["id"] == selected) {
                return Err("Unknown provider region".into());
            }
            Some(selected.to_string())
        } else {
            None
        };
        let api_key = match input.api_key {
            Some(key) if !key.trim().is_empty() => key.trim().to_string(),
            Some(_) => return Err("API key cannot be empty".into()),
            None => credentials.get(&id).ok_or("Configure an API key first")?.api_key.clone(),
        };
        let base_url = match input.base_url {
            Some(value) if !value.trim().is_empty() => Some(normalize_base_url(&value)?),
            Some(_) => None,
            None => credentials.get(&id).and_then(|current| current.base_url.clone()),
        };
        // A first DeepSeek connection defaults to closed (the company stopped offering it); an
        // explicit disabled flag — including a deliberate re-enable — always wins.
        let default_disabled = id == "deepseek" && !credentials.contains_key("deepseek");
        let protocol = input.protocol.or_else(|| credentials.get(&id).map(|key| key.protocol)).unwrap_or_default();
        if id != "openrouter" && protocol != Protocol::Responses {
            return Err("Protocol selection is supported only for OpenRouter".into());
        }
        credentials.insert(
            id,
            Credential { api_key, protocol, region, base_url, disabled: input.disabled.unwrap_or(default_disabled) },
        );
    } else {
        credentials.remove(&id);
    }
    Ok(Saved {
        revision: saved.revision.checked_add(1).ok_or("Provider revision exhausted")?,
        credentials,
        custom_providers: saved.custom_providers.clone(),
        built_in_model_overrides: saved.built_in_model_overrides.clone(),
        // Rebuilding `Saved` must carry the account cache forward: saving any unrelated provider
        // must never sign the reader out of their ALwith account.
        managed: saved.managed.clone(),
        deepseek_default_closed: saved.deepseek_default_closed,
    })
}

fn normalize_base_url(value: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(value.trim()).map_err(|_| "API base URL is invalid".to_string())?;
    let local_http = url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !local_http {
        return Err("API base URL must use HTTPS (HTTP is allowed only for localhost)".into());
    }
    if url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
        return Err("API base URL cannot contain credentials, query parameters, or a fragment".into());
    }
    let mut path = url.path().trim_end_matches('/').to_string();
    // The gateway appends `/responses` and `/models` itself. A URL pasted from a curl example
    // (`https://openrouter.ai/api/v1/chat/completions`) would otherwise become
    // `/chat/completions/responses` and 404 on every turn. This is the last shared checkpoint for
    // built-in providers, custom providers and model discovery alike, so strip it here as well as
    // in the settings UI (which only echoes the cleaned value back into its own input).
    const ENDPOINTS: [&str; 5] = ["/chat/completions", "/responses", "/completions", "/models", "/embeddings"];
    loop {
        let lowered = path.to_ascii_lowercase();
        let matched = ENDPOINTS.iter().find(|candidate| lowered.ends_with(**candidate)).copied();
        match matched {
            Some(suffix) => {
                path.truncate(path.len() - suffix.len());
                path = path.trim_end_matches('/').to_string();
            }
            None => break,
        }
    }
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

const REASONING_LEVELS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"];

fn inferred_reasoning_levels(api_id: &str, label: &str) -> Option<(&'static [&'static str], &'static str)> {
    let hint = format!("{api_id} {label}").to_ascii_lowercase();
    if hint.contains("qwen3.8") || hint.contains("qwen-3.8") || hint.contains("qwen 3.8") {
        // Qwen's own Codex catalogue for 3.8 publishes three levels and defaults to `xhigh`;
        // `none` is added because the endpoint accepts it and it genuinely disables thinking.
        Some((&["none", "low", "medium", "xhigh"], "xhigh"))
    } else if hint.contains("qwen4") || hint.contains("qwen-4") || hint.contains("qwen 4") {
        // Qwen4 preview (e.g. qwen4-max-preview) accepts none/low/medium/high/xhigh/max on the
        // Responses endpoint (all verified 200) and defaults to `high`; `minimal` is not published.
        Some((&["none", "low", "medium", "high", "xhigh", "max"], "high"))
    } else if hint.contains("qwen") {
        // 3.7 and earlier publish the full ladder. Verified against the Responses endpoint:
        // none/minimal/low/medium/high/xhigh/max all answer 200, and `none` reports zero
        // reasoning tokens, so it is a real off switch rather than a clamped low.
        Some((&["none", "minimal", "low", "medium", "high", "xhigh", "max"], "medium"))
    } else if hint.contains("claude") {
        Some((&["low", "medium", "high", "max"], "medium"))
    } else if hint.contains("deepseek") {
        // DeepSeek maps medium->high, xhigh->high and ultra->max, so medium/xhigh are noise.
        // `none` is the documented way to answer without thinking, and the service default is
        // `high` — a catalogue claiming `max` made every new chat burn the most expensive tier.
        Some((&["none", "low", "high", "max"], "high"))
    } else if hint.contains("gpt") || hint.contains("openai") || hint.contains("codex") {
        // Matches the GPT/OpenAI presets in the settings catalogue; a model the gateway rejects
        // simply falls back to its own default.
        Some((&["low", "medium", "high"], "medium"))
    } else if hint.contains("mimo") {
        // 小米 MiMo 的 reasoning.effort 接受 none/minimal/low/medium/high/xhigh/max/ultra，但文档说
        // 只有 `none` 真正关掉思考，其余取值都被映射成「开」。四档是可用的最小集合。
        Some((&["none", "low", "medium", "high"], "medium"))
    } else if hint.contains("kimi") || hint.contains("moonshot") {
        // Only the K3 family accepts `reasoning_effort`, and it takes exactly low/high/max with
        // `max` as the default. K2.x configures thinking through its own object and the older
        // moonshot models take neither, so offering them a ladder only produces 400s.
        hint.contains("k3").then_some((&["low", "high", "max"][..], "max"))
    } else if hint.contains("glm") {
        Some((&["low", "medium", "high"], "medium"))
    } else {
        None
    }
}

fn normalize_reasoning(model: &mut CustomModel) -> Result<(), String> {
    if let Some(levels) = &mut model.reasoning_levels {
        if levels.is_empty() {
            return Err("Model reasoningLevels cannot be empty".into());
        }
        let mut seen = BTreeSet::new();
        for level in levels.iter_mut() {
            *level = level.trim().to_ascii_lowercase();
            if !REASONING_LEVELS.contains(&level.as_str()) {
                return Err(format!("Unknown reasoning effort: {level}"));
            }
            if !seen.insert(level.clone()) {
                return Err(format!("Duplicate reasoning effort: {level}"));
            }
        }
    } else if let Some((levels, default)) = inferred_reasoning_levels(&model.api_id, &model.label) {
        model.reasoning_levels = Some(levels.iter().map(|level| (*level).to_string()).collect());
        model.default_reasoning_level = Some(default.to_string());
    }
    let Some(levels) = &model.reasoning_levels else {
        if model.default_reasoning_level.is_some() {
            return Err("Model defaultReasoningLevel requires reasoningLevels".into());
        }
        return Ok(());
    };
    let explicit = model.default_reasoning_level.as_mut().map(|level| {
        *level = level.trim().to_ascii_lowercase();
        level.clone()
    });
    let inferred = inferred_reasoning_levels(&model.api_id, &model.label).map(|(_, default)| default);
    let default = match explicit {
        Some(level) => {
            if !REASONING_LEVELS.contains(&level.as_str()) {
                return Err(format!("Unknown default reasoning effort: {level}"));
            }
            if !levels.contains(&level) {
                return Err("defaultReasoningLevel must be one of reasoningLevels".into());
            }
            level
        }
        None => inferred
            .map(str::to_string)
            .filter(|level| levels.contains(level))
            .or_else(|| levels.iter().find(|level| level.as_str() == "medium").cloned())
            .unwrap_or_else(|| levels[0].clone()),
    };
    model.default_reasoning_level = Some(default);
    Ok(())
}

fn update_custom(saved: &Saved, input: CustomInput, expected_revision: u64) -> Result<Saved, String> {
    if saved.revision != expected_revision {
        return Err("Provider settings changed in another window; reload and retry".into());
    }
    let id = input.id.unwrap_or_else(|| format!("custom_{}", uuid::Uuid::new_v4().simple()));
    if !id.starts_with("custom_") {
        return Err("Custom provider ID is invalid".into());
    }
    let name = input.name.trim();
    if name.is_empty() {
        return Err("Provider name cannot be empty".into());
    }
    if input.models.is_empty() {
        return Err("Add at least one model".into());
    }
    let mut ids = BTreeSet::new();
    let models = input
        .models
        .into_iter()
        .map(|mut model| {
            model.label = model.label.trim().to_string();
            model.api_id = model.api_id.trim().to_string();
            if model.label.is_empty() || model.api_id.is_empty() {
                return Err("Model label and API ID cannot be empty".to_string());
            }
            if !ids.insert(model.api_id.clone()) {
                return Err("Model IDs must be unique".to_string());
            }
            if model.context_window == Some(0) {
                return Err("Model context window must be greater than zero".to_string());
            }
            normalize_reasoning(&mut model)?;
            Ok(model)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut custom_providers = saved.custom_providers.clone();
    let api_key = match input.api_key {
        Some(value) if !value.trim().is_empty() => value.trim().to_string(),
        Some(_) => return Err("API key cannot be empty".into()),
        None => custom_providers.get(&id).ok_or("Configure an API key first")?.api_key.clone(),
    };
    custom_providers.insert(
        id.clone(),
        CustomProvider { id, name: name.to_string(), base_url: normalize_base_url(&input.base_url)?, models, api_key },
    );
    Ok(Saved {
        revision: saved.revision.checked_add(1).ok_or("Provider revision exhausted")?,
        credentials: saved.credentials.clone(),
        custom_providers,
        built_in_model_overrides: saved.built_in_model_overrides.clone(),
        managed: saved.managed.clone(),
        deepseek_default_closed: saved.deepseek_default_closed,
    })
}

fn remove_custom(saved: &Saved, id: &str, expected_revision: u64) -> Result<Saved, String> {
    if saved.revision != expected_revision {
        return Err("Provider settings changed in another window; reload and retry".into());
    }
    let mut custom_providers = saved.custom_providers.clone();
    if custom_providers.remove(id).is_none() {
        return Err("Unknown custom provider".into());
    }
    Ok(Saved {
        revision: saved.revision.checked_add(1).ok_or("Provider revision exhausted")?,
        credentials: saved.credentials.clone(),
        custom_providers,
        built_in_model_overrides: saved.built_in_model_overrides.clone(),
        managed: saved.managed.clone(),
        deepseek_default_closed: saved.deepseek_default_closed,
    })
}

fn update_built_in_models(
    saved: &Saved, id: &str, models: Vec<CustomModel>, expected_revision: u64,
) -> Result<Saved, String> {
    if saved.revision != expected_revision {
        return Err("Provider settings changed in another window; reload and retry".into());
    }
    if definition(id).is_err() {
        return Err("Unknown provider".into());
    }
    let mut ids = BTreeSet::new();
    let models = models
        .into_iter()
        .map(|mut model| {
            model.label = model.label.trim().to_string();
            model.api_id = model.api_id.trim().to_string();
            if model.label.is_empty() || model.api_id.is_empty() {
                return Err("Model label and API ID cannot be empty".to_string());
            }
            if !ids.insert(model.api_id.clone()) {
                return Err("Model IDs must be unique".to_string());
            }
            if model.context_window == Some(0) {
                return Err("Model context window must be greater than zero".to_string());
            }
            normalize_reasoning(&mut model)?;
            Ok(model)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut overrides = saved.built_in_model_overrides.clone();
    overrides.insert(id.to_string(), models);
    Ok(Saved {
        revision: saved.revision.checked_add(1).ok_or("Provider revision exhausted")?,
        credentials: saved.credentials.clone(),
        custom_providers: saved.custom_providers.clone(),
        built_in_model_overrides: overrides,
        managed: saved.managed.clone(),
        deepseek_default_closed: saved.deepseek_default_closed,
    })
}

fn classify_response_failure(status: u16, body: &str, secret: &str) -> TestResult {
    let code = match status {
        401 | 403 => "unauthorized",
        404 => "not_found",
        429 => "rate_limited",
        400..=499 => "request_rejected",
        _ => "server_error",
    };
    let parsed = serde_json::from_str::<Value>(body).ok();
    let detail = parsed
        .as_ref()
        .and_then(|value| {
            value.pointer("/error/message").or_else(|| value.get("message")).or_else(|| value.get("detail"))
        })
        .and_then(Value::as_str)
        .unwrap_or("The provider rejected the connection test");
    let mut message = detail.replace(secret, "[redacted]");
    message.truncate(message.floor_char_boundary(300));
    TestResult { ok: false, code, message, status: Some(status), latency_ms: None }
}

fn classify_success_response(status: u16, body: &str, latency_ms: u128) -> TestResult {
    let valid = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value.get("object").and_then(Value::as_str).map(str::to_string))
        .is_some_and(|object| object == "response");
    if !valid {
        return TestResult {
            ok: false,
            code: "invalid_response",
            message: "The endpoint returned success without a Responses API object".into(),
            status: Some(status),
            latency_ms: Some(latency_ms),
        };
    }
    TestResult {
        ok: true,
        code: "ok",
        message: "Connection succeeded".into(),
        status: Some(status),
        latency_ms: Some(latency_ms),
    }
}
fn persist(path: &std::path::Path, saved: &Saved) -> Result<(), String> {
    let directory = path.parent().ok_or("Provider path has no directory")?;
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    // NamedTempFile is private (0600 on Unix); replacement never exposes a partially written key.
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(saved).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.error.to_string())?;
    // The window is a top-level Codex key, independent of gateway registration. Sync it as soon
    // as settings are saved; a failure here must not roll back the settings that were just written.
    if let Err(error) = sync_managed_config(saved) {
        log::warn!("Config: could not sync config.toml: {error}");
    }
    // Keep the launch catalog in step with what was just saved: the engine reads it at boot, so a
    // provider added or edited now has to be in the file before the next launch.
    let _ = merged_catalog_path(directory);
    Ok(())
}
#[tauri3_specta::command]
pub async fn providers_read(state: State<'_, Providers>) -> Result<Snapshot, String> {
    Ok(state.inner.lock().await.snapshot())
}
#[tauri3_specta::command]
pub async fn providers_save(
    app: AppHandle, state: State<'_, Providers>, provider_id: String, input: Option<Input>, expected_revision: u64,
) -> Result<Snapshot, String> {
    let runtime = app.state::<crate::runtime::RuntimeState>();
    // Persist first, then apply if this moment is safe. Waiting for another session's admission
    // held the settings save command forever (the spinner never stopped); the catalog is
    // independent of that admission and can be persisted immediately. When the runtime is busy,
    // schedule the same reconciliation that a pending provider change already uses.
    let admission = try_apply_admission(&runtime.admission);
    {
        let mut inner = state.inner.lock().await;
        let next = update(&inner.saved, provider_id, input, expected_revision)?;
        persist(&state.path, &next)?;
        inner.saved = next;
        inner.error = None;
    }
    if admission.is_ok() {
        if let Ok(client) = runtime.current() {
            let _ = apply_locked(&app, &client).await;
        }
    } else {
        schedule_apply(&app);
    }
    let snapshot = state.inner.lock().await.snapshot();
    let _ = snapshot.emit(&app);
    Ok(snapshot)
}
#[tauri3_specta::command]
pub async fn providers_save_custom(
    app: AppHandle, state: State<'_, Providers>, input: CustomInput, expected_revision: u64,
) -> Result<Snapshot, String> {
    let runtime = app.state::<crate::runtime::RuntimeState>();
    let admission = try_apply_admission(&runtime.admission);
    {
        let mut inner = state.inner.lock().await;
        let next = update_custom(&inner.saved, input, expected_revision)?;
        persist(&state.path, &next)?;
        inner.saved = next;
        inner.error = None;
    }
    if admission.is_ok() {
        if let Ok(client) = runtime.current() {
            let _ = apply_locked(&app, &client).await;
        }
    } else {
        schedule_apply(&app);
    }
    let snapshot = state.inner.lock().await.snapshot();
    let _ = snapshot.emit(&app);
    Ok(snapshot)
}
#[tauri3_specta::command]
pub async fn providers_remove_custom(
    app: AppHandle, state: State<'_, Providers>, provider_id: String, expected_revision: u64,
) -> Result<Snapshot, String> {
    let runtime = app.state::<crate::runtime::RuntimeState>();
    let admission = try_apply_admission(&runtime.admission);
    {
        let mut inner = state.inner.lock().await;
        let next = remove_custom(&inner.saved, &provider_id, expected_revision)?;
        persist(&state.path, &next)?;
        inner.saved = next;
        inner.error = None;
    }
    if admission.is_ok() {
        if let Ok(client) = runtime.current() {
            let _ = apply_locked(&app, &client).await;
        }
    } else {
        schedule_apply(&app);
    }
    let snapshot = state.inner.lock().await.snapshot();
    let _ = snapshot.emit(&app);
    Ok(snapshot)
}

#[tauri3_specta::command]
pub async fn providers_save_built_in_models(
    app: AppHandle, state: State<'_, Providers>, provider_id: String, models: Vec<CustomModel>, expected_revision: u64,
) -> Result<Snapshot, String> {
    let runtime = app.state::<crate::runtime::RuntimeState>();
    let admission = try_apply_admission(&runtime.admission);
    {
        let mut inner = state.inner.lock().await;
        let next = update_built_in_models(&inner.saved, &provider_id, models, expected_revision)?;
        persist(&state.path, &next)?;
        inner.saved = next;
        inner.error = None;
    }
    if admission.is_ok() {
        if let Ok(client) = runtime.current() {
            let _ = apply_locked(&app, &client).await;
        }
    } else {
        schedule_apply(&app);
    }
    let snapshot = state.inner.lock().await.snapshot();
    let _ = snapshot.emit(&app);
    Ok(snapshot)
}

#[tauri3_specta::command]
pub async fn providers_test(state: State<'_, Providers>, provider_id: String) -> Result<TestResult, String> {
    let config = {
        let inner = state.inner.lock().await;
        test_config(&inner.saved, &provider_id)?
    };
    Ok(test_connection(config).await)
}

/// Times one round trip against a single model of a saved provider.
///
/// This is the per-model "测速" in settings: it tells whether that model id answers at this
/// endpoint at all, and how long it takes, which a provider-level check cannot say.
#[tauri3_specta::command]
pub async fn providers_test_model(
    state: State<'_, Providers>, provider_id: String, model: String,
) -> Result<TestResult, String> {
    let config = {
        let inner = state.inner.lock().await;
        let mut config = test_config(&inner.saved, &provider_id)?;
        config.model = model;
        config
    };
    Ok(test_connection(config).await)
}
/// Read an OpenAI-compatible `/models` catalog without exposing the API key to the webview snapshot.
#[tauri3_specta::command]
pub async fn providers_discover_models(
    state: State<'_, Providers>, input: DiscoverInput,
) -> Result<Vec<CustomModel>, String> {
    let base_url = normalize_base_url(&input.base_url)?;
    let api_key = {
        let inner = state.inner.lock().await;
        discovery_api_key(&inner.saved, input.provider_id.as_deref(), input.api_key.as_deref())?
    };
    discover_models(&base_url, &api_key).await
}
#[tauri3_specta::command]
pub async fn providers_apply(app: AppHandle) -> Result<Snapshot, String> {
    let runtime = app.state::<crate::runtime::RuntimeState>();
    // Draft preparation can use the applied catalog while another admission is pending.
    // The admission owner schedules reconciliation when it releases the lock.
    let _admission = try_apply_admission(&runtime.admission)?;
    let client = runtime.current()?;
    apply_locked(&app, &client).await?;
    Ok(app.state::<Providers>().inner.lock().await.snapshot())
}
fn try_apply_admission(admission: &tokio::sync::Mutex<()>) -> Result<tokio::sync::MutexGuard<'_, ()>, String> {
    admission.try_lock().map_err(|_| PROVIDERS_PENDING.to_owned())
}

pub fn schedule_apply(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let runtime = app.state::<crate::runtime::RuntimeState>();
        // The last idle notification may arrive while another admission still owns
        // the lock. Queue the retry so a saved revision cannot remain pending forever.
        // A stuck session must not wedge the whole provider catalog: keep retrying on a
        // timer until the adapter accepts the change or the attempts run out.
        for _ in 0..20 {
            let _admission = runtime.admission.lock().await;
            if let Ok(client) = runtime.current() {
                let _ = apply_locked(&app, &client).await;
                {
                    let state = app.state::<Providers>();
                    let inner = state.inner.lock().await;
                    if inner.applied_revision == Some(inner.saved.revision) {
                        break;
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });
}
/// The providers the runtime should be running right now. A provider the user closed keeps its
/// credential on disk but is not applied: that is what "关闭不删 KEY" has to mean for the engine,
/// otherwise the models would stay reachable through a saved key.
fn desired_providers(saved: &Saved) -> BTreeMap<String, AppliedProvider> {
    saved
        .credentials
        .iter()
        .filter(|(_, key)| !key.disabled)
        .map(|(id, key)| {
            (id.clone(), AppliedProvider::BuiltIn(key.clone(), saved.built_in_model_overrides.get(id).cloned()))
        })
        .chain(
            saved.custom_providers.iter().map(|(id, provider)| (id.clone(), AppliedProvider::Custom(provider.clone()))),
        )
        .collect()
}

pub async fn apply_locked(app: &AppHandle, client: &Arc<RuntimeClient>) -> Result<(), String> {
    let state = app.state::<Providers>();
    let mut inner = state.inner.lock().await;
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let outcome = reconcile(&mut inner, client, &resource_dir, &state.catalog_dir).await;
    // Startup and provider changes both land here; re-sync even if reconcile took its fast path or
    // failed, since another client may have rewritten config.toml in the meantime.
    if let Err(error) = sync_managed_config(&inner.saved) {
        log::warn!("Config: could not sync config.toml: {error}");
    }
    let _ = inner.snapshot().emit(app);
    outcome
}

async fn reconcile(
    inner: &mut Inner, client: &RuntimeClient, resource_dir: &std::path::Path, catalog_dir: &Path,
) -> Result<(), String> {
    reconcile_target(inner, client, resource_dir, catalog_dir, "codex").await
}

async fn reconcile_target(
    inner: &mut Inner, client: &RuntimeClient, resource_dir: &std::path::Path, catalog_dir: &Path, agent_id: &str,
) -> Result<(), String> {
    if inner.applied_revision == Some(inner.saved.revision) {
        return Ok(());
    }
    // The adapter owns session routing and rejects only changes affecting busy sessions.
    // A global Runtime idle check would also block unrelated provider additions.
    let mut pending = false;
    let mut failures = Vec::new();
    let desired = desired_providers(&inner.saved);
    // A revision without catalog changes does not need an idle boundary.
    if inner.applied == desired {
        inner.applied_revision = Some(inner.saved.revision);
        inner.error = None;
        return Ok(());
    }
    let mut provider_blocks: Vec<String> = Vec::new();
    let outcome: Result<(), String> = async {
        for (id, selected) in &desired {
            // Order-only model changes are a picker preference: keep the applied order in sync
            // without asking the adapter to swap the catalog (which fails with -32603).
            let already = inner
                .applied
                .get(id)
                .is_some_and(|applied| same_applied(applied, selected));
            let runtime_id = runtime_provider_id(id);
            let (name, base_url, bearer_token, models, mut config, bundled_catalog) = match selected {
                AppliedProvider::BuiltIn(key, overrides) => {
                    let provider = definition(id)?;
                    let default_url = match key.region.as_deref() {
                        Some(region) => provider["regions"].as_array().and_then(|regions| regions.iter().find(|r| r["id"] == region)).map(|r| r["baseUrl"].clone()).ok_or("Unknown provider region")?,
                        None => provider["baseUrl"].clone(),
                    };
                    let mut models = provider["models"].clone();
                    let mut config = provider.get("config").cloned().unwrap_or(json!({}));
                    let mut bundled_catalog = provider["catalog"].as_str().map(str::to_string);
                    if let Some(overridden) = overrides.as_deref() {
                        let catalog = write_built_in_catalog(catalog_dir, id, overridden, resource_dir)?;
                        config["model_catalog_json"] = json!(catalog);
                        // Same stable order as the catalog: the saved order drives the UI only.
                        let mut enabled: Vec<&CustomModel> = overridden.iter().filter(|model| model.is_enabled()).collect();
                        enabled.sort_by(|a, b| a.api_id.cmp(&b.api_id));
                        models = json!(enabled.iter().map(|model| json!({
                            "id": model.api_id,
                            "label": model.label,
                            "description": model.description,
                            "contextWindow": model.context_window,
                        })).collect::<Vec<_>>());
                        bundled_catalog = None;
                    }
                    (provider["name"].clone(), key.base_url.clone().map(Value::String).unwrap_or(default_url), key.api_key.clone(), models, config, bundled_catalog)
                }
                AppliedProvider::Custom(provider) => {
                    // The per-thread catalog lets Codex resolve the model instead of falling back to
                    // tiny metadata, and exposes each model's real reasoning levels to the picker.
                    // It carries no compaction threshold: the engine's own 95% default is what the
                    // user asked for, and a per-model override here only ever reached the picker —
                    // see `merged_catalog_path` for the channel that actually binds.
                    let catalog = write_custom_catalog(catalog_dir, provider)?;
                    (
                        Value::String(provider.name.clone()),
                        Value::String(provider.base_url.clone()),
                        provider.api_key.clone(),
                        Value::Array({
                            let mut enabled: Vec<&CustomModel> = provider.models.iter().filter(|model| model.is_enabled()).collect();
                            enabled.sort_by(|a, b| a.api_id.cmp(&b.api_id));
                            enabled.iter().map(|model| json!({
                                "id": model.api_id,
                                "label": model.label,
                                "description": model.description,
                                "contextWindow": model.context_window,
                            })).collect()
                        }),
                        json!({"model_catalog_json": catalog}),
                        None,
                    )
                }
            };
            if let Some(catalog) = bundled_catalog {
                config["model_catalog_json"] = json!(write_bundled_catalog(
                    catalog_dir,
                    &runtime_id,
                    &resource_dir.join(catalog)
                )?);
            }
            // Gateways flagged `apiType: "chat"` in the catalog (aipro.love) reject reasoning
            // history items that carry plain-text content, which Codex replays for threads
            // written by OpenAI-family models. Route them through the local sanitizing proxy,
            // which strips that field and forwards everything else untouched.
            let is_sanitized = definition(id).ok().is_some_and(|d| d["apiType"].as_str() == Some("chat"));
            let upstream_base = base_url.as_str().unwrap_or_default().to_string();
            let upstream_token = bearer_token.clone();
            // Threads written before the router existed are bound to their own provider and are
            // still resumed through it, so keep that route alive next to the shared one.
            let base_url = crate::bridge::router_base_url().unwrap_or_else(|| upstream_base.clone());
            if !already {
                let result = client.acp_request(agent_id, "providers/set", json!({"providerId":"openai", "apiType":"openai", "baseUrl":base_url,
                    "_meta":{"codex":{"id":runtime_id,"runtimeId":crate::bridge::ROUTER_ID,"name":name,"mode":"catalog","bearerToken":bearer_token,"config":config}, "alwith":{"models":models}}}), None, None)
                    .await;
                if let Err(error) = result {
                    record_application_error(id, "apply", &error, &mut pending, &mut failures);
                    continue;
                }
                inner.applied.insert(id.clone(), selected.clone());
            } else {
                // Normalise the stored order so the next reconciliation can take the fast path.
                inner.applied.insert(id.clone(), selected.clone());
            }
            // Register the live route only after the adapter accepted the catalog. Registering
            // first used to leave the bridge forwarding to credentials the engine never applied
            // whenever the adapter rejected the request because sessions were busy.
            if is_sanitized {
                crate::bridge::register_route(&runtime_id, &upstream_base);
            }
            // Every gateway is reachable through the one shared provider; the bridge decides where
            // a turn actually goes from the `<gateway>/<model>` name Codex sends.
            let protocol = match selected {
                AppliedProvider::BuiltIn(key, _) if id == "openrouter" => key.protocol,
                _ => Protocol::Responses,
            };
            crate::bridge::register_protocol_route(&runtime_id, &upstream_base, &upstream_token, is_sanitized, protocol);
            // codex resolves a thread's provider from config.toml when resuming, so a runtime
            // registration alone leaves it "not found". Record a managed block as well.
            // codex 0.164 dropped wire_api = "chat"; the config block only exists so
            // thread/resume can resolve the provider name — actual traffic still goes through the
            // adapter's runtime registration.
            let wire_api = "responses";
            provider_blocks.push(format!(
                "{MANAGED_MARKER}\n[model_providers.{runtime_id}]\nname = \"{}\"\nbase_url = \"{}\"\nwire_api = \"{wire_api}\"\nexperimental_bearer_token = \"{}\"",
                escape_toml(name.as_str().unwrap_or_default()),
                escape_toml(&upstream_base),
                escape_toml(&bearer_token)
            ));
        }
        // The shared provider Codex actually runs on. Its token is a placeholder: the bridge
        // replaces the Authorization header with the token of the vendor the model belongs to.
        // This block must be written unconditionally: `write_provider_config` deletes every
        // `[model_providers.*]` section it owns before re-adding `blocks`, so skipping it here
        // (e.g. when the bridge has not bound its port yet) leaves config.toml without `alwith`
        // and every `thread/resume` fails with "Model provider `alwith` not found".
        let router_base = crate::bridge::router_base_url().unwrap_or_else(router_fallback_base);
        provider_blocks.push(router_provider_block(&router_base));
        let removed: Vec<_> = inner.applied.keys().filter(|id| !desired.contains_key(*id)).cloned().collect();
        for id in removed {
            let result = client.acp_request(agent_id, "providers/disable", json!({"providerId":"openai","_meta":{"codex":{"id":runtime_provider_id(&id)}}}), None, None)
                .await;
            if let Err(error) = result {
                record_application_error(&id, "remove", &error, &mut pending, &mut failures);
                continue;
            }
            inner.applied.remove(&id);
        }
        Ok(())
    }.await;
    inner.error = outcome.err().or_else(|| (!failures.is_empty()).then(|| failures.join("; ")));
    if inner.error.is_none()
        && !pending
        && let Err(error) = write_provider_config(&provider_blocks)
    {
        inner.error = Some(error);
    }
    if inner.error.is_none() && !pending {
        inner.applied_revision = Some(inner.saved.revision);
    }
    log::info!(
        "Provider catalog: agent={agent_id} saved_revision={} applied_revision={:?} status={} pending_affected_sessions={pending}",
        inner.saved.revision,
        inner.applied_revision,
        inner.snapshot().status
    );
    if let Some(error) = &inner.error {
        Err(error.clone())
    } else if pending {
        Err(PROVIDERS_PENDING.into())
    } else {
        Ok(())
    }
}

const PROVIDERS_PENDING: &str = "Provider settings are pending; waiting for affected sessions to finish";

/// Marker that owns the `[model_providers.*]` blocks ALWith writes into config.toml.
const MANAGED_MARKER: &str = "# managed by ALWith";
/// Marks the single top-level window key ALWith owns in `~/.codex/config.toml`. Every rewrite
/// drops the previous line, so clearing all model windows also removes Codex's override.
const CONTEXT_WINDOW_MARKER: &str = "# managed by ALWith: context window";
/// Codex clamps the window to the account's own ceiling, but a malformed settings value should
/// never reach a global config key in the first place.
const MIN_CONTEXT_WINDOW: u64 = 32_000;
const MAX_CONTEXT_WINDOW: u64 = 2_000_000;
/// Placeholder credential for the shared provider; the bridge substitutes the real one per turn.
///
/// `codex_launcher.rs#DEFAULT_ROUTER_TOKEN` repeats this literal because the launcher is compiled
/// on its own with plain `rustc` and cannot import it; both sides are pinned by tests, and the
/// authoritative value reaches the launcher as `ALWITH_U_ROUTER_TOKEN`.
pub(crate) const ROUTER_TOKEN: &str = "alwith-router";

/// Used only while the bridge has not bound a port yet. It is never the final value: the next
/// managed-config sync rewrites `base_url` with the live port. A syntactically valid placeholder
/// still lets `thread/resume` resolve the provider, instead of failing before any turn starts.
fn router_fallback_base() -> String {
    format!("http://127.0.0.1:1/{}", crate::bridge::ROUTER_ID)
}

/// The block the shared router runs on.
///
/// No retries: a capacity dip makes the engine sleep the upstream's `retry-after` and try again,
/// four times at roughly five minutes each, while the reader watches a turn that is going nowhere.
/// The answer to "the model is at capacity" is "switch models", and that is the user's call — not a
/// retry loop that can hold the single shared agent for half an hour.
fn router_provider_block(router_base: &str) -> String {
    format!(
        "{MANAGED_MARKER}\n[model_providers.{}]\nname = \"ALWith Router\"\nbase_url = \"{}\"\nwire_api = \"responses\"\nrequest_max_retries = 0\nstream_max_retries = 0\nexperimental_bearer_token = \"{ROUTER_TOKEN}\"",
        crate::bridge::ROUTER_ID,
        escape_toml(router_base)
    )
}

fn codex_home_dir() -> std::path::PathBuf {
    if let Ok(home) = std::env::var("CODEX_HOME")
        && !home.trim().is_empty()
    {
        return home.into();
    }
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".codex")
}

fn escape_toml(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Mirrors the applied gateways into codex's config so `thread/resume` can name them.
///
/// Only blocks between the managed marker and the next section are replaced; everything else in
/// the user's config is preserved verbatim. The first rewrite leaves a `.bak-alwith` copy.
///
/// The router block is composed in the *same* render, not left to the next managed sync: this
/// function strips the managed region (which contains `[model_providers.alwith]`) and used to
/// depend on a later `sync_managed_config` to put it back. Any failure between the two writes left
/// `model_provider = "alwith"` without its table, and Codex then exits 1 on the next launch —
/// before ACP can answer, so the repair that would have fixed it could never run again.
fn write_provider_config(blocks: &[String]) -> Result<(), String> {
    // `reconcile_test` drives the real reconcile with a fake client. Those tests must never write
    // the operator's REAL config.toml: the test process has no bridge port, so it produced a
    // config without `[model_providers.alwith]` and every live conversation then failed to resume
    // (2026-11-06). The block renderer below is tested as a pure string function instead.
    if cfg!(test) {
        return Ok(());
    }
    let home = codex_home_dir();
    let path = home.join("config.toml");
    let contents = std::fs::read_to_string(&path).unwrap_or_default();
    let backup = path.with_extension("toml.bak-alwith");
    if !backup.exists() && path.exists() {
        std::fs::copy(&path, &backup).map_err(|error| error.to_string())?;
    }
    let out = render_managed_config(&contents, blocks, crate::bridge::router_base_url());
    write_config_file(&path, &out)
}

/// Materialises `config.toml` from the user's contents plus the blocks ALWith owns.
fn render_managed_config(contents: &str, blocks: &[String], router_base: Option<String>) -> String {
    let mut kept: Vec<String> = Vec::new();
    let mut skipping = false;
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed == MANAGED_MARKER {
            skipping = true;
            continue;
        }
        if skipping {
            if trimmed.starts_with('[') && !trimmed.starts_with("[model_providers.") {
                skipping = false;
            } else {
                continue;
            }
        }
        kept.push(line.to_string());
    }
    while kept.last().is_some_and(|line| line.trim().is_empty()) {
        kept.pop();
    }
    // Codex fixes a provider per thread: a chat created on one provider can never be moved to
    // another, and the first model switch in it fails with "Provider selection and rollback
    // failed; session closed". A `model_provider` left behind by an older build or another client
    // (this machine had `hakimi`) pins every new chat to that vendor, so switching from a GPT
    // model to any gateway and back is impossible. Own the key while the shared router exists:
    // every thread starts on the router, which forwards native models to ChatGPT itself.
    if blocks.iter().any(|block| block.contains(&format!("[model_providers.{}]", crate::bridge::ROUTER_ID))) {
        let mut seen_section = false;
        kept.retain(|line| {
            let trimmed = line.trim_start();
            if trimmed.starts_with('[') {
                seen_section = true;
                return true;
            }
            seen_section || !trimmed.starts_with("model_provider")
        });
        let at = kept.iter().position(|line| line.trim_start().starts_with('[')).unwrap_or(kept.len());
        kept.insert(at, format!("model_provider = \"{}\"", crate::bridge::ROUTER_ID));
    }
    if !blocks.is_empty() {
        kept.push(String::new());
        for block in blocks {
            kept.extend(block.lines().map(str::to_string));
        }
    }
    let mut out = kept.join("\n");
    out.push('\n');
    // The invariant every launch depends on: a `model_provider = "alwith"` line must never exist
    // without the table it names.
    render_router_provider_config(&out, router_base)
}

/// Collapses the blank-line runs the managed renderers leave behind.
///
/// Three passes edit this file (context window, reasoning effort, router provider), and each one
/// removes or moves a line without cleaning up the gap it leaves. On 2026-11-07 a real config had
/// grown fourteen blank lines right after `model_context_window`, one per launch: the file kept
/// "changing" so every start rewrote it, and the key it was drifting away from is the one the
/// router needs at the top. Normalising at the single write point makes any composition of those
/// passes converge instead of accumulating.
fn normalize_config(contents: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    for line in contents.lines() {
        if line.trim().is_empty() {
            if kept.is_empty() || kept.last().is_some_and(|previous| previous.trim().is_empty()) {
                continue;
            }
            kept.push("");
        } else {
            kept.push(line);
        }
    }
    while kept.last().is_some_and(|line| line.trim().is_empty()) {
        kept.pop();
    }
    let mut out = kept.join("\n");
    out.push('\n');
    out
}

/// Replaces `config.toml` atomically: a crash mid-write must not leave a truncated file that
/// Codex refuses to parse (which is indistinguishable from "the provider is missing").
fn write_config_file(path: &std::path::Path, contents: &str) -> Result<(), String> {
    let contents = normalize_config(contents);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if std::fs::read_to_string(path).is_ok_and(|current| current == contents) {
        return Ok(());
    }
    let temporary = path.with_extension("toml.alwith-tmp");
    std::fs::write(&temporary, &contents).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        error.to_string()
    })
}

/// Codex has one global `model_context_window` knob, not a per-model one. The settings page still
/// stores a window per model, so take the largest configured value: a 1M-token model must not be
/// squeezed by a smaller sibling. Codex then clamps it to
/// `max_context_window × effective_context_window_percent` (measured on this machine:
/// 872000 × 0.95 = 828400), so a value above the account's real ceiling cannot produce
/// `context_window_exceeded`.
///
/// This is the missing link in the old path. `context_window` in `model_catalog_json` only reaches
/// providers that own a credential; ChatGPT-native sessions have none, and Codex resolved their
/// window from its own `models_cache.json` (272000 × 0.95 = 258400) no matter what the settings
/// page said. A top-level config key is the only channel covering every session.
fn configured_context_window(saved: &Saved) -> Option<u64> {
    saved
        .built_in_model_overrides
        .values()
        .map(|models| models.as_slice())
        .chain(saved.custom_providers.values().map(|provider| provider.models.as_slice()))
        .flatten()
        .filter(|model| model.is_enabled())
        .filter_map(|model| model.context_window)
        .filter(|window| (MIN_CONTEXT_WINDOW..=MAX_CONTEXT_WINDOW).contains(window))
        .max()
}

/// Pure renderer, so a rewrite can be tested without touching the user's `CODEX_HOME`.
fn render_context_window_config(contents: &str, desired: Option<u64>) -> String {
    let mut kept: Vec<String> =
        contents.lines().filter(|line| !line.contains(CONTEXT_WINDOW_MARKER)).map(str::to_string).collect();
    if let Some(window) = desired {
        // Put it at the very top. `write_provider_config` drops everything from its own
        // `# managed by ALWith` marker to the next table, so a key inserted just above a
        // `[model_providers.*]` header would be erased by the next provider reconcile.
        kept.insert(0, format!("model_context_window = {window} {CONTEXT_WINDOW_MARKER}"));
    }
    while kept.last().is_some_and(|line| line.trim().is_empty()) {
        kept.pop();
    }
    let mut out = kept.join("\n");
    out.push('\n');
    out
}

/// Effort values any Codex model or the upstream accepts. The shared `config.toml` is also written
/// by the ChatGPT desktop app and by hand, and a typo there (`model_reasoning_effort = "meduim"`)
/// is sent verbatim on every native turn: the backend answers 400 `invalid_value` and Codex reports
/// a dead conversation with no hint that the local config is at fault. Only values outside this set
/// are removed; a legitimate choice (including a model's own extended ladder) is left alone.
const REASONING_EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"];

/// Pure renderer: drop just the top-level `model_reasoning_effort` line when its value is illegal.
/// Removing (rather than substituting) lets Codex fall back to the selected model's own default,
/// which the client then pins explicitly, instead of silently overriding the user's intent.
fn render_reasoning_effort_config(contents: &str) -> String {
    let mut kept: Vec<String> = contents
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            let Some(rest) = trimmed.strip_prefix("model_reasoning_effort") else {
                return true;
            };
            let Some(value) = rest.trim_start().strip_prefix('=') else {
                return true;
            };
            let value = value.split('#').next().unwrap_or("").trim().trim_matches(|c| c == '"' || c == '\'');
            REASONING_EFFORTS.contains(&value)
        })
        .map(str::to_string)
        .collect();
    while kept.last().is_some_and(|line| line.trim().is_empty()) {
        kept.pop();
    }
    let mut out = kept.join("\n");
    out.push('\n');
    out
}

/// Repairs the one provider section every conversation depends on.
///
/// The engine is launched with `-c model_provider="alwith"`. If `~/.codex/config.toml` lacks
/// `[model_providers.alwith]`, Codex refuses to load the configuration — so *every* thread, old
/// or new, fails with "Model provider `alwith` not found" (surfaced by the adapter as "this
/// chat's provider is no longer configured"). A *partial* table is equally fatal: another Codex
/// client can trim it to `name` + `base_url`, and Codex then exits at boot before ACP answers.
/// `write_provider_config` is one-shot: `reconcile` returns early on its fast path, and an external
/// Codex client can rewrite the shared file at any time. So this runs on every managed sync and
/// completes the block in place — both its presence and every key the router needs — including
/// the loopback port, which changes on each app launch. Values already in the file are kept.
fn render_router_provider_config(contents: &str, router_base: Option<String>) -> String {
    let router_section = format!("[model_providers.{}]", crate::bridge::ROUTER_ID);
    let has_router = contents.lines().any(|line| line.trim() == router_section);
    let mut kept: Vec<String> = Vec::new();
    let mut in_router = false;
    // Keys already present in the router table. Another Codex client (or an older ALWith build)
    // can leave a *partial* `[model_providers.alwith]` behind — header + name, missing `wire_api`
    // or the token. Codex reads that table at boot; a half-written one exits 1 with the very same
    // "Model provider `alwith` not found" as a missing one, so "the section exists" is not enough.
    // Complete it in place, keeping any value the file already had (notably the bearer token).
    let mut router_keys: BTreeSet<String> = BTreeSet::new();
    // Index in `kept` just past the last key line of the router table, where missing keys are
    // inserted. Trailing blank lines and the *next* block's marker must stay after our keys.
    let mut router_end: Option<usize> = None;
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_router = trimmed == router_section;
        }
        // We own the top-level `model_provider` key while the router exists: a stale vendor value
        // pins new threads to that vendor, and a missing one makes the router unresolvable. Every
        // occurrence is dropped here — not only the ones above the first table — and a single
        // canonical line is re-inserted below. This is what lets the startup self-heal
        // (`repair_router_provider`) recover a file that accumulated duplicate `model_provider`
        // lines *after* a `[projects.*]` (or any other) table, which is invalid TOML Codex refuses
        // to parse ("Model provider `alwith` not found", error pointing at the first duplicate key).
        if trimmed.starts_with("model_provider") {
            continue;
        }
        let is_key = !trimmed.starts_with('#') && trimmed.split_once('=').is_some();
        if in_router {
            if is_key && let Some((key, _)) = trimmed.split_once('=') {
                router_keys.insert(key.trim().to_string());
            }
            if trimmed.starts_with("base_url")
                && let Some(base) = router_base.as_deref()
            {
                kept.push(format!("base_url = \"{}\"", escape_toml(base)));
                router_end = Some(kept.len());
                continue;
            }
        }
        kept.push(line.to_string());
        if in_router && (trimmed == router_section || is_key) {
            router_end = Some(kept.len());
        }
    }
    // The key must be BOTH top-level (before the first table header) AND outside the managed
    // region (before the first `# managed by ALWith` marker), because `render_managed_config`
    // skips everything from that marker up to the next non-`[model_providers.*]` table.
    //
    // The old anchor picked the marker with `.or_else(table)`. On the other Mac the marker sits
    // at the *end* of the file (it prefixes the provider blocks), so the key landed inside
    // `[projects."…"]` — no top-level provider at all, and repeated keys there made Codex refuse
    // to parse the file as "Model provider `alwith` not found". Conversely, using only the table
    // header puts the key *after* an early marker, where the next provider reconcile erases it.
    // Take whichever boundary comes first. `render_context_window_config` prepends its own key at
    // index 0, so both owned keys stay in the top-level preamble.
    let marker_at = kept.iter().position(|line| line.trim() == MANAGED_MARKER);
    let table_at = kept.iter().position(|line| line.trim_start().starts_with('['));
    let at = match (marker_at, table_at) {
        (Some(marker), Some(table)) => marker.min(table),
        (Some(marker), None) => marker,
        (None, Some(table)) => table,
        (None, None) => kept.len(),
    };
    // The `model_provider` insert below shifts everything at or after `at` by one line.
    let mut router_end_at = router_end.unwrap_or(kept.len());
    if at <= router_end_at {
        router_end_at += 1;
    }
    kept.insert(at, format!("model_provider = \"{}\"", crate::bridge::ROUTER_ID));
    if has_router {
        // A table that exists but is short of a required key is just as fatal as a missing table.
        // Fill only what is absent: never overwrite a value another client wrote (especially the
        // bearer token, which the bridge may still be expecting from a previous build).
        let base = router_base.clone().unwrap_or_else(router_fallback_base);
        let missing: Vec<String> = router_provider_block(&base)
            .lines()
            .skip(2) // marker + table header
            .filter(|line| {
                let key = line.split_once('=').map(|(key, _)| key.trim()).unwrap_or("");
                !key.is_empty() && !router_keys.contains(key)
            })
            .map(str::to_string)
            .collect();
        if !missing.is_empty() {
            let position = router_end_at.min(kept.len());
            kept.splice(position..position, missing);
        }
    } else {
        let base = router_base.unwrap_or_else(router_fallback_base);
        kept.push(String::new());
        kept.extend(router_provider_block(&base).lines().map(str::to_string));
    }
    while kept.last().is_some_and(|line| line.trim().is_empty()) {
        kept.pop();
    }
    let mut out = kept.join("\n");
    out.push('\n');
    out
}

/// Keep the managed top-level keys in sync with the saved model settings. This runs on every save
/// and on every apply (including startup), even when `reconcile` takes its fast path: a native
/// ChatGPT session has no gateway registration, so a provider-only sync would never reach it.
/// Another Codex client may have rewritten the shared file in between, so the repair is repeated
/// rather than done once at first run.
fn sync_managed_config(saved: &Saved) -> Result<(), String> {
    // `persist()` calls this on every write, and the unit tests build throwaway `Saved` fixtures
    // through `persist()`. Without this guard a `cargo test` rewrites the operator's REAL
    // ~/.codex/config.toml with a fixture that has no bridge port — on 2026-11-06 that wiped the
    // shared `[model_providers.alwith]` block and made every conversation fail to resume. The
    // renderers are pure functions and are tested directly with strings instead.
    if cfg!(test) {
        return Ok(());
    }
    let path = codex_home_dir().join("config.toml");
    let contents = std::fs::read_to_string(&path).unwrap_or_default();
    let repaired = render_reasoning_effort_config(&contents);
    let windowed = render_context_window_config(&repaired, configured_context_window(saved));
    let out = render_router_provider_config(&windowed, crate::bridge::router_base_url());
    if normalize_config(&out) == normalize_config(&contents) {
        return Ok(());
    }
    if repaired != contents {
        log::warn!("Config: removed an invalid model_reasoning_effort from config.toml");
    }
    log::info!("Context window: config.toml model_context_window={:?}", configured_context_window(saved));
    write_config_file(&path, &out)
}

/// Restores the router provider before anything is allowed to read `config.toml`.
///
/// Codex parses the file when the agent starts. A `model_provider = "alwith"` line with no
/// `[model_providers.alwith]` table makes it exit 1 immediately ("Model provider `alwith` not
/// found"), which takes the ACP agent with it. Every other repair path runs through a live
/// engine — `apply_locked` is called from the first lifecycle request — so on a machine whose
/// file was left broken, the repair could never run again. This runs at launch (after the bridge
/// has bound its port) and again before an in-app engine restart, which is the only window in
/// which it can actually prevent the failure.
pub fn repair_router_provider() {
    // Unit tests build throwaway fixtures; they must never touch the operator's real file.
    if cfg!(test) {
        return;
    }
    let path = codex_home_dir().join("config.toml");
    let contents = std::fs::read_to_string(&path).unwrap_or_default();
    let out = render_router_provider_config(&contents, crate::bridge::router_base_url());
    if normalize_config(&out) == normalize_config(&contents) {
        return;
    }
    match write_config_file(&path, &out) {
        Ok(()) => log::info!("Config: restored the alwith provider block before engine start"),
        Err(error) => log::warn!("Config: could not repair config.toml before engine start: {error}"),
    }
    // The launcher now carries the router table on the command line, so a file we cannot write no
    // longer stops the engine. Say so explicitly: without this line the next failure would look
    // like a fresh mystery instead of "the file is still missing the table".
    let applied = std::fs::read_to_string(&path).unwrap_or_default();
    let table = format!("[model_providers.{}]", crate::bridge::ROUTER_ID);
    if !applied.lines().any(|line| line.trim() == table) {
        log::error!(
            "Config: {} still has no {table} after repair; the engine depends on the launcher's -c overrides",
            path.display()
        );
    }
}

pub(crate) fn application_pending(error: &str) -> bool {
    error == PROVIDERS_PENDING
}

fn record_application_error(
    id: &str, operation: &str, error: &ResponseError, pending: &mut bool, failures: &mut Vec<String>,
) {
    // Match the installed adapter's busy response exactly; other invalid requests are failures.
    let busy = error.code == -32600
        && error.message == "Invalid request: Wait for affected sessions to finish before changing their provider";
    log::warn!(
        "Provider catalog: provider={id} operation={operation} code={} waiting_for_sessions={busy} message={}",
        error.code,
        error.message
    );
    if busy {
        *pending = true;
    } else {
        failures.push(format!("Provider {id} could not {operation} ({}); retry to apply saved settings", error.code));
    }
}

/// Preserve saved IDs while encoding custom IDs without collisions for the adapter's [a-z0-9-]+ grammar.
/// Keep this mapping aligned with gatewayModelId in src/lib/providers.ts.
fn runtime_provider_id(id: &str) -> String {
    if id.starts_with("custom_") {
        format!("custom-{}", id.bytes().map(|byte| format!("{byte:02x}")).collect::<String>())
    } else {
        id.to_string()
    }
}

/// Codex requires a complete model description in `model_catalog_json`; the bundled Qwen entry
/// supplies the instruction template and tool shape, while each custom model supplies identity,
/// context, and its provider-specific reasoning levels.
fn catalog_template() -> &'static Value {
    static TEMPLATE: OnceLock<Value> = OnceLock::new();
    TEMPLATE.get_or_init(|| {
        let catalog: Value =
            serde_json::from_str(include_str!("../resources/qwen/models.json")).expect("bundled Qwen model catalog");
        catalog["models"][0].clone()
    })
}

/// A catalog entry Codex can actually parse, built from `entry` on top of the complete template.
///
/// Codex validates every entry against its full model schema, so an entry that only names the
/// model, its context and its reasoning levels is rejected — `missing field `shell_type`` — and the
/// whole config load fails, which surfaces as "Internal error: failed to load configuration" on the
/// next model switch. Kimi, GLM and MiniMax ship hand-written minimal catalogs, so every bundled
/// entry is laid over the template instead of trusting it to be complete; the bundled values still
/// win wherever they exist.
fn complete_catalog_entry(entry: Option<&Value>) -> Value {
    let mut merged = catalog_template().clone();
    if let (Some(target), Some(source)) = (merged.as_object_mut(), entry.and_then(Value::as_object)) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
        // Another model's compaction hash would make Codex summarize against the wrong model.
        target.remove("comp_hash");
    }
    merged
}

/// 引擎自己公布的一个 GPT 模型，只保留应用真正要用的字段。
///
/// 引擎目录是 GPT 模型的唯一真源：型号上下线、effort 档位、加速档位都随引擎发行版变化，
/// 应用不该维护第二份。以前靠 `inferred_reasoning_levels` 猜（GPT 一律 three levels），
/// 于是 6.2 上线后选择器里只有 `low/medium/high`，「快速模式」整行消失。
#[derive(Clone, Debug)]
struct EngineModel {
    slug: String,
    label: String,
    efforts: Vec<String>,
    default_effort: Option<String>,
    context_window: Option<u64>,
    speed_tiers: Vec<String>,
    service_tiers: Value,
    /// `multi_agent_reasoning_effort` as published by the engine.
    ///
    /// The engine's own model definition uses this pair to run a model's sub-agents at a different
    /// effort than the main turn (`gpt-6.2-sol` = `xhigh` + `v2`). Dropping it here made the merged
    /// catalog — the file the engine actually reads — fall back to `max`, so Ultra silently sent a
    /// different effort than the model was designed for.
    multi_agent_effort: Option<String>,
    /// `multi_agent_version` as published by the engine (`v2` enables the orchestrated path).
    multi_agent_version: Option<String>,
}

/// 引擎目录缓存的位置。`merged_catalog` 是同步函数，不能去跑子进程，只能读这份快照。
fn engine_catalog_path(directory: &Path) -> PathBuf {
    directory.join("model-catalogs").join("engine-catalog.json")
}

/// 读上一次落盘的引擎目录；缺失或不可解析时返回空表（调用方按「不知道」处理）。
fn engine_catalog(directory: &Path) -> Vec<EngineModel> {
    let Ok(bytes) = std::fs::read(engine_catalog_path(directory)) else { return Vec::new() };
    let Ok(parsed) = serde_json::from_slice::<Value>(&bytes) else { return Vec::new() };
    let Some(models) = parsed.get("models").and_then(Value::as_array) else { return Vec::new() };
    models.iter().filter_map(engine_model_from).collect()
}

fn engine_model_from(model: &Value) -> Option<EngineModel> {
    let slug = model.get("slug").and_then(Value::as_str)?.trim().to_string();
    if slug.is_empty() {
        return None;
    }
    let efforts = model
        .get("supported_reasoning_levels")
        .and_then(Value::as_array)
        .map(|levels| {
            levels
                .iter()
                .filter_map(|level| level.get("effort").and_then(Value::as_str).map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(EngineModel {
        label: engine_display_label(model.get("display_name").and_then(Value::as_str).unwrap_or(&slug)),
        slug,
        efforts,
        default_effort: model.get("default_reasoning_level").and_then(Value::as_str).map(str::to_string),
        context_window: model.get("context_window").and_then(Value::as_u64),
        speed_tiers: model
            .get("additional_speed_tiers")
            .and_then(Value::as_array)
            .map(|tiers| tiers.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default(),
        service_tiers: model.get("service_tiers").cloned().unwrap_or(Value::Null),
        multi_agent_effort: model.get("multi_agent_reasoning_effort").and_then(Value::as_str).map(str::to_string),
        multi_agent_version: model.get("multi_agent_version").and_then(Value::as_str).map(str::to_string),
    })
}

/// `GPT-6.2-Sol` → `6.2 Sol`，与设置里既有的短名风格（`6.1 Sol` / `6 Astra`）一致。
fn engine_display_label(published: &str) -> String {
    let stripped = published.trim().strip_prefix("GPT-").unwrap_or(published.trim());
    stripped.replace('-', " ").replace("  ", " ").trim().to_string()
}

/// 跑一次 `codex debug models --bundled`，把结果写进缓存。
///
/// 子进程放在线程里带超时：这是启动路径，一个卡住的引擎不能拖住整个应用。读的是内嵌表，
/// 不联网，实测毫秒级；超时值只是防线。
fn refresh_engine_catalog(directory: &Path) -> Vec<EngineModel> {
    let (sender, receiver) = std::sync::mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let output = std::process::Command::new(crate::runtime::bundled_codex_path())
            .args(["debug", "models", "--bundled"])
            .output();
        let _ =
            sender.send(output.ok().and_then(|result| {
                result.status.success().then(|| String::from_utf8_lossy(&result.stdout).to_string())
            }));
    });
    let Some(Some(raw)) = receiver.recv_timeout(Duration::from_secs(10)).ok() else {
        log::warn!("engine catalog: {} did not answer; keeping the previous snapshot", ENGINE_CATALOG_LABEL);
        return engine_catalog(directory);
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        log::warn!("engine catalog: unreadable output; keeping the previous snapshot");
        return engine_catalog(directory);
    };
    let path = engine_catalog_path(directory);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(bytes) = serde_json::to_vec(&parsed)
        && std::fs::read(&path).ok().as_deref() != Some(bytes.as_slice())
        && let Err(error) = std::fs::write(&path, &bytes)
    {
        log::warn!("engine catalog: could not write {}: {error}", path.display());
    }
    engine_catalog(directory)
}

const ENGINE_CATALOG_LABEL: &str = "codex debug models";

/// 引擎公布、且明确要出现在选择器里的 GPT 模型。
///
/// 两个条件都取自引擎自己的字段，不维护第二份名单：
///   * `visibility == "list"` —— `hide` 是内部用途（`codex-auto-review`、`gpt-daybreak-*`）；
///   * 没有 `upgrade` —— 引擎用它标出「已被某型号取代」，例如 5.6 Sol/5.5 都指向 `gpt-6-sol`。
///     已被取代的型号还列在选择器里，读的人只会困惑该选哪个。
fn engine_listed_models(directory: &Path) -> Vec<EngineModel> {
    let Ok(bytes) = std::fs::read(engine_catalog_path(directory)) else { return Vec::new() };
    let Ok(parsed) = serde_json::from_slice::<Value>(&bytes) else { return Vec::new() };
    let Some(models) = parsed.get("models").and_then(Value::as_array) else { return Vec::new() };
    models
        .iter()
        .filter(|model| model.get("visibility").and_then(Value::as_str) == Some("list"))
        .filter(|model| model.get("upgrade").is_none_or(Value::is_null))
        .filter_map(engine_model_from)
        .collect()
}

/// 把引擎的 GPT 目录同步进 `可用模型` 的 openai 清单，返回是否真的改了什么。
///
/// 这是「各处调用模型一致」的那一步：设置页、对话框、拉会/分工、外部 API 都从同一份
/// `built_in_model_overrides` 派生。只在 merged catalog 里补模型会让引擎认识它、而 UI 不认识，
/// 于是出现「选择器里没有、但会话能跑」的分裂——正是要避免的东西。
///
/// 规则：
///   * 引擎有、清单没有 → 追加（引擎顺序，最新的在前）；
///   * 两边都有 → 用引擎的 effort 档位与默认档覆盖，label 与上下文窗口保留用户的值；
///   * 清单有、引擎没有 → 保留（bridge-only 条目和用户自建条目都靠这条活着）。
fn sync_engine_models(directory: &Path, saved: &mut Saved) -> bool {
    // 刷新缓存是副作用：`merged_catalog` 与 adapter 的 per-thread 目录都从这份快照取元数据。
    refresh_engine_catalog(directory);
    let listed = engine_listed_models(directory);
    if listed.is_empty() {
        // 引擎没答话：不要凭空删掉或重排用户的清单。
        return false;
    }
    let rows = saved.built_in_model_overrides.entry("openai".to_string()).or_default();
    let mut added: Vec<CustomModel> = Vec::new();
    let mut changed = false;
    for model in &listed {
        if model.efforts.is_empty() {
            // 没有档位声明的条目写进清单只会让选择器显示一个不能调档的模型。
            continue;
        }
        match rows.iter_mut().find(|row| row.api_id == model.slug) {
            Some(row) => {
                // 档位清单必须跟着引擎走：选一个上游已撤掉的档位，整轮请求会被 400 拒。
                // 默认档只有在用户明确改过时才保留；初始种子必须跟随引擎，否则引擎换了
                // 推荐值还一直跑旧值，用户看到的就是“默认档对不上”。
                if row.reasoning_levels.as_deref() != Some(model.efforts.as_slice()) {
                    row.reasoning_levels = Some(model.efforts.clone());
                    changed = true;
                }
                if !row.default_reasoning_level_explicit
                    && model.default_effort.is_some()
                    && row.default_reasoning_level != model.default_effort
                {
                    row.default_reasoning_level = model.default_effort.clone();
                    changed = true;
                }
                if row.context_window.is_none() && model.context_window.is_some() {
                    row.context_window = model.context_window;
                    changed = true;
                }
            }
            None => {
                log::info!("engine catalog: adding {} to the GPT shortlist", model.slug);
                added.push(CustomModel {
                    label: model.label.clone(),
                    api_id: model.slug.clone(),
                    context_window: model.context_window,
                    description: None,
                    reasoning_levels: Some(model.efforts.clone()),
                    default_reasoning_level: model.default_effort.clone(),
                    default_reasoning_level_explicit: false,
                    enabled: None,
                });
                changed = true;
            }
        }
    }
    if !added.is_empty() {
        rows.splice(0..0, added);
    }
    changed
}

/// Rewrites the `Model identity:` paragraph so it names *this* entry's own model.
///
/// A catalog entry that is not spelled out in a bundled catalog is built by cloning a sibling
/// (`complete_catalog_entry(Some(&bundled["models"][0]))`, `catalog_template()`), and
/// `base_instructions` is a ~21KB prompt whose first paragraph claims "this session runs on X,
/// served via Y". Cloning the whole blob therefore told GLM it was Qwen 4 Max, told every
/// OpenRouter free model it was Kimi K3, and told the GPT models they were Claude Opus 5.5. The
/// model then answered "I am Claude Opus 5.5" while the picker said "Ling 3.2 Flash", which reads
/// exactly like a routing bug — the request was routed correctly, the prompt was lying.
///
/// Replaced rather than deleted: a model told nothing about itself announces whatever the Codex
/// CLI prompt says, which is just as wrong in the other direction.
fn retarget_identity(entry: &mut Value) {
    let Some(object) = entry.as_object_mut() else { return };
    let slug = object.get("slug").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    if slug.is_empty() {
        return;
    }
    let display = object.get("display_name").and_then(Value::as_str).unwrap_or(&slug).trim().to_string();
    let Some(text) = object.get("base_instructions").and_then(Value::as_str) else { return };
    const MARKER: &str = "Model identity:";
    let replacement = format!(
        "Model identity: this session runs on {display} ({slug}). When the user asks which model you are, \
         answer \"{display}\" — never name a different model, and do not treat the Codex CLI description \
         below as your own identity."
    );
    let Some(start) = text.find(MARKER) else {
        // No identity paragraph at all (an engine-native prompt, or a catalog written before the
        // paragraph existed). `deepseek-V4.1-flash` opened with "You are Codex, an agent based on
        // GPT-5", which the model then repeated verbatim. Prepend instead of leaving it silent.
        object.insert("base_instructions".into(), json!(format!("{replacement}\n\n{text}")));
        return;
    };
    // The paragraph ends at the blank line separating it from the Codex prompt below.
    let end = text[start..].find("\n\n").map_or(text.len(), |offset| start + offset);
    let mut updated = String::with_capacity(text.len() + replacement.len());
    updated.push_str(&text[..start]);
    updated.push_str(&replacement);
    updated.push_str(&text[end..]);
    object.insert("base_instructions".into(), json!(updated));
}

fn effort_description(effort: &str) -> &'static str {
    match effort {
        "none" => "Disable reasoning",
        "minimal" => "Minimal reasoning effort",
        "low" => "Low reasoning effort",
        "medium" => "Medium reasoning effort",
        "high" => "High reasoning effort",
        "xhigh" => "Extra high reasoning effort",
        "max" => "Maximum reasoning effort",
        "ultra" => "Ultra reasoning effort",
        _ => "Extended reasoning effort",
    }
}

fn custom_catalog(provider: &CustomProvider) -> Result<Value, String> {
    let models = provider
        .models
        .iter()
        // A model switched off in settings stays saved but never reaches the picker.
        .filter(|model| model.is_enabled())
        .enumerate()
        .map(|(index, model)| {
            let mut entry = catalog_template().clone();
            let object = entry.as_object_mut().ok_or("Invalid bundled model catalog")?;
            // A compaction hash from another model would make Codex summarize with the previous
            // model against this provider's endpoint. These catalogs intentionally omit it.
            object.remove("comp_hash");
            object.remove("context_window");
            object.remove("max_context_window");
            object.remove("default_reasoning_level");
            object.insert("slug".into(), json!(model.api_id));
            object.insert("display_name".into(), json!(model.label));
            object.insert(
                "description".into(),
                json!(model.description.clone().unwrap_or_else(|| "Custom model via the Responses API.".into())),
            );
            object.insert("priority".into(), json!(index));
            // Saved providers from older builds may predate reasoning level injection; re-apply
            // the same family inference as saving so existing gateways gain Effort unchanged.
            let levels: Vec<String> = match &model.reasoning_levels {
                Some(levels) => levels.clone(),
                None => inferred_reasoning_levels(&model.api_id, &model.label)
                    .map(|(inferred, _)| inferred.iter().map(|level| level.to_string()).collect())
                    .unwrap_or_default(),
            };
            let default_level = model.default_reasoning_level.clone().or_else(|| {
                inferred_reasoning_levels(&model.api_id, &model.label).map(|(_, default)| default.to_string())
            });
            object.insert(
                "supported_reasoning_levels".into(),
                json!(
                    levels
                        .iter()
                        .map(|effort| json!({"effort": effort, "description": effort_description(effort)}))
                        .collect::<Vec<_>>()
                ),
            );
            if let Some(default) = &default_level {
                object.insert("default_reasoning_level".into(), json!(default));
            }
            if let Some(window) = model.context_window {
                object.insert("context_window".into(), json!(window));
                object.insert("max_context_window".into(), json!(window));
                // ChatGPT 的 responses 端点**要求** reasoning 必须开启：模板里 sol 的
                // `default_reasoning_summary: "none"` 会让引擎不带 reasoning 发送，服务端直接回
                // `Reasoning is mandatory for this endpoint and cannot be disabled.`
                // 这正是 terra 第一次尝试时那条「操作没有完成」的来源。
                object.insert("default_reasoning_summary".into(), json!("auto"));
                object.insert("reasoning_summary_format".into(), json!("auto"));
                // No `auto_compact_token_limit`: the engine compacts at its own 95% default, which
                // is what the user chose. The key used to be forced to 70% for the company relay,
                // but a per-thread catalog never reached model resolution anyway (see
                // `merged_catalog_path`), so all it did was disagree with the engine.
            } else {
                // Providers saved before contextWindow existed must not fall back to Codex's
                // tiny unknown-model window: that triggers premature auto-compaction mid-turn.
                object.insert("context_window".into(), json!(1_000_000u64));
                object.insert("max_context_window".into(), json!(1_000_000u64));
            }
            retarget_identity(&mut entry);
            Ok(entry)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({ "models": models }))
}

fn write_custom_catalog(directory: &Path, provider: &CustomProvider) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let catalog = custom_catalog(provider)?;
    let bytes = serde_json::to_vec(&catalog).map_err(|error| error.to_string())?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    let path = directory.join(format!("{}-{:016x}.json", runtime_provider_id(&provider.id), hasher.finish()));
    if std::fs::read(&path).ok().as_deref() == Some(bytes.as_slice()) {
        return Ok(path);
    }
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.as_file().sync_all().map_err(|error| error.to_string())?;
    file.persist(&path).map_err(|error| error.error.to_string())?;
    Ok(path)
}

/// Sets `default_reasoning_level` on every model in the shared company catalog whose
/// `supported_reasoning_levels` includes `level`. Idempotent: only writes when the value differs,
/// so re-running on every tune tick is free.
fn inject_default_reasoning(catalog: &mut Value, level: Option<&str>) -> usize {
    let Some(level) = level else { return 0 };
    let Some(models) = catalog.get_mut("models").and_then(|models| models.as_array_mut()) else {
        return 0;
    };
    let mut changed = 0;
    for model in models {
        let supported = model
            .get("supported_reasoning_levels")
            .and_then(Value::as_array)
            .map(|levels| levels.iter().any(|entry| entry.get("effort").and_then(Value::as_str) == Some(level)))
            .unwrap_or(false);
        if !supported {
            continue;
        }
        match model.get("default_reasoning_level").and_then(Value::as_str) {
            Some(current) if current == level => {}
            _ => {
                model["default_reasoning_level"] = json!(level);
                changed += 1;
            }
        }
    }
    changed
}

/// Injects `default_reasoning_level` into the shared ALwith model catalog that the
/// account-managed (company) provider points at, in place.
///
/// The account-managed `litellm` provider's `model_catalog_json` is the engine-owned
/// `model-catalogs/alwith/models.json`, which the Codex plugin regenerates from a bundled template
/// at startup. That template pins `default_reasoning_level` to `high`; the user wants `max`, and
/// wants it configurable, so this mirrors the configured level into the catalog the picker reads.
///
/// Compaction is deliberately NOT touched: the engine's own 95% default is the chosen behaviour.
/// The plugin rewrites this file on every Codex launch, so the caller re-runs this after startup
/// (see `start_managed_catalog_tuner`). Returns whether the file existed and was (re)tuned.
fn tune_managed_catalog(app: &AppHandle) -> bool {
    use tauri::Manager;
    let Ok(directory) = app.path().app_data_dir() else { return false };
    let path = directory.join("model-catalogs").join("alwith").join("models.json");
    let Ok(bytes) = std::fs::read(&path) else { return false };
    let Ok(mut catalog) = serde_json::from_slice::<Value>(&bytes) else { return false };
    let reasoned = inject_default_reasoning(&mut catalog, company_reasoning_level().as_deref());
    if reasoned == 0 {
        return false;
    }
    if let Ok(next) = serde_json::to_vec_pretty(&catalog)
        && next != bytes
        && let Err(error) = std::fs::write(&path, &next)
    {
        log::warn!("managed: could not tune shared catalog: {error}");
    }
    true
}

/// Sets the company model's default reasoning level and propagates it everywhere it matters.
///
/// The level is stored in process memory, persisted to `company-model.json`, mirrored into the
/// shared engine catalog (so new chats on the company model actually think at that level), and
/// written into the live managed-provider snapshot (so the 大模型 picker shows the new default
/// immediately). Invalid levels (anything but `low` / `high` / `max`) are rejected; `None` keeps
/// the default `max`.
#[tauri3_specta::command]
pub async fn set_company_model_reasoning(app: AppHandle, level: Option<String>) -> Result<(), String> {
    let normalized = match level {
        None => "max".to_string(),
        Some(ref candidate) if COMPANY_REASONING_LEVELS.contains(&candidate.as_str()) => candidate.clone(),
        Some(other) => return Err(format!("Unsupported reasoning level: {other}")),
    };
    *COMPANY_MODEL_REASONING.lock().unwrap() = Some(normalized.clone());
    if let Ok(directory) = app.path().app_data_dir() {
        let path = directory.join("company-model.json");
        if let Ok(bytes) = serde_json::to_vec_pretty(&json!({ "reasoningLevel": normalized })) {
            let _ = std::fs::write(&path, bytes);
        }
    }
    // Engine thinking changes without waiting for the next 15s tune tick.
    tune_managed_catalog(&app);
    // Reflect the new default in the picker right away.
    {
        let state = app.state::<Providers>();
        let mut inner = state.inner.lock().await;
        if let Some(cache) = inner.saved.managed.as_mut()
            && let Some(provider) = cache.provider.as_mut()
        {
            for model in &mut provider.models {
                model.reasoning_levels = Some(COMPANY_REASONING_LEVELS.iter().map(|level| level.to_string()).collect());
                model.default_reasoning_level = Some(normalized.clone());
            }
        }
        let _ = inner.snapshot().emit(&app);
    }
    Ok(())
}

/// Every model the app has spelled out, in one catalog the engine can be launched with.
///
/// Measured against codex-cli 0.167.2 with a throwaway `CODEX_HOME` and a fake upstream:
/// a catalog named by `model_catalog_json` in `config.toml` sets the window (a 1M model reported
/// 950000 = 1M × 95%), while the exact same path passed as the per-thread `config` value the ACP
/// adapter sends is ignored — the engine stayed on Codex's default 272000 × 95% = 258400. The
/// per-thread catalog still feeds the picker (display name, reasoning ladder), which is why the
/// gap was invisible: the app advertised a 1M-token company model while the engine compacted at
/// 245k and never reached the 70% limit we inject.
///
/// The launcher therefore hands this merged file to the engine on the command line, next to the
/// router table it already injects. Sources are the catalogs the app generates itself: the
/// account-managed one, the enterprise relay's tuned copy, one per built-in provider carrying
/// overrides, and one per custom provider. The newest file per provider prefix wins so a stale
/// hash left behind by an older build can never shadow the current entry.
/// Writes the merged catalog at startup and reports what happened.
///
/// `merged_catalog_path` used to run only from `persist` (a settings save), so a launch after an
/// upgrade kept whatever file the previous build left behind — or, when the file was absent, gave
/// the engine an empty `ALWITH_U_MODEL_CATALOG` and let it use its own catalog. Both paths ended in
/// the same user-visible bug: the picker said one model and the prompt claimed another.
pub fn prepare_merged_catalog(app: &tauri::AppHandle) {
    let Some(directory) = app.path().app_data_dir().ok() else {
        log::warn!("merged catalog: no app data directory");
        return;
    };
    match merged_catalog_path(&directory) {
        Some(path) => log::info!("merged catalog: ready at {}", path.display()),
        None => log::warn!("merged catalog: nothing to write under {}", directory.display()),
    }
}

pub(crate) fn merged_catalog_path(app_data: &std::path::Path) -> Option<std::path::PathBuf> {
    let catalog = merged_catalog(app_data)?;
    let bytes = serde_json::to_vec(&catalog).ok()?;
    let path = app_data.join("model-catalogs").join("merged.json");
    if std::fs::read(&path).ok().as_deref() != Some(bytes.as_slice()) {
        std::fs::create_dir_all(path.parent()?).ok()?;
        if let Err(error) = std::fs::write(&path, &bytes) {
            log::warn!("merged catalog: could not write {}: {error}", path.display());
            return None;
        }
    }
    Some(path)
}

fn merged_catalog(app_data: &std::path::Path) -> Option<Value> {
    let mut sources = vec![app_data.join("model-catalogs").join("alwith").join("models.json")];
    sources.extend(newest_catalog_files(&app_data.join("enterprise-catalogs"), "tuned-"));
    sources.extend(newest_catalog_files(&app_data.join("provider-catalogs"), "builtin-"));
    sources.extend(newest_catalog_files(&app_data.join("provider-catalogs"), "custom-"));
    let mut entries: Vec<Value> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for source in sources {
        let Ok(bytes) = std::fs::read(&source) else { continue };
        let Ok(catalog) = serde_json::from_slice::<Value>(&bytes) else { continue };
        let Some(models) = catalog.get("models").and_then(Value::as_array) else { continue };
        for model in models {
            let Some(slug) = model.get("slug").and_then(Value::as_str) else { continue };
            // A slug can only resolve to one entry; the first source in priority order owns it.
            if !seen.insert(slug.to_string()) {
                continue;
            }
            // The engine compacts at its own 95% default. A limit left in a catalog written by an
            // older build (70% of the window) would silently win here, so drop it on the way
            // through: this file is the one the engine actually reads.
            let mut entry = model.clone();
            if let Some(object) = entry.as_object_mut() {
                object.remove("auto_compact_token_limit");
            }
            // 最终闸门：上游目录（内置、自定义、公司下发）都可能带着克隆来的错误身份，
            // 而引擎真正读的就是这个文件。
            retarget_identity(&mut entry);
            entries.push(entry);
        }
    }
    // 引擎目录缺的 GPT 模型（目前只有 `gpt-6.1-terra`）由 bridge 提供。
    //
    // 事实链（2026-11-17 实测）：
    //   * 引擎 0.7.39 的内置模型表里没有 terra，configOptions 也就没有它 → 选择器里选不到；
    //   * 但本地 bridge（127.0.0.1:18765）的 `/v1/models` 已经列出 terra，实测
    //     `POST /v1/chat/completions {model:"gpt-6.1-terra"}` 返回 200；
    //   * 共享 router 的分派规则是「模型名不带斜杠 → 走 ChatGPT 原生后端」，所以 terra 只要
    //     能进引擎目录，请求就会被 router 原样转发到 bridge 的 ChatGPT 通路上。
    //
    // 因此这里把 bridge 认、引擎不认的模型补进合并目录：引擎读到就列出它，选择不再落空，
    // 也不会再出现「显示 terra、实际跑 sol」。等引擎版本自带这些模型时，同名条目会被上面的
    // 去重逻辑挡住，这里的注入自然失效，不需要再改。
    for (slug, display, window) in BRIDGE_ONLY_GPT_MODELS {
        if !seen.insert((*slug).to_string()) {
            continue;
        }
        // 模板必须取自同族模型（sol），不能用 entries 的第一条：第一版拿 deepseek 的条目当模板，
        // 会把它的工具/搜索能力原样带给 GPT，选择器里看着对、实际能力是错的。
        let template_entry = entries
            .iter()
            .find(|entry| entry.get("slug").and_then(Value::as_str) == Some("gpt-6.1-sol"))
            .or_else(|| entries.first())
            .cloned();
        if let Some(template) = template_entry.map(|mut entry| {
            if let Some(object) = entry.as_object_mut() {
                object.insert("slug".into(), json!(slug));
                object.insert("display_name".into(), json!(display));
                object.insert("description".into(), json!("GPT coding model served through the local bridge."));
                object.insert("context_window".into(), json!(window));
                object.insert("max_context_window".into(), json!(window));
            }
            // 模板来自 sol，身份段会写着 sol——必须换成它自己，否则 terra 会说自己是 sol。
            retarget_identity(&mut entry);
            entry
        }) {
            log::info!("merged catalog: added bridge-only model {slug}");
            entries.push(template);
        }
    }
    // 已存在的同类条目也要补 reasoning：`seen` 去重会让「上游目录里已经有 terra」的情况跳过
    // 上面的注入块，字段就停在模板原样（`default_reasoning_summary` 缺失 → 引擎按禁用发送 →
    // 服务端回 "Reasoning is mandatory"）。这里统一收口，避免依赖条目来自哪一层。
    for entry in entries.iter_mut() {
        if entry.get("slug").and_then(Value::as_str) != Some("gpt-6.1-terra") {
            continue;
        }
        if let Some(object) = entry.as_object_mut() {
            object.insert("default_reasoning_summary".into(), json!("auto"));
            object.insert("reasoning_summary_format".into(), json!("auto"));
            if object.get("supported_reasoning_levels").is_none() {
                object.insert(
                    "supported_reasoning_levels".into(),
                    json!([{"effort":"low"},{"effort":"medium"},{"effort":"high"}]),
                );
            }
        }
    }
    // 引擎目录先落一遍：型号上下线、effort 档位、加速档位都以引擎为准。写在这里而不是各条
    // 目录源里，是因为克隆模板（qwen4-max-preview）不带这些字段，任何一级上游都可能缺。
    let engine = engine_catalog(app_data);
    // GPT defaults are engine-owned unless the reader explicitly changed them. Read the saved
    // provider state here because this function only has the app-data path, not `Providers.inner`.
    let explicit_defaults = explicit_gpt_defaults(app_data);
    for entry in entries.iter_mut() {
        let preserve_default =
            entry.get("slug").and_then(Value::as_str).is_some_and(|slug| explicit_defaults.contains(slug));
        apply_engine_metadata(entry, &engine, preserve_default);
        restore_native_speed_tiers(entry);
    }
    // 引擎有、目录里没有的型号：直接补进来。`sync_engine_models` 已经把清单补齐，但那次写入的
    // 是 `builtin-openai-*.json`，而它只在 provider apply 时才生成——首次启动的这一刻还没有。
    // 两边都做，谁先到都能得到同一份清单。
    append_engine_models(&mut entries, &engine_listed_models(app_data), &mut seen);
    if entries.is_empty() {
        return None;
    }
    Some(json!({ "models": entries }))
}

/// GPT model ids whose default effort the reader changed explicitly.
///
/// `runtime-providers.json` is the same store `Providers::load` reads; a missing or older file
/// simply means "nothing explicit", which lets the engine recommendation apply.
fn explicit_gpt_defaults(app_data: &std::path::Path) -> BTreeSet<String> {
    let Ok(bytes) = std::fs::read(app_data.join("runtime-providers.json")) else {
        return BTreeSet::new();
    };
    let Ok(saved) = serde_json::from_slice::<Saved>(&bytes) else {
        return BTreeSet::new();
    };
    saved
        .built_in_model_overrides
        .get("openai")
        .into_iter()
        .flatten()
        .filter(|model| model.default_reasoning_level_explicit)
        .map(|model| model.api_id.clone())
        .collect()
}

/// 用引擎的声明覆盖一个目录条目的能力字段。
///
/// 只认 `gpt-` 开头的 slug：引擎目录里没有网关型号，按 slug 匹配天然不会碰它们。缺字段时
/// 什么都不做，免得把一份好条目改坏——`restore_native_speed_tiers` 仍是最后的兜底。
fn apply_engine_metadata(entry: &mut Value, engine: &[EngineModel], preserve_default: bool) {
    let Some(object) = entry.as_object_mut() else { return };
    let slug = object.get("slug").and_then(Value::as_str).unwrap_or_default().to_string();
    if !slug.starts_with("gpt-") {
        return;
    }
    let Some(model) = engine.iter().find(|candidate| candidate.slug == slug) else { return };
    if !model.efforts.is_empty() {
        object.insert(
            "supported_reasoning_levels".into(),
            json!(
                model
                    .efforts
                    .iter()
                    .map(|effort| json!({ "effort": effort, "description": effort_description(effort) }))
                    .collect::<Vec<_>>()
            ),
        );
    }
    if let Some(default) = &model.default_effort {
        // An explicit user choice wins. A row that only carries the initial seed follows the
        // engine, otherwise the app keeps running an old recommendation after the engine moves.
        if !preserve_default || object.get("default_reasoning_level").is_none() {
            object.insert("default_reasoning_level".into(), json!(default));
        }
    }
    if !model.speed_tiers.is_empty() {
        object.insert("additional_speed_tiers".into(), json!(model.speed_tiers));
    }
    if !model.service_tiers.is_null() {
        object.insert("service_tiers".into(), model.service_tiers.clone());
    }
    // Sub-agent orchestration is part of the model definition, not a global rule: only models whose
    // own engine entry declares it get it, and the values are copied verbatim (`xhigh`, `v2`).
    // Never synthesise these from an Effort name — `ultra` is a UI choice, not an outbound value.
    if let Some(effort) = &model.multi_agent_effort {
        object.insert("multi_agent_reasoning_effort".into(), json!(effort));
    } else {
        // A provider catalog cloned this entry may still carry the pair from an older engine.
        // The engine's current definition is authoritative: if it no longer declares a sub-agent
        // effort, keeping the stale value silently changes what `ultra` sends.
        object.remove("multi_agent_reasoning_effort");
    }
    if let Some(version) = &model.multi_agent_version {
        object.insert("multi_agent_version".into(), json!(version));
    } else {
        object.remove("multi_agent_version");
    }
    if object.get("context_window").is_none()
        && let Some(window) = model.context_window
    {
        object.insert("context_window".into(), json!(window));
        object.insert("max_context_window".into(), json!(window));
    }
}

/// 把引擎新公布、目录里还没有的型号补进合并目录。
///
/// 模板优先取同族（已是 `gpt-` 的条目），因为工具/搜索这些能力字段必须对得上；一条都没有时
/// 才退回 `complete_catalog_entry(None)`，那是全新安装的第一帧。
fn append_engine_models(entries: &mut Vec<Value>, engine: &[EngineModel], seen: &mut BTreeSet<String>) {
    for model in engine {
        if model.efforts.is_empty() || !seen.insert(model.slug.clone()) {
            continue;
        }
        let family = entries
            .iter()
            .find(|entry| entry.get("slug").and_then(Value::as_str).is_some_and(|slug| slug.starts_with("gpt-")))
            .cloned();
        let Some(template) = family.or_else(|| Some(complete_catalog_entry(None))).filter(|entry| entry.is_object())
        else {
            continue;
        };
        let mut entry = template;
        if let Some(object) = entry.as_object_mut() {
            object.insert("slug".into(), json!(model.slug));
            object.insert("display_name".into(), json!(model.label));
            object.insert("description".into(), json!("GPT model served through the local bridge."));
            if let Some(window) = model.context_window {
                object.insert("context_window".into(), json!(window));
                object.insert("max_context_window".into(), json!(window));
            }
        }
        apply_engine_metadata(&mut entry, engine, false);
        restore_native_speed_tiers(&mut entry);
        // 模板来自同族，身份段会写着那个型号——必须换成它自己。
        retarget_identity(&mut entry);
        log::info!("engine catalog: added {} to the merged catalog", model.slug);
        entries.push(entry);
    }
}

/// 把 Codex 原生 GPT 家族的加速档位补回目录条目。
///
/// 只在条目自己没写这个字段时生效：写过的（例如 `gpt-daybreak-*` 确实声明 `[]`）原样保留，
/// 免得把「不支持加速」的模型也变成可选。`service_tiers` 一并补上，引擎才认 `service_tier:
/// "priority"` 这个取值——只补前者会让开关能点但请求被拒。
fn restore_native_speed_tiers(entry: &mut Value) {
    let Some(object) = entry.as_object_mut() else { return };
    let slug = object.get("slug").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
    if !slug.starts_with("gpt-") || slug.starts_with("gpt-daybreak") {
        return;
    }
    if object.contains_key("additional_speed_tiers") {
        return;
    }
    object.insert("additional_speed_tiers".into(), json!(["fast"]));
    if !object.contains_key("service_tiers") {
        object.insert(
            "service_tiers".into(),
            json!([{"id":"priority","name":"Fast","description":"1.5x speed, increased usage"}]),
        );
    }
}

/// 本地 bridge 支持、但引擎内置表里没有的 GPT 模型：(引擎 slug, 显示名, 上下文窗口)。
///
/// 来源是 `src-tauri/resources/alwith-bridge/alwith-model.py` 的 `NATIVE_MODELS` 与 bridge 的
/// `/v1/models`（两者必须一致，由 `scripts/__tests__` 覆盖）。加模型时两处一起改。
const BRIDGE_ONLY_GPT_MODELS: &[(&str, &str, u64)] = &[("gpt-6.1-terra", "GPT · 6.1 Terra", 1_050_000)];

/// The newest catalog file per provider prefix (`builtin-deepseek-<hash>.json` →
/// `builtin-deepseek`) in a directory. Catalogs are content-addressed, so an edit leaves the old
/// file behind; only the newest one describes what the provider currently offers.
fn newest_catalog_files(directory: &std::path::Path, prefix: &str) -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir(directory) else { return Vec::new() };
    let mut newest: BTreeMap<String, (std::time::SystemTime, std::path::PathBuf)> = BTreeMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else { continue };
        let Some(stem) = name.strip_suffix(".json") else { continue };
        let Some((stem_prefix, _hash)) = stem.rsplit_once('-') else { continue };
        if !stem_prefix.starts_with(prefix) {
            continue;
        }
        let modified = entry.metadata().and_then(|meta| meta.modified()).unwrap_or(std::time::UNIX_EPOCH);
        let slot = newest.entry(stem_prefix.to_string()).or_insert_with(|| (modified, path.clone()));
        if modified > slot.0 {
            *slot = (modified, path.clone());
        }
    }
    newest.into_values().map(|(_, path)| path).collect()
}

/// Keeps the account-managed (company) model catalog tuned across Codex restarts.
///
/// The Codex plugin rewrites `model-catalogs/alwith/models.json` from its bundled template on each
/// launch, which strips the `auto_compact_token_limit` and `default_reasoning_level` we inject.
/// This loop re-tunes shortly after startup (when the plugin first writes the file) and then
/// periodically, so the company DeepSeek V4.1 Flash always compacts early and thinks at the
/// configured level rather than going silent or dropping to `high` near the end of the window.
pub fn start_managed_catalog_tuner(app: &AppHandle) {
    if cfg!(test) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Fast passes for the first ~8s to catch the plugin's startup write, then a calm cadence.
        for _ in 0..8 {
            tune_managed_catalog(&app);
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            tune_managed_catalog(&app);
        }
    });
}

/// Merge user overrides onto a built-in provider's bundled catalog and write it next to the custom
/// catalogs. Returns the absolute path for `model_catalog_json`, so the adapter threads the
/// overridden Effort levels, context window, display name and slug instead of the bundled ones.
fn write_built_in_catalog(
    directory: &Path, provider_id: &str, overrides: &[CustomModel], resource_dir: &Path,
) -> Result<PathBuf, String> {
    let provider = definition(provider_id)?;
    // Native providers (e.g. OpenAI) ship no bundled catalog file — their model list comes from the
    // engine's own GPT catalog at runtime. An override for them still needs a `model_catalog_json`,
    // so fall back to an empty bundled set and build every entry from the complete template, exactly
    // like `custom_catalog` does for custom providers.
    let bundled: Value = match provider["catalog"].as_str() {
        Some(relative) => {
            let bundled_path = resource_dir.join(relative);
            serde_json::from_str(
                &std::fs::read_to_string(&bundled_path).map_err(|error| format!("Read bundled catalog: {error}"))?,
            )
            .map_err(|error| error.to_string())?
        }
        None => json!({ "models": [] }),
    };
    let mut entries: BTreeMap<String, Value> = bundled["models"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|entry| {
            let slug = entry["slug"].as_str().unwrap_or("").to_string();
            (slug, complete_catalog_entry(Some(&entry)))
        })
        .collect();
    // The saved vector order is the picker's order; the engine catalog must stay stable or a drag
    // changes the provider's default model/priorities and the adapter rejects the swap (-32603).
    let mut ordered: Vec<&CustomModel> = overrides.iter().filter(|model| model.is_enabled()).collect();
    ordered.sort_by(|a, b| a.api_id.cmp(&b.api_id));
    for (index, model) in ordered.iter().enumerate() {
        let mut entry = entries
            .get(&model.api_id)
            .cloned()
            .unwrap_or_else(|| complete_catalog_entry(bundled["models"].as_array().and_then(|models| models.first())));
        {
            let object = entry.as_object_mut().ok_or("Invalid bundled model catalog")?;
            object.insert("slug".into(), json!(model.api_id));
            object.insert("display_name".into(), json!(model.label));
            object.insert(
                "description".into(),
                json!(model.description.clone().unwrap_or_else(|| format!("{} via the Responses API.", model.label))),
            );
            object.insert("priority".into(), json!(index));
            object.remove("comp_hash");
            object.remove("default_reasoning_level");
            object.remove("context_window");
            object.remove("max_context_window");
            let levels: Vec<String> = model.reasoning_levels.clone().unwrap_or_else(|| {
                inferred_reasoning_levels(&model.api_id, &model.label)
                    .map(|(inferred, _)| inferred.iter().map(|level| level.to_string()).collect())
                    .unwrap_or_default()
            });
            let default_level = model.default_reasoning_level.clone().or_else(|| {
                inferred_reasoning_levels(&model.api_id, &model.label).map(|(_, default)| default.to_string())
            });
            object.insert(
                "supported_reasoning_levels".into(),
                json!(
                    levels
                        .iter()
                        .map(|effort| json!({ "effort": effort, "description": effort_description(effort) }))
                        .collect::<Vec<_>>()
                ),
            );
            if let Some(default) = &default_level {
                object.insert("default_reasoning_level".into(), json!(default));
            }
            if let Some(window) = model.context_window {
                object.insert("context_window".into(), json!(window));
                object.insert("max_context_window".into(), json!(window));
            } else if !object.contains_key("context_window") {
                // A missing window makes Codex auto-compact mid-turn against tiny unknown-model
                // defaults; keep the bundled window when the override leaves it unset.
                object.insert("context_window".into(), json!(1_000_000u64));
                object.insert("max_context_window".into(), json!(1_000_000u64));
            }
        }
        retarget_identity(&mut entry);
        // 这份文件经 `model_catalog_json` 交给 adapter，per-thread 的 configOptions 就由它生成。
        // 少了 `additional_speed_tiers`，adapter 的 `modelSupportsFast` 判 false，`fast-mode`
        // 这个 configOption 根本不会发布 —— 对话框上方那行「快速模式」直接消失。
        restore_native_speed_tiers(&mut entry);
        entries.insert(model.api_id.clone(), entry);
    }
    let models: Vec<Value> = ordered.iter().map(|model| entries.get(&model.api_id).cloned().unwrap()).collect();
    let catalog = json!({ "models": models });
    write_catalog_file(directory, &format!("builtin-{provider_id}"), &catalog)
}

/// Writes `catalog` under a content hash and returns its path, reusing an identical file.
fn write_catalog_file(directory: &Path, prefix: &str, catalog: &Value) -> Result<PathBuf, String> {
    let bytes = serde_json::to_vec(catalog).map_err(|error| error.to_string())?;
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    let path = directory.join(format!("{prefix}-{:016x}.json", hasher.finish()));
    if std::fs::read(&path).ok().as_deref() == Some(bytes.as_slice()) {
        return Ok(path);
    }
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.as_file().sync_all().map_err(|error| error.to_string())?;
    file.persist(&path).map_err(|error| error.error.to_string())?;
    Ok(path)
}

/// The bundled catalog for `provider_id`, guaranteed to parse.
///
/// Kimi, GLM and MiniMax ship hand-written catalogs that describe only the model's identity,
/// context window and reasoning levels. Codex validates the whole file against its model schema and
/// rejects it with `missing field \`shell_type\``, which takes the entire configuration down — the
/// "Internal error: failed to load configuration" seen when switching models. Such a file is
/// completed through the template before Codex reads it; catalogs that are already complete keep
/// pointing at the shipped resource and cost no extra file.
fn write_bundled_catalog(directory: &Path, provider_id: &str, bundled: &Path) -> Result<PathBuf, String> {
    let parsed: Value = serde_json::from_str(
        &std::fs::read_to_string(bundled).map_err(|error| format!("Read bundled catalog: {error}"))?,
    )
    .map_err(|error| error.to_string())?;
    let shipped = parsed["models"].as_array().cloned().unwrap_or_default();
    if shipped.iter().all(|entry| entry.get("shell_type").is_some()) {
        return Ok(bundled.to_path_buf());
    }
    let models: Vec<Value> = shipped.iter().map(|entry| complete_catalog_entry(Some(entry))).collect();
    write_catalog_file(directory, &format!("bundled-{provider_id}"), &json!({ "models": models }))
}

#[derive(Clone)]
struct TestConfig {
    base_url: String,
    api_key: String,
    model: String,
}

fn test_config(saved: &Saved, id: &str) -> Result<TestConfig, String> {
    if let Some(provider) = saved.custom_providers.get(id) {
        return Ok(TestConfig {
            base_url: provider.base_url.clone(),
            api_key: provider.api_key.clone(),
            model: provider
                .models
                .iter()
                .find(|model| model.is_enabled())
                .ok_or("Add at least one enabled model")?
                .api_id
                .clone(),
        });
    }
    let key = saved.credentials.get(id).ok_or("Configure and save this provider first")?;
    let provider = definition(id)?;
    let base_url = if let Some(url) = &key.base_url {
        url.clone()
    } else if let Some(region) = key.region.as_deref() {
        provider["regions"]
            .as_array()
            .and_then(|regions| regions.iter().find(|item| item["id"] == region))
            .and_then(|item| item["baseUrl"].as_str())
            .ok_or("Unknown provider region")?
            .to_string()
    } else {
        provider["baseUrl"].as_str().ok_or("Provider has no API base URL")?.to_string()
    };
    // A sanitized gateway is probed through the bridge as well, so the result reflects the
    // exact path a chat turn takes instead of a direct connection the gateway may treat
    // differently.
    let base_url = if provider["apiType"].as_str() == Some("chat") {
        crate::bridge::register_route(&runtime_provider_id(id), &base_url);
        crate::bridge::gateway_base_url(&runtime_provider_id(id)).unwrap_or(base_url)
    } else {
        base_url
    };
    let model = provider["models"]
        .as_array()
        .and_then(|models| models.first())
        .and_then(|model| model["id"].as_str())
        .ok_or("Provider has no models")?
        .to_string();
    Ok(TestConfig { base_url, api_key: key.api_key.clone(), model })
}

/// Reads the macOS system proxy (scutil --proxy) as a proxy URL, when enabled.
///
/// The app launches from the Finder and inherits no shell environment, so the speed test
/// would otherwise bypass the proxy every other tool on this Mac uses.
fn system_proxy() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/scutil").arg("--proxy").output().ok()?;
    if !out.status.success() {
        return None;
    }
    system_proxy_from_scutil(&String::from_utf8_lossy(&out.stdout))
}

fn system_proxy_from_scutil(text: &str) -> Option<String> {
    let get = |key: &str| -> Option<String> {
        text.lines()
            .find(|line| line.trim_start().starts_with(key))
            .and_then(|line| line.split_once(':').map(|(_, value)| value.trim().to_string()))
    };
    let https_enabled = get("HTTPSEnable").is_some_and(|value| value == "1");
    let http_enabled = get("HTTPEnable").is_some_and(|value| value == "1");
    if !https_enabled && !http_enabled {
        return None;
    }
    let host = get("HTTPSProxy").or_else(|| get("HTTPProxy"))?;
    let port = get("HTTPSPort").or_else(|| get("HTTPPort")).unwrap_or_else(|| "8080".to_string());
    Some(format!("http://{host}:{port}"))
}

async fn test_connection(config: TestConfig) -> TestResult {
    let started = Instant::now();
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20));
    // The GUI app inherits no shell environment from launchd; honour the proxy variables anyway
    // when present, and fall back to the macOS system proxy so the test follows the same route
    // the user's other tools take.
    let proxy_env = std::env::var("https_proxy")
        .ok()
        .or_else(|| std::env::var("HTTPS_PROXY").ok())
        .or_else(|| std::env::var("all_proxy").ok())
        .or_else(|| std::env::var("ALL_PROXY").ok());
    if let Some(proxy) = proxy_env {
        if let Ok(proxy) = reqwest::Proxy::all(proxy.trim()) {
            builder = builder.proxy(proxy);
        }
    } else if let Some(proxy) = system_proxy()
        && let Ok(proxy) = reqwest::Proxy::all(proxy)
    {
        builder = builder.proxy(proxy);
    }
    let client = match builder.build() {
        Ok(client) => client,
        Err(error) => {
            return TestResult {
                ok: false,
                code: "network",
                message: error.to_string(),
                status: None,
                latency_ms: None,
            };
        }
    };
    let request = match build_test_request(&client, &config) {
        Ok(request) => request,
        Err(error) => {
            return TestResult {
                ok: false,
                code: "request_failed",
                message: error.to_string(),
                status: None,
                latency_ms: None,
            };
        }
    };
    let response = client.execute(request).await;
    match response {
        Ok(response) if response.status().is_success() => {
            let status = response.status().as_u16();
            match response.text().await {
                Ok(body) => classify_success_response(status, &body, started.elapsed().as_millis()),
                Err(error) => TestResult {
                    ok: false,
                    code: "invalid_response",
                    message: error.to_string(),
                    status: Some(status),
                    latency_ms: Some(started.elapsed().as_millis()),
                },
            }
        }
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            classify_response_failure(status, &body, &config.api_key)
        }
        Err(error) => {
            let code = if error.is_timeout() {
                "timeout"
            } else if error.is_connect() {
                "network"
            } else {
                "request_failed"
            };
            let mut message = error.to_string().replace(&config.api_key, "[redacted]");
            message.truncate(message.floor_char_boundary(300));
            TestResult { ok: false, code, message, status: None, latency_ms: None }
        }
    }
}

fn build_test_request(client: &reqwest::Client, config: &TestConfig) -> Result<reqwest::Request, reqwest::Error> {
    client
        .post(format!("{}/responses", config.base_url.trim_end_matches('/')))
        .bearer_auth(&config.api_key)
        .json(&json!({"model": config.model, "input": "Reply with OK.", "max_output_tokens": 16, "store": false}))
        .build()
}

fn discovery_api_key(saved: &Saved, provider_id: Option<&str>, supplied: Option<&str>) -> Result<String, String> {
    if let Some(api_key) = supplied.map(str::trim).filter(|api_key| !api_key.is_empty()) {
        return Ok(api_key.to_string());
    }
    let provider_id = provider_id.ok_or("Enter an API key to fetch models")?;
    saved
        .custom_providers
        .get(provider_id)
        .map(|provider| provider.api_key.clone())
        .or_else(|| saved.credentials.get(provider_id).map(|credential| credential.api_key.clone()))
        .ok_or_else(|| "Enter an API key to fetch models".into())
}

fn models_endpoint(base_url: &str) -> String {
    let base_url = base_url.trim_end_matches('/');
    if base_url.ends_with("/models") { base_url.to_string() } else { format!("{base_url}/models") }
}

fn text_at<'a>(value: &'a Value, pointers: &[&str]) -> Option<&'a str> {
    for pointer in pointers {
        if let Some(text) = value.pointer(pointer).and_then(Value::as_str) {
            let text = text.trim();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

fn positive_u64_at(value: &Value, pointers: &[&str]) -> Option<u64> {
    for pointer in pointers {
        let Some(candidate) = value.pointer(pointer) else { continue };
        let number = candidate.as_u64().or_else(|| candidate.as_str().and_then(|text| text.trim().parse::<u64>().ok()));
        if let Some(number) = number.filter(|number| *number > 0) {
            return Some(number);
        }
    }
    None
}

fn normalized_effort(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().replace(['_', ' '], "-").as_str() {
        "none" => Some("none"),
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" | "x-high" | "extra-high" => Some("xhigh"),
        "max" => Some("max"),
        "ultra" => Some("ultra"),
        "persistent" => Some("persistent"),
        _ => None,
    }
}

fn effort_values(value: &Value) -> Vec<&'static str> {
    match value {
        Value::String(text) => text.split(',').filter_map(normalized_effort).collect(),
        Value::Array(items) => items.iter().flat_map(effort_values).collect(),
        Value::Object(object) => {
            if let Some(effort) = ["effort", "name", "id", "level"]
                .iter()
                .filter_map(|key| object.get(*key).and_then(Value::as_str))
                .filter_map(normalized_effort)
                .next()
            {
                return vec![effort];
            }
            ["efforts", "levels", "supported_efforts", "supported_levels"]
                .iter()
                .filter_map(|key| object.get(*key))
                .flat_map(effort_values)
                .collect()
        }
        _ => Vec::new(),
    }
}

fn efforts_at(value: &Value, pointers: &[&str]) -> Vec<&'static str> {
    for pointer in pointers {
        let Some(candidate) = value.pointer(pointer) else { continue };
        let mut levels = Vec::new();
        for level in effort_values(candidate) {
            if !levels.contains(&level) {
                levels.push(level);
            }
        }
        if !levels.is_empty() {
            return levels;
        }
    }
    Vec::new()
}

fn reasoning_support_at(value: &Value) -> Option<bool> {
    for pointer in
        ["/supports_reasoning", "/supportsReasoning", "/capabilities/reasoning", "/capabilities/reasoning/supported"]
    {
        if let Some(supported) = value.pointer(pointer).and_then(Value::as_bool) {
            return Some(supported);
        }
    }
    if let Some(reasoning) = value.pointer("/reasoning").and_then(Value::as_bool) {
        return Some(reasoning);
    }
    for pointer in ["/supported_parameters", "/supportedParameters"] {
        if let Some(parameters) = value.pointer(pointer).and_then(Value::as_array) {
            let reasoning = parameters.iter().any(|parameter| {
                let name = parameter
                    .as_str()
                    .or_else(|| parameter.get("name").and_then(Value::as_str))
                    .or_else(|| parameter.get("id").and_then(Value::as_str));
                name.is_some_and(|name| matches!(name, "reasoning" | "reasoning_effort" | "reasoning.effort"))
            });
            return Some(reasoning);
        }
    }
    if value.pointer("/reasoning").is_some_and(Value::is_object) {
        return Some(true);
    }
    None
}

fn default_effort(levels: &[&str], explicit: Option<&str>, inferred: Option<&str>) -> Option<String> {
    explicit
        .and_then(normalized_effort)
        .filter(|level| levels.contains(level))
        .or_else(|| inferred.filter(|level| levels.contains(level)))
        .or_else(|| levels.contains(&"medium").then_some("medium"))
        .or_else(|| levels.first().copied())
        .map(str::to_string)
}

fn discovered_model(value: &Value) -> Option<CustomModel> {
    let api_id = if let Some(api_id) = value.as_str().map(str::trim).filter(|id| !id.is_empty()) {
        api_id.to_string()
    } else {
        text_at(value, &["/id", "/model", "/slug", "/name"])?.to_string()
    };
    let label = text_at(
        value,
        &["/display_name", "/displayName", "/friendly_name", "/friendlyName", "/label", "/title", "/name"],
    )
    .unwrap_or(&api_id)
    .to_string();
    let description = text_at(value, &["/description", "/desc"]).map(str::to_string);
    let context_window = positive_u64_at(
        value,
        &[
            "/context_length",
            "/context_window",
            "/contextWindow",
            "/max_context_window",
            "/max_input_tokens",
            "/input_token_limit",
            "/max_model_len",
            "/n_ctx",
            "/meta/n_ctx",
            "/top_provider/context_length",
            "/limits/context_window",
            "/metadata/context_window",
        ],
    );
    let explicit_levels = efforts_at(
        value,
        &[
            "/supported_reasoning_levels",
            "/supported_reasoning_efforts",
            "/reasoning_levels",
            "/reasoningLevels",
            "/reasoning_efforts",
            "/reasoningEfforts",
            "/reasoning_effort_levels",
            "/supported_efforts",
            "/supportedEfforts",
            "/reasoning/efforts",
            "/reasoning/levels",
            "/reasoning/supported_efforts",
            "/capabilities/reasoning/efforts",
        ],
    );
    let support = reasoning_support_at(value);
    let inference = (explicit_levels.is_empty() && support != Some(false))
        .then(|| inferred_reasoning_levels(&api_id, &label))
        .flatten();
    let levels = if explicit_levels.is_empty() {
        inference.map(|(levels, _)| levels.to_vec()).unwrap_or_default()
    } else {
        explicit_levels
    };
    let explicit_default = text_at(
        value,
        &[
            "/default_reasoning_level",
            "/default_reasoning_effort",
            "/reasoning_effort",
            "/defaultReasoningLevel",
            "/reasoning/default_effort",
            "/reasoning/default",
            "/capabilities/reasoning/default",
        ],
    );
    let inferred_default = inference.map(|(_, default)| default);
    let default = default_effort(&levels, explicit_default, inferred_default);
    let mut model = CustomModel {
        label,
        api_id,
        context_window,
        description,
        reasoning_levels: (!levels.is_empty()).then(|| levels.iter().map(|level| (*level).to_string()).collect()),
        default_reasoning_level: default,
        default_reasoning_level_explicit: false,
        enabled: None,
    };
    if model.reasoning_levels.is_some() {
        normalize_reasoning(&mut model).ok()?;
    }
    Some(model)
}

fn model_entries(root: &Value) -> Vec<&Value> {
    if let Some(models) = root.as_array() {
        return models.iter().collect();
    }
    for pointer in ["/data", "/models", "/result", "/data/models"] {
        if let Some(models) = root.pointer(pointer).and_then(Value::as_array) {
            return models.iter().collect();
        }
    }
    if root.get("id").is_some() || root.get("slug").is_some() { vec![root] } else { Vec::new() }
}

fn parse_discovered_models(source: &str) -> Result<Vec<CustomModel>, String> {
    let root: Value =
        serde_json::from_str(source).map_err(|_| "The provider returned invalid model JSON".to_string())?;
    let mut models = BTreeMap::new();
    for entry in model_entries(&root) {
        if let Some(model) = discovered_model(entry) {
            models.entry(model.api_id.clone()).or_insert(model);
        }
    }
    if models.is_empty() {
        return Err("The provider returned no models".into());
    }
    Ok(models.into_values().collect())
}

fn redacted_message(message: &str, secret: &str) -> String {
    let mut message = if secret.is_empty() { message.to_string() } else { message.replace(secret, "[redacted]") };
    message.truncate(message.floor_char_boundary(400));
    message
}

fn discovery_failure(status: u16, body: &str, secret: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| value.get("message").and_then(Value::as_str))
                .or_else(|| value.get("detail").and_then(Value::as_str))
                .map(str::to_string)
        })
        .map(|message| redacted_message(&message, secret));
    match detail {
        Some(detail) => format!("The provider returned HTTP {status}: {detail}"),
        None => format!("The provider returned HTTP {status}"),
    }
}

fn build_models_request(
    client: &reqwest::Client, base_url: &str, api_key: &str,
) -> Result<reqwest::Request, reqwest::Error> {
    client
        .get(models_endpoint(base_url))
        .bearer_auth(api_key)
        .header(reqwest::header::ACCEPT, "application/json")
        .build()
}

async fn discover_models(base_url: &str, api_key: &str) -> Result<Vec<CustomModel>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        // Never forward a bearer token to a different host after a redirect.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| redacted_message(&error.to_string(), api_key))?;
    let request = build_models_request(&client, base_url, api_key)
        .map_err(|error| redacted_message(&error.to_string(), api_key))?;
    let response = client.execute(request).await.map_err(|error| redacted_message(&error.to_string(), api_key))?;
    let status = response.status();
    let body = response.text().await.map_err(|error| redacted_message(&error.to_string(), api_key))?;
    if !status.is_success() {
        return Err(discovery_failure(status.as_u16(), &body, api_key));
    }
    parse_discovered_models(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_proxy_uses_the_enabled_https_endpoint() {
        let output = r#"
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 8443
  HTTPSProxy : 10.0.0.8
}
"#;
        assert_eq!(system_proxy_from_scutil(output).as_deref(), Some("http://10.0.0.8:8443"));
    }

    #[test]
    fn macos_proxy_falls_back_to_http_and_ignores_disabled_proxy() {
        let http_only =
            "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 0\n}\n";
        assert_eq!(system_proxy_from_scutil(http_only).as_deref(), Some("http://127.0.0.1:7890"));
        let disabled = "<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n}\n";
        assert_eq!(system_proxy_from_scutil(disabled), None);
    }

    /// TOML only treats `model_provider` as a top-level key while it precedes EVERY table header.
    /// A bare "the line exists / appears once" assertion cannot catch it landing inside a
    /// `[projects."…"]` table, which is exactly the 2026-11-08 cross-machine failure.
    fn assert_top_level_provider(config: &str) {
        let provider_at = config
            .lines()
            .position(|line| line.trim() == "model_provider = \"alwith\"")
            .expect("missing model_provider line");
        let first_table_at = config
            .lines()
            .position(|line| line.trim_start().starts_with('['))
            .expect("expected at least one table header");
        assert!(
            provider_at < first_table_at,
            "model_provider landed on line {} — after the first table header on line {}:\n{config}",
            provider_at + 1,
            first_table_at + 1
        );
        // It must also sit OUTSIDE the managed region: render_managed_config drops everything
        // from the first marker up to the next non-`[model_providers.*]` table header.
        if let Some(marker_at) = config.lines().position(|line| line.trim() == MANAGED_MARKER) {
            assert!(
                provider_at < marker_at,
                "model_provider landed inside the managed region (line {} vs marker on line {}):\n{config}",
                provider_at + 1,
                marker_at + 1
            );
        }
    }

    fn deepseek_credential(disabled: bool) -> Credential {
        Credential { protocol: Protocol::Responses, api_key: "sk-test".into(), region: None, base_url: None, disabled }
    }

    #[test]
    fn deepseek_default_close_flips_an_open_credential_once() {
        let mut saved = Saved {
            credentials: BTreeMap::from([("deepseek".to_string(), deepseek_credential(false))]),
            ..Saved::default()
        };
        // First load: the credential is closed and the marker is set so the flip persists.
        assert!(close_deepseek_by_default(&mut saved));
        assert!(saved.deepseek_default_closed);
        assert!(saved.credentials["deepseek"].disabled);
        // The key survives the close — re-enabling must not ask for it again.
        assert_eq!(saved.credentials["deepseek"].api_key, "sk-test");
        // Second load: the marker is already set, so nothing is touched again.
        assert!(!close_deepseek_by_default(&mut saved));
        assert!(saved.credentials["deepseek"].disabled);
    }

    #[test]
    fn deepseek_default_close_keeps_a_deliberate_reenable_across_restarts() {
        let mut saved = Saved {
            credentials: BTreeMap::from([("deepseek".to_string(), deepseek_credential(false))]),
            ..Saved::default()
        };
        close_deepseek_by_default(&mut saved);
        // The reader re-enables DeepSeek on purpose after the one-shot close.
        saved.credentials.get_mut("deepseek").unwrap().disabled = false;
        // A later launch must NOT close it again: the marker is already persisted.
        assert!(!close_deepseek_by_default(&mut saved));
        assert!(!saved.credentials["deepseek"].disabled);
    }

    #[test]
    fn deepseek_default_close_persists_the_marker_even_with_no_credential() {
        // Nothing to flip, but the marker still has to be recorded — otherwise a reader who adds
        // and enables DeepSeek later would be closed again on the next launch.
        let mut saved = Saved::default();
        assert!(close_deepseek_by_default(&mut saved));
        assert!(saved.deepseek_default_closed);
        assert!(!close_deepseek_by_default(&mut saved));
    }

    #[test]
    fn deepseek_default_close_leaves_other_providers_alone() {
        let mut saved = Saved {
            credentials: BTreeMap::from([
                ("deepseek".to_string(), deepseek_credential(false)),
                ("qwen".to_string(), deepseek_credential(false)),
            ]),
            ..Saved::default()
        };
        close_deepseek_by_default(&mut saved);
        assert!(saved.credentials["deepseek"].disabled);
        assert!(!saved.credentials["qwen"].disabled);
    }

    #[test]
    fn first_deepseek_save_defaults_to_closed_but_an_explicit_flag_wins() {
        let saved = Saved::default();
        // No prior credential: a first save lands closed (the company stopped offering it).
        let closed = update(
            &saved,
            "deepseek".into(),
            Some(Input {
                protocol: None,
                api_key: Some("sk-test".into()),
                region: None,
                base_url: None,
                disabled: None,
            }),
            saved.revision,
        )
        .unwrap();
        assert!(closed.credentials["deepseek"].disabled);
        // An explicit re-enable on that same first save is a deliberate choice and must win.
        let enabled = update(
            &saved,
            "deepseek".into(),
            Some(Input {
                protocol: None,
                api_key: Some("sk-test".into()),
                region: None,
                base_url: None,
                disabled: Some(false),
            }),
            saved.revision,
        )
        .unwrap();
        assert!(!enabled.credentials["deepseek"].disabled);
        // Once a credential exists, a later save without a flag keeps whatever state it had —
        // the default-close only applies to the very first connection.
        let mut existing = saved.clone();
        existing.credentials.insert("deepseek".to_string(), deepseek_credential(false));
        let kept = update(
            &existing,
            "deepseek".into(),
            Some(Input {
                protocol: None,
                api_key: Some("sk-test".into()),
                region: None,
                base_url: None,
                disabled: None,
            }),
            existing.revision,
        )
        .unwrap();
        assert!(!kept.credentials["deepseek"].disabled);
    }

    #[test]
    fn base_urls_are_roots_not_concrete_endpoints() {
        // OpenRouter's quickstart base URL is already correct and must survive untouched.
        assert_eq!(normalize_base_url("  https://openrouter.ai/api/v1  ").unwrap(), "https://openrouter.ai/api/v1");
        // A curl-example URL is the mistake users actually make; saving it verbatim produced
        // `/chat/completions/responses` on every turn.
        assert_eq!(
            normalize_base_url("https://openrouter.ai/api/v1/chat/completions").unwrap(),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(
            normalize_base_url("https://openrouter.ai/api/v1/responses/").unwrap(),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(normalize_base_url("https://api.deepseek.com/").unwrap(), "https://api.deepseek.com");
        // A prefix that happens to contain the word is not an endpoint.
        assert_eq!(
            normalize_base_url("https://example.com/v1/models-router").unwrap(),
            "https://example.com/v1/models-router"
        );
        assert!(normalize_base_url("http://openrouter.ai/api/v1").is_err());
    }

    fn test_catalog_dir() -> &'static Path {
        static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
        DIRECTORY
            .get_or_init(|| {
                let path =
                    std::env::temp_dir().join(format!("alwith-u-provider-catalog-tests-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&path).unwrap();
                path
            })
            .as_path()
    }

    /// Codex validates the whole catalog file against its model schema and rejects the entire
    /// configuration when one entry is incomplete, so every shipped catalog has to come out of
    /// `write_bundled_catalog` complete — Kimi, GLM and MiniMax ship identity-only files.
    #[test]
    fn every_bundled_catalog_is_completed_before_codex_reads_it() {
        let resources = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/resources"));
        let directory = tempfile::tempdir().unwrap();
        for provider in catalog() {
            let Some(relative) = provider["catalog"].as_str() else { continue };
            let id = provider["id"].as_str().expect("provider id");
            let written = write_bundled_catalog(directory.path(), id, &resources.join(relative)).unwrap();
            let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&written).unwrap()).unwrap();
            let models = parsed["models"].as_array().unwrap();
            assert!(!models.is_empty(), "{relative} has no models");
            for entry in models {
                assert!(entry.get("shell_type").is_some(), "{relative} still lacks shell_type");
            }
        }
    }

    async fn reconcile_test(inner: &mut Inner, client: &RuntimeClient) -> Result<(), String> {
        // Reconciling a built-in provider reads its bundled catalog, so the test has to hand in the
        // real resource tree instead of a made-up root: "/resources" does not exist.
        reconcile(inner, client, Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/resources")), test_catalog_dir()).await
    }

    #[test]
    fn custom_model_effort_defaults_cover_qwen_claude_and_deepseek() {
        let input = |label: &str, api_id: &str| CustomModel {
            label: label.into(),
            api_id: api_id.into(),
            context_window: None,
            description: None,
            reasoning_levels: None,
            default_reasoning_level: None,
            default_reasoning_level_explicit: false,
            enabled: None,
        };
        for (label, api_id, levels, default) in [
            ("Qwen 3.8 Flash", "qwen3.8-flash", vec!["none", "low", "medium", "xhigh"], "xhigh"),
            // Qwen4 preview accepts none/low/medium/high/xhigh/max (verified 200) and defaults high.
            ("4 Max Preview", "qwen4-max-preview", vec!["none", "low", "medium", "high", "xhigh", "max"], "high"),
            // 3.7 and earlier publish the full ladder; `none` disables thinking for real.
            ("Qwen 3.7 Max", "qwen3.7-max", vec!["none", "minimal", "low", "medium", "high", "xhigh", "max"], "medium"),
            ("Claude Opus", "claude-opus-5-5", vec!["low", "medium", "high", "max"], "medium"),
            ("Claude Sonnet", "claude-sonnet-5-5", vec!["low", "medium", "high", "max"], "medium"),
            // DeepSeek collapses medium/xhigh/ultra on its side, so the ladder stays short; the
            // service default is `high`, and `none` is the documented way to skip thinking.
            ("DeepSeek", "deepseek-flash", vec!["none", "low", "high", "max"], "high"),
            // K3 accepts exactly three levels and defaults to the most expensive one.
            ("Kimi K3", "kimi-k3", vec!["low", "high", "max"], "max"),
        ] {
            let mut model = input(label, api_id);
            normalize_reasoning(&mut model).unwrap();
            assert_eq!(model.reasoning_levels.unwrap(), levels);
            assert_eq!(model.default_reasoning_level.as_deref(), Some(default));
        }
    }

    #[test]
    fn models_that_reject_reasoning_effort_get_no_ladder() {
        // Offering a level the vendor answers with a 400 is worse than offering none: the picker
        // would look complete and every turn would fail. Only Kimi's K3 family takes the field.
        for api_id in ["kimi-k2.6", "kimi-k2.7-code", "moonshot-v1-128k"] {
            assert!(inferred_reasoning_levels(api_id, api_id).is_none(), "{api_id} must publish no ladder");
        }
        assert!(inferred_reasoning_levels("kimi-k3", "Kimi K3").is_some());
        assert!(inferred_reasoning_levels("kimi-k3.1-pro", "K3.1 Pro").is_some());
    }

    #[test]
    fn custom_model_effort_override_is_normalized_and_validated() {
        let mut model = CustomModel {
            label: "Custom".into(),
            api_id: "custom-model".into(),
            context_window: None,
            description: None,
            reasoning_levels: Some(vec![" Low ".into(), "HIGH".into()]),
            default_reasoning_level: Some(" HIGH ".into()),
            default_reasoning_level_explicit: false,
            enabled: None,
        };
        normalize_reasoning(&mut model).unwrap();
        assert_eq!(model.reasoning_levels, Some(vec!["low".into(), "high".into()]));
        assert_eq!(model.default_reasoning_level.as_deref(), Some("high"));

        model.default_reasoning_level = Some("max".into());
        assert_eq!(
            normalize_reasoning(&mut model).unwrap_err(),
            "defaultReasoningLevel must be one of reasoningLevels"
        );
        model.default_reasoning_level = None;
        model.reasoning_levels = Some(vec!["invalid".into()]);
        assert_eq!(normalize_reasoning(&mut model).unwrap_err(), "Unknown reasoning effort: invalid");
    }

    #[test]
    fn region_change_preserves_private_key_and_public_snapshot_never_contains_it() {
        let saved = update(
            &Saved::default(),
            "qwen".into(),
            Some(Input {
                protocol: None,
                api_key: Some("private-test-secret".into()),
                region: Some("intl".into()),
                base_url: None,
                disabled: None,
            }),
            0,
        )
        .unwrap();
        let saved = update(
            &saved,
            "qwen".into(),
            Some(Input { protocol: None, api_key: None, region: Some("cn".into()), base_url: None, disabled: None }),
            1,
        )
        .unwrap();
        assert_eq!(saved.credentials["qwen"].api_key, "private-test-secret");
        assert_eq!(saved.credentials["qwen"].region.as_deref(), Some("cn"));
        let inner = Inner {
            saved,
            applied: BTreeMap::new(),
            applied_revision: None,
            error: None,
            managed_error: None,
            resource_dir: PathBuf::from("/"),
            managed_active: false,
        };
        let public = serde_json::to_string(&inner.snapshot()).unwrap();
        assert!(!public.contains("private-test-secret"));
        assert!(!public.contains("apiKey"));
        assert!(public.contains("pending"));
    }
    #[test]
    fn closing_a_provider_keeps_its_key_so_re_enabling_needs_no_re_entry() {
        let saved = update(
            &Saved::default(),
            "deepseek".into(),
            Some(Input {
                protocol: None,
                api_key: Some("kept-secret".into()),
                region: None,
                base_url: None,
                disabled: None,
            }),
            0,
        )
        .unwrap();
        // Close: the frontend sends only the flag, no key.
        let closed = update(
            &saved,
            "deepseek".into(),
            Some(Input { protocol: None, api_key: None, region: None, base_url: None, disabled: Some(true) }),
            1,
        )
        .unwrap();
        assert_eq!(closed.credentials["deepseek"].api_key, "kept-secret");
        assert!(closed.credentials["deepseek"].disabled);
        let inner = Inner {
            saved: closed,
            applied: BTreeMap::new(),
            applied_revision: None,
            error: None,
            managed_error: None,
            resource_dir: PathBuf::from("/"),
            managed_active: false,
        };
        let snapshot = inner.snapshot();
        assert!(!snapshot.providers["deepseek"].configured);
        assert!(snapshot.providers["deepseek"].disabled);
        assert!(!desired_providers(&inner.saved).contains_key("deepseek"));

        // Re-enable is the same flag the other way round; the key is still there.
        let reopened = update(
            &inner.saved,
            "deepseek".into(),
            Some(Input { protocol: None, api_key: None, region: None, base_url: None, disabled: Some(false) }),
            2,
        )
        .unwrap();
        assert_eq!(reopened.credentials["deepseek"].api_key, "kept-secret");
        assert!(!reopened.credentials["deepseek"].disabled);
    }

    #[test]
    fn stale_edits_and_invalid_regions_do_not_replace_credentials() {
        let saved = Saved::default();
        assert!(update(&saved, "qwen".into(), None, 1).is_err());
        assert!(
            update(
                &saved,
                "qwen".into(),
                Some(Input {
                    protocol: None,
                    api_key: Some("test".into()),
                    region: Some("invalid".into()),
                    base_url: None,
                    disabled: None
                }),
                0
            )
            .is_err()
        );
        assert!(saved.credentials.is_empty());
    }
    #[test]
    fn atomic_storage_roundtrips_and_is_private() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("providers.json");
        let saved = update(
            &Saved::default(),
            "deepseek".into(),
            Some(Input { protocol: None, api_key: Some("test".into()), region: None, base_url: None, disabled: None }),
            0,
        )
        .unwrap();
        persist(&path, &saved).unwrap();
        let loaded: Saved = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(loaded.revision, 1);
        assert_eq!(loaded.credentials["deepseek"].api_key, "test");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn legacy_provider_file_without_page_configuration_still_loads() {
        let saved: Saved = serde_json::from_str(
            r#"{"revision":4,"credentials":{"deepseek":{"apiKey":"private-test-secret","region":null}}}"#,
        )
        .unwrap();
        assert_eq!(saved.revision, 4);
        assert_eq!(saved.credentials["deepseek"].base_url, None);
        assert!(saved.custom_providers.is_empty());
    }

    #[test]
    fn built_in_base_url_override_is_normalized_and_keeps_the_private_key() {
        let saved = update(
            &Saved::default(),
            "deepseek".into(),
            Some(Input {
                protocol: None,
                api_key: Some("private-test-secret".into()),
                region: None,
                base_url: Some("https://gateway.example.test/v1/".into()),
                disabled: None,
            }),
            0,
        )
        .unwrap();
        assert_eq!(saved.credentials["deepseek"].base_url.as_deref(), Some("https://gateway.example.test/v1"));
        assert!(
            !serde_json::to_string(
                &Inner {
                    saved,
                    applied: BTreeMap::new(),
                    applied_revision: None,
                    error: None,
                    managed_error: None,
                    resource_dir: PathBuf::from("/"),
                    managed_active: false
                }
                .snapshot()
            )
            .unwrap()
            .contains("private-test-secret")
        );
    }

    #[test]
    fn custom_provider_requires_a_responses_url_and_unique_non_empty_models() {
        let input = CustomInput {
            id: Some("custom_existing".into()),
            name: "Private gateway".into(),
            api_key: Some("private-test-secret".into()),
            base_url: "https://gateway.example.test/v1/".into(),
            models: vec![CustomModel {
                label: "Model A".into(),
                api_id: "model-a".into(),
                context_window: Some(128_000),
                description: Some("Fast".into()),
                reasoning_levels: None,
                default_reasoning_level: None,
                default_reasoning_level_explicit: false,
                enabled: None,
            }],
        };
        let saved = update_custom(&Saved::default(), input, 0).unwrap();
        let provider = &saved.custom_providers["custom_existing"];
        assert_eq!(provider.base_url, "https://gateway.example.test/v1");
        assert_eq!(provider.models[0].api_id, "model-a");
        assert!(
            !serde_json::to_string(
                &Inner {
                    saved,
                    applied: BTreeMap::new(),
                    applied_revision: None,
                    error: None,
                    managed_error: None,
                    resource_dir: PathBuf::from("/"),
                    managed_active: false
                }
                .snapshot()
            )
            .unwrap()
            .contains("private-test-secret")
        );

        let duplicate = CustomInput {
            id: None,
            name: "Duplicate".into(),
            api_key: Some("key".into()),
            base_url: "https://gateway.example.test/v1".into(),
            models: vec![
                CustomModel {
                    label: "A".into(),
                    api_id: "same".into(),
                    context_window: None,
                    description: None,
                    reasoning_levels: None,
                    default_reasoning_level: None,
                    default_reasoning_level_explicit: false,
                    enabled: None,
                },
                CustomModel {
                    label: "B".into(),
                    api_id: "same".into(),
                    context_window: None,
                    description: None,
                    reasoning_levels: None,
                    default_reasoning_level: None,
                    default_reasoning_level_explicit: false,
                    enabled: None,
                },
            ],
        };
        assert_eq!(update_custom(&Saved::default(), duplicate, 0).unwrap_err(), "Model IDs must be unique");
    }

    #[test]
    fn custom_model_json_keeps_the_desktop_api_id_field() {
        let input: CustomInput = serde_json::from_value(json!({
            "id": "custom_private",
            "name": "Private gateway",
            "apiKey": "private-test-secret",
            "baseUrl": "https://gateway.example.test/v1",
            "models": [{"label":"Model A","api_id":"model-a","contextWindow":128000}]
        }))
        .unwrap();
        assert_eq!(input.models[0].api_id, "model-a");
        assert_eq!(serde_json::to_value(&input.models[0]).unwrap()["api_id"], "model-a");
    }

    #[test]
    fn removing_a_custom_provider_builds_a_new_revision_without_mutating_the_saved_snapshot() {
        let saved = update_custom(
            &Saved::default(),
            CustomInput {
                id: Some("custom_private".into()),
                name: "Private gateway".into(),
                api_key: Some("private-test-secret".into()),
                base_url: "https://gateway.example.test/v1".into(),
                models: vec![CustomModel {
                    label: "Model A".into(),
                    api_id: "model-a".into(),
                    context_window: None,
                    description: None,
                    reasoning_levels: None,
                    default_reasoning_level: None,
                    default_reasoning_level_explicit: false,
                    enabled: None,
                }],
            },
            0,
        )
        .unwrap();
        let next = remove_custom(&saved, "custom_private", 1).unwrap();
        assert_eq!(next.revision, 2);
        assert!(next.custom_providers.is_empty());
        assert!(saved.custom_providers.contains_key("custom_private"));
        assert!(remove_custom(&saved, "custom_private", 0).is_err());
    }

    #[test]
    fn response_errors_are_classified_and_secrets_are_redacted() {
        let body = r#"{"error":{"message":"Invalid key private-test-secret"}}"#;
        let failure = classify_response_failure(401, body, "private-test-secret");
        assert_eq!(failure.code, "unauthorized");
        assert_eq!(failure.status, Some(401));
        assert!(!failure.message.contains("private-test-secret"));
    }

    #[test]
    fn a_success_status_with_a_non_responses_body_is_not_reported_as_connected() {
        let result = classify_success_response(200, "<html>proxy login</html>", 12);
        assert!(!result.ok);
        assert_eq!(result.code, "invalid_response");
        assert_eq!(result.status, Some(200));
    }

    #[test]
    fn no_catalog_entry_requests_an_early_compaction() {
        let provider = CustomProvider {
            id: "litellm".into(),
            name: "LiteLLM".into(),
            base_url: "https://ai-gateway.example/v1".into(),
            api_key: "k".into(),
            models: vec![CustomModel {
                label: "DS 4.1 Flash".into(),
                api_id: "deepseek-V4.1-flash".into(),
                context_window: Some(1_000_000),
                description: None,
                reasoning_levels: None,
                default_reasoning_level: None,
                default_reasoning_level_explicit: false,
                enabled: None,
            }],
        };
        // The window is spelled out so the engine stops guessing, but the threshold is left to
        // Codex's own 95% default — the user's choice, and the only value the engine honours.
        let catalog = custom_catalog(&provider).unwrap();
        assert_eq!(catalog["models"][0]["context_window"], 1_000_000);
        assert!(catalog["models"][0].get("auto_compact_token_limit").is_none());
    }

    #[test]
    fn inject_default_reasoning_only_touches_supported_levels_and_is_idempotent() {
        let mut catalog = json!({
            "models": [
                {
                    "slug": "deepseek-V4.1-flash",
                    "supported_reasoning_levels": [
                        {"effort": "low"}, {"effort": "high"}, {"effort": "max"}
                    ],
                    "default_reasoning_level": "high"
                },
                {
                    // A model that does not advertise `max` must be left alone.
                    "slug": "other",
                    "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}],
                    "default_reasoning_level": "high"
                }
            ]
        });
        // First pass writes Max on the company model only.
        let written = inject_default_reasoning(&mut catalog, Some("max"));
        assert_eq!(written, 1, "only the company model should change");
        assert_eq!(catalog["models"][0]["default_reasoning_level"], "max");
        assert_eq!(catalog["models"][1]["default_reasoning_level"], "high", "unsupported model untouched");
        // Re-running with the same level is a no-op (idempotent).
        let again = inject_default_reasoning(&mut catalog, Some("max"));
        assert_eq!(again, 0, "already at Max: nothing to write");
        // A different level lands on every model that supports it (the "other" model advertises
        // `low`, so lowering to `low` changes it too — the function is catalog-wide, not just the
        // company model).
        let lowered = inject_default_reasoning(&mut catalog, Some("low"));
        assert_eq!(lowered, 2);
        assert_eq!(catalog["models"][0]["default_reasoning_level"], "low");
        assert_eq!(catalog["models"][1]["default_reasoning_level"], "low");
        // None is a no-op.
        assert_eq!(inject_default_reasoning(&mut catalog, None), 0);
    }

    #[tokio::test]
    async fn unchanged_catalog_acknowledges_revision_while_another_turn_runs() {
        use std::sync::atomic::AtomicBool;
        let (client, calls) = fake_runtime(Arc::new(AtomicBool::new(true)), Arc::new(AtomicBool::new(false)));
        let mut inner = Inner {
            saved: Saved::default(),
            applied: BTreeMap::new(),
            applied_revision: None,
            error: None,
            managed_error: None,
            resource_dir: PathBuf::from("/"),
            managed_active: false,
        };
        reconcile_test(&mut inner, &client).await.unwrap();
        assert_eq!(inner.snapshot().status, "applied");
        assert!(calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn draft_catalog_read_does_not_wait_for_another_sessions_admission() {
        let admission = tokio::sync::Mutex::new(());
        let sending = admission.lock().await;
        let error = try_apply_admission(&admission).unwrap_err();
        assert!(application_pending(&error));
        drop(sending);
        assert!(try_apply_admission(&admission).is_ok());
    }

    fn pending_provider() -> Inner {
        let saved = update(
            &Saved::default(),
            "qwen".into(),
            Some(Input {
                protocol: None,
                api_key: Some("private-test-secret".into()),
                region: Some("cn".into()),
                base_url: None,
                disabled: None,
            }),
            0,
        )
        .unwrap();
        // Reconciliation reads the bundled catalog of the provider it applies, so the fixture has to
        // point at the real resource tree: "/" made every one of these tests fail on a missing file.
        Inner {
            saved,
            applied: BTreeMap::new(),
            applied_revision: None,
            error: None,
            managed_error: None,
            resource_dir: PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/resources")),
            managed_active: false,
        }
    }
    fn fake_runtime(
        active: Arc<std::sync::atomic::AtomicBool>, fail: Arc<std::sync::atomic::AtomicBool>,
    ) -> (RuntimeClient, Arc<std::sync::Mutex<Vec<Value>>>) {
        fake_runtime_with_busy(active, fail, Arc::new(std::sync::atomic::AtomicBool::new(false)))
    }
    fn fake_runtime_with_busy(
        active: Arc<std::sync::atomic::AtomicBool>, fail: Arc<std::sync::atomic::AtomicBool>,
        busy: Arc<std::sync::atomic::AtomicBool>,
    ) -> (RuntimeClient, Arc<std::sync::Mutex<Vec<Value>>>) {
        fake_runtime_state(active, fail, busy, None)
    }
    fn fake_runtime_with_interruption(
        active: Arc<std::sync::atomic::AtomicBool>, fail: Arc<std::sync::atomic::AtomicBool>,
        interruption: Option<&'static str>,
    ) -> (RuntimeClient, Arc<std::sync::Mutex<Vec<Value>>>) {
        fake_runtime_state(active, fail, Arc::new(std::sync::atomic::AtomicBool::new(false)), interruption)
    }
    fn fake_runtime_state(
        active: Arc<std::sync::atomic::AtomicBool>, fail: Arc<std::sync::atomic::AtomicBool>,
        busy: Arc<std::sync::atomic::AtomicBool>, interruption: Option<&'static str>,
    ) -> (RuntimeClient, Arc<std::sync::Mutex<Vec<Value>>>) {
        use std::sync::atomic::Ordering;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        let (host, peer) = tokio::io::duplex(16384);
        let (reader, writer) = tokio::io::split(host);
        let client = RuntimeClient::over(reader, writer);
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = Arc::clone(&calls);
        tokio::spawn(async move {
            let (reader, mut writer) = tokio::io::split(peer);
            let mut lines = tokio::io::BufReader::new(reader).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let frame: Value = serde_json::from_str(&line).unwrap();
                let (result, error) = if frame["method"] == "runStates" {
                    (
                        if active.load(Ordering::SeqCst) {
                            json!([{"sessionId":"active","state":if interruption.is_some() { "requires_action" } else { "running" },"version":1,"interruption":interruption,"reusableDraft":false,"owner":"u","cwd":"/tmp","title":"","since":0,"tasks":[],"listeningPorts":[],"executionId":null,"executionRole":null,"lastActivityAt":0}])
                        } else {
                            json!([])
                        },
                        Value::Null,
                    )
                } else {
                    recorded.lock().unwrap().push(frame.clone());
                    if busy.load(Ordering::SeqCst) && frame["params"]["params"]["_meta"]["codex"]["id"] == "qwen" {
                        (
                            Value::Null,
                            json!({"code":-32600,"message":"Invalid request: Wait for affected sessions to finish before changing their provider"}),
                        )
                    } else if fail.load(Ordering::SeqCst) {
                        (Value::Null, json!({"code":-32000,"message":"private-test-secret upstream failure"}))
                    } else {
                        (json!({}), Value::Null)
                    }
                };
                let response = json!({"id":frame["id"],"result":result,"error":error}).to_string() + "\n";
                if writer.write_all(response.as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        (client, calls)
    }
    #[tokio::test]
    async fn restored_interrupted_session_allows_saved_provider_application() {
        use std::sync::atomic::AtomicBool;
        let (client, calls) = fake_runtime_with_interruption(
            Arc::new(AtomicBool::new(true)),
            Arc::new(AtomicBool::new(false)),
            Some("runtime_stopped"),
        );
        let mut inner = pending_provider();
        reconcile_test(&mut inner, &client).await.unwrap();
        assert_eq!(inner.snapshot().status, "applied");
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn unrelated_active_turn_does_not_block_new_provider() {
        use std::sync::atomic::AtomicBool;
        let (client, calls) = fake_runtime(Arc::new(AtomicBool::new(true)), Arc::new(AtomicBool::new(false)));
        let mut inner = pending_provider();
        reconcile_test(&mut inner, &client).await.unwrap();
        reconcile_test(&mut inner, &client).await.unwrap();
        assert_eq!(inner.snapshot().status, "applied");
        assert_eq!(inner.applied_revision, Some(1));
        assert_eq!(calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn busy_provider_does_not_block_independent_changes_and_retries_only_pending() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let busy = Arc::new(AtomicBool::new(true));
        let (client, calls) =
            fake_runtime_with_busy(Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)), busy.clone());
        let mut inner = pending_provider();
        let mut key = inner.saved.credentials["qwen"].clone();
        key.region = None;
        inner.saved.credentials.insert("xai".into(), key);
        assert!(reconcile_test(&mut inner, &client).await.is_err());
        assert_eq!(inner.snapshot().status, "pending");
        assert!(inner.error.is_none());
        assert!(inner.applied.contains_key("xai"));
        assert!(!inner.applied.contains_key("qwen"));
        busy.store(false, Ordering::SeqCst);
        reconcile_test(&mut inner, &client).await.unwrap();
        assert_eq!(inner.snapshot().status, "applied");
        let calls = calls.lock().unwrap();
        let ids: Vec<_> =
            calls.iter().map(|call| call["params"]["params"]["_meta"]["codex"]["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["qwen", "xai", "qwen"]);
    }
    #[tokio::test]
    async fn busy_removal_keeps_routing_while_other_removals_apply() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let busy = Arc::new(AtomicBool::new(true));
        let (client, calls) =
            fake_runtime_with_busy(Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)), busy.clone());
        let mut inner = pending_provider();
        let old = AppliedProvider::BuiltIn(inner.saved.credentials["qwen"].clone(), None);
        inner.applied.insert("qwen".into(), old.clone());
        inner.applied.insert("xai".into(), old);
        inner.applied_revision = Some(0);
        inner.saved.credentials.clear();
        assert!(reconcile_test(&mut inner, &client).await.is_err());
        assert_eq!(inner.snapshot().status, "pending");
        assert!(inner.applied.contains_key("qwen"));
        assert!(!inner.applied.contains_key("xai"));
        busy.store(false, Ordering::SeqCst);
        reconcile_test(&mut inner, &client).await.unwrap();
        assert!(inner.applied.is_empty());
        assert_eq!(inner.snapshot().status, "applied");
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 3);
        assert!(calls.iter().all(|call| call["params"]["method"] == "providers/disable"));
    }

    #[test]
    fn only_the_adapter_busy_response_is_pending_and_raw_errors_stay_private() {
        let mut pending = false;
        let mut failures = Vec::new();
        record_application_error(
            "qwen",
            "apply",
            &ResponseError::new(-32600, "private-test-secret"),
            &mut pending,
            &mut failures,
        );
        assert!(!pending);
        assert_eq!(failures.len(), 1);
        assert!(!failures[0].contains("private-test-secret"));
        assert!(application_pending(PROVIDERS_PENDING));
        assert!(!application_pending(&failures[0]));
    }

    #[tokio::test]
    async fn failed_apply_is_not_acknowledged_and_can_retry_without_exposing_private_error() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let fail = Arc::new(AtomicBool::new(true));
        let (client, calls) = fake_runtime(Arc::new(AtomicBool::new(false)), fail.clone());
        let mut inner = pending_provider();
        assert!(reconcile_test(&mut inner, &client).await.is_err());
        assert_eq!(inner.applied_revision, None);
        assert!(inner.applied.is_empty());
        assert_eq!(inner.snapshot().status, "failed");
        assert!(!serde_json::to_string(&inner.snapshot()).unwrap().contains("private-test-secret"));
        fail.store(false, Ordering::SeqCst);
        reconcile_test(&mut inner, &client).await.unwrap();
        assert_eq!(inner.snapshot().status, "applied");
        inner.saved = update(&inner.saved, "qwen".into(), None, 1).unwrap();
        reconcile_test(&mut inner, &client).await.unwrap();
        assert_eq!(calls.lock().unwrap().last().unwrap()["params"]["method"], "providers/disable");
        assert!(inner.applied.is_empty());
    }

    #[tokio::test]
    async fn custom_provider_models_are_mapped_from_page_schema_to_adapter_schema() {
        let saved = update_custom(
            &Saved::default(),
            CustomInput {
                id: Some("custom_private".into()),
                name: "Private gateway".into(),
                api_key: Some("private-test-secret".into()),
                base_url: "https://gateway.example.test/v1".into(),
                models: vec![CustomModel {
                    label: "Model A".into(),
                    api_id: "model-a".into(),
                    context_window: Some(128_000),
                    description: Some("Fast".into()),
                    reasoning_levels: Some(vec!["low".into(), "high".into()]),
                    default_reasoning_level: Some("high".into()),
                    default_reasoning_level_explicit: false,
                    enabled: None,
                }],
            },
            0,
        )
        .unwrap();
        let (client, calls) = fake_runtime(
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
        );
        let mut inner = Inner {
            saved,
            applied: BTreeMap::new(),
            applied_revision: None,
            error: None,
            managed_error: None,
            resource_dir: PathBuf::from("/"),
            managed_active: false,
        };
        reconcile_test(&mut inner, &client).await.unwrap();
        {
            let recorded = calls.lock().unwrap();
            let params = &recorded[0]["params"]["params"];
            let runtime_id = params["_meta"]["codex"]["id"].as_str().unwrap();
            assert!(runtime_id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'));
            assert_eq!(runtime_id, "custom-637573746f6d5f70726976617465");
            assert_eq!(params["baseUrl"], "https://gateway.example.test/v1");
            assert_eq!(params["_meta"]["codex"]["name"], "Private gateway");
            assert_eq!(
                params["_meta"]["alwith"]["models"],
                json!([{
                    "id": "model-a",
                    "label": "Model A",
                    "description": "Fast",
                    "contextWindow": 128000
                }])
            );
            let catalog_path = params["_meta"]["codex"]["config"]["model_catalog_json"].as_str().unwrap();
            let catalog: Value = serde_json::from_slice(&std::fs::read(catalog_path).unwrap()).unwrap();
            let model = &catalog["models"][0];
            assert_eq!(model["slug"], "model-a");
            assert_eq!(model["display_name"], "Model A");
            assert_eq!(model["context_window"], 128_000);
            assert_eq!(model["default_reasoning_level"], "high");
            assert_eq!(
                model["supported_reasoning_levels"],
                json!([
                    {"effort": "low", "description": "Low reasoning effort"},
                    {"effort": "high", "description": "High reasoning effort"}
                ])
            );
            assert!(model.get("comp_hash").is_none());
            assert!(model["base_instructions"].as_str().unwrap().contains("Codex"));
        }

        inner.saved = remove_custom(&inner.saved, "custom_private", 1).unwrap();
        reconcile_test(&mut inner, &client).await.unwrap();
        let calls = calls.lock().unwrap();
        assert_eq!(calls[1]["params"]["params"]["_meta"]["codex"]["id"], "custom-637573746f6d5f70726976617465");
    }

    /// The regression behind "我选的 Ling 3.2 Flash，它说自己是 Claude Opus 5.5": a catalog entry
    /// cloned from a sibling kept the sibling's identity paragraph, so the prompt told the model it
    /// was a different product. Every entry must name itself.
    #[test]
    fn a_cloned_catalog_entry_never_keeps_another_models_identity() {
        let mut cloned = catalog_template().clone();
        {
            let object = cloned.as_object_mut().unwrap();
            object.insert("slug".into(), json!("inclusionai/ling-3.2-flash:free"));
            object.insert("display_name".into(), json!("Ling 3.2 Flash"));
        }
        // Before: the template's paragraph claims Qwen's first model.
        assert!(cloned["base_instructions"].as_str().unwrap().contains("qwen4-max-preview"));

        retarget_identity(&mut cloned);
        let text = cloned["base_instructions"].as_str().unwrap();
        assert!(text.contains("Ling 3.2 Flash"));
        assert!(text.contains("inclusionai/ling-3.2-flash:free"));
        assert!(!text.contains("qwen4-max-preview"));
        // The rest of the prompt (the Codex CLI description) survives untouched.
        assert!(text.contains("Codex"));
        // Only one identity paragraph remains.
        assert_eq!(text.matches("Model identity:").count(), 1);
    }

    /// An entry with no identity paragraph at all must get one: `deepseek-V4.1-flash` opened with
    /// "You are Codex, an agent based on GPT-5" and the model repeated that verbatim.
    #[test]
    fn an_entry_without_an_identity_paragraph_gets_one_prepended() {
        let mut entry = json!({
            "slug": "deepseek-V4.1-flash",
            "display_name": "DeepSeek V4.1 Flash",
            "base_instructions": "You are Codex, an agent based on GPT-5."
        });
        retarget_identity(&mut entry);
        let text = entry["base_instructions"].as_str().unwrap();
        assert!(text.starts_with("Model identity: this session runs on DeepSeek V4.1 Flash"));
        // The original prompt survives below it.
        assert!(text.contains("You are Codex, an agent based on GPT-5."));
        assert_eq!(text.matches("Model identity:").count(), 1);
    }

    /// A built-in (native) provider's saved model override must thread its `context_window` into the
    /// per-thread `model_catalog_json` Codex reads — otherwise the chat silently falls back to the
    /// bundled window and auto-compacts mid-turn. This is the exact path Settings uses for GPT.
    #[test]
    fn built_in_override_context_window_reaches_catalog() {
        let directory = tempfile::tempdir().unwrap();
        let resources = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/resources"));
        let overrides = vec![CustomModel {
            label: "GPT Override".into(),
            api_id: "gpt-override-test".into(),
            context_window: Some(256_000),
            description: None,
            reasoning_levels: None,
            default_reasoning_level: None,
            default_reasoning_level_explicit: false,
            enabled: None,
        }];
        let path = write_built_in_catalog(directory.path(), "openai", &overrides, resources).unwrap();
        let catalog: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let model = &catalog["models"][0];
        assert_eq!(model["slug"], "gpt-override-test");
        assert_eq!(model["context_window"], 256_000);
        assert_eq!(model["max_context_window"], 256_000);
    }

    #[test]
    fn connection_test_builds_a_minimal_authenticated_responses_request() {
        let client = reqwest::Client::new();
        let request = build_test_request(
            &client,
            &TestConfig {
                base_url: "http://127.0.0.1:43210/v1".into(),
                api_key: "private-test-secret".into(),
                model: "model-a".into(),
            },
        )
        .unwrap();
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(request.url().as_str(), "http://127.0.0.1:43210/v1/responses");
        assert_eq!(request.headers()[reqwest::header::AUTHORIZATION], "Bearer private-test-secret");
        let body = request.body().and_then(reqwest::Body::as_bytes).unwrap();
        let body: Value = serde_json::from_slice(body).unwrap();
        assert_eq!(body, json!({"model":"model-a","input":"Reply with OK.","max_output_tokens":16,"store":false}));
    }

    #[test]
    fn model_discovery_reads_names_context_and_infers_effort_from_families() {
        let body = json!({
            "object": "list",
            "data": [
                {
                    "id": "claude-opus-5-5",
                    "display_name": "Claude Opus 5.5",
                    "description": "Flagship Claude",
                    "context_length": "1000000"
                },
                {
                    "id": "glm-4.7",
                    "name": "GLM 4.7",
                    "top_provider": { "context_length": 1048576 },
                    "supported_parameters": ["reasoning", "tools"]
                },
                {
                    "id": "plain-model",
                    "name": "Plain Model",
                    "supports_reasoning": false
                }
            ]
        })
        .to_string();
        let models = parse_discovered_models(&body).unwrap();
        assert_eq!(models.len(), 3);

        let claude = &models[0];
        assert_eq!(claude.api_id, "claude-opus-5-5");
        assert_eq!(claude.label, "Claude Opus 5.5");
        assert_eq!(claude.context_window, Some(1_000_000));
        assert_eq!(claude.reasoning_levels.as_ref().unwrap(), &["low", "medium", "high", "max"]);
        assert_eq!(claude.default_reasoning_level.as_deref(), Some("medium"));

        let glm = &models[1];
        assert_eq!(glm.context_window, Some(1_048_576));
        assert_eq!(glm.reasoning_levels.as_ref().unwrap(), &["low", "medium", "high"]);

        assert_eq!(models[2].label, "Plain Model");
        assert!(models[2].reasoning_levels.is_none());
        assert!(models[2].default_reasoning_level.is_none());
    }

    #[test]
    fn model_discovery_prefers_declared_efforts_and_keeps_false_support_explicit() {
        let body = json!({
            "models": [
                {
                    "id": "claude-custom",
                    "supported_reasoning_levels": [
                        {"effort": "LOW"},
                        {"effort": "extra-high"},
                        {"effort": "unsupported-level"}
                    ],
                    "default_reasoning_level": "extra-high",
                    "context_window": 200000
                },
                {
                    "id": "claude-with-reasoning-disabled",
                    "supports_reasoning": false
                }
            ]
        })
        .to_string();
        let models = parse_discovered_models(&body).unwrap();
        let declared = models.iter().find(|model| model.api_id == "claude-custom").unwrap();
        assert_eq!(declared.reasoning_levels.as_ref().unwrap(), &["low", "xhigh"]);
        assert_eq!(declared.default_reasoning_level.as_deref(), Some("xhigh"));
        let disabled = models.iter().find(|model| model.api_id == "claude-with-reasoning-disabled").unwrap();
        assert!(disabled.reasoning_levels.is_none());
    }

    #[test]
    fn model_discovery_deduplicates_ids_and_accepts_a_direct_models_endpoint() {
        let body = json!([
            {"id": "model-b"},
            {"id": "model-a", "name": "First A"},
            {"id": "model-a", "name": "Duplicate A"}
        ])
        .to_string();
        let models = parse_discovered_models(&body).unwrap();
        assert_eq!(models.iter().map(|model| model.api_id.as_str()).collect::<Vec<_>>(), ["model-a", "model-b"]);
        assert_eq!(models[0].label, "First A");
        assert_eq!(models_endpoint("https://gateway.example.test/v1/"), "https://gateway.example.test/v1/models");
        assert_eq!(models_endpoint("https://gateway.example.test/v1/models"), "https://gateway.example.test/v1/models");
    }

    #[test]
    fn model_discovery_reuses_saved_keys_and_redacts_failures() {
        let saved = update_custom(
            &Saved::default(),
            CustomInput {
                id: Some("custom_private".into()),
                name: "Private gateway".into(),
                api_key: Some("private-test-secret".into()),
                base_url: "https://gateway.example.test/v1".into(),
                models: vec![CustomModel {
                    label: "Model A".into(),
                    api_id: "model-a".into(),
                    context_window: None,
                    description: None,
                    reasoning_levels: None,
                    default_reasoning_level: None,
                    default_reasoning_level_explicit: false,
                    enabled: None,
                }],
            },
            0,
        )
        .unwrap();
        assert_eq!(discovery_api_key(&saved, Some("custom_private"), None).unwrap(), "private-test-secret");
        assert_eq!(discovery_api_key(&saved, Some("custom_private"), Some(" replacement ")).unwrap(), "replacement");
        assert!(discovery_api_key(&saved, None, None).is_err());

        let failure = discovery_failure(
            401,
            r#"{"error":{"message":"API key private-test-secret was rejected"}}"#,
            "private-test-secret",
        );
        assert!(failure.contains("HTTP 401"));
        assert!(failure.contains("[redacted]"));
        assert!(!failure.contains("private-test-secret"));
    }

    #[test]
    fn model_discovery_request_is_authenticated_and_read_only() {
        let client = reqwest::Client::new();
        let request = build_models_request(&client, "https://gateway.example.test/v1", "private-test-secret").unwrap();
        assert_eq!(request.method(), reqwest::Method::GET);
        assert_eq!(request.url().as_str(), "https://gateway.example.test/v1/models");
        assert_eq!(request.headers()[reqwest::header::AUTHORIZATION], "Bearer private-test-secret");
        assert_eq!(request.headers()[reqwest::header::ACCEPT], "application/json");
    }

    #[test]
    fn mimo_models_get_an_effort_ladder() {
        // The endpoint does not declare efforts for MiMo, so the family table has to: the docs
        // accept none/low/medium/high and treat every non-none value as "thinking on".
        let (levels, default) = inferred_reasoning_levels("mimo-v2.6-pro", "MiMo v2.6 Pro").unwrap();
        assert_eq!(levels, &["none", "low", "medium", "high"]);
        assert_eq!(default, "medium");
    }

    #[test]
    fn native_provider_overrides_reach_the_snapshot() {
        // OpenAI has no bundled catalog file; a trimmed list must still surface in the snapshot,
        // otherwise the settings row falls back to the engine's full model set ("deleted models
        // came back"). Regression guard for the early `?` that skipped providers without
        // `catalog`.
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let kept = CustomModel {
            label: "6.1 Sol".into(),
            api_id: "gpt-6.1-sol".into(),
            context_window: None,
            description: None,
            reasoning_levels: None,
            default_reasoning_level: None,
            default_reasoning_level_explicit: false,
            enabled: Some(true),
        };
        let mut overrides = BTreeMap::new();
        overrides.insert("openai".to_string(), vec![kept.clone()]);
        let models = built_in_models(&resources, &overrides);
        let native = models.get("openai").cloned().unwrap_or_default();
        assert_eq!(native.len(), 1);
        assert_eq!(native[0].api_id, "gpt-6.1-sol");
        // A provider with neither a catalog nor overrides reports an empty list, not a missing key.
        let empty = built_in_models(&resources, &BTreeMap::new());
        assert_eq!(empty.get("openai").map(Vec::len), Some(0));
    }

    #[test]
    fn a_native_gpt_entry_keeps_its_acceleration_tier() {
        // 目录条目都以 qwen4-max-preview 为模板克隆，而模板没有 additional_speed_tiers。适配器正是
        // 靠这个字段决定要不要发布 `fast-mode`，缺了整个「快速模式」入口就消失。GPT 全系在引擎的
        // 内置表里都写了 ["fast"]，所以这里必须补回去；写过空数组的（daybreak）保持原样。
        let mut plain = json!({"slug": "gpt-6.1-sol", "display_name": "6.1 Sol"});
        restore_native_speed_tiers(&mut plain);
        assert_eq!(plain["additional_speed_tiers"], json!(["fast"]));
        assert_eq!(plain["service_tiers"][0]["id"], json!("priority"));

        let mut declined = json!({"slug": "gpt-daybreak-blue-latest", "additional_speed_tiers": []});
        restore_native_speed_tiers(&mut declined);
        assert_eq!(declined["additional_speed_tiers"], json!([]), "a model that declares none keeps none");

        let mut other = json!({"slug": "qwen4-max-preview"});
        restore_native_speed_tiers(&mut other);
        assert!(other.get("additional_speed_tiers").is_none(), "a non-GPT model must not gain the switch");
    }

    /// 写一份引擎目录快照到临时 app data，模拟一次启动时同步到的内容。
    fn write_engine_catalog(root: &std::path::Path, models: Value) {
        let path = engine_catalog_path(root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_vec(&json!({ "models": models })).unwrap()).unwrap();
    }

    fn engine_row(slug: &str, display: &str, efforts: &[&str], default: &str, visible: &str) -> Value {
        json!({
            "slug": slug,
            "display_name": display,
            "visibility": visible,
            "default_reasoning_level": default,
            "supported_reasoning_levels": efforts.iter().map(|effort| json!({ "effort": effort })).collect::<Vec<_>>(),
            "additional_speed_tiers": ["fast"],
            "service_tiers": [{ "id": "priority", "name": "Fast" }],
            "context_window": 500_000,
        })
    }

    #[test]
    fn a_new_engine_model_joins_the_shortlist_and_keeps_the_old_rows() {
        // 引擎发了 6.2，用户清单里还是 6.1 / 6 —— 用户既不能去设置里手写一个 id，也不该被要求
        // 知道引擎换过型号。同步要做的：把新的按引擎顺序放到最前，effort 跟着引擎走，用户自己
        // 加的行和已选默认档一个都不能动。
        let root = tempfile::tempdir().unwrap();
        write_engine_catalog(
            root.path(),
            json!([
                engine_row(
                    "gpt-6.2-sol",
                    "GPT-6.2-Sol",
                    &["low", "medium", "high", "xhigh", "max", "ultra"],
                    "low",
                    "list"
                ),
                engine_row(
                    "gpt-6.1-sol",
                    "GPT-6.1-Sol",
                    &["low", "medium", "high", "xhigh", "max", "ultra"],
                    "low",
                    "list"
                ),
                engine_row("gpt-daybreak-blue-latest", "Daybreak Blue", &["low", "high"], "low", "hide"),
            ]),
        );
        let mut saved = Saved {
            built_in_model_overrides: BTreeMap::from([(
                "openai".to_string(),
                vec![
                    CustomModel {
                        label: "6.1 Sol".into(),
                        api_id: "gpt-6.1-sol".into(),
                        context_window: Some(1_050_000),
                        description: None,
                        reasoning_levels: Some(vec!["low".into(), "medium".into(), "high".into()]),
                        default_reasoning_level: Some("medium".into()),
                        default_reasoning_level_explicit: true,
                        enabled: None,
                    },
                    CustomModel {
                        label: "我自己的".into(),
                        api_id: "my-own-model".into(),
                        context_window: None,
                        description: None,
                        reasoning_levels: None,
                        default_reasoning_level: None,
                        default_reasoning_level_explicit: false,
                        enabled: None,
                    },
                ],
            )]),
            ..Saved::default()
        };

        assert!(sync_engine_models(root.path(), &mut saved));

        let rows = &saved.built_in_model_overrides["openai"];
        assert_eq!(rows[0].api_id, "gpt-6.2-sol", "the newest engine model comes first");
        assert_eq!(rows[0].label, "6.2 Sol", "GPT- prefix and dashes are folded into the app's short label");
        assert_eq!(
            rows[0].reasoning_levels.as_deref(),
            Some(["low", "medium", "high", "xhigh", "max", "ultra"].map(str::to_string).as_slice())
        );

        let updated = rows.iter().find(|row| row.api_id == "gpt-6.1-sol").unwrap();
        assert_eq!(
            updated.reasoning_levels.as_deref().map(<[String]>::len),
            Some(6),
            "the ladder follows the engine: three levels cannot express xhigh/max/ultra"
        );
        assert_eq!(updated.default_reasoning_level.as_deref(), Some("medium"), "the user's default is a preference");
        assert_eq!(updated.context_window, Some(1_050_000), "a window the user set is not overwritten");

        assert!(rows.iter().any(|row| row.api_id == "my-own-model"), "a row the engine never heard of survives");
        assert!(
            !rows.iter().any(|row| row.api_id == "gpt-daybreak-blue-latest"),
            "visibility=hide is the engine's own word for internal models"
        );

        // 第二次同步没有新信息，就不能再改 revision —— 否则每次启动都重写一遍 provider。
        assert!(!sync_engine_models(root.path(), &mut saved));
    }

    #[test]
    fn an_unmarked_default_follows_the_engine_but_an_explicit_one_stays() {
        let root = tempfile::tempdir().unwrap();
        write_engine_catalog(
            root.path(),
            json!([
                engine_row("gpt-6.2-sol", "GPT-6.2-Sol", &["low", "medium", "high"], "low", "list"),
                engine_row("gpt-6.1-sol", "GPT-6.1-Sol", &["low", "medium", "high"], "low", "list"),
            ]),
        );
        let mut saved = Saved {
            built_in_model_overrides: BTreeMap::from([(
                "openai".to_string(),
                vec![
                    CustomModel {
                        label: "6.2 Sol".into(),
                        api_id: "gpt-6.2-sol".into(),
                        context_window: None,
                        description: None,
                        reasoning_levels: Some(vec!["low".into(), "medium".into(), "high".into()]),
                        default_reasoning_level: Some("medium".into()),
                        default_reasoning_level_explicit: false,
                        enabled: None,
                    },
                    CustomModel {
                        label: "6.1 Sol".into(),
                        api_id: "gpt-6.1-sol".into(),
                        context_window: None,
                        description: None,
                        reasoning_levels: Some(vec!["low".into(), "medium".into(), "high".into()]),
                        default_reasoning_level: Some("medium".into()),
                        default_reasoning_level_explicit: true,
                        enabled: None,
                    },
                ],
            )]),
            ..Saved::default()
        };

        assert!(sync_engine_models(root.path(), &mut saved));
        let rows = &saved.built_in_model_overrides["openai"];
        let untouched = rows.iter().find(|row| row.api_id == "gpt-6.2-sol").unwrap();
        let explicit = rows.iter().find(|row| row.api_id == "gpt-6.1-sol").unwrap();
        assert_eq!(untouched.default_reasoning_level.as_deref(), Some("low"));
        assert_eq!(explicit.default_reasoning_level.as_deref(), Some("medium"));
    }

    #[test]
    fn a_cloned_catalog_entry_takes_its_ladder_and_speed_from_the_engine() {
        // 目录条目的骨架来自 qwen 模板：三档 effort、没有加速档位。引擎对这些型号说得很清楚，
        // 该由引擎覆盖；网关型号不在引擎目录里，一个字段都不该被碰。
        let engine = vec![EngineModel {
            slug: "gpt-6.2-astra".into(),
            label: "6.2 Astra".into(),
            efforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map(str::to_string).to_vec(),
            default_effort: Some("low".into()),
            context_window: Some(272_000),
            speed_tiers: vec!["fast".into()],
            service_tiers: json!([{ "id": "priority", "name": "Fast" }]),
            multi_agent_effort: None,
            multi_agent_version: None,
        }];
        let mut entry = json!({
            "slug": "gpt-6.2-astra",
            "supported_reasoning_levels": [{"effort": "low"}, {"effort": "medium"}, {"effort": "high"}],
            "default_reasoning_level": "medium",
        });
        apply_engine_metadata(&mut entry, &engine, false);
        assert_eq!(entry["supported_reasoning_levels"].as_array().unwrap().len(), 6);
        assert_eq!(entry["additional_speed_tiers"], json!(["fast"]));
        // A model whose engine entry does not publish the sub-agent pair gets no invented value:
        // `ultra` in the ladder is a UI choice and must never be turned into an outbound effort.
        assert!(entry.get("multi_agent_reasoning_effort").is_none());
        assert!(entry.get("multi_agent_version").is_none());
        assert_eq!(entry["default_reasoning_level"], "low", "an unmarked default follows the engine");
        let mut explicit = entry.clone();
        explicit["default_reasoning_level"] = json!("medium");
        apply_engine_metadata(&mut explicit, &engine, true);
        assert_eq!(explicit["default_reasoning_level"], "medium", "an explicit default survives");
        assert_eq!(entry["context_window"], 272_000);

        let mut gateway = json!({ "slug": "qwen3.8-max", "supported_reasoning_levels": [{"effort": "none"}] });
        apply_engine_metadata(&mut gateway, &engine, false);
        assert_eq!(gateway["supported_reasoning_levels"], json!([{"effort": "none"}]));
        assert!(gateway.get("additional_speed_tiers").is_none());
    }

    #[test]
    fn an_engine_model_missing_from_every_catalog_is_appended_once() {
        let engine = vec![EngineModel {
            slug: "gpt-6.2-sol".into(),
            label: "6.2 Sol".into(),
            efforts: ["low", "high"].map(str::to_string).to_vec(),
            default_effort: Some("low".into()),
            context_window: Some(500_000),
            speed_tiers: vec!["fast".into()],
            service_tiers: Value::Null,
            // The engine publishes the sub-agent pair for this model; the merged catalog is what
            // the engine reads, so it has to carry them through.
            multi_agent_effort: Some("xhigh".into()),
            multi_agent_version: Some("v2".into()),
        }];
        let mut entries = vec![json!({ "slug": "gpt-6.1-sol", "display_name": "6.1 Sol" })];
        let mut seen: BTreeSet<String> = BTreeSet::from(["gpt-6.1-sol".to_string()]);
        append_engine_models(&mut entries, &engine, &mut seen);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1]["slug"], "gpt-6.2-sol");
        assert_eq!(entries[1]["display_name"], "6.2 Sol");
        assert_eq!(entries[1]["additional_speed_tiers"], json!(["fast"]));
        assert_eq!(entries[1]["context_window"], 500_000);
        // Regression: dropping these made Ultra silently fall back to `max` on the native route.
        assert_eq!(entries[1]["multi_agent_reasoning_effort"], "xhigh");
        assert_eq!(entries[1]["multi_agent_version"], "v2");

        // 再跑一次不能出现第二条 —— `seen` 是跨源去重的同一张表。
        append_engine_models(&mut entries, &engine, &mut seen);
        assert_eq!(entries.len(), 2);
    }

    fn model_with_window(api_id: &str, window: Option<u64>, enabled: Option<bool>) -> CustomModel {
        CustomModel {
            label: api_id.to_string(),
            api_id: api_id.to_string(),
            context_window: window,
            description: None,
            reasoning_levels: None,
            default_reasoning_level: None,
            default_reasoning_level_explicit: false,
            enabled,
        }
    }

    #[test]
    fn context_window_uses_largest_enabled_value_and_rejects_absurd_ones() {
        let mut saved = Saved::default();
        saved.built_in_model_overrides.insert(
            "openai".to_string(),
            vec![
                model_with_window("small", Some(200_000), None),
                model_with_window("large", Some(1_048_576), None),
                model_with_window("oversized", Some(9_000_000), None),
                model_with_window("disabled", Some(1_900_000), Some(false)),
                model_with_window("unset", None, None),
            ],
        );
        saved.custom_providers.insert(
            "custom_a".to_string(),
            CustomProvider {
                id: "custom_a".into(),
                name: "A".into(),
                base_url: "https://a.test/v1".into(),
                models: vec![model_with_window("tiny", Some(500_000), None)],
                api_key: "key".into(),
            },
        );
        // Native (credential-less) overrides count too: they used to be ignored entirely.
        assert_eq!(configured_context_window(&saved), Some(1_048_576));
        saved.built_in_model_overrides.clear();
        assert_eq!(configured_context_window(&saved), Some(500_000));
        saved.custom_providers.clear();
        assert_eq!(configured_context_window(&saved), None);
    }

    #[test]
    fn the_router_token_matches_the_launcher_fallback() {
        // `codex_launcher.rs` is compiled standalone with plain `rustc`, so it cannot import this
        // constant and repeats the literal as `DEFAULT_ROUTER_TOKEN`. A change here without a
        // change there would hand the engine a token the bridge then rejects.
        assert_eq!(ROUTER_TOKEN, "alwith-router");
    }

    #[test]
    fn router_provider_block_turns_off_engine_retries() {
        // A capacity dip otherwise costs four retries of about five minutes each before the reader
        // is even told the turn failed. Two zeroes are the whole point of this block's shape.
        let block = router_provider_block("http://127.0.0.1:60639/alwith");
        assert!(block.contains("request_max_retries = 0"), "{block}");
        assert!(block.contains("stream_max_retries = 0"), "{block}");
        // Still the block `thread/resume` needs to resolve the shared provider by name.
        assert!(block.contains(&format!("[model_providers.{}]", crate::bridge::ROUTER_ID)), "{block}");
        assert!(block.contains("base_url = \"http://127.0.0.1:60639/alwith\""), "{block}");
    }

    #[test]
    fn context_window_config_is_idempotent_and_removable() {
        let existing = "model_provider = \"alwith\"\n\n# managed by ALWith\n[model_providers.qwen]\nname = \"Qwen\"\n";
        let once = render_context_window_config(existing, Some(1_048_576));
        assert!(once.starts_with("model_context_window = 1048576 # managed by ALWith: context window\n"));
        assert!(once.contains("[model_providers.qwen]"));
        // A second sync must not stack another key.
        assert_eq!(render_context_window_config(&once, Some(1_048_576)), once);
        // A smaller value replaces the old one.
        let changed = render_context_window_config(&once, Some(400_000));
        assert!(changed.contains("model_context_window = 400000"));
        assert!(!changed.contains("1048576"));
        // Clearing every model window removes Codex's override and leaves the rest verbatim.
        let cleared = render_context_window_config(&once, None);
        assert!(!cleared.contains("model_context_window"));
        assert!(!cleared.contains(CONTEXT_WINDOW_MARKER));
        assert_eq!(cleared, existing);
    }

    #[test]
    fn config_repair_drops_only_illegal_effort() {
        // The real 2026-11-05 config: a typo shared in from the ChatGPT desktop app. Every native
        // turn built from it was rejected with 400 invalid_value before any model ran.
        let bad = "model_context_window = 1048576\nmodel_reasoning_effort = \"meduim\"\nmodel = \"gpt-6.1-terra\"\n\n# managed by ALWith\n[model_providers.alwith]\nname = \"ALWith Router\"\n";
        let repaired = render_reasoning_effort_config(bad);
        assert!(!repaired.contains("meduim"), "{repaired}");
        assert!(repaired.contains("model_context_window = 1048576"));
        assert!(repaired.contains("model = \"gpt-6.1-terra\""));
        assert!(repaired.contains("[model_providers.alwith]"));
        // Idempotent, and a legitimate choice survives untouched.
        assert_eq!(render_reasoning_effort_config(&repaired), repaired);
        let good = "model_reasoning_effort = \"high\"\nmodel_provider = \"alwith\"\n";
        assert_eq!(render_reasoning_effort_config(good), good);
        // An extended ladder value is a per-model option, not something to silently rewrite.
        let extended = "model_reasoning_effort = 'ultra'\n";
        assert_eq!(render_reasoning_effort_config(extended), extended);
        // A comment mentioning the key is not a config line.
        let comment = "# model_reasoning_effort = meduim\nmodel_provider = \"alwith\"\n";
        assert_eq!(render_reasoning_effort_config(comment), comment);
    }

    #[test]
    fn a_missing_router_provider_is_repaired_on_every_managed_sync() {
        // The exact 2026-11-06 state: a provider apply left only Qwen in config.toml, so every
        // `thread/resume` failed with "Model provider `alwith` not found" and the adapter told the
        // user the vendor was no longer configured — even though `alwith` is our internal router.
        let broken = "model_context_window = 1000000 # managed by ALWith: context window\n\n# managed by ALWith\n[model_providers.qwen]\nname = \"Qwen\"\n";
        let base = Some("http://127.0.0.1:64531/alwith".to_string());
        let once = render_router_provider_config(broken, base.clone());
        assert!(once.contains("model_provider = \"alwith\""), "{once}");
        assert!(once.contains("[model_providers.alwith]"), "{once}");
        assert!(once.contains("[model_providers.qwen]"), "{once}");
        assert!(once.contains("base_url = \"http://127.0.0.1:64531/alwith\""), "{once}");
        assert_eq!(render_router_provider_config(&once, base), once);
        // The loopback port changes on every launch: replace it, never stack another section.
        let moved = Some("http://127.0.0.1:65000/alwith".to_string());
        let updated = render_router_provider_config(&once, moved.clone());
        assert!(updated.contains("base_url = \"http://127.0.0.1:65000/alwith\""), "{updated}");
        assert!(!updated.contains("64531"), "{updated}");
        assert_eq!(render_router_provider_config(&updated, moved), updated);
    }

    #[test]
    fn a_partial_router_table_is_completed_without_overwriting_its_values() {
        // 2026-11-08 cross-machine shape: the `[model_providers.alwith]` header existed but the
        // table had been trimmed by another Codex client. Codex still exited at boot with
        // "Model provider `alwith` not found", so "the section exists" was the wrong test for a
        // usable ALWith model configuration. The fix fills every key it needs, in place.
        let partial = r#"model_context_window = 1048576

[projects."/Users/shouhouyangguang/Documents/YUP/dev"]
trust_level = "trusted"

# managed by ALWith
[model_providers.alwith]
name = "ALWith Router"
base_url = "http://127.0.0.1:61610/alwith"
experimental_bearer_token = "legacy-router-token"

# managed by ALWith
[model_providers.qwen]
name = "Qwen"
"#;
        let base = Some("http://127.0.0.1:65001/alwith".to_string());
        let healed = render_router_provider_config(partial, base.clone());
        assert_eq!(healed.matches("[model_providers.alwith]").count(), 1, "{healed}");
        assert!(healed.contains("wire_api = \"responses\""), "{healed}");
        assert!(healed.contains("request_max_retries = 0"), "{healed}");
        assert!(healed.contains("stream_max_retries = 0"), "{healed}");
        assert!(healed.contains("base_url = \"http://127.0.0.1:65001/alwith\""), "{healed}");
        // Existing values are preserved: the bridge may still expect a token written by an older
        // build, and the renderer must never silently rotate it.
        assert!(healed.contains("experimental_bearer_token = \"legacy-router-token\""), "{healed}");
        assert!(!healed.contains("alwith-router"), "{healed}");
        // The completed keys land INSIDE the router table, before the next provider's marker.
        let router_at = healed.find("[model_providers.alwith]").expect("router table");
        let wire_at = healed.find("wire_api = \"responses\"").expect("wire_api");
        let qwen_at = healed.find("[model_providers.qwen]").expect("qwen table");
        assert!(router_at < wire_at && wire_at < qwen_at, "{healed}");
        assert!(healed.contains("[projects."), "user table lost: {healed}");
        assert_top_level_provider(&healed);
        // Idempotent: a second launch appends nothing and writes nothing.
        assert_eq!(render_router_provider_config(&healed, base), healed);
    }

    #[test]
    fn the_router_section_exists_even_before_the_bridge_binds_a_port() {
        let once = render_router_provider_config("", None);
        assert!(once.contains("model_provider = \"alwith\""), "{once}");
        assert!(once.contains("[model_providers.alwith]"), "{once}");
        assert!(once.contains(&router_fallback_base()), "{once}");
        // A stale vendor key from another Codex client must not pin new threads to that vendor.
        let legacy = "model_provider = \"hakimi\"\n\n[desktop]\nfoo = 1\n";
        let replaced = render_router_provider_config(legacy, None);
        assert!(replaced.contains("model_provider = \"alwith\""), "{replaced}");
        assert!(!replaced.contains("hakimi"), "{replaced}");
    }

    #[test]
    fn duplicate_model_provider_lines_after_a_table_are_collapsed() {
        // The real 2026-11-07 cross-machine failure: the other Mac's config.toml had 32 repeated
        // `model_provider = "alwith"` lines sitting *after* a `[projects."..."]` table. TOML forbids
        // duplicate keys inside one table, so Codex aborted at the first duplicate ("invalid
        // configuration at ...:60:1") and the adapter surfaced "Model provider `alwith` not found".
        // The pre-fix self-heal only stripped `model_provider` lines *above* the first table, so it
        // never cleared them. This asserts the router renderer now collapses every occurrence into a
        // single canonical line wherever it appears.
        let mut bad = String::from(
            "model_context_window = 1000000\n\n[projects.\"/Users/shouhouyangguang/Documents/YUP/dev\"]\n",
        );
        for _ in 0..32 {
            bad.push_str("model_provider = \"alwith\"\n");
        }
        bad.push_str("\n# managed by ALWith\n[model_providers.alwith]\nname = \"ALWith Router\"\n");
        let base = Some("http://127.0.0.1:61610/alwith".to_string());

        let healed = render_router_provider_config(&bad, base.clone());
        let count = healed.matches("model_provider = \"alwith\"").count();
        assert_eq!(count, 1, "expected exactly one canonical line, got {count}:\n{healed}");
        // Collapsing the duplicates is not enough: the surviving line must be a TOP-LEVEL key.
        // The old marker-based anchor left it inside the `[projects."…"]` table.
        assert_top_level_provider(&healed);
        // The owned router table survives and is not duplicated or dropped.
        assert!(healed.contains("[model_providers.alwith]"), "{healed}");
        // Idempotent: a second pass must not re-stack duplicate lines.
        let again = render_router_provider_config(&healed, base.clone());
        assert_eq!(again.matches("model_provider = \"alwith\"").count(), 1, "{again}");
        assert_top_level_provider(&again);
        assert_eq!(again, healed);
    }

    #[test]
    fn the_provider_key_is_top_level_with_managed_blocks_after_a_project_table() {
        // Shape of the other Mac's 2026-11-08 config.toml (secrets stripped), taken from
        // 「ALWith本机链路诊断-20261108」: user tables first, then `# managed by ALWith` provider
        // blocks, with `model_provider` wedged between `[projects."…"]` and the first marker at
        // line 59. That line is `projects.….model_provider`, not the global key — the engine only
        // worked because the launcher force-injects `-c model_provider="alwith"`.
        let contents = r#"model_context_window = 1048576 # managed by ALWith: context window
notify = ["notify"]
service_tier = "default"
model = "gpt-6.1-terra"

[plugins."sites@openai-bundled"]
enabled = true

[mcp_servers.node_repl.env]
CODEX_HOME = "/Users/shouhouyangguang/.codex"

[projects."/Users/shouhouyangguang/Documents/YUP/2610_风险交易拒绝分析"]
trust_level = "trusted"

model_provider = "alwith"
# managed by ALWith
[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/"

# managed by ALWith
[model_providers.alwith]
name = "ALWith Router"
base_url = "http://127.0.0.1:54936/alwith"
"#;
        let base = Some("http://127.0.0.1:54936/alwith".to_string());
        let healed = render_router_provider_config(contents, base.clone());
        assert_eq!(healed.matches("model_provider = \"alwith\"").count(), 1, "{healed}");
        assert_top_level_provider(&healed);
        // Every user-owned section stays byte-for-byte present; only the key moves.
        assert!(healed.contains("[projects."), "user table lost: {healed}");
        assert!(healed.contains("CODEX_HOME"), "mcp env lost: {healed}");
        assert!(healed.contains("[model_providers.alwith]"), "{healed}");
        assert_eq!(render_router_provider_config(&healed, base), healed);
    }

    #[test]
    fn the_provider_key_stays_outside_the_managed_region_when_the_marker_comes_first() {
        // This Mac's shape: the marker prefixes the provider blocks near the top, with no user
        // table before it. Anchoring only on the table header would put the key *after* the
        // marker, where the next provider reconcile's skipping pass erases it.
        let contents = "model_context_window = 1048576 # managed by ALWith: context window\n\n# managed by ALWith\nmodel_provider = \"alwith\"\n[model_providers.deepseek]\nname = \"DeepSeek\"\n\n# managed by ALWith\n[model_providers.alwith]\nname = \"ALWith Router\"\n";
        let healed = render_router_provider_config(contents, None);
        assert_eq!(healed.matches("model_provider = \"alwith\"").count(), 1, "{healed}");
        assert_top_level_provider(&healed);
        // A full provider reconcile must not drop the key either.
        let reconciled = render_managed_config(&healed, &[], None);
        assert_top_level_provider(&reconciled);
    }

    #[test]
    fn blank_lines_left_by_the_renderers_never_accumulate() {
        // The real 2026-11-07 file: one extra blank line per launch, fourteen deep, pushing the
        // router key away from the top where every pass expects it.
        let drifted = "model_context_window = 1000000\n\n\n\n\n\nmodel_provider = \"alwith\"\n\n# managed by ALWith\n[model_providers.alwith]\nname = \"ALWith Router\"\n";
        let normalized = normalize_config(drifted);
        assert_eq!(normalize_config(&normalized), normalized);
        assert!(!normalized.contains("\n\n\n"), "{normalized:?}");
        assert!(normalized.starts_with("model_context_window"), "{normalized:?}");

        // A render whose only change is whitespace must settle after one write, not churn on
        // every launch: the second pass has to produce byte-identical contents.
        let base = "model_provider = \"alwith\"\n\n# managed by ALWith\n[model_providers.alwith]\nname = \"ALWith Router\"\nbase_url = \"http://127.0.0.1:49516/alwith\"\n";
        let same = Some("http://127.0.0.1:49516/alwith".to_string());
        let once = normalize_config(&render_router_provider_config(base, same.clone()));
        let twice = normalize_config(&render_router_provider_config(&once, same));
        assert_eq!(once, twice);
        assert!(!once.contains("\n\n\n"), "{once:?}");
    }

    #[test]
    fn writing_the_gateway_blocks_never_strips_the_router_it_depends_on() {
        // What `apply_locked` used to leave behind when no gateway was selected: the managed
        // region (which holds the router block) was stripped and only a later sync put it back.
        // Codex exits 1 the moment it reads a `model_provider` it cannot resolve, and that sync
        // needs a live engine — so a single missed call bricked every later launch.
        let existing = "model = \"gpt-6.1-sol\"\n\n# managed by ALWith\n[model_providers.alwith]\nname = \"ALWith Router\"\n\n# managed by ALWith\n[model_providers.qwen]\nname = \"Qwen\"\n";
        let rendered = render_managed_config(existing, &[], None);
        assert!(rendered.contains("[model_providers.alwith]"), "{rendered}");
        assert!(rendered.contains("model_provider = \"alwith\""), "{rendered}");
        assert!(!rendered.contains("[model_providers.qwen]"), "{rendered}");
        assert!(rendered.contains("model = \"gpt-6.1-sol\""), "{rendered}");

        // A file already broken by an earlier build is healed by the same write.
        let broken = "model_provider = \"alwith\"\n\n[desktop]\ntheme = \"dark\"\n";
        let healed = render_managed_config(broken, &[], Some("http://127.0.0.1:60636/alwith".into()));
        assert!(healed.contains("[model_providers.alwith]"), "{healed}");
        assert!(healed.contains("base_url = \"http://127.0.0.1:60636/alwith\""), "{healed}");
        assert!(healed.contains("theme = \"dark\""), "{healed}");
        // Idempotent: a second launch writes nothing.
        assert_eq!(render_managed_config(&healed, &[], Some("http://127.0.0.1:60636/alwith".into())), healed);
    }
}

#[cfg(test)]
mod merged_catalog_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_provider_lands_in_one_catalog_and_a_stale_hash_never_shadows_it() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        std::fs::create_dir_all(root.join("model-catalogs/alwith")).unwrap();
        std::fs::write(
            root.join("model-catalogs/alwith/models.json"),
            json!({"models":[{"slug":"company","context_window":1_000_000,"auto_compact_token_limit":700_000}]})
                .to_string(),
        )
        .unwrap();
        let catalogs = root.join("provider-catalogs");
        std::fs::create_dir_all(&catalogs).unwrap();
        std::fs::write(
            catalogs.join("builtin-deepseek-aaaa.json"),
            json!({"models":[{"slug":"deepseek-old","context_window":1}]}).to_string(),
        )
        .unwrap();
        // Content-addressed catalogs leave the previous hash behind; the newer file must win.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(
            catalogs.join("builtin-deepseek-bbbb.json"),
            json!({"models":[{"slug":"deepseek-flash","context_window":1_048_576,"auto_compact_token_limit":734_003}]})
                .to_string(),
        )
        .unwrap();
        std::fs::write(
            catalogs.join("custom-6162-cccc.json"),
            json!({"models":[{"slug":"company","context_window":500_000}]}).to_string(),
        )
        .unwrap();

        let path = merged_catalog_path(root).expect("a catalog with models is written");
        let merged: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let models = merged["models"].as_array().unwrap();
        let slugs: Vec<&str> = models.iter().filter_map(|model| model["slug"].as_str()).collect();
        assert!(slugs.contains(&"company"));
        assert!(slugs.contains(&"deepseek-flash"));
        assert!(!slugs.contains(&"deepseek-old"), "the stale hash must not shadow the current catalog");
        // A duplicated slug is resolved once, by the highest-priority source.
        assert_eq!(slugs.iter().filter(|slug| **slug == "company").count(), 1);
        assert_eq!(models[0]["context_window"], 1_000_000);
        // The engine compacts at its own 95% default: a limit written by an older build must not
        // survive the merge, or it would keep overriding the engine after the policy changed.
        assert!(
            models.iter().all(|model| model.get("auto_compact_token_limit").is_none()),
            "compaction stays at the engine default"
        );
        let flash = models.iter().find(|model| model["slug"] == "deepseek-flash").unwrap();
        assert_eq!(flash["context_window"], 1_048_576);

        // Idempotent: an unchanged set of inputs must not rewrite the file.
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        merged_catalog_path(root).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before);
    }

    #[test]
    fn a_machine_with_no_catalogs_asks_for_none() {
        let root = tempfile::tempdir().unwrap();
        assert!(merged_catalog_path(root.path()).is_none());
    }

    /// End-to-end through `merged_catalog_path`: the engine's sub-agent pair must survive the merge.
    ///
    /// Regression for the native 6.2 Sol route: the engine publishes
    /// `multi_agent_reasoning_effort=xhigh` + `multi_agent_version=v2`, but the merge only copied
    /// the effort ladder and speed tiers, so the file the engine actually reads had `null` for both
    /// and Ultra silently resolved to `max` instead of the model's own orchestration settings.
    #[test]
    fn the_engine_sub_agent_pair_survives_into_the_merged_catalog() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        std::fs::create_dir_all(root.join("model-catalogs/alwith")).unwrap();
        std::fs::write(
            root.join("model-catalogs/alwith/models.json"),
            json!({"models":[{
                "slug":"gpt-6.2-sol",
                "display_name":"6.2 Sol",
                "default_reasoning_level":"medium"
            }]})
            .to_string(),
        )
        .unwrap();
        // Snapshot written by `codex debug models --bundled`.
        std::fs::write(
            engine_catalog_path(root),
            json!({"models":[{
                "slug":"gpt-6.2-sol",
                "display_name":"GPT-6.2-Sol",
                "supported_reasoning_levels":[{"effort":"low"},{"effort":"max"},{"effort":"ultra"}],
                "multi_agent_reasoning_effort":"xhigh",
                "multi_agent_version":"v2"
            }]})
            .to_string(),
        )
        .unwrap();

        let path = merged_catalog_path(root).expect("the catalog is written");
        let merged: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let sol = merged["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["slug"] == "gpt-6.2-sol")
            .expect("6.2 Sol stays in the catalog");
        assert_eq!(sol["multi_agent_reasoning_effort"], "xhigh");
        assert_eq!(sol["multi_agent_version"], "v2");
        // The UI ladder is untouched: `ultra` is offered, it just is not sent as an effort value.
        let efforts: Vec<&str> = sol["supported_reasoning_levels"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|level| level["effort"].as_str())
            .collect();
        assert!(efforts.contains(&"ultra"));
    }

    /// The inverse of the test above: a provider catalog cloned the old sub-agent pair, while the
    /// engine's current definition no longer declares one. Keeping the stale effort changed what
    /// `ultra` sent (`xhigh` instead of the engine's `max`).
    #[test]
    fn a_model_that_no_longer_declares_a_sub_agent_effort_drops_the_stale_field() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        std::fs::create_dir_all(root.join("model-catalogs/alwith")).unwrap();
        std::fs::write(
            root.join("model-catalogs/alwith/models.json"),
            json!({"models":[{
                "slug":"gpt-6-sol",
                "display_name":"6 Sol",
                "multi_agent_reasoning_effort":"xhigh",
                "multi_agent_version":"v2"
            }]})
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            engine_catalog_path(root),
            json!({"models":[{
                "slug":"gpt-6-sol",
                "display_name":"GPT-6-Sol",
                "supported_reasoning_levels":[{"effort":"low"},{"effort":"max"},{"effort":"ultra"}],
                "multi_agent_version":"v2"
            }]})
            .to_string(),
        )
        .unwrap();

        let path = merged_catalog_path(root).expect("the catalog is written");
        let merged: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let sol = merged["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["slug"] == "gpt-6-sol")
            .expect("6 Sol stays in the catalog");
        assert!(sol.get("multi_agent_reasoning_effort").is_none());
        assert_eq!(sol["multi_agent_version"], "v2");
    }

    #[test]
    fn an_explicit_default_survives_the_engine_recommendation() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        std::fs::create_dir_all(root.join("model-catalogs/alwith")).unwrap();
        std::fs::write(
            root.join("model-catalogs/alwith/models.json"),
            json!({"models":[{
                "slug":"gpt-6.2-sol",
                "display_name":"6.2 Sol",
                "default_reasoning_level":"medium"
            }]})
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            engine_catalog_path(root),
            json!({"models":[{
                "slug":"gpt-6.2-sol",
                "display_name":"GPT-6.2-Sol",
                "supported_reasoning_levels":[{"effort":"low"},{"effort":"medium"}],
                "default_reasoning_level":"low"
            }]})
            .to_string(),
        )
        .unwrap();
        let providers = |explicit: bool| {
            json!({"revision":1,"built_in_model_overrides":{"openai":[{
                "label":"6.2 Sol",
                "api_id":"gpt-6.2-sol",
                "defaultReasoningLevel":"medium",
                "defaultReasoningLevelExplicit":explicit
            }]}})
            .to_string()
        };
        std::fs::write(root.join("runtime-providers.json"), providers(true)).unwrap();
        assert!(explicit_gpt_defaults(root).contains("gpt-6.2-sol"), "the explicit marker is parsed");
        let direct = super::merged_catalog(root).expect("the direct catalog is built");
        let direct_sol =
            direct["models"].as_array().unwrap().iter().find(|model| model["slug"] == "gpt-6.2-sol").unwrap();
        assert_eq!(direct_sol["default_reasoning_level"], "medium", "the merge preserves the explicit value");
        let path = merged_catalog_path(root).expect("the catalog is written");
        let merged: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let sol = merged["models"].as_array().unwrap().iter().find(|model| model["slug"] == "gpt-6.2-sol").unwrap();
        assert_eq!(sol["default_reasoning_level"], "medium", "explicit user choice wins");

        std::fs::write(root.join("runtime-providers.json"), providers(false)).unwrap();
        let path = merged_catalog_path(root).expect("the catalog is rewritten");
        let merged: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let sol = merged["models"].as_array().unwrap().iter().find(|model| model["slug"] == "gpt-6.2-sol").unwrap();
        assert_eq!(sol["default_reasoning_level"], "low", "an unmarked seed follows the engine");
    }
}
