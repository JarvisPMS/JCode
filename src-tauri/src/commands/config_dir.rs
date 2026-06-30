use std::fs;
use std::path::Path;

/// 将路径中的 ~ 或 ~/ 展开为用户主目录
pub fn expand_tilde(path: &str) -> String {
    if path.starts_with("~/") || path.starts_with("~\\") {
        if let Some(home) = dirs::home_dir() {
            return home.join(&path[2..]).to_string_lossy().to_string();
        }
    } else if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().to_string();
        }
    }
    path.to_string()
}

/// 解析配置目录路径：
/// - 绝对路径直接使用
/// - ~ 开头展开为用户主目录
/// - 其他（如 "ali"）视为 ~/.jcode/<name> 的简写
pub fn resolve_config_dir(path: &str) -> String {
    let expanded = expand_tilde(path);
    if Path::new(&expanded).is_absolute() {
        return expanded;
    }
    if let Some(home) = dirs::home_dir() {
        home.join(".jcode").join(&expanded).to_string_lossy().to_string()
    } else {
        expanded
    }
}

/// 初始化配置目录：
/// 1. 创建目录（如不存在）
/// 2. 写入 .claude.json 跳过 onboarding + 预批准 API Key
/// 3. 清除残留 OAuth 凭证，避免与 API Key 冲突
pub fn ensure_config_dir(config_dir: &str, api_key: &str) -> Result<(), String> {
    let dir = Path::new(config_dir);

    if !dir.exists() {
        fs::create_dir_all(dir)
            .map_err(|e| format!("无法创建配置目录: {}", e))?;
    }

    // API key 后缀（Claude 用后 20 位做指纹识别）
    let key_suffix = if api_key.len() > 20 {
        &api_key[api_key.len() - 20..]
    } else {
        api_key
    };

    let claude_json = dir.join(".claude.json");
    if claude_json.exists() {
        // 已有配置：确保当前 key 在 approved 列表中
        if let Ok(content) = fs::read_to_string(&claude_json) {
            if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&content) {
                let approved = val
                    .pointer_mut("/customApiKeyResponses/approved")
                    .and_then(|v| v.as_array_mut());

                if let Some(arr) = approved {
                    let suffix_val = serde_json::Value::String(key_suffix.to_string());
                    if !arr.contains(&suffix_val) {
                        arr.push(suffix_val);
                        let _ = fs::write(
                            &claude_json,
                            serde_json::to_string_pretty(&val).unwrap_or_default(),
                        );
                    }
                } else {
                    val["customApiKeyResponses"] = serde_json::json!({
                        "approved": [key_suffix],
                        "rejected": []
                    });
                    let _ = fs::write(
                        &claude_json,
                        serde_json::to_string_pretty(&val).unwrap_or_default(),
                    );
                }
            }
        }
    } else {
        // 首次创建
        let minimal = serde_json::json!({
            "hasCompletedOnboarding": true,
            "customApiKeyResponses": {
                "approved": [key_suffix],
                "rejected": []
            }
        });
        let _ = fs::write(
            &claude_json,
            serde_json::to_string_pretty(&minimal).unwrap_or_default(),
        );
    }

    // 清除残留 OAuth 凭证
    let credentials = dir.join(".credentials.json");
    if credentials.exists() {
        let _ = fs::remove_file(&credentials);
    }

    Ok(())
}
