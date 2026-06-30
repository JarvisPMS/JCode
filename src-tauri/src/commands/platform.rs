use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::commands::config_dir::{ensure_config_dir, resolve_config_dir};
use crate::commands::keychain;
use crate::models::platform::PlatformConfig;

#[tauri::command]
pub fn save_platform(
    app: AppHandle,
    config: PlatformConfig,
    api_key: Option<String>,
) -> Result<(), String> {
    // Save API key to keychain if provided
    if let Some(ref key) = api_key {
        if !key.is_empty() {
            keychain::save_api_key(config.id.clone(), key.clone())?;
        }
    }

    let store = app
        .store("platforms.json")
        .map_err(|e| format!("Failed to open store: {}", e))?;

    // Read existing platforms
    let mut platforms: Vec<PlatformConfig> = store
        .get("platforms")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    // Update or insert
    if let Some(existing) = platforms.iter_mut().find(|p| p.id == config.id) {
        *existing = config.clone();
    } else {
        platforms.push(config.clone());
    }

    store.set(
        "platforms",
        serde_json::to_value(&platforms).map_err(|e| e.to_string())?,
    );

    // 初始化配置目录（跳过 onboarding + 预批准 API Key）
    if !config.config_dir.is_empty() {
        // 获取 API key：优先用本次传入的，否则从 keychain 读取已有的
        let effective_key = match api_key {
            Some(ref k) if !k.is_empty() => k.clone(),
            _ => keychain::get_api_key_internal(&config.id).unwrap_or_default(),
        };

        if !effective_key.is_empty() {
            let resolved = resolve_config_dir(&config.config_dir);
            ensure_config_dir(&resolved, &effective_key)?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn get_platforms(app: AppHandle) -> Result<Vec<PlatformConfig>, String> {
    let store = app
        .store("platforms.json")
        .map_err(|e| format!("Failed to open store: {}", e))?;

    let platforms: Vec<PlatformConfig> = store
        .get("platforms")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    Ok(platforms)
}

#[tauri::command]
pub fn delete_platform(app: AppHandle, platform_id: String) -> Result<(), String> {
    // Delete from keychain
    let _ = keychain::delete_api_key(platform_id.clone());

    let store = app
        .store("platforms.json")
        .map_err(|e| format!("Failed to open store: {}", e))?;

    let mut platforms: Vec<PlatformConfig> = store
        .get("platforms")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    platforms.retain(|p| p.id != platform_id);

    store.set(
        "platforms",
        serde_json::to_value(&platforms).map_err(|e| e.to_string())?,
    );

    Ok(())
}

#[tauri::command]
pub fn reorder_platforms(app: AppHandle, ordered_ids: Vec<String>) -> Result<(), String> {
    let store = app
        .store("platforms.json")
        .map_err(|e| format!("Failed to open store: {}", e))?;

    let mut platforms: Vec<PlatformConfig> = store
        .get("platforms")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    for platform in &mut platforms {
        if let Some(pos) = ordered_ids.iter().position(|id| id == &platform.id) {
            platform.order = pos as u32;
        }
    }

    store.set(
        "platforms",
        serde_json::to_value(&platforms).map_err(|e| e.to_string())?,
    );

    Ok(())
}
