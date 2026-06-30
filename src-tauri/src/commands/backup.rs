use std::fs;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::commands::config_dir::{ensure_config_dir, resolve_config_dir};
use crate::commands::keychain;
use crate::models::platform::PlatformConfig;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlatformExport {
    name: String,
    icon: String,
    base_url: String,
    #[serde(default)]
    openai_base_url: String,
    #[serde(default)]
    anthropic_compat_via_proxy: bool,
    default_model: String,
    #[serde(default)]
    models: String,
    default_work_dir: String,
    config_dir: String,
    extra_args: String,
    order: u32,
    #[serde(default = "default_enabled")]
    enabled: bool,
    api_key: String,
}

fn default_enabled() -> bool {
    true
}

#[tauri::command]
pub fn export_platforms(app: AppHandle) -> Result<String, String> {
    let store = app
        .store("platforms.json")
        .map_err(|e| format!("Failed to open store: {}", e))?;

    let platforms: Vec<PlatformConfig> = store
        .get("platforms")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let default_claude_id = "00000000-0000-0000-0000-000000000000";
    let mut exports: Vec<PlatformExport> = Vec::new();
    for p in &platforms {
        // 跳过默认 Claude 卡片
        if p.id == default_claude_id {
            continue;
        }
        let api_key = keychain::get_api_key_internal(&p.id).unwrap_or_default();
        exports.push(PlatformExport {
            name: p.name.clone(),
            icon: p.icon.clone(),
            base_url: p.base_url.clone(),
            openai_base_url: p.openai_base_url.clone(),
            anthropic_compat_via_proxy: p.anthropic_compat_via_proxy,
            default_model: p.default_model.clone(),
            models: p.models.clone(),
            default_work_dir: p.default_work_dir.clone(),
            config_dir: p.config_dir.clone(),
            extra_args: p.extra_args.clone(),
            order: p.order,
            enabled: p.enabled,
            api_key,
        });
    }

    serde_json::to_string_pretty(&exports).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_platforms(app: AppHandle, json: String) -> Result<usize, String> {
    let imports: Vec<PlatformExport> =
        serde_json::from_str(&json).map_err(|e| format!("JSON 解析失败: {}", e))?;

    let store = app
        .store("platforms.json")
        .map_err(|e| format!("Failed to open store: {}", e))?;

    let mut platforms: Vec<PlatformConfig> = store
        .get("platforms")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let mut count = 0;
    let default_claude_id = "00000000-0000-0000-0000-000000000000";

    for item in &imports {
        // 跳过默认 Claude 卡片（它始终自动创建，无需导入）
        if item.base_url.is_empty() && item.config_dir.is_empty() {
            continue;
        }

        // 按 baseUrl + configDir 去重：两者相同 = 同一个平台配置
        let existing = platforms.iter_mut().find(|p| {
            p.id != default_claude_id
                && p.base_url == item.base_url
                && p.config_dir == item.config_dir
        });

        let id = if let Some(ex) = existing {
            // 更新已有平台的属性
            ex.name = item.name.clone();
            ex.icon = item.icon.clone();
            ex.openai_base_url = item.openai_base_url.clone();
            ex.anthropic_compat_via_proxy = item.anthropic_compat_via_proxy;
            ex.default_model = item.default_model.clone();
            ex.models = item.models.clone();
            ex.default_work_dir = item.default_work_dir.clone();
            ex.extra_args = item.extra_args.clone();
            ex.enabled = item.enabled;
            ex.id.clone()
        } else {
            // 新建平台
            let id = uuid::Uuid::new_v4().to_string();
            platforms.push(PlatformConfig {
                id: id.clone(),
                name: item.name.clone(),
                icon: item.icon.clone(),
                base_url: item.base_url.clone(),
                openai_base_url: item.openai_base_url.clone(),
                anthropic_compat_via_proxy: item.anthropic_compat_via_proxy,
                default_model: item.default_model.clone(),
                models: item.models.clone(),
                default_work_dir: item.default_work_dir.clone(),
                config_dir: item.config_dir.clone(),
                extra_args: item.extra_args.clone(),
                order: item.order,
                enabled: item.enabled,
            });
            id
        };

        // 写入 API Key 到 keychain
        if !item.api_key.is_empty() {
            keychain::save_api_key(id.clone(), item.api_key.clone())?;

            // 初始化配置目录
            if !item.config_dir.is_empty() {
                let resolved = resolve_config_dir(&item.config_dir);
                let _ = ensure_config_dir(&resolved, &item.api_key);
            }
        }

        count += 1;
    }

    store.set(
        "platforms",
        serde_json::to_value(&platforms).map_err(|e| e.to_string())?,
    );

    Ok(count)
}

#[tauri::command]
pub fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| format!("写入文件失败: {}", e))
}
