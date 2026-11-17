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
/// How long a *healthy* renewal answer may be reused. `host.status` is a native round trip that
/// every window rendering the account page pays for, yet a healthy answer cannot change meaning
/// inside this window: the native renewal loop announces expiry and re-login through
/// `enterprise:event`, and every publication/revocation clears the cache below. Unhealthy answers
/// are never cached, so a failing renewal is still reported the first time it is seen.
const STATUS_TTL: std::time::Duration = std::time::Duration::from_secs(60);
struct CachedStatus {
    generation: u64,
    at: std::time::Instant,
    value: Value,
}
struct Binding {
    account: Account,
    epoch: u64,
    generation: u64,
    token: String,
}
/// 原生企业模块是否支持「网关会话」。
///
/// 运行时探测在本机电里**不可用**：这一步调用 `enterprise.dispatch{capabilities}` 需要已打开的
/// enterprise id（`Missing enterprise id`），而在 `open` 之前还拿不到 id；等 client 打开后再问，
/// 0.6.2 的 crate 也没有这个接口。所以能力位改成**编译期特性开关**：
///   * 1.0.12（当前）：`enterprise-gateway-sessions` 关闭 → 上报 false，登录链路完全不变；
///   * 1.0.13：接上 0.6.5 crate 的 `open_gateway`（它自己会校验 `capabilities.gatewaySessions`），
///     打开该特性，状态里的 `gatewaySessions` 随之变真，前端据此切到新路径。
const GATEWAY_SESSIONS: bool = cfg!(feature = "enterprise-gateway-sessions");

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
    status_cache: Mutex<Option<CachedStatus>>,
}
fn error(message: impl ToString) -> Value {
    json!({"message":message.to_string()})
}
/// The exact shape that means "the local renewal can be trusted right now": it renews by itself,
/// it is not asking the reader to sign in, and the native layer recorded no error. Anything else
/// — including a missing field — is a real answer and must reach the reader immediately.
fn healthy(status: &Value) -> bool {
    status["automatic_renewal"] == true && status["requires_login"] == false && status["error"].is_null()
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


/// 平台给企业模型起的展示名（`api_id -> label`）。
///
/// 纯展示层：任何失败（离线、未授权、字段变形）都返回空表，让网关自己的 name 兜底。
/// 放在 Rust 侧是因为这里正好握着同一次刷新的 access token，前端不必为它多发一次请求——
/// 那会打乱启动期的请求序列（登录校验与刷新共用同一个 transport 计数）。
async fn enterprise_model_labels(account: &Account, token: &str) -> BTreeMap<String, String> {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return BTreeMap::new();
    };
    let url = format!("{}/api/v1/providers/finture-enterprise", account.api_base_url);
    let Ok(response) = client.get(url).bearer_auth(token).send().await else {
        log::debug!("[enterprise] model labels unavailable (request failed)");
        return BTreeMap::new();
    };
    if !response.status().is_success() {
        log::debug!("[enterprise] model labels unavailable ({})", response.status());
        return BTreeMap::new();
    }
    let Ok(value) = response.json::<Value>().await else { return BTreeMap::new() };
    if value["provider_id"] != "finture-enterprise" {
        return BTreeMap::new();
    }
    let Some(models) = value["models"].as_array() else { return BTreeMap::new() };
    let mut labels = BTreeMap::new();
    for model in models {
        let (Some(api_id), Some(label)) = (model["api_id"].as_str(), model["label"].as_str()) else {
            continue;
        };
        let (api_id, label) = (api_id.trim(), label.trim());
        if api_id.is_empty() || label.is_empty() || labels.contains_key(api_id) {
            // 重复 id 说明元数据自相矛盾：整份丢弃比猜一个更安全。
            return BTreeMap::new();
        }
        labels.insert(api_id.to_string(), label.to_string());
    }
    labels
}

/// 企业网关地址：生产与开发共用同一个 hosts 入口，由原生按环境选择。
const GATEWAY_URL: &str = "https://ai-enterprise-ai-gateway-api-dev.finture.id";

/// 申请名写进原生会话，便于网关上区分是哪个客户端开的路由。
fn environment() -> String {
    if crate::native::development_directory().is_some() && cfg!(debug_assertions) {
        "development".into()
    } else {
        "production".into()
    }
}

/// 登录邮箱给原生做会话标识。0.6.5 的 `prepare_gateway` 需要它，而我们的 bind 只传 baseUrl +
/// userUuid（少改一处前端就少一个回归点），所以从平台的凭据文件里读；读不到就留空，
/// 原生会按匿名会话处理，不阻断登录。
fn account_email(app: &AppHandle) -> Option<String> {
    let directory = app.path().app_data_dir().ok()?;
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&directory) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with("auth.") {
                candidates.push(entry.path());
            }
        }
    }
    for path in candidates {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { continue };
        if let Some(email) = value["user"]["login_email"].as_str()
            && !email.trim().is_empty()
        {
            return Some(email.to_string());
        }
    }
    None
}

/// 打包后的共享模型模板：引擎按这份 `alwith/models.json` 建企业目录。
fn source_catalog(app: &AppHandle) -> Result<std::path::PathBuf, Value> {
    let path = app.path().resource_dir().map_err(error)?.join("alwith/models.json");
    if !path.exists() {
        return Err(error("共享模型目录缺失，请重新安装应用后重试"));
    }
    Ok(path)
}

/// 把原生的连接结果组装成本应用使用的形状。
///
/// 关键差异：**不用** crate 的 `codex::connection()`。它把 `baseUrl` 指向企业 relay、把真实
/// `api_key` 写进 `bearerToken`；而本应用要求凭据只留在原生内存与本机路由里，引擎侧一律指向
/// 共享路由（`bridge::router_base_url`），由 router 转发。所以这里复用既有的
/// `catalog::connection_params`，只把原生给的 provider 转成它的入参。
fn build_connection(
    app: &AppHandle,
    identity: &str,
    connection: alwith_enterprise_client::Connection,
) -> Result<catalog::Connection, Value> {
    let provider = catalog::IssuedProvider {
        provider_id: connection.provider.id.clone(),
        name: connection.provider.name.clone(),
        base_url: connection.provider.base_url.clone(),
        hidden: false,
        models: connection
            .provider
            .models
            .iter()
            .map(|model| catalog::Model {
                api_id: model.api_id.clone(),
                label: model.label.clone(),
                context_window: model.context_window,
                description: model.description.clone(),
            })
            .collect(),
    };
    let catalog = connection.catalog.ok_or_else(|| error("企业模型目录缺失"))?;
    // 目录稳定副本：`providers::merged_catalog_path` 只在固定位置找它（与 0.6.2 路径一致）。
    let path = catalog::relocated_catalog(app, &catalog.path).unwrap_or(catalog.path);
    let router = crate::bridge::router_base_url().ok_or_else(|| error("共享模型路由不可用，请重启应用后重试"))?;
    let id = catalog::scoped_provider_id(identity, &provider.provider_id);
    Ok(catalog::connection_params(
        id,
        provider,
        connection.relay,
        path,
        catalog.has_known_model,
        &router,
    ))
}

impl Enterprise {
    async fn host(&self, app: &AppHandle) -> Result<&Arc<EnterpriseClient>, Value> {
        self.host.get_or_try_init(|| async {
            // 0.6.5 起企业会话由原生持有：`open_gateway` 拿走一个**会话文件**，令牌、续期和
            // 设备指纹都在原生侧，应用不再拿 access token 去换 relay。文件随应用数据目录走，
            // 重装应用要重新登录一次，与上游行为一致。
            let sessions = app.path().app_data_dir().map_err(error)?.join("enterprise-gateway-sessions.json");
            let directory = match crate::native::development_directory() {
                Some(directory) => directory,
                None => app.path().resource_dir().map_err(error)?.join("native"),
            };
            let host = Arc::new(EnterpriseClient::open_gateway(&directory, &sessions).await?);
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
        self.forget_status();
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
            return Err(error("企业账号尚未就绪，请稍后重试"));
        };
        let gate = self.gate.lock().unwrap();
        if binding.generation != generation || binding.epoch != gate.generation || gate.account.is_none() {
            return Err(error("ALwith 账号已变更，请重试"));
        }
        Ok(self.host.get().expect("prepared enterprise client").clone())
    }
    /// A locally healthy renewal answer is reused for `STATUS_TTL`; every other answer is passed
    /// through and forgotten. This is the short circuit the account page needs: it reads the
    /// status on mount and on each renewal event, and a healthy account produced an identical
    /// native round trip every single time.
    async fn status(&self, generation: u64) -> Result<Value, Value> {
        {
            let cache = self.status_cache.lock().unwrap();
            if let Some(cached) = cache.as_ref()
                && cached.generation == generation
                && cached.at.elapsed() < STATUS_TTL
            {
                return Ok(cached.value.clone());
            }
        }
        let host = self.host.get().ok_or_else(|| error("企业账号尚未就绪，请稍后重试"))?.clone();
        let value = host.status(generation).await?;
        let entry = healthy(&value).then(|| CachedStatus {
            generation,
            at: std::time::Instant::now(),
            value: value.clone(),
        });
        *self.status_cache.lock().unwrap() = entry;
        Ok(value)
    }
    /// Anything that moves the routing state — a new account, a published catalog, a revocation —
    /// makes a previously healthy renewal answer unrepresentative, so it is dropped rather than
    /// waited out.
    fn forget_status(&self) {
        *self.status_cache.lock().unwrap() = None;
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
        self.forget_status();
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
        return Err(error("ALwith 账号信息无效，请重新登录"));
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
    // 平台为同一批模型给出的展示名（`api_id -> label`）。取不到时传空表：原生会退回网关自己的
    // 名称，登录与续期绝不能因为一次元数据请求失败而中断。
    model_labels: BTreeMap<String, String>,
) -> Result<Value, Value> {
    main_window(&window)?;
    let app = window.app_handle();
    let state = app.state::<Enterprise>();
    let identity = format!("{}:{}", account.api_base_url, account.user_uuid);
    if access_token.trim().is_empty() {
        {
            let mut gate = state.gate.lock().unwrap();
            if gate.generation != generation || gate.account.as_ref() != Some(&identity) {
                return Err(error("ALwith 账号已变更，请重试"));
            }
            state.revoke_connection();
            // Retire pending refreshes as well as the live route before any async wait.
            gate.invalidate().map_err(error)?;
        }
        let _transition = state.transition.lock().await;
        state.clear(app, false).await?;
        return Err(error("登录已失效，请重新登录 ALwith 账号"));
    }
    let _refresh = state.refresh.lock().await;
    let check = || {
        let gate = state.gate.lock().unwrap();
        if gate.generation != generation || gate.account.as_ref() != Some(&identity) {
            Err(error("ALwith 账号已变更，请重试"))
        } else {
            Ok(())
        }
    };
    check()?;
    let result = async {
        let host = state.host(app).await?;
        // `prepare_gateway` 取代了 0.6.2 的 `prepare(base_url, uuid, token)`：网关会话由原生建立，
        // 应用只提供身份（用户 uuid + 邮箱 + 环境）与申请名，不再经手 access token。
        let native_generation = {
            let mut binding = state.binding.lock().await;
            check()?;
            let native_generation = host
                .prepare_gateway(
                    GATEWAY_URL.to_string(),
                    account.user_uuid.clone(),
                    account_email(app).unwrap_or_default(),
                    environment(),
                    "alwith-u".to_string(),
                )
                .await?;
            if let Err(reason) = check() {
                host.suspend(native_generation).await?;
                return Err(reason);
            }
            *binding = Some(Binding {
                account: account.clone(),
                epoch: generation,
                generation: native_generation,
                token: String::new(),
            });
            native_generation
        };
        // `connect` 一次做完「确保会话 → 拉网关 provider → 校验 → 起 relay → 建引擎目录」。
        // 0.6.2 那四步（GET /api/v1/providers → ensure → relay → modelCatalog）里最容易失败的
        // 组合被原生收敛成一个原子操作。`labels` 目前交给原生返回的 label（平台标签接口要
        // 单独授权，留到下一步）。
        // 平台标签优先，缺口由调用方给的（一般是空表）补。
        let mut labels = enterprise_model_labels(&account, &access_token).await;
        for (api_id, label) in model_labels.iter() {
            labels.entry(api_id.clone()).or_insert_with(|| label.clone());
        }
        let source = source_catalog(app)?;
        if !labels.is_empty() {
            log::debug!("[enterprise] applying {} platform model label(s)", labels.len());
        }
        let connected = host.connect(native_generation, &labels, Protocol::Responses, Some(&source)).await?;
        check()?;
        let Some(connection) = connected else { return Ok(None) };
        Ok::<_, Value>(Some(Arc::new(build_connection(app, &identity, connection)?)))
    }
    .await;
    check()?;
    // 一次失败的发现不是「目录权威地变空了」。刷新失败（网关抖动、平台 5xx、企业登录临时失效）
    // 时**不要**动 gate 里的模型集，也不吊销已注册的路由：用户正在跑的会话会立刻变成
    // 「企业模型不可用」，重新登录后模型又回来 —— 这就是「打开企业模型状态异常、和会话记录的
    // 最后一个模型冲突」的由来。只在刷新成功后提交新的模型集，失败时把错误交给调用方显示。
    // （对应上游 3328185e fix(enterprise): preserve connections after failed model refreshes）
    // `Ok(None)` 是权威的「没有可用模型」（企业账号未授权 / 未自动续期）：这时必须清空，
    // 否则撤销了企业模型、选择器里还留着旧条目。只有 `Err` 才是「这次没问出来」，保持不动。
    let models = result.as_ref().ok().map(|connection| {
        connection
            .as_ref()
            .map(|connection| {
                connection
                    .provider
                    .models
                    .iter()
                    .map(|model| catalog::model_id(&connection.provider.id, &model.api_id))
                    .collect::<BTreeSet<String>>()
            })
            .unwrap_or_default()
    });
    if let Some(models) = models {
        let mut gate = state.gate.lock().unwrap();
        gate.commit(generation, models).map_err(error)?;
        state.revoke_connection();
        *state.connection.lock().unwrap() = result.as_ref().ok().and_then(|connection| connection.as_ref()).cloned();
    } else if let Err(reason) = &result {
        log::warn!("[enterprise] refresh failed, keeping the previous connection: {reason}");
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
    let gateway_sessions = GATEWAY_SESSIONS;
    let generation = {
        let binding = state.binding.lock().await;
        let Some(binding) = binding.as_ref() else {
            return Ok(json!({
                "automatic_renewal":false,"requires_login":false,"error":null,
                "gatewaySessions":gateway_sessions
            }));
        };
        binding.generation
    };
    state.current(generation).await?;
    let mut status = state.status(generation).await?;
    if let Some(object) = status.as_object_mut() {
        object.insert("gatewaySessions".into(), Value::Bool(gateway_sessions));
    }
    Ok(status)
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
    // 0.6.5 起企业令牌由原生网关会话持有：轮换、续期、重登都在原生侧完成，并通过
    // `enterprise:event` 上报。应用不再把 access token 递进去，这条命令保留只为兼容前端
    // 既有调用（它仍要确认账号没换），实际只刷新一次状态缓存。
    state.current(generation).await?;
    let request = request_id.clone();
    log::debug!("[enterprise] account token rotation acknowledged (request {request}, {} bytes)", access_token.len());
    state.forget_status();
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
        let bound = binding.as_ref().ok_or_else(|| error("ALwith 账号已变更，请重试"))?;
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
        .map_err(|_| error("远端退出登录失败，本机权限已撤销"))?;
    if !response.status().is_success() {
        return Err(error("远端退出登录失败，本机权限已撤销"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "enterprise/__tests__/native.rs"]
mod native_tests;
