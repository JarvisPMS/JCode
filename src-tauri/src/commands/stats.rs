use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::commands::config_dir::resolve_config_dir;
use crate::models::platform::PlatformConfig;

const DEFAULT_CLAUDE_ID: &str = "00000000-0000-0000-0000-000000000000";

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub message_count: u64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyTokens {
    pub date: String,
    pub tokens_by_model: HashMap<String, u64>,
    pub message_count: u64,
    pub session_count: u64,
    /// 当天活跃过的会话 ID 列表（去重）。前端按时间范围聚合时取并集，避免跨天重复计数
    pub session_ids: Vec<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStats {
    pub platform_id: String,
    pub config_dir: String,
    pub exists: bool,
    pub total_sessions: u64,
    pub total_messages: u64,
    pub total_tool_calls: u64,
    pub active_days: u64,
    pub current_streak: u64,
    pub longest_streak: u64,
    pub peak_hour: Option<u32>,
    pub favorite_model: Option<String>,
    pub first_session_date: Option<String>,
    pub last_session_date: Option<String>,
    pub daily: Vec<DailyTokens>,
    pub model_usage: Vec<ModelUsage>,
    pub hour_counts: HashMap<String, u64>,
}

#[derive(Debug, Deserialize)]
struct AssistantMessage {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    usage: Option<UsageBlock>,
}

#[derive(Debug, Deserialize)]
struct UsageBlock {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

#[derive(Debug, Deserialize)]
struct LineRecord {
    #[serde(rename = "type")]
    record_type: Option<String>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default, rename = "sessionId")]
    session_id: Option<String>,
    #[serde(default, rename = "requestId")]
    request_id: Option<String>,
    #[serde(default)]
    message: Option<AssistantMessage>,
    #[serde(default, rename = "toolUseResult")]
    _tool_use_result: Option<serde_json::Value>,
}

/// 解析平台对应的根目录（Claude 默认为 ~/.claude；第三方为 config_dir）
fn resolve_platform_root(platform: &PlatformConfig) -> Option<PathBuf> {
    if platform.id == DEFAULT_CLAUDE_ID {
        dirs::home_dir().map(|h| h.join(".claude"))
    } else if !platform.config_dir.is_empty() {
        Some(PathBuf::from(resolve_config_dir(&platform.config_dir)))
    } else {
        None
    }
}

/// 收集所有 JSONL 会话文件（包括 subagent）
fn collect_jsonl_files(projects_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if !projects_dir.is_dir() {
        return files;
    }
    for entry in walk_dir(projects_dir) {
        if entry.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            files.push(entry);
        }
    }
    files
}

fn walk_dir(dir: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let read = match fs::read_dir(&current) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in read.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                result.push(path);
            }
        }
    }
    result
}

#[tauri::command]
pub fn get_token_stats(app: AppHandle, platform_id: String) -> Result<TokenStats, String> {
    let store = app
        .store("platforms.json")
        .map_err(|e| format!("Failed to open store: {}", e))?;

    let platforms: Vec<PlatformConfig> = store
        .get("platforms")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let platform = platforms
        .iter()
        .find(|p| p.id == platform_id)
        .ok_or(format!("未找到平台: {}", platform_id))?
        .clone();

    let root = resolve_platform_root(&platform)
        .ok_or("无法定位平台数据目录")?;

    let projects_dir = root.join("projects");

    let mut stats = TokenStats {
        platform_id: platform_id.clone(),
        config_dir: root.to_string_lossy().to_string(),
        exists: projects_dir.is_dir(),
        ..Default::default()
    };

    if !stats.exists {
        return Ok(stats);
    }

    // 聚合容器
    let mut seen_request_ids: HashSet<String> = HashSet::new();
    let mut seen_sessions: HashSet<String> = HashSet::new();
    let mut active_dates: HashSet<String> = HashSet::new();
    let mut model_totals: HashMap<String, ModelUsage> = HashMap::new();
    let mut daily_map: HashMap<String, DailyTokens> = HashMap::new();
    // 每天去重的 session ID 集合，用于前端按时间窗口计算唯一会话数
    let mut daily_sessions: HashMap<String, HashSet<String>> = HashMap::new();
    let mut tool_call_total: u64 = 0;
    let mut total_messages: u64 = 0;
    let mut hour_counts: HashMap<String, u64> = HashMap::new();
    let mut earliest: Option<String> = None;
    let mut latest: Option<String> = None;

    let files = collect_jsonl_files(&projects_dir);

    for file in files {
        let f = match fs::File::open(&file) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let reader = BufReader::new(f);
        for line in reader.lines().map_while(Result::ok) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let rec: LineRecord = match serde_json::from_str(line) {
                Ok(r) => r,
                Err(_) => continue,
            };

            let rt = rec.record_type.as_deref().unwrap_or("");

            if rt == "user" || rt == "assistant" {
                total_messages += 1;
                if let Some(sid) = rec.session_id.as_ref() {
                    seen_sessions.insert(sid.clone());
                }
                if let Some(ts) = rec.timestamp.as_ref() {
                    if let Some(date) = ts.get(0..10) {
                        active_dates.insert(date.to_string());
                        update_extremes(&mut earliest, &mut latest, ts);

                        // 当天消息数 +1
                        let day = daily_map
                            .entry(date.to_string())
                            .or_insert_with(|| DailyTokens {
                                date: date.to_string(),
                                ..Default::default()
                            });
                        day.message_count += 1;

                        // 当天活跃会话集合
                        if let Some(sid) = rec.session_id.as_ref() {
                            daily_sessions
                                .entry(date.to_string())
                                .or_default()
                                .insert(sid.clone());
                        }
                    }
                    if let Some(hour) = ts.get(11..13) {
                        if let Ok(h) = hour.parse::<u32>() {
                            *hour_counts.entry(h.to_string()).or_insert(0) += 1;
                        }
                    }
                }
            }

            if rt == "assistant" {

                // 按 requestId 去重 token 统计
                let req_id = rec.request_id.clone();
                let should_count_tokens = match &req_id {
                    Some(id) => seen_request_ids.insert(id.clone()),
                    None => true,
                };

                if let Some(msg) = rec.message.as_ref() {
                    let model = msg.model.clone().unwrap_or_else(|| "unknown".to_string());
                    if let Some(usage) = msg.usage.as_ref() {
                        if should_count_tokens
                            && (usage.input_tokens
                                + usage.output_tokens
                                + usage.cache_read_input_tokens
                                + usage.cache_creation_input_tokens)
                                > 0
                        {
                            let total = usage.input_tokens
                                + usage.output_tokens
                                + usage.cache_read_input_tokens
                                + usage.cache_creation_input_tokens;

                            let entry =
                                model_totals.entry(model.clone()).or_insert_with(|| ModelUsage {
                                    model: model.clone(),
                                    ..Default::default()
                                });
                            entry.input_tokens += usage.input_tokens;
                            entry.output_tokens += usage.output_tokens;
                            entry.cache_read_input_tokens += usage.cache_read_input_tokens;
                            entry.cache_creation_input_tokens += usage.cache_creation_input_tokens;
                            entry.message_count += 1;

                            if let Some(ts) = rec.timestamp.as_ref() {
                                if let Some(date) = ts.get(0..10) {
                                    let day = daily_map
                                        .entry(date.to_string())
                                        .or_insert_with(|| DailyTokens {
                                            date: date.to_string(),
                                            ..Default::default()
                                        });
                                    *day.tokens_by_model.entry(model.clone()).or_insert(0) += total;
                                }
                            }
                        }
                    }
                }
            } else if rt == "tool_use" {
                tool_call_total += 1;
            }

            // tool_use 也可能藏在 assistant 的 content 里，简单处理：把 attachment/system 等其他记录跳过
        }
    }

    // 把每天的 session_count 与 session_ids 写回 daily_map
    for (date, sessions) in &daily_sessions {
        let day = daily_map.entry(date.clone()).or_insert_with(|| DailyTokens {
            date: date.clone(),
            ..Default::default()
        });
        day.session_count = sessions.len() as u64;
        day.session_ids = sessions.iter().cloned().collect();
    }

    let mut daily: Vec<DailyTokens> = daily_map.into_values().collect();
    daily.sort_by(|a, b| a.date.cmp(&b.date));

    let mut model_usage: Vec<ModelUsage> = model_totals.into_values().collect();
    model_usage.sort_by(|a, b| {
        let total_b = b.input_tokens + b.output_tokens + b.cache_read_input_tokens + b.cache_creation_input_tokens;
        let total_a = a.input_tokens + a.output_tokens + a.cache_read_input_tokens + a.cache_creation_input_tokens;
        total_b.cmp(&total_a)
    });

    // peak hour
    let peak_hour = hour_counts
        .iter()
        .max_by_key(|(_, v)| **v)
        .and_then(|(k, _)| k.parse::<u32>().ok());

    let favorite_model = model_usage.first().map(|m| m.model.clone());

    // streaks
    let (current_streak, longest_streak) = compute_streaks(&active_dates);

    stats.total_sessions = seen_sessions.len() as u64;
    stats.total_messages = total_messages;
    stats.total_tool_calls = tool_call_total;
    stats.active_days = active_dates.len() as u64;
    stats.current_streak = current_streak;
    stats.longest_streak = longest_streak;
    stats.peak_hour = peak_hour;
    stats.favorite_model = favorite_model;
    stats.first_session_date = earliest;
    stats.last_session_date = latest;
    stats.daily = daily;
    stats.model_usage = model_usage;
    stats.hour_counts = hour_counts;

    Ok(stats)
}

fn update_extremes(earliest: &mut Option<String>, latest: &mut Option<String>, ts: &str) {
    match earliest {
        Some(e) if ts >= e.as_str() => {}
        Some(_) => *earliest = Some(ts.to_string()),
        None => *earliest = Some(ts.to_string()),
    }
    match latest {
        Some(l) if ts <= l.as_str() => {}
        Some(_) => *latest = Some(ts.to_string()),
        None => *latest = Some(ts.to_string()),
    }
}

/// 计算当前连续活跃天数与最长连续活跃天数（基于 ISO 日期字符串）
fn compute_streaks(dates: &HashSet<String>) -> (u64, u64) {
    if dates.is_empty() {
        return (0, 0);
    }
    let mut sorted: Vec<&String> = dates.iter().collect();
    sorted.sort();

    let parse = |s: &str| -> Option<(i32, u32, u32)> {
        let parts: Vec<&str> = s.split('-').collect();
        if parts.len() != 3 {
            return None;
        }
        Some((
            parts[0].parse().ok()?,
            parts[1].parse().ok()?,
            parts[2].parse().ok()?,
        ))
    };

    let to_julian = |y: i32, m: u32, d: u32| -> i64 {
        // 简化的日期序号转换（足够用于 streak 计算）
        let (y, m) = if m <= 2 { (y - 1, m + 12) } else { (y, m) };
        let a = y / 100;
        let b = 2 - a + a / 4;
        ((365.25 * (y as f64 + 4716.0)) as i64)
            + ((30.6001 * (m as f64 + 1.0)) as i64)
            + d as i64
            + b as i64
            - 1524
    };

    let day_nums: Vec<i64> = sorted
        .iter()
        .filter_map(|s| parse(s).map(|(y, m, d)| to_julian(y, m, d)))
        .collect();

    if day_nums.is_empty() {
        return (0, 0);
    }

    let mut longest = 1u64;
    let mut current_run = 1u64;
    for i in 1..day_nums.len() {
        if day_nums[i] == day_nums[i - 1] + 1 {
            current_run += 1;
        } else {
            current_run = 1;
        }
        if current_run > longest {
            longest = current_run;
        }
    }

    // current streak：从今天向前数
    use std::time::{SystemTime, UNIX_EPOCH};
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let now_days = (now_secs / 86400) as i64;
    // Unix epoch (1970-01-01) julian = 2440588
    let today_julian = now_days + 2440588;

    let day_set: HashSet<i64> = day_nums.iter().copied().collect();

    let mut current_streak = 0u64;
    let mut probe = today_julian;
    if !day_set.contains(&probe) {
        // 如果今天没活跃，从昨天开始数
        probe -= 1;
    }
    while day_set.contains(&probe) {
        current_streak += 1;
        probe -= 1;
    }

    (current_streak, longest)
}
