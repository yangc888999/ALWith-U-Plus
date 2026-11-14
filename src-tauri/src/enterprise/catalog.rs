//! Validate API-issued enterprise metadata; the gateway and models are never bundled in U.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const PROVIDER_PREFIX: &str = "custom_alwith_enterprise_";

#[derive(Deserialize)]
pub(super) struct IssuedProvider {
    pub provider_id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub hidden: bool,
    pub models: Vec<Model>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all(serialize = "camelCase"))]
pub(super) struct Model {
    #[serde(rename = "api_id")]
    pub api_id: String,
    pub label: String,
    pub context_window: Option<u64>,
    pub description: Option<String>,
}

pub(super) fn parse(value: Value) -> Result<Option<IssuedProvider>, String> {
    let rows = value.as_array().ok_or("Invalid ALwith provider response")?;
    let mut enterprise = rows.iter().filter(|row| row["auth_type"] == "enterprise_session");
    let Some(value) = enterprise.next() else { return Ok(None) };
    if enterprise.next().is_some() {
        return Err("Multiple enterprise gateways are not supported by the enterprise relay".into());
    }
    let provider: IssuedProvider =
        serde_json::from_value(value.clone()).map_err(|_| "Invalid enterprise provider metadata")?;
    if provider.hidden || provider.models.is_empty() {
        return Ok(None);
    }
    if provider.provider_id.trim().is_empty() || provider.name.trim().is_empty() {
        return Err("Missing enterprise provider identity".into());
    }
    let mut ids = BTreeSet::new();
    if provider.models.iter().any(|model| {
        model.api_id.trim().is_empty()
            || model.label.trim().is_empty()
            || model.context_window == Some(0)
            || !ids.insert(&model.api_id)
    }) {
        return Err("Invalid or duplicate enterprise model metadata".into());
    }
    Ok(Some(provider))
}

pub(super) fn provider_id(account: &str, provider: &str) -> String {
    // Stable within an account; another account can never inherit a persisted model selection.
    format!("{PROVIDER_PREFIX}{}", hex::encode(Sha256::digest(format!("{}:{account}{provider}", account.len()))))
}
pub(super) fn runtime_id(provider: &str) -> String {
    format!("custom-{}", hex::encode(provider))
}
pub(super) fn model_id(provider: &str, model: &str) -> String {
    let encoded = model
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect::<String>();
    format!("gateway:{}:{encoded}", runtime_id(provider))
}
pub(super) fn is_model(model: &str) -> bool {
    model.starts_with(&format!("gateway:custom-{}", hex::encode(PROVIDER_PREFIX)))
        || model.starts_with("gateway:finture-enterprise:")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn catalog_accepts_issued_gateways_without_built_in_provider_ids() {        let value = json!([{"provider_id":"company-issued","auth_type":"enterprise_session","name":"Issued","base_url":"https://issued.test","models":[{"api_id":"issued/model","label":"Issued"}]}]);
        let provider = parse(value).unwrap().unwrap();
        assert_eq!(provider.base_url, "https://issued.test");
        assert_eq!(provider.models[0].api_id, "issued/model");
        assert_ne!(provider_id("a", &provider.provider_id), provider_id("b", &provider.provider_id));
        assert!(is_model(&model_id(&provider_id("a", &provider.provider_id), "issued/model")));
        assert!(!is_model("gateway:custom-personal:model"));
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PublicProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub models: Vec<Model>,
}
pub(super) struct Connection {
    pub provider: PublicProvider,
    pub params: Value,
    // Relay credentials remain native and are never sent to shared provider storage.
    pub relay: alwith_enterprise_client::RelayConnection,
}

pub(super) async fn connection(
    // Only the release build resolves the resource dir through the app handle; a debug build reads
    // the manifest's resources directly, so the parameter is unused there.
    #[cfg_attr(debug_assertions, allow(unused_variables))] app: &tauri::AppHandle,
    account: &str,
    provider: IssuedProvider,
    relay: alwith_enterprise_client::RelayConnection,
    host: &alwith_enterprise_client::EnterpriseClient,
    generation: u64,
) -> Result<Connection, String> {
    let id = provider_id(account, &provider.provider_id);
    // The native owner builds the runtime catalog from a bundled source, exactly as the upstream
    // enterprise integration does. The earlier port looked for `custom/models.json`, a resource
    // this fork never ships, so every refresh failed after the provider fetch and no enterprise
    // model ever reached the picker. `alwith/models.json` is this fork's shared account catalog.
    #[cfg(not(debug_assertions))]
    use tauri::Manager;
    #[cfg(debug_assertions)]
    let resources = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    #[cfg(not(debug_assertions))]
    let resources = app.path().resource_dir().map_err(|error| error.to_string())?;
    // `bundled_model_catalogs` only lists the eight built-in vendor catalogs (deepseek, qwen,
    // openrouter, …); `alwith/models.json` is the account-owned template and is NOT in that list.
    // Looking it up there made every refresh fail with "Shared ALwith model catalog unavailable"
    // after a successful provider fetch, which surfaced to the reader as an authorization error.
    let source = resources.join("alwith/models.json");
    if !source.is_file() {
        return Err(format!("Shared ALwith model catalog missing at {}", source.display()));
    }
    let models: Vec<_> = provider
        .models
        .iter()
        .map(|model| alwith_enterprise_client::CatalogModel {
            api_id: model.api_id.clone(),
            label: model.label.clone(),
            description: model.description.clone(),
            context_window: model.context_window,
        })
        .collect();
    let catalog = host.model_catalog(generation, &source, &models).await.map_err(|reason| reason.to_string())?;
    let router = crate::bridge::router_base_url().ok_or("Shared ALwith router unavailable")?;
    // Keep a copy inside the app's own data directory: the engine boots with one merged catalog
    // (`providers::merged_catalog_path`), and this is where that merge looks for the enterprise
    // models. The bytes are copied untouched — compaction stays at the engine's 95% default.
    let catalog_path = relocated_catalog(app, &catalog.path).unwrap_or_else(|| catalog.path.clone());
    Ok(connection_params(id, provider, relay, catalog_path, catalog.has_known_model, &router))
}

/// Copies the native owner's catalog into `app_data/enterprise-catalogs`, unchanged.
///
/// The owner rebuilds its catalog under a content-addressed name on every refresh, so the merged
/// catalog needs one stable place to find it. Nothing is injected: an earlier build rewrote the
/// threshold to 70% of the window here, which never reached the engine's model resolution and only
/// made the app disagree with what Codex actually did.
fn relocated_catalog(app: &tauri::AppHandle, source: &std::path::Path) -> Option<std::path::PathBuf> {
    use std::hash::{Hash, Hasher};
    use tauri::Manager;
    let bytes = std::fs::read(source).ok()?;
    let directory = app.path().app_data_dir().ok()?.join("enterprise-catalogs");
    std::fs::create_dir_all(&directory).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    let path = directory.join(format!("tuned-{:016x}.json", hasher.finish()));
    if std::fs::read(&path).ok().as_deref() != Some(bytes.as_slice()) {
        std::fs::write(&path, &bytes).ok()?;
    }
    Some(path)
}

pub(super) fn connection_params(
    id: String, provider: IssuedProvider, relay: alwith_enterprise_client::RelayConnection, path: std::path::PathBuf,
    known: bool, router: &str,
) -> Connection {
    let models: Vec<_> = provider.models.iter().map(|model| serde_json::json!({"id":model.api_id,"label":model.label,"description":model.description,"contextWindow":model.context_window})).collect();
    let mut config = if known {
        serde_json::json!({"web_search":"disabled","model_reasoning_summary":"none"})
    } else {
        serde_json::json!({"features":{"code_mode":false,"code_mode_only":false}})
    };
    config["model_catalog_json"] = serde_json::json!(path);
    let params = serde_json::json!({"providerId":"openai","apiType":"openai","baseUrl":router,"_meta":{
        "codex":{"id":runtime_id(&id),"runtimeId":crate::bridge::ROUTER_ID,"name":provider.name,"mode":"catalog","bearerToken":"alwith-router","config":config},
        "alwith":{"models":models}
    }});
    Connection {
        provider: PublicProvider { id, name: provider.name, base_url: provider.base_url, models: provider.models },
        params,
        relay,
    }
}

#[cfg(test)]
mod connection_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn relay_credentials_stay_native_while_catalog_uses_shared_runtime() {
        let provider = parse(json!([{"provider_id":"from-api","auth_type":"enterprise_session","name":"Issued","base_url":"https://issued.test","models":[{"api_id":"issued/model","label":"Issued","context_window":120000}]}])).unwrap().unwrap();
        let id = provider_id("account", &provider.provider_id);
        let connection = connection_params(
            id.clone(),
            provider,
            alwith_enterprise_client::RelayConnection {
                base_url: "http://127.0.0.1:8123/v1".into(),
                api_key: "memory-only-secret".into(),
            },
            "test-catalog.json".into(),
            false,
            "http://127.0.0.1:9999/alwith",
        );
        let public = serde_json::to_value(&connection.provider).unwrap();
        assert_eq!(public["baseUrl"], "https://issued.test");
        assert_eq!(public["models"][0]["contextWindow"], 120000);
        assert!(!public.to_string().contains("memory-only-secret"));
        assert_eq!(connection.params["baseUrl"], "http://127.0.0.1:9999/alwith");
        assert_eq!(connection.params["_meta"]["codex"]["runtimeId"], "alwith");
        assert_eq!(connection.params["_meta"]["codex"]["bearerToken"], "alwith-router");
        assert!(!connection.params.to_string().contains("memory-only-secret"));
        assert!(!connection.params.to_string().contains("8123"));
        assert_eq!(connection.relay.api_key, "memory-only-secret");
        assert_eq!(connection.params["_meta"]["codex"]["id"], runtime_id(&id));
        assert_eq!(connection.params["_meta"]["alwith"]["models"][0]["id"], "issued/model");
    }

}
