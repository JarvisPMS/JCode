//! API Key 存储命令。
//!
//! 历史上这里使用 `keyring` crate 调用系统 Keychain / Credential Manager；
//! 由于 macOS 上每次读取都会触发授权弹窗，已切换到 `secret_store` 自管的
//! AES-256-GCM 加密文件。对外暴露的命令名保持不变。
//!
//! 同时保留 `migrate_legacy_keychain` 命令，供用户从设置页一次性把旧
//! Keychain 数据迁移过来。

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::commands::secret_store;
use crate::models::platform::PlatformConfig;

const LEGACY_SERVICE_NAME: &str = "jcode";

#[tauri::command]
pub fn save_api_key(platform_id: String, api_key: String) -> Result<(), String> {
    secret_store::save(&platform_id, &api_key)
}

#[tauri::command]
pub fn delete_api_key(platform_id: String) -> Result<(), String> {
    secret_store::delete(&platform_id).map(|_| ())
}

#[tauri::command]
pub fn has_api_key(platform_id: String) -> Result<bool, String> {
    Ok(secret_store::has(&platform_id))
}

pub fn get_api_key_internal(platform_id: &str) -> Result<String, String> {
    secret_store::get(platform_id)?.ok_or_else(|| format!("未找到 API Key: {}", platform_id))
}

/// 读取指定平台的 API Key（供前端复制配置时使用）。未配置时返回空字符串。
#[tauri::command]
pub fn get_api_key(platform_id: String) -> Result<String, String> {
    Ok(secret_store::get(&platform_id)?.unwrap_or_default())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResult {
    /// 系统 Keychain 中能找到的平台数。
    pub total: usize,
    /// 成功写入新存储的数量（含已存在但被覆盖的）。
    pub migrated: usize,
    /// 已经存在于新存储、未被覆盖的数量。
    pub skipped: usize,
    /// 系统 Keychain 中未找到记录的平台数。
    pub not_found: usize,
    /// 失败信息（平台名 -> 错误描述），便于在 UI 中展示。
    pub failures: Vec<(String, String)>,
}

/// 从旧的系统 Keychain 把所有平台的 API Key 拷贝到新加密存储。
/// 设计原则：幂等、不覆盖、不删除旧数据 —— 用户可以放心点多次。
///
/// `overwrite=true` 时强制覆盖新存储里已有的条目。
#[tauri::command]
pub fn migrate_legacy_keychain(
    app: AppHandle,
    overwrite: bool,
) -> Result<MigrationResult, String> {
    let store = app
        .store("platforms.json")
        .map_err(|e| format!("Failed to open store: {}", e))?;

    let platforms: Vec<PlatformConfig> = store
        .get("platforms")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let mut result = MigrationResult {
        total: 0,
        migrated: 0,
        skipped: 0,
        not_found: 0,
        failures: Vec::new(),
    };

    for p in &platforms {
        let entry = match keyring::Entry::new(LEGACY_SERVICE_NAME, &p.id) {
            Ok(e) => e,
            Err(err) => {
                result
                    .failures
                    .push((p.name.clone(), format!("无法打开 Keychain 条目: {}", err)));
                continue;
            }
        };

        let legacy_key = match entry.get_password() {
            Ok(k) => k,
            Err(keyring::Error::NoEntry) => {
                result.not_found += 1;
                continue;
            }
            Err(err) => {
                result
                    .failures
                    .push((p.name.clone(), format!("读取 Keychain 失败: {}", err)));
                continue;
            }
        };

        result.total += 1;

        if !overwrite && secret_store::has(&p.id) {
            result.skipped += 1;
            continue;
        }

        match secret_store::save(&p.id, &legacy_key) {
            Ok(()) => result.migrated += 1,
            Err(err) => result.failures.push((p.name.clone(), err)),
        }
    }

    Ok(result)
}
