//! U orchestrates enterprise authentication and the relay; shared chat owns provider storage and routing.
pub(crate) mod catalog;
mod gate;
mod runtime;
use alwith_enterprise_client::{EnterpriseClient, Protocol};
pub(crate) use runtime::{apply, check, observe, observe_event, observe_realtime, ready, reset, uses_enterprise};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex as AsyncMutex, OnceCell};

// Same shape the account-owned gateway already binds with; one specta type, one wire contract.
pub use crate::providers::managed::Account;
struct Binding {
    account: Account,
    epoch: u64,
    generation: u64,
    token: String,
}
#[derive(Default)]
pub struct Enterprise {
    host: OnceCell<Arc<EnterpriseClient>>,
    closing: Arc<AtomicBool>,
    gate: Mutex<gate::Gate>,
    binding: AsyncMutex<Option<Binding>>,
    refresh: AsyncMutex<()>,
    transition: AsyncMutex<()>,
    realtime: Mutex<BTreeSet<String>>,
    connection: Mutex<Option<Arc<catalog::Connection>>>,
    ready_agents: Mutex<BTreeSet<String>>,
    configured: Mutex<BTreeMap<String, BTreeSet<String>>>,
    applied: Mutex<BTreeMap<String, Value>>,
    configuration: Arc<AsyncMutex<()>>,
}
fn error(message: impl ToString) -> Value {
    json!({"message":message.to_string()})
}
fn controls(window: &tauri::WebviewWindow) -> Result<(), Value> {
    if matches!(window.label(), "main" | "settings") {
        Ok(())
    } else {
        Err(error("Enterprise controls belong to account settings"))
    }
}
fn main_window(window: &tauri::WebviewWindow) -> Result<(), Value> {
    if window.label() == "main" { Ok(()) } else { Err(error("Enterprise account changes belong to the main window")) }
}
impl Enterprise {
    async fn host(&self, app: &AppHandle) -> Result<&Arc<EnterpriseClient>, Value> {
        self.host.get_or_try_init(|| async {
            let settings = app.path().app_data_dir().map_err(error)?.join("enterprise-settings.json");
            let directory = match crate::native::development_directory() {
                Some(directory) => directory,
                None => app.path().resource_dir().map_err(error)?.join("native"),
            };
            let host = Arc::new(EnterpriseClient::open(&directory, &settings).await?);
            let events = host.clone();
            let closing = self.closing.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match events.next_event().await {
                        Ok(Value::Null) => break,
                        Ok(value) => {
                            if value["type"] == "enterpriseRequestTools" { continue; }
                            if let Err(reason) = app.emit("enterprise:event", value) { log::error!("Enterprise event delivery failed: {reason}"); }
                        }
                        Err(reason) => {
                            if closing.load(Ordering::Acquire) { break; }
                            log::error!("Enterprise event stream interrupted: {reason}");
                            let state = app.state::<Enterprise>();
                            if let Some(binding) = state.binding.lock().await.as_ref() {
                                let _ = app.emit("enterprise:event", json!({"type":"enterpriseEventStreamInterrupted","accountId":binding.account.user_uuid,"generation":binding.generation}));
                            }
                            if reason["kind"] != "event_lagged" { break; }
                        }
                    }
                }
            });
            Ok(host)
        }).await
    }
    fn changed(&self, app: &AppHandle) -> Result<(), Value> {
        app.emit("enterprise:models-changed", ()).map_err(error)?;
        let gate = self.gate.lock().unwrap();
        let sessions: Vec<_> = gate
            .routes
            .iter()
            .filter(|(id, _)| gate.check(None, Some(id.as_str())).is_err())
            .map(|(id, _)| id.clone())
            .collect();
        app.emit("providers:managed-revoked", json!({"sessionIds":sessions})).map_err(error)
    }
    async fn current(&self, generation: u64) -> Result<Arc<EnterpriseClient>, Value> {
        let binding = self.binding.lock().await;
        let Some(binding) = binding.as_ref() else {
            return Err(error("Enterprise account is not ready"));
        };
        let gate = self.gate.lock().unwrap();
        if binding.generation != generation || binding.epoch != gate.generation || gate.account.is_none() {
            return Err(error("ALwith account changed"));
        }
        Ok(self.host.get().expect("prepared enterprise client").clone())
    }
    pub async fn close(&self) -> Result<(), String> {
        self.invalidate().map_err(|reason| reason.to_string())?;
        self.closing.store(true, Ordering::Release);
        if let Some(host) = self.host.get() {
            host.close().await.map_err(|reason| reason.to_string())?;
        }
        Ok(())
    }
    // Call while holding the gate: publication uses the same lock, including the bridge write.
    fn revoke_connection(&self) {
        if let Some(connection) = self.connection.lock().unwrap().take() {
            crate::bridge::unregister_router_route(&catalog::runtime_id(&connection.provider.id));
        }
        self.applied.lock().unwrap().clear();
    }
    // Gate and bridge publication are one synchronous operation. Connection identity also
    // distinguishes refreshes within the same account generation (and identical catalogs).
    fn publish_connection(&self, generation: u64, connection: &Arc<catalog::Connection>, agent: &str) -> bool {
        let gate = self.gate.lock().unwrap();
        if gate.generation != generation
            || gate.account.is_none()
            || gate.models.is_empty()
            || !self.connection.lock().unwrap().as_ref().is_some_and(|current| Arc::ptr_eq(current, connection))
        {
            return false;
        }
        crate::bridge::register_router_route(
            &catalog::runtime_id(&connection.provider.id),
            &connection.relay.base_url,
            &connection.relay.api_key,
            false,
        );
        self.applied.lock().unwrap().insert(agent.into(), connection.params.clone());
        true
    }
    fn invalidate(&self) -> Result<(), Value> {
        let mut gate = self.gate.lock().unwrap();
        self.revoke_connection();
        gate.invalidate().map_err(error)
    }
    async fn clear(&self, app: &AppHandle, explicit: bool) -> Result<(), Value> {
        self.invalidate()?;
        let notification = self.changed(app);
        // Invalidation precedes waits: late refreshes cannot restore this account's routes.
        let mut binding = self.binding.lock().await;
        let stopped = if let Some(bound) = binding.take() {
            let host = self.host.get().expect("prepared enterprise client");
            if explicit { host.logout(bound.generation).await } else { host.suspend(bound.generation).await }
        } else {
            Ok(())
        };
        drop(binding);
        let cleanup = runtime::cleanup(app).await;
        stopped?;
        cleanup?;
        notification
    }
}

#[tauri3_specta::command]
pub async fn enterprise_bind(window: tauri::WebviewWindow, account: Account) -> Result<u64, Value> {
    main_window(&window)?;
    if !matches!(account.api_base_url.as_str(), "https://api.alwith.ai/service" | "https://api-dev.alwith.ai/service")
        || account.user_uuid.trim().is_empty()
    {
        return Err(error("Invalid ALwith account"));
    }
    let state = window.state::<Enterprise>();
    let identity = format!("{}:{}", account.api_base_url, account.user_uuid);
    {
        let mut gate = state.gate.lock().unwrap();
        if gate.account.as_ref() != Some(&identity) {
            state.revoke_connection();
            gate.invalidate().map_err(error)?;
        }
    }
    let _transition = state.transition.lock().await;
    let changed = state.gate.lock().unwrap().account.as_ref() != Some(&identity);
    if changed {
        state.clear(window.app_handle(), false).await?;
    }
    let generation = state.gate.lock().unwrap().bind(identity).map_err(error)?;
    state.changed(window.app_handle())?;
    Ok(generation)
}

#[tauri3_specta::command]
pub async fn enterprise_refresh(
    window: tauri::WebviewWindow, account: Account, generation: u64, access_token: String,
) -> Result<Value, Value> {
    main_window(&window)?;
    let app = window.app_handle();
    let state = app.state::<Enterprise>();
    let identity = format!("{}:{}", account.api_base_url, account.user_uuid);
    if access_token.trim().is_empty() {
        {
            let mut gate = state.gate.lock().unwrap();
            if gate.generation != generation || gate.account.as_ref() != Some(&identity) {
                return Err(error("ALwith account changed"));
            }
            state.revoke_connection();
            // Retire pending refreshes as well as the live route before any async wait.
            gate.invalidate().map_err(error)?;
        }
        let _transition = state.transition.lock().await;
        state.clear(app, false).await?;
        return Err(error("Missing ALwith access token"));
    }
    let _refresh = state.refresh.lock().await;
    let check = || {
        let gate = state.gate.lock().unwrap();
        if gate.generation != generation || gate.account.as_ref() != Some(&identity) {
            Err(error("ALwith account changed"))
        } else {
            Ok(())
        }
    };
    check()?;
    let result = async {
        let host = state.host(app).await?;
        let native_generation = {
            let mut binding = state.binding.lock().await;
            check()?;
            let native_generation =
                host.prepare(account.api_base_url.clone(), account.user_uuid.clone(), access_token.clone()).await?;
            if let Err(reason) = check() {
                host.suspend(native_generation).await?;
                return Err(reason);
            }
            *binding = Some(Binding {
                account: account.clone(),
                epoch: generation,
                generation: native_generation,
                token: access_token.clone(),
            });
            native_generation
        };
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(error)?;
        let response = http
            .get(format!("{}/api/v1/providers", account.api_base_url))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|_| error("ALwith configuration request failed"))?;
        if !response.status().is_success() {
            return Err(error("ALwith configuration request rejected"));
        }
        let catalog = response.json::<Value>().await.map_err(|_| error("Invalid ALwith provider response"))?;
        check()?;
        let Some(provider) = catalog::parse(catalog).map_err(error)? else { return Ok(None) };
        let status = host.ensure(native_generation).await?;
        if status["automatic_renewal"] != true {
            return Ok(None);
        }
        let gateway = provider.base_url.clone();
        let relay = host.relay(native_generation, gateway, Protocol::Responses).await?;
        Ok::<_, Value>(Some(Arc::new(
            catalog::connection(app, &identity, provider, relay, host, native_generation).await.map_err(error)?,
        )))
    }
    .await;
    check()?;
    let models = result
        .as_ref()
        .ok()
        .and_then(|connection| connection.as_ref())
        .map(|connection| {
            connection
                .provider
                .models
                .iter()
                .map(|model| catalog::model_id(&connection.provider.id, &model.api_id))
                .collect()
        })
        .unwrap_or_default();
    {
        let mut gate = state.gate.lock().unwrap();
        gate.commit(generation, models).map_err(error)?;
        state.revoke_connection();
        *state.connection.lock().unwrap() = result.as_ref().ok().and_then(|connection| connection.as_ref()).cloned();
    }
    let notification = state.changed(app);
    runtime::cleanup(app).await?;
    result?;
    runtime::apply_ready(app).await;
    notification?;
    Ok(Value::Null)
}

#[tauri3_specta::command]
pub async fn enterprise_catalog(window: tauri::WebviewWindow) -> Value {
    let state = window.state::<Enterprise>();
    let gate = state.gate.lock().unwrap();
    match state.connection.lock().unwrap().as_ref() {
        Some(connection) if gate.account.is_some() && !gate.models.is_empty() => {
            serde_json::to_value(&connection.provider).expect("public enterprise catalog")
        }
        _ => Value::Null,
    }
}

#[tauri3_specta::command]
pub async fn enterprise_clear(window: tauri::WebviewWindow) -> Result<(), Value> {
    main_window(&window)?;
    let state = window.state::<Enterprise>();
    state.invalidate()?;
    if let Err(reason) = state.changed(window.app_handle()) {
        log::error!("Enterprise revocation notification failed: {reason}");
    }
    let _transition = state.transition.lock().await;
    state.clear(window.app_handle(), false).await
}
#[tauri3_specta::command]
pub async fn enterprise_status(window: tauri::WebviewWindow) -> Result<Value, Value> {
    let state = window.state::<Enterprise>();
    let generation = {
        let binding = state.binding.lock().await;
        let Some(binding) = binding.as_ref() else {
            return Ok(json!({"automatic_renewal":false,"requires_login":false,"error":null}));
        };
        binding.generation
    };
    state.current(generation).await?.status(generation).await
}
#[tauri3_specta::command]
pub async fn enterprise_begin(window: tauri::WebviewWindow, generation: u64) -> Result<Value, Value> {
    controls(&window)?;
    window.state::<Enterprise>().current(generation).await?.begin_browser(generation).await
}
#[tauri3_specta::command]
pub async fn enterprise_cancel(window: tauri::WebviewWindow, generation: u64, state: String) -> Result<(), Value> {
    controls(&window)?;
    window.state::<Enterprise>().current(generation).await?.cancel(generation, state).await
}
#[tauri3_specta::command]
pub async fn enterprise_update_account(
    window: tauri::WebviewWindow, generation: u64, request_id: String, access_token: String,
) -> Result<(), Value> {
    main_window(&window)?;
    let state = window.state::<Enterprise>();
    state.current(generation).await?.update(generation, request_id, access_token.clone()).await?;
    let mut binding = state.binding.lock().await;
    let Some(binding) = binding.as_mut().filter(|binding| binding.generation == generation) else {
        return Err(error("ALwith account changed"));
    };
    binding.token = access_token;
    Ok(())
}
#[tauri3_specta::command]
pub async fn enterprise_logout(window: tauri::WebviewWindow, generation: u64) -> Result<(), Value> {
    controls(&window)?;
    let app = window.app_handle();
    let state = window.state::<Enterprise>();
    let transition = state.transition.lock().await;
    state.current(generation).await?;
    let (base, token) = {
        let binding = state.binding.lock().await;
        let bound = binding.as_ref().ok_or_else(|| error("ALwith account changed"))?;
        (bound.account.api_base_url.clone(), bound.token.clone())
    };
    state.clear(app, true).await?;
    drop(transition);
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(error)?;
    let response = http
        .delete(format!("{base}/api/v1/me/enterprise/finture"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| error("Remote enterprise logout failed; local access is revoked"))?;
    if !response.status().is_success() {
        return Err(error("Remote enterprise logout failed; local access is revoked"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "enterprise/__tests__/native.rs"]
mod native_tests;
