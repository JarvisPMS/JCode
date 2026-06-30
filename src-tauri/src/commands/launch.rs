use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::commands::config_dir::resolve_config_dir;
use crate::commands::keychain::get_api_key_internal;
use crate::commands::terminal::{launch_in_terminal, LaunchConfig};
use crate::models::platform::{ClaudeRoute, PlatformConfig};

const DEFAULT_CLAUDE_ID: &str = "00000000-0000-0000-0000-000000000000";
/// OpenAI 平台经代理启动时占位的 API Key——真实 key 由代理按平台 id 从 keychain 取。
pub const PROXY_PLACEHOLDER_KEY: &str = "jcode-proxy-managed";

#[tauri::command]
pub fn is_directory(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).is_dir())
}

#[tauri::command]
pub fn check_claude_installed() -> Result<bool, String> {
    Ok(command_exists("claude"))
}

#[tauri::command]
pub async fn launch_platform(
    app: AppHandle,
    platform_id: String,
    work_dir: String,
) -> Result<(), String> {
    // 先在主线程读取 store（需要 AppHandle）
    let launch_config = {
        if !Path::new(&work_dir).is_dir() {
            return Err(format!("工作目录不存在: {}", work_dir));
        }

        // 读取全局权限模式设置
        let permission_mode = crate::commands::settings::get_permission_mode_internal(&app);

        // 默认 Claude：不注入平台相关环境变量，但可能注入网络代理
        if platform_id == DEFAULT_CLAUDE_ID {
            let mut claude_args: Vec<String> = Vec::new();
            if permission_mode != "default" {
                claude_args.push("--permission-mode".to_string());
                claude_args.push(permission_mode);
            }
            // 注入网络代理（官方平台 is_official = true）
            let env_vars = crate::commands::settings::network_proxy_env_vars(&app, true);
            LaunchConfig {
                work_dir: work_dir.clone(),
                env_vars,
                claude_args,
            }
        } else {
            // Read platform config from store
            let store = app
                .store("platforms.json")
                .map_err(|e| format!("Failed to open store: {}", e))?;

            let platforms_json = store.get("platforms").ok_or("未找到平台配置")?;

            let platforms: Vec<PlatformConfig> = serde_json::from_value(platforms_json.clone())
                .map_err(|e| format!("Failed to parse platforms: {}", e))?;

            let platform = platforms
                .iter()
                .find(|p| p.id == platform_id)
                .ok_or(format!("未找到平台: {}", platform_id))?
                .clone();

            // Read API key from keychain
            let api_key = get_api_key_internal(&platform_id).map_err(|_| {
                format!(
                    "平台「{}」尚未配置 API Key，请先编辑该平台并填写密钥。",
                    platform.name
                )
            })?;

            // Build environment variables —— 按平台接入方式分两路（直连 / 经代理转协议）
            let mut env_vars: Vec<(String, String)> = Vec::new();
            match platform.claude_route() {
                ClaudeRoute::DirectAnthropic(url) => {
                    // 原生 Anthropic 端点：直连，注入真实 key。
                    env_vars.push(("ANTHROPIC_API_KEY".to_string(), api_key));
                    env_vars.push(("ANTHROPIC_BASE_URL".to_string(), url));
                }
                ClaudeRoute::OpenAiViaProxy => {
                    // 仅 OpenAI 端点 + 兼容开关：经本地代理转协议。
                    let port = crate::commands::proxy::ensure_proxy_running(&app).await?;
                    env_vars.push((
                        "ANTHROPIC_API_KEY".to_string(),
                        PROXY_PLACEHOLDER_KEY.to_string(),
                    ));
                    env_vars.push((
                        "ANTHROPIC_BASE_URL".to_string(),
                        format!("http://127.0.0.1:{}/p/{}", port, platform.id),
                    ));
                }
                ClaudeRoute::Unsupported => {
                    return Err(format!(
                        "平台「{}」无可用端点：需配置 Anthropic 端点，或 OpenAI 端点并开启「兼容 Anthropic」开关。",
                        platform.name
                    ));
                }
            }

            if platform.config_dir.is_empty() {
                return Err("请在平台配置中填写「配置目录」，例如：ali → ~/.jcode/ali".to_string());
            }
            let config_dir = resolve_config_dir(&platform.config_dir);
            env_vars.push(("CLAUDE_CONFIG_DIR".to_string(), config_dir));

            // 注入网络代理（非官方平台 is_official = false，仅当代理范围为「全部」时生效）
            env_vars.extend(crate::commands::settings::network_proxy_env_vars(&app, false));

            // Build claude arguments
            let mut claude_args: Vec<String> = Vec::new();
            if !platform.default_model.is_empty() {
                claude_args.push("--model".to_string());
                claude_args.push(platform.default_model.clone());
            }
            if !platform.extra_args.is_empty() {
                for arg in platform.extra_args.split_whitespace() {
                    claude_args.push(arg.to_string());
                }
            }
            if permission_mode != "default" {
                claude_args.push("--permission-mode".to_string());
                claude_args.push(permission_mode);
            }

            LaunchConfig {
                work_dir: work_dir.clone(),
                env_vars,
                claude_args,
            }
        }
    };

    // 阻塞操作（检查 claude、启动终端）放到后台线程，不冻结 UI
    tauri::async_runtime::spawn_blocking(move || {
        if !command_exists("claude") {
            return Err("未找到 claude 命令。请先安装 Claude Code CLI。".to_string());
        }

        launch_in_terminal(launch_config)
    })
    .await
    .map_err(|e| format!("启动线程异常: {}", e))?
}

#[cfg(windows)]
fn command_exists(command: &str) -> bool {
    Command::new("where")
        .arg(command)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn command_exists(command: &str) -> bool {
    let lookup_cmd = format!("command -v {}", shell_quote(command));
    let mut shells: Vec<String> = std::env::var("SHELL").ok().into_iter().collect();
    shells.extend([
        "/bin/zsh".to_string(),
        "/bin/bash".to_string(),
        "/bin/sh".to_string(),
    ]);

    for shell in shells {
        if Command::new(&shell)
            .args(["-lc", &lookup_cmd])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return true;
        }
    }

    command_exists_in_common_paths(command)
}

#[cfg(not(windows))]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(not(windows))]
fn command_exists_in_common_paths(command: &str) -> bool {
    let mut dirs = vec![
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        "/usr/bin".into(),
        "/bin".into(),
    ];

    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".npm-global/bin"));
        dirs.push(home.join(".cargo/bin"));
    }

    dirs.into_iter().any(|dir| dir.join(command).is_file())
}
