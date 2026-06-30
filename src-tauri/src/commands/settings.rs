use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const SETTINGS_STORE: &str = "settings.json";
const PERMISSION_MODE_KEY: &str = "permissionMode";
const NETWORK_PROXY_KEY: &str = "networkProxy";

pub fn get_permission_mode_internal(app: &AppHandle) -> String {
    app.store(SETTINGS_STORE)
        .ok()
        .and_then(|store| store.get(PERMISSION_MODE_KEY))
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "default".to_string())
}

#[tauri::command]
pub fn get_permission_mode(app: AppHandle) -> String {
    get_permission_mode_internal(&app)
}

#[tauri::command]
pub fn save_permission_mode(app: AppHandle, mode: String) -> Result<(), String> {
    let store = app
        .store(SETTINGS_STORE)
        .map_err(|e| format!("Failed to open settings store: {}", e))?;
    store.set(PERMISSION_MODE_KEY, serde_json::Value::String(mode));
    Ok(())
}

/// 网络代理配置。
///
/// scope 取值：
///   - "off"      关闭，不注入任何代理环境变量
///   - "all"      对所有平台生效
///   - "official" 仅对内置的 Claude 官方平台生效
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkProxyConfig {
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: String,
    #[serde(default = "default_scope")]
    pub scope: String,
}

fn default_scope() -> String {
    "off".to_string()
}

impl Default for NetworkProxyConfig {
    fn default() -> Self {
        NetworkProxyConfig {
            host: String::new(),
            port: String::new(),
            scope: default_scope(),
        }
    }
}

pub fn get_network_proxy_internal(app: &AppHandle) -> NetworkProxyConfig {
    app.store(SETTINGS_STORE)
        .ok()
        .and_then(|store| store.get(NETWORK_PROXY_KEY))
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

/// 根据代理配置与目标平台是否为官方，构建需要注入的代理环境变量。
/// 同时设置大小写两种变量名，以兼容不同工具。
pub fn network_proxy_env_vars(app: &AppHandle, is_official: bool) -> Vec<(String, String)> {
    let cfg = get_network_proxy_internal(app);
    let active = match cfg.scope.as_str() {
        "all" => true,
        "official" => is_official,
        _ => false,
    };

    let host = cfg.host.trim();
    let port = cfg.port.trim();
    if !active || host.is_empty() || port.is_empty() {
        return Vec::new();
    }

    let http = format!("http://{}:{}", host, port);
    let socks = format!("socks5h://{}:{}", host, port);

    vec![
        ("HTTP_PROXY".to_string(), http.clone()),
        ("HTTPS_PROXY".to_string(), http.clone()),
        ("ALL_PROXY".to_string(), socks.clone()),
        ("http_proxy".to_string(), http.clone()),
        ("https_proxy".to_string(), http),
        ("all_proxy".to_string(), socks),
    ]
}

/// 本地代理「上游出站」要使用的网络代理 URL。
///
/// 仅当 scope == "all"（对所有平台生效）且填了 host/port 时返回 Some。
/// 用途：经本地代理转协议的 OpenAI 平台，其上游（如 openrouter.ai）可能被墙，
/// 需要让代理的出站请求走用户的 VPN 本地代理。
pub fn network_proxy_url(app: &AppHandle) -> Option<String> {
    let cfg = get_network_proxy_internal(app);
    if cfg.scope != "all" {
        return None;
    }
    let host = cfg.host.trim();
    let port = cfg.port.trim();
    if host.is_empty() || port.is_empty() {
        return None;
    }
    Some(format!("http://{}:{}", host, port))
}

#[tauri::command]
pub fn get_network_proxy_config(app: AppHandle) -> NetworkProxyConfig {
    get_network_proxy_internal(&app)
}

#[tauri::command]
pub fn save_network_proxy_config(
    app: AppHandle,
    config: NetworkProxyConfig,
) -> Result<(), String> {
    let store = app
        .store(SETTINGS_STORE)
        .map_err(|e| format!("Failed to open settings store: {}", e))?;
    store.set(
        NETWORK_PROXY_KEY,
        serde_json::to_value(&config).map_err(|e| e.to_string())?,
    );
    Ok(())
}
