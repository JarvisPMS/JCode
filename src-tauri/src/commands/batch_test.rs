use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write as IoWrite};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_store::StoreExt;

use crate::commands::config_dir::{ensure_config_dir, resolve_config_dir};
use crate::commands::keychain::get_api_key_internal;
use crate::models::platform::{ClaudeRoute, PlatformConfig};

// 与 launch.rs 保持一致：此 ID 代表默认 Claude（账号授权，无需 API Key）
const DEFAULT_CLAUDE_ID: &str = "00000000-0000-0000-0000-000000000000";

// 全局进程注册表：run_id -> 各平台 PID 列表
pub struct BatchTestState {
    pub processes: Arc<Mutex<HashMap<String, Vec<u32>>>>,
}

impl BatchTestState {
    pub fn new() -> Self {
        BatchTestState {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// ── 事件负载 ──────────────────────────────────────────────
#[derive(Serialize, Clone)]
pub struct BatchOutputEvent {
    pub run_id: String,
    pub platform_id: String,
    /// "start" | "text" | "tool" | "done" | "error" | "stopped"
    pub event_type: String,
    pub content: Option<String>,
    pub elapsed_ms: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

// ── stream-json 解析结构 ──────────────────────────────────
#[derive(Deserialize)]
struct StreamLine {
    #[serde(rename = "type")]
    msg_type: String,
    subtype: Option<String>,
    message: Option<StreamMessage>,
    result: Option<String>,
    usage: Option<StreamUsage>,
    duration_ms: Option<u64>,
}

#[derive(Deserialize)]
struct StreamMessage {
    content: Option<Vec<StreamContent>>,
}

#[derive(Deserialize)]
struct StreamContent {
    #[serde(rename = "type")]
    content_type: String,
    text: Option<String>,
    name: Option<String>,
    input: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct StreamUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

// ── 设置：保存目录 ────────────────────────────────────────
#[tauri::command]
pub fn get_batch_save_dir(app: AppHandle) -> String {
    app.store("settings.json")
        .ok()
        .and_then(|s| s.get("batch_save_dir"))
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_default()
}

#[tauri::command]
pub fn set_batch_save_dir(app: AppHandle, dir: String) -> Result<(), String> {
    let store = app
        .store("settings.json")
        .map_err(|e| format!("无法打开设置: {}", e))?;
    store.set("batch_save_dir", serde_json::Value::String(dir));
    store.save().map_err(|e| format!("保存失败: {}", e))
}

// ── 停止测试 ──────────────────────────────────────────────
#[tauri::command]
pub fn stop_batch_test(
    state: State<'_, BatchTestState>,
    run_id: String,
) -> Result<(), String> {
    let mut procs = state.processes.lock().map_err(|e| e.to_string())?;
    if let Some(pids) = procs.remove(&run_id) {
        for pid in pids {
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &pid.to_string()])
                    .creation_flags(0x08000000)
                    .output();
            }
            #[cfg(not(windows))]
            {
                let _ = Command::new("kill")
                    .args(["-TERM", &pid.to_string()])
                    .output();
            }
        }
    }
    Ok(())
}

// ── 启动批量测试 ──────────────────────────────────────────
#[tauri::command]
pub async fn start_batch_test(
    app: AppHandle,
    state: State<'_, BatchTestState>,
    platform_ids: Vec<String>,
    prompt: String,
    save_dir: String,
    run_id: String,
) -> Result<(), String> {
    // 读取平台配置
    let store = app
        .store("platforms.json")
        .map_err(|e| format!("Failed to open store: {}", e))?;

    let platforms_json = store.get("platforms").ok_or("未找到平台配置")?;
    let all_platforms: Vec<PlatformConfig> = serde_json::from_value(platforms_json.clone())
        .map_err(|e| format!("Failed to parse platforms: {}", e))?;

    let selected: Vec<PlatformConfig> = all_platforms
        .into_iter()
        .filter(|p| platform_ids.contains(&p.id))
        .collect();

    if selected.is_empty() {
        return Err("未找到选中的平台配置".to_string());
    }

    // 创建本次运行目录
    let run_dir = Path::new(&save_dir).join(&run_id);
    fs::create_dir_all(&run_dir).map_err(|e| format!("无法创建保存目录: {}", e))?;
    fs::write(run_dir.join("prompt.txt"), &prompt)
        .map_err(|e| format!("无法写入 prompt.txt: {}", e))?;

    // 提前克隆 Arc，供各线程使用
    let processes_arc = Arc::clone(&state.processes);

    let mut task_handles = Vec::new();

    for platform in selected {
        let app_clone = app.clone();
        let prompt_clone = prompt.clone();
        let run_id_clone = run_id.clone();
        let run_dir_clone = run_dir.clone();
        let processes_clone = Arc::clone(&processes_arc);

        // ── 凭证与环境变量组装 ──
        // 默认 Claude（账号授权登录）：不注入任何环境变量，直接调用即可
        let env_vars: Vec<(String, String)> = if platform.id == DEFAULT_CLAUDE_ID {
            Vec::new()
        } else {
            let api_key = match get_api_key_internal(&platform.id) {
                Ok(k) => k,
                Err(_) => {
                    let _ = app.emit(
                        "batch_output",
                        BatchOutputEvent {
                            run_id: run_id.clone(),
                            platform_id: platform.id.clone(),
                            event_type: "error".to_string(),
                            content: Some(format!("平台「{}」未配置 API Key", platform.name)),
                            elapsed_ms: None,
                            input_tokens: None,
                            output_tokens: None,
                        },
                    );
                    continue;
                }
            };

            if platform.config_dir.is_empty() {
                let _ = app.emit(
                    "batch_output",
                    BatchOutputEvent {
                        run_id: run_id.clone(),
                        platform_id: platform.id.clone(),
                        event_type: "error".to_string(),
                        content: Some(format!("平台「{}」未配置配置目录", platform.name)),
                        elapsed_ms: None,
                        input_tokens: None,
                        output_tokens: None,
                    },
                );
                continue;
            }

            let config_dir = resolve_config_dir(&platform.config_dir);
            let _ = ensure_config_dir(&config_dir, &api_key);

            let mut vars = vec![("CLAUDE_CONFIG_DIR".to_string(), config_dir)];
            match platform.claude_route() {
                ClaudeRoute::DirectAnthropic(url) => {
                    vars.push(("ANTHROPIC_API_KEY".to_string(), api_key));
                    vars.push(("ANTHROPIC_BASE_URL".to_string(), url));
                }
                ClaudeRoute::OpenAiViaProxy => {
                    match crate::commands::proxy::ensure_proxy_running(&app).await {
                        Ok(port) => {
                            vars.push((
                                "ANTHROPIC_API_KEY".to_string(),
                                crate::commands::launch::PROXY_PLACEHOLDER_KEY.to_string(),
                            ));
                            vars.push((
                                "ANTHROPIC_BASE_URL".to_string(),
                                format!("http://127.0.0.1:{}/p/{}", port, platform.id),
                            ));
                        }
                        Err(e) => {
                            let _ = app.emit(
                                "batch_output",
                                BatchOutputEvent {
                                    run_id: run_id.clone(),
                                    platform_id: platform.id.clone(),
                                    event_type: "error".to_string(),
                                    content: Some(format!("启动本地代理失败: {}", e)),
                                    elapsed_ms: None,
                                    input_tokens: None,
                                    output_tokens: None,
                                },
                            );
                            continue;
                        }
                    }
                }
                ClaudeRoute::Unsupported => {
                    let _ = app.emit(
                        "batch_output",
                        BatchOutputEvent {
                            run_id: run_id.clone(),
                            platform_id: platform.id.clone(),
                            event_type: "error".to_string(),
                            content: Some(format!(
                                "平台「{}」无可用端点（需 Anthropic 端点，或 OpenAI 端点 + 兼容开关）",
                                platform.name
                            )),
                            elapsed_ms: None,
                            input_tokens: None,
                            output_tokens: None,
                        },
                    );
                    continue;
                }
            }
            vars
        };

        // 组装 claude 参数
        let mut claude_args: Vec<String> = vec![
            "-p".to_string(),
            prompt_clone.clone(),
            "--dangerously-skip-permissions".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
        ];
        if !platform.default_model.is_empty() {
            claude_args.push("--model".to_string());
            claude_args.push(platform.default_model.clone());
        }
        if !platform.extra_args.is_empty() {
            for arg in platform.extra_args.split_whitespace() {
                claude_args.push(arg.to_string());
            }
        }

        let platform_id = platform.id.clone();
        let platform_name = platform.name.clone();

        let handle = tauri::async_runtime::spawn_blocking(move || {
            // 创建平台工作目录（也是 claude 的 cwd，产物直接落这里）
            let platform_dir = run_dir_clone.join(&platform_name);
            if let Err(e) = fs::create_dir_all(&platform_dir) {
                let _ = app_clone.emit(
                    "batch_output",
                    BatchOutputEvent {
                        run_id: run_id_clone.clone(),
                        platform_id: platform_id.clone(),
                        event_type: "error".to_string(),
                        content: Some(format!("无法创建目录: {}", e)),
                        elapsed_ms: None,
                        input_tokens: None,
                        output_tokens: None,
                    },
                );
                return;
            }

            // 发出 start 事件
            let _ = app_clone.emit(
                "batch_output",
                BatchOutputEvent {
                    run_id: run_id_clone.clone(),
                    platform_id: platform_id.clone(),
                    event_type: "start".to_string(),
                    content: None,
                    elapsed_ms: None,
                    input_tokens: None,
                    output_tokens: None,
                },
            );

            let start_time = Instant::now();

            // 启动 claude 子进程
            let mut cmd = Command::new("claude");
            for arg in &claude_args {
                cmd.arg(arg);
            }
            for (k, v) in &env_vars {
                cmd.env(k, v);
            }
            cmd.current_dir(&platform_dir);
            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped()); // 捕获 stderr 以便诊断错误

            #[cfg(windows)]
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    let _ = app_clone.emit(
                        "batch_output",
                        BatchOutputEvent {
                            run_id: run_id_clone.clone(),
                            platform_id: platform_id.clone(),
                            event_type: "error".to_string(),
                            content: Some(format!("启动 Claude Code 失败: {}", e)),
                            elapsed_ms: None,
                            input_tokens: None,
                            output_tokens: None,
                        },
                    );
                    return;
                }
            };

            // 注册 PID 到全局注册表
            let pid = child.id();
            {
                let mut procs = processes_clone.lock().unwrap();
                procs.entry(run_id_clone.clone()).or_default().push(pid);
            }

            // 打开 dev.log
            let mut log_file = fs::File::create(platform_dir.join("dev.log")).ok();

            // 提前取出 stderr pipe（必须在读 stdout 前取，否则 Windows 可能死锁）
            let stderr_pipe = child.stderr.take();

            // 逐行读取 stdout 并解析 stream-json
            let stdout = match child.stdout.take() {
                Some(s) => s,
                None => {
                    let _ = child.wait();
                    return;
                }
            };
            let reader = BufReader::new(stdout);
            let mut got_result = false;

            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };

                // 写 dev.log
                if let Some(ref mut f) = log_file {
                    let _ = writeln!(f, "{}", line);
                }

                // 解析 JSON
                let Ok(parsed) = serde_json::from_str::<StreamLine>(&line) else {
                    continue;
                };

                match parsed.msg_type.as_str() {
                    "assistant" => {
                        let Some(msg) = parsed.message else { continue };
                        let Some(contents) = msg.content else { continue };
                        for c in contents {
                            match c.content_type.as_str() {
                                "text" => {
                                    if let Some(text) = c.text {
                                        let _ = app_clone.emit(
                                            "batch_output",
                                            BatchOutputEvent {
                                                run_id: run_id_clone.clone(),
                                                platform_id: platform_id.clone(),
                                                event_type: "text".to_string(),
                                                content: Some(text),
                                                elapsed_ms: None,
                                                input_tokens: None,
                                                output_tokens: None,
                                            },
                                        );
                                    }
                                }
                                "tool_use" => {
                                    let tool_name = c.name.unwrap_or_default();
                                    let desc = format_tool_action(&tool_name, c.input.as_ref());
                                    let _ = app_clone.emit(
                                        "batch_output",
                                        BatchOutputEvent {
                                            run_id: run_id_clone.clone(),
                                            platform_id: platform_id.clone(),
                                            event_type: "tool".to_string(),
                                            content: Some(desc),
                                            elapsed_ms: None,
                                            input_tokens: None,
                                            output_tokens: None,
                                        },
                                    );
                                }
                                _ => {}
                            }
                        }
                    }
                    "result" => {
                        got_result = true;
                        let elapsed = start_time.elapsed().as_millis() as u64;
                        let elapsed_ms = parsed.duration_ms.unwrap_or(elapsed);
                        let (input_tokens, output_tokens) = parsed
                            .usage
                            .map(|u| (u.input_tokens, u.output_tokens))
                            .unwrap_or((None, None));

                        let is_error = parsed.subtype.as_deref()
                            == Some("error_during_execution");

                        let _ = app_clone.emit(
                            "batch_output",
                            BatchOutputEvent {
                                run_id: run_id_clone.clone(),
                                platform_id: platform_id.clone(),
                                event_type: if is_error { "error" } else { "done" }.to_string(),
                                content: parsed.result,
                                elapsed_ms: Some(elapsed_ms),
                                input_tokens,
                                output_tokens,
                            },
                        );
                    }
                    _ => {}
                }
            }

            // stdout 读完后收集 stderr（此时子进程已基本退出，不会死锁）
            let stderr_text: String = stderr_pipe
                .map(|s| {
                    use std::io::Read;
                    let mut buf = String::new();
                    let _ = BufReader::new(s).read_to_string(&mut buf);
                    buf
                })
                .unwrap_or_default();
            let stderr_trimmed = stderr_text.trim().to_string();

            let exit_status = child.wait().ok();

            // 如果没收到 result（被 stop 或异常退出）
            if !got_result {
                let elapsed = start_time.elapsed().as_millis() as u64;

                // 把 stderr 写入 dev.log 便于离线排查
                if !stderr_trimmed.is_empty() {
                    if let Some(ref mut f) = log_file {
                        let _ = writeln!(f, "\n=== STDERR ===");
                        let _ = writeln!(f, "{}", stderr_trimmed);
                    }
                }

                // 有 stderr → 真实错误；无 stderr → 用户主动停止
                let (event_type, content) = if !stderr_trimmed.is_empty() {
                    ("error", Some(stderr_trimmed))
                } else {
                    let was_killed = exit_status.map(|s| !s.success()).unwrap_or(true);
                    if was_killed { ("stopped", None) } else { ("done", None) }
                };

                let _ = app_clone.emit(
                    "batch_output",
                    BatchOutputEvent {
                        run_id: run_id_clone.clone(),
                        platform_id: platform_id.clone(),
                        event_type: event_type.to_string(),
                        content,
                        elapsed_ms: Some(elapsed),
                        input_tokens: None,
                        output_tokens: None,
                    },
                );
            }

            // 从注册表移除该 PID
            {
                let mut procs = processes_clone.lock().unwrap();
                if let Some(pids) = procs.get_mut(&run_id_clone) {
                    pids.retain(|&p| p != pid);
                    if pids.is_empty() {
                        procs.remove(&run_id_clone);
                    }
                }
            }
        });

        task_handles.push(handle);
    }

    // 所有平台完成后发出 batch_complete
    let app_done = app.clone();
    let run_id_done = run_id.clone();
    tauri::async_runtime::spawn(async move {
        for h in task_handles {
            let _ = h.await;
        }
        let _ = app_done.emit(
            "batch_complete",
            serde_json::json!({ "run_id": run_id_done }),
        );
    });

    Ok(())
}

// 格式化 tool_use 描述
fn format_tool_action(tool_name: &str, input: Option<&serde_json::Value>) -> String {
    match tool_name {
        "Write" | "write_file" => {
            let path = input
                .and_then(|v| v.get("file_path"))
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            format!("[Write] {}", path)
        }
        "Edit" | "str_replace_editor" => {
            let path = input
                .and_then(|v| v.get("path").or_else(|| v.get("file_path")))
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            format!("[Edit] {}", path)
        }
        "Bash" | "bash" => {
            let cmd = input
                .and_then(|v| v.get("command"))
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let short = if cmd.len() > 60 {
                format!("{}…", &cmd[..60])
            } else {
                cmd.to_string()
            };
            format!("[Bash] {}", short)
        }
        "Read" | "read_file" => {
            let path = input
                .and_then(|v| v.get("file_path").or_else(|| v.get("path")))
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            format!("[Read] {}", path)
        }
        _ => format!("[{}]", tool_name),
    }
}
