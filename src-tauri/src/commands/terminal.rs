use serde::Serialize;
#[cfg(target_os = "macos")]
use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 隐藏控制台窗口的标志
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize)]
pub struct TerminalInfo {
    pub name: String,
    pub path: String,
    pub available: bool,
}

#[tauri::command]
#[cfg(windows)]
pub fn detect_terminals() -> Vec<TerminalInfo> {
    let terminals = vec![
        ("Windows Terminal", "wt.exe"),
        ("Command Prompt", "cmd.exe"),
        ("PowerShell 7", "pwsh.exe"),
        ("PowerShell", "powershell.exe"),
    ];

    terminals
        .into_iter()
        .map(|(name, exe)| {
            let available = Command::new("where")
                .arg(exe)
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            TerminalInfo {
                name: name.to_string(),
                path: exe.to_string(),
                available,
            }
        })
        .collect()
}

#[tauri::command]
#[cfg(target_os = "macos")]
pub fn detect_terminals() -> Vec<TerminalInfo> {
    vec![
        TerminalInfo {
            name: "Terminal".to_string(),
            path: "/System/Applications/Utilities/Terminal.app".to_string(),
            available: Path::new("/System/Applications/Utilities/Terminal.app").exists()
                || Path::new("/Applications/Utilities/Terminal.app").exists(),
        },
        TerminalInfo {
            name: "iTerm".to_string(),
            path: "/Applications/iTerm.app".to_string(),
            available: Path::new("/Applications/iTerm.app").exists(),
        },
    ]
}

#[tauri::command]
#[cfg(all(not(windows), not(target_os = "macos")))]
pub fn detect_terminals() -> Vec<TerminalInfo> {
    let terminals = vec![
        ("x-terminal-emulator", "x-terminal-emulator"),
        ("GNOME Terminal", "gnome-terminal"),
        ("Konsole", "konsole"),
        ("xterm", "xterm"),
    ];

    terminals
        .into_iter()
        .map(|(name, exe)| TerminalInfo {
            name: name.to_string(),
            path: exe.to_string(),
            available: command_exists(exe),
        })
        .collect()
}

pub struct LaunchConfig {
    pub work_dir: String,
    pub env_vars: Vec<(String, String)>,
    pub claude_args: Vec<String>,
}

#[cfg(windows)]
pub fn launch_in_terminal(config: LaunchConfig) -> Result<(), String> {
    let has_wt = Command::new("where")
        .arg("wt.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    // Build the set commands for env vars
    // 用 "set K=V&&" 格式（&& 紧贴值），防止空格被算入变量值
    // 先清除 CLAUDECODE 避免 "nested session" 检测误报
    let mut parts: Vec<String> = vec!["set CLAUDECODE=".to_string()];
    parts.extend(
        config
            .env_vars
            .iter()
            .map(|(k, v)| format!("set {}={}", k, v)),
    );

    let claude_cmd = if config.claude_args.is_empty() {
        "claude".to_string()
    } else {
        format!("claude {}", config.claude_args.join(" "))
    };

    parts.push(claude_cmd);

    // 用 "&&" 无空格连接，避免 cmd.exe 的 set 把空格算入值
    let inner_cmd = parts.join("&&");

    if has_wt {
        // wt.exe new-tab -d <dir> cmd.exe /K "set X=Y && claude"
        Command::new("wt.exe")
            .args([
                "new-tab",
                "-d",
                &config.work_dir,
                "cmd.exe",
                "/K",
                &inner_cmd,
            ])
            .spawn()
            .map_err(|e| format!("Failed to launch Windows Terminal: {}", e))?;
    } else {
        // Fallback: cmd.exe /C start cmd.exe /K "cd /d <dir>&&set ...&&claude"
        let fallback_cmd = format!("cd /d {}&&{}", &config.work_dir, inner_cmd);
        Command::new("cmd.exe")
            .args(["/C", "start", "cmd.exe", "/K", &fallback_cmd])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to launch cmd.exe: {}", e))?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
pub fn launch_in_terminal(config: LaunchConfig) -> Result<(), String> {
    // 把 env + cd + claude 写入临时脚本（0700），脚本第一行自删除。
    // AppleScript 仅注入 `clear; exec '<script>'`，避免环境变量与 API Key
    // 暴露在终端会话历史里。
    let script_path = write_launcher_script(&config)?;
    let cmd = format!("clear; exec {}", shell_quote(&script_path));
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
        escape_applescript_string(&cmd)
    );

    Command::new("osascript")
        .arg("-e")
        .arg(script)
        .spawn()
        .map_err(|e| format!("Failed to launch Terminal.app: {}", e))?;

    Ok(())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
pub fn launch_in_terminal(config: LaunchConfig) -> Result<(), String> {
    let script_path = write_launcher_script(&config)?;
    let exec_arg = format!("clear; exec {}", shell_quote(&script_path));

    let candidates = [
        ("x-terminal-emulator", vec!["-e", "sh", "-lc"]),
        ("gnome-terminal", vec!["--", "sh", "-lc"]),
        ("konsole", vec!["-e", "sh", "-lc"]),
        ("xterm", vec!["-e", "sh", "-lc"]),
    ];

    for (terminal, args) in candidates {
        if command_exists(terminal) {
            Command::new(terminal)
                .args(args)
                .arg(&exec_arg)
                .spawn()
                .map_err(|e| format!("Failed to launch {}: {}", terminal, e))?;
            return Ok(());
        }
    }

    Err("未找到可用终端。".to_string())
}

/// 把启动配置写入 `$TMPDIR/jcode-launch-<uuid>.sh`，权限 0700。
/// 脚本结构：
/// 1. 自删除（rm -f -- "$0"）—— bash 已通过 fd 持有内容，删除磁盘副本不影响执行。
/// 2. 设置 PATH、cd 工作目录、unset CLAUDECODE。
/// 3. 注入用户环境变量（API Key / Base URL / 配置目录）。
/// 4. exec claude 替换当前进程，claude 退出后终端回到普通 shell。
#[cfg(not(windows))]
fn write_launcher_script(config: &LaunchConfig) -> Result<String, String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut script = String::new();
    script.push_str("#!/bin/bash\n");
    script.push_str("rm -f -- \"$0\"\n");
    script.push_str("export PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"\n");
    script.push_str(&format!("cd {}\n", shell_quote(&config.work_dir)));
    script.push_str("unset CLAUDECODE\n");
    for (k, v) in &config.env_vars {
        script.push_str(&format!("export {}={}\n", k, shell_quote(v)));
    }
    let mut claude_parts: Vec<String> = vec!["claude".to_string()];
    claude_parts.extend(config.claude_args.iter().map(|a| shell_quote(a)));
    script.push_str(&format!("exec {}\n", claude_parts.join(" ")));

    let temp_dir = std::env::temp_dir();
    let filename = format!("jcode-launch-{}.sh", uuid::Uuid::new_v4());
    let path = temp_dir.join(filename);

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o700)
        .open(&path)
        .map_err(|e| format!("创建启动脚本失败: {}", e))?;
    file.write_all(script.as_bytes())
        .map_err(|e| format!("写入启动脚本失败: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}

#[cfg(not(windows))]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
fn escape_applescript_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn command_exists(command: &str) -> bool {
    Command::new("sh")
        .args(["-lc", &format!("command -v {}", shell_quote(command))])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
