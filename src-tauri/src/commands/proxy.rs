//! 本地 Anthropic Messages API 代理。
//!
//! 用途：第三方软件锁死了 Claude 的模型名（如 claude-sonnet-4-7-...），
//! 通过把它的 baseUrl 指向本代理，由代理把模型名换成用户实际想用的
//! 平台/模型，再透传到目标 baseUrl，对客户端零感知。
//!
//! 协议：纯 Anthropic Messages API 透传。SSE 字节流原样转发。

use std::net::SocketAddr;
use std::time::Duration;

use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode, Uri},
    response::Response,
    routing::any,
    Router,
};
use bytes::Bytes;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;
use tokio::sync::{oneshot, Mutex};

use crate::commands::keychain;
use crate::commands::openai_adapter;
use crate::models::platform::PlatformConfig;
use crate::models::proxy::ProxyConfig;

/// 应用启动时插入到 Tauri State 的代理状态。
pub struct ProxyState {
    inner: Mutex<Option<RunningProxy>>,
}

struct RunningProxy {
    port: u16,
    shutdown_tx: oneshot::Sender<()>,
    join_handle: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Clone)]
struct AppCtx {
    app: AppHandle,
    client: reqwest::Client,
}

impl ProxyState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

impl Default for ProxyState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub running: bool,
    pub port: Option<u16>,
}

// =========================
// Tauri Commands
// =========================

#[tauri::command]
pub fn get_proxy_config(app: AppHandle) -> Result<ProxyConfig, String> {
    let store = app
        .store("proxy.json")
        .map_err(|e| format!("打开 proxy.json 失败: {}", e))?;
    let cfg: ProxyConfig = store
        .get("config")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    Ok(cfg)
}

#[tauri::command]
pub fn save_proxy_config(app: AppHandle, config: ProxyConfig) -> Result<(), String> {
    let store = app
        .store("proxy.json")
        .map_err(|e| format!("打开 proxy.json 失败: {}", e))?;
    store.set(
        "config",
        serde_json::to_value(&config).map_err(|e| e.to_string())?,
    );
    Ok(())
}

#[tauri::command]
pub async fn get_proxy_status(app: AppHandle) -> Result<ProxyStatus, String> {
    let state = app.state::<ProxyState>();
    let guard = state.inner.lock().await;
    Ok(match guard.as_ref() {
        Some(p) => ProxyStatus {
            running: true,
            port: Some(p.port),
        },
        None => ProxyStatus {
            running: false,
            port: None,
        },
    })
}

#[tauri::command]
pub async fn start_proxy(app: AppHandle, port: u16) -> Result<(), String> {
    let state = app.state::<ProxyState>();
    let mut guard = state.inner.lock().await;
    if guard.is_some() {
        return Err("代理服务已经在运行".into());
    }
    *guard = Some(spawn_proxy(&app, port).await?);
    Ok(())
}

/// 起一个监听 `127.0.0.1:<port>` 的代理服务，返回其句柄。不碰全局状态。
async fn spawn_proxy(app: &AppHandle, port: u16) -> Result<RunningProxy, String> {
    // 上游出站：若用户配了「全部」范围的网络代理，转发到上游时也走它
    // （否则部分被墙的 OpenAI 端点如 openrouter.ai 会连不上）。否则沿用环境变量代理。
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(600));
    if let Some(proxy_url) = crate::commands::settings::network_proxy_url(app) {
        match reqwest::Proxy::all(proxy_url.as_str()) {
            Ok(p) => builder = builder.proxy(p),
            Err(e) => eprintln!("网络代理配置无效，已忽略：{}", e),
        }
    }
    let client = builder
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败: {}", e))?;

    let ctx = AppCtx {
        app: app.clone(),
        client,
    };

    let router: Router = Router::new()
        .route("/p/:id/*rest", any(proxy_handler_by_id))
        .fallback(any(proxy_handler))
        .with_state(ctx);

    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("无法绑定端口 {}：{}", port, e))?;

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let join_handle = tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await;
    });

    Ok(RunningProxy {
        port,
        shutdown_tx,
        join_handle,
    })
}

/// 确保本地代理在运行（OpenAI 平台启动时的运行时刚需），返回端口。
/// 已在运行则直接返回当前端口；未运行则按 proxy.json 配置端口拉起。
pub async fn ensure_proxy_running(app: &AppHandle) -> Result<u16, String> {
    let state = app.state::<ProxyState>();
    let mut guard = state.inner.lock().await;
    if let Some(p) = guard.as_ref() {
        return Ok(p.port);
    }
    let cfg: ProxyConfig = app
        .store("proxy.json")
        .ok()
        .and_then(|s| s.get("config"))
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let proxy = spawn_proxy(app, cfg.port).await?;
    let port = proxy.port;
    *guard = Some(proxy);
    Ok(port)
}

#[tauri::command]
pub async fn stop_proxy(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ProxyState>();
    let mut guard = state.inner.lock().await;
    let proxy = guard.take().ok_or("代理服务未运行")?;
    let _ = proxy.shutdown_tx.send(());
    let _ = tokio::time::timeout(Duration::from_secs(3), proxy.join_handle).await;
    Ok(())
}

// =========================
// HTTP Handler
// =========================

async fn proxy_handler(
    State(ctx): State<AppCtx>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match handle_request(ctx, method, uri, headers, body).await {
        Ok(resp) => resp,
        Err((status, msg)) => error_response(status, &msg),
    }
}

/// `/p/<平台id>/...` 直连入口：跳过模型名映射，按 id 直接定位平台。
/// 供 JCode 自身启动 OpenAI 平台时使用（model 已是后端真实名，原样透传）。
async fn proxy_handler_by_id(
    State(ctx): State<AppCtx>,
    Path((id, rest)): Path<(String, String)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match handle_by_id(ctx, id, rest, uri, method, headers, body).await {
        Ok(resp) => resp,
        Err((status, msg)) => error_response(status, &msg),
    }
}

async fn handle_by_id(
    ctx: AppCtx,
    id: String,
    rest: String,
    uri: Uri,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, (StatusCode, String)> {
    let json: Value = serde_json::from_slice(&body)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("请求 body 不是合法 JSON: {}", e)))?;
    let target_model = json
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let platforms_store = ctx.app.store("platforms.json").map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("读取 platforms.json 失败: {}", e),
        )
    })?;
    let platforms: Vec<PlatformConfig> = platforms_store
        .get("platforms")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let platform = platforms
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| (StatusCode::BAD_REQUEST, format!("目标平台不存在：{}", id)))?
        .clone();

    // 重建去掉 /p/<id> 前缀的 URI，供下游按原 path 处理（含 count_tokens 识别）。
    let query = uri.query().map(|q| format!("?{}", q)).unwrap_or_default();
    let clean_uri: Uri = format!("/{}{}", rest, query)
        .parse()
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("URI 解析失败: {}", e)))?;

    dispatch(&ctx, &platform, &target_model, method, clean_uri, headers, json).await
}

async fn handle_request(
    ctx: AppCtx,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, (StatusCode, String)> {
    // 解析 JSON 取 model（仅对 messages 类端点有 model 字段；其他端点直接报错让客户端能看到清晰提示）
    let json: Value = serde_json::from_slice(&body).map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            format!("请求 body 不是合法 JSON: {}", e),
        )
    })?;
    let source_model = json
        .get("model")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "请求中未指定 model 字段".to_string(),
            )
        })?
        .to_string();

    // 读 proxy 配置
    let proxy_store = ctx.app.store("proxy.json").map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("读取 proxy.json 失败: {}", e),
        )
    })?;
    let cfg: ProxyConfig = proxy_store
        .get("config")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let mapping = cfg
        .mappings
        .iter()
        .find(|m| m.source_model == source_model)
        .cloned()
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                format!("未配置模型映射：{}", source_model),
            )
        })?;

    // 读平台配置 + API Key
    let platforms_store = ctx.app.store("platforms.json").map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("读取 platforms.json 失败: {}", e),
        )
    })?;
    let platforms: Vec<PlatformConfig> = platforms_store
        .get("platforms")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let platform = platforms
        .iter()
        .find(|p| p.id == mapping.target_platform_id)
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                format!("目标平台不存在：{}", mapping.target_platform_id),
            )
        })?
        .clone();
    dispatch(&ctx, &platform, &mapping.target_model, method, uri, headers, json).await
}

/// 按平台端点选择协议并分发：有原生 Anthropic 端点则透传，否则走 OpenAI 适配器。
async fn dispatch(
    ctx: &AppCtx,
    platform: &PlatformConfig,
    target_model: &str,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    json: Value,
) -> Result<Response, (StatusCode, String)> {
    let api_key = keychain::get_api_key_internal(&platform.id).map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            format!("平台「{}」未配置 API Key", platform.name),
        )
    })?;

    if platform.has_anthropic() {
        forward_anthropic(ctx, platform, target_model, method, uri, headers, json, &api_key).await
    } else if platform.has_openai() {
        forward_openai(ctx, platform, target_model, uri, json, &api_key).await
    } else {
        Err((
            StatusCode::BAD_REQUEST,
            format!("平台「{}」未配置任何协议端点", platform.name),
        ))
    }
}

/// Anthropic 协议透传：改写模型名后原样转发到平台 base_url，SSE 字节流直传。
#[allow(clippy::too_many_arguments)]
async fn forward_anthropic(
    ctx: &AppCtx,
    platform: &PlatformConfig,
    target_model: &str,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    mut json: Value,
    api_key: &str,
) -> Result<Response, (StatusCode, String)> {
    json["model"] = Value::String(target_model.to_string());
    let new_body =
        serde_json::to_vec(&json).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let path_and_query = uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/v1/messages");
    let base = platform.base_url.trim_end_matches('/');
    let target_url = format!("{}{}", base, path_and_query);

    let mut req = ctx.client.request(method, &target_url);
    for (k, v) in headers.iter() {
        let name = k.as_str().to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "host"
                | "authorization"
                | "x-api-key"
                | "content-length"
                | "connection"
                | "transfer-encoding"
                | "accept-encoding"
        ) {
            continue;
        }
        if let Ok(s) = v.to_str() {
            req = req.header(k.as_str(), s);
        }
    }
    req = req
        .header("x-api-key", api_key)
        .header("content-type", "application/json")
        .body(new_body);

    let upstream = req
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("转发到上游失败: {}", e)))?;

    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let mut builder = Response::builder().status(status.as_u16());
    for (k, v) in upstream_headers.iter() {
        let n = k.as_str().to_ascii_lowercase();
        if matches!(
            n.as_str(),
            "content-length" | "transfer-encoding" | "connection"
        ) {
            continue;
        }
        builder = builder.header(k.as_str(), v);
    }
    let body = Body::from_stream(upstream.bytes_stream());
    builder
        .body(body)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("构建响应失败: {}", e)))
}

/// OpenAI 协议适配：请求转 OpenAI、注入 Bearer、响应/SSE 转回 Anthropic。
async fn forward_openai(
    ctx: &AppCtx,
    platform: &PlatformConfig,
    target_model: &str,
    uri: Uri,
    json: Value,
    api_key: &str,
) -> Result<Response, (StatusCode, String)> {
    // count_tokens 端点 OpenAI 无对应：本地估算，绝不能 404。
    if uri.path().ends_with("/count_tokens") {
        let est = openai_adapter::estimate_count_tokens(&json);
        return json_response(StatusCode::OK, &est);
    }

    let stream = json.get("stream").and_then(|v| v.as_bool()).unwrap_or(false);
    let openai_req = openai_adapter::build_openai_request(&json, target_model);

    let base = platform.openai_base_url.trim_end_matches('/');
    let target_url = format!("{}/chat/completions", base);

    let upstream = ctx
        .client
        .post(&target_url)
        .header("authorization", format!("Bearer {}", api_key))
        .header("content-type", "application/json")
        .json(&openai_req)
        .send()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("转发到上游失败: {}", e)))?;

    let status = upstream.status();
    if !status.is_success() {
        let code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let mut text = upstream.text().await.unwrap_or_default();
        let looks_like_html = text.trim_start().starts_with('<');
        // 错误页（尤其是 HTML 404）可能很长，截断
        if text.chars().count() > 300 {
            text = text.chars().take(300).collect::<String>() + "…";
        }
        // 404 或 HTML 多半是 BaseURL 路径不对（OpenAI 端点通常要带 /v1）
        let hint = if status.as_u16() == 404 || looks_like_html {
            "\n提示：OpenAI 兼容端点通常需带版本路径（如 …/v1），代理会在其后自动拼 /chat/completions。请检查该平台的「OpenAI 兼容端点」是否填到 /v1 为止。"
        } else {
            ""
        };
        return Err((code, format!("上游返回 {}: {}{}", status.as_u16(), text, hint)));
    }

    if stream {
        let body_stream =
            openai_adapter::anthropic_sse_stream(upstream.bytes_stream(), target_model.to_string());
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .body(Body::from_stream(body_stream))
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("构建响应失败: {}", e)))
    } else {
        let openai_resp: Value = upstream
            .json()
            .await
            .map_err(|e| (StatusCode::BAD_GATEWAY, format!("解析上游响应失败: {}", e)))?;
        let anthropic = openai_adapter::openai_response_to_anthropic(&openai_resp, target_model);
        json_response(StatusCode::OK, &anthropic)
    }
}

/// 构造一个 JSON 响应。
fn json_response(status: StatusCode, value: &Value) -> Result<Response, (StatusCode, String)> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("构建响应失败: {}", e)))
}

fn error_response(status: StatusCode, msg: &str) -> Response {
    let payload = serde_json::json!({
        "type": "error",
        "error": { "type": "proxy_error", "message": msg }
    });
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .unwrap()
}
