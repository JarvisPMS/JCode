//! OpenAI 兼容协议适配器。
//!
//! 把 Claude Code 发来的 Anthropic Messages API 请求转换为 OpenAI
//! `/chat/completions` 请求，并把 OpenAI 的响应（含 SSE 流）转回 Anthropic 格式。
//! 仅做无状态的纯数据转换，HTTP 收发与平台/密钥解析在 proxy.rs 中完成。

use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::{json, Value};

/// OpenAI `finish_reason` → Anthropic `stop_reason`。
pub fn map_stop_reason(finish: Option<&str>) -> &'static str {
    match finish {
        Some("length") => "max_tokens",
        Some("tool_calls") => "tool_use",
        // "stop" / "content_filter" / 其它 → 兜底 end_turn
        _ => "end_turn",
    }
}

/// Anthropic 顶层 `system`（字符串或 content 块数组）→ 拼成一段纯文本。
fn extract_system_text(system: &Value) -> Option<String> {
    match system {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Array(blocks) => {
            let mut buf = String::new();
            for b in blocks {
                if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(t);
                }
            }
            if buf.is_empty() {
                None
            } else {
                Some(buf)
            }
        }
        _ => None,
    }
}

/// Anthropic `tools` → OpenAI `tools`（包一层 function 包装）。
fn convert_tools(tools: &Value) -> Option<Value> {
    let arr = tools.as_array()?;
    let out: Vec<Value> = arr
        .iter()
        .filter_map(|t| {
            let name = t.get("name")?.as_str()?;
            let mut func = json!({ "name": name });
            if let Some(desc) = t.get("description") {
                func["description"] = desc.clone();
            }
            // Anthropic input_schema → OpenAI function.parameters
            if let Some(schema) = t.get("input_schema") {
                func["parameters"] = schema.clone();
            }
            Some(json!({ "type": "function", "function": func }))
        })
        .collect();
    if out.is_empty() {
        None
    } else {
        Some(Value::Array(out))
    }
}

/// Anthropic `tool_choice` → OpenAI `tool_choice`。
fn convert_tool_choice(tc: &Value) -> Option<Value> {
    match tc.get("type").and_then(|v| v.as_str()) {
        Some("auto") => Some(json!("auto")),
        Some("any") => Some(json!("required")),
        Some("tool") => {
            let name = tc.get("name")?.as_str()?;
            Some(json!({ "type": "function", "function": { "name": name } }))
        }
        _ => None,
    }
}

/// Anthropic image 块的 source → OpenAI image_url 的 data URI。
fn image_block_to_url(block: &Value) -> Option<Value> {
    let src = block.get("source")?;
    let media = src.get("media_type").and_then(|v| v.as_str())?;
    let data = src.get("data").and_then(|v| v.as_str())?;
    Some(json!({
        "type": "image_url",
        "image_url": { "url": format!("data:{};base64,{}", media, data) }
    }))
}

/// 从 tool_result 块的 `content`（字符串或块数组）里抽出纯文本。
fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// 把一条 Anthropic 消息转换为零个或多个 OpenAI 消息，push 进 `out`。
fn push_message(out: &mut Vec<Value>, role: &str, content: &Value) {
    // content 为纯字符串：直接映射。
    if let Some(s) = content.as_str() {
        out.push(json!({ "role": role, "content": s }));
        return;
    }
    let blocks = match content.as_array() {
        Some(b) => b,
        None => return,
    };

    // 文本/图片部分累积成 OpenAI content；tool_use→tool_calls；tool_result→独立 tool 消息。
    let mut parts: Vec<Value> = Vec::new();
    let mut text_buf = String::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    let mut tool_msgs: Vec<Value> = Vec::new();

    for b in blocks {
        match b.get("type").and_then(|v| v.as_str()) {
            Some("text") => {
                if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                    if !text_buf.is_empty() {
                        text_buf.push('\n');
                    }
                    text_buf.push_str(t);
                }
            }
            Some("image") => {
                if let Some(img) = image_block_to_url(b) {
                    parts.push(img);
                }
            }
            Some("tool_use") => {
                let id = b.get("id").and_then(|v| v.as_str()).unwrap_or("");
                let name = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let args = b.get("input").cloned().unwrap_or_else(|| json!({}));
                tool_calls.push(json!({
                    "id": id,
                    "type": "function",
                    "function": { "name": name, "arguments": args.to_string() }
                }));
            }
            Some("tool_result") => {
                let id = b.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
                let text = b.get("content").map(tool_result_text).unwrap_or_default();
                tool_msgs.push(json!({
                    "role": "tool",
                    "tool_call_id": id,
                    "content": text
                }));
            }
            _ => {}
        }
    }

    // tool_result 先行（应答上一条 assistant 的 tool_calls）。
    out.append(&mut tool_msgs);

    // 组装本消息的 content：有图片走数组，否则用字符串。
    let has_text = !text_buf.is_empty();
    let content_val: Value = if !parts.is_empty() {
        if has_text {
            parts.insert(0, json!({ "type": "text", "text": text_buf }));
        }
        Value::Array(parts)
    } else {
        Value::String(text_buf)
    };

    if !tool_calls.is_empty() {
        // assistant 带工具调用：content 允许为空串。
        out.push(json!({
            "role": role,
            "content": content_val,
            "tool_calls": tool_calls
        }));
    } else if has_text || content_val.as_array().is_some() {
        out.push(json!({ "role": role, "content": content_val }));
    }
}

/// 把整个 Anthropic 请求体转换为 OpenAI `/chat/completions` 请求体。
///
/// `target_model` 为后端真实模型名（复用现有「模型名映射」结果）。
pub fn build_openai_request(anthropic: &Value, target_model: &str) -> Value {
    let mut messages: Vec<Value> = Vec::new();

    // system → messages[0]
    if let Some(sys) = anthropic.get("system") {
        if let Some(text) = extract_system_text(sys) {
            messages.push(json!({ "role": "system", "content": text }));
        }
    }

    // 逐条转换 messages
    if let Some(arr) = anthropic.get("messages").and_then(|v| v.as_array()) {
        for m in arr {
            let role = m.get("role").and_then(|v| v.as_str()).unwrap_or("user");
            if let Some(content) = m.get("content") {
                push_message(&mut messages, role, content);
            }
        }
    }

    let stream = anthropic
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut req = json!({
        "model": target_model,
        "messages": messages,
        "stream": stream,
    });

    // max_tokens（Anthropic 必填）
    if let Some(mt) = anthropic.get("max_tokens") {
        req["max_tokens"] = mt.clone();
    }
    // 采样参数：OpenAI 支持的直接透传
    for key in ["temperature", "top_p"] {
        if let Some(v) = anthropic.get(key) {
            req[key] = v.clone();
        }
    }
    // stop_sequences → stop
    if let Some(stop) = anthropic.get("stop_sequences") {
        req["stop"] = stop.clone();
    }
    // tools / tool_choice
    if let Some(tools) = anthropic.get("tools") {
        if let Some(converted) = convert_tools(tools) {
            req["tools"] = converted;
        }
    }
    if let Some(tc) = anthropic.get("tool_choice") {
        if let Some(converted) = convert_tool_choice(tc) {
            req["tool_choice"] = converted;
        }
    }
    // 流式必须索要 usage，否则拿不到 token 统计
    if stream {
        req["stream_options"] = json!({ "include_usage": true });
    }

    req
}

/// 非流式：OpenAI 完整响应 → Anthropic message 对象。
pub fn openai_response_to_anthropic(openai: &Value, fallback_model: &str) -> Value {
    let choice = openai
        .get("choices")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first());
    let msg = choice.and_then(|c| c.get("message"));

    // content 块数组：text 块 + tool_use 块
    let mut blocks: Vec<Value> = Vec::new();
    if let Some(text) = msg
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    if let Some(calls) = msg.and_then(|m| m.get("tool_calls")).and_then(|v| v.as_array()) {
        for call in calls {
            let id = call.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let func = call.get("function");
            let name = func
                .and_then(|f| f.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            // arguments 是 JSON 字符串 → 解析回对象
            let input = func
                .and_then(|f| f.get("arguments"))
                .and_then(|v| v.as_str())
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or_else(|| json!({}));
            blocks.push(json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": input
            }));
        }
    }

    let finish = choice
        .and_then(|c| c.get("finish_reason"))
        .and_then(|v| v.as_str());
    let stop_reason = map_stop_reason(finish);

    let usage = openai.get("usage");
    let input_tokens = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output_tokens = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let id = openai
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("msg_proxy");
    let model = openai
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or(fallback_model);

    json!({
        "id": id,
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": blocks,
        "stop_reason": stop_reason,
        "stop_sequence": null,
        "usage": { "input_tokens": input_tokens, "output_tokens": output_tokens }
    })
}

/// OpenAI 没有 count_tokens 端点：按字符数粗估（≈ 4 字符/token），字段不能缺。
pub fn estimate_count_tokens(anthropic: &Value) -> Value {
    let mut chars = 0usize;
    if let Some(sys) = anthropic.get("system") {
        if let Some(t) = extract_system_text(sys) {
            chars += t.chars().count();
        }
    }
    if let Some(arr) = anthropic.get("messages").and_then(|v| v.as_array()) {
        for m in arr {
            match m.get("content") {
                Some(Value::String(s)) => chars += s.chars().count(),
                Some(Value::Array(blocks)) => {
                    for b in blocks {
                        if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                            chars += t.chars().count();
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let tokens = (chars / 4).max(1) as u64;
    json!({ "input_tokens": tokens })
}

/// 把一个 Anthropic 事件格式化成 SSE 帧：`event: <type>\ndata: <json>\n\n`。
fn sse_frame(event_type: &str, data: &Value) -> Vec<u8> {
    format!("event: {}\ndata: {}\n\n", event_type, data).into_bytes()
}

/// 当前打开的 content block 类型（用于在切换时正确发 content_block_stop）。
#[derive(PartialEq)]
enum OpenBlock {
    None,
    Text,
    /// 记录 OpenAI 的 tool_calls 索引，用于把后续 arguments 增量归到同一块。
    Tool(u64),
}

/// 把 OpenAI chat.completion.chunk 流重组为 Anthropic 事件流的状态机。
pub struct SseConverter {
    model: String,
    message_id: String,
    message_started: bool,
    /// 下一个 Anthropic content block 的 index（文本与每个工具各占一个）。
    next_index: i64,
    open: OpenBlock,
    /// 当前打开块对应的 Anthropic index。
    open_index: i64,
    /// OpenAI tool_calls.index → 已分配的 Anthropic index（用于判断是否首次出现）。
    tool_index_map: std::collections::HashMap<u64, i64>,
    stop_reason: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    /// 是否已发送收尾事件（message_delta + message_stop），防止重复。
    closed: bool,
}

impl SseConverter {
    pub fn new(model: String) -> Self {
        Self {
            model,
            message_id: format!("msg_{}", uuid::Uuid::new_v4().simple()),
            message_started: false,
            next_index: 0,
            open: OpenBlock::None,
            open_index: 0,
            tool_index_map: std::collections::HashMap::new(),
            stop_reason: None,
            input_tokens: 0,
            output_tokens: 0,
            closed: false,
        }
    }

    /// 首个 chunk 时发 message_start（必须在任何 content block 之前，且只发一次）。
    fn ensure_started(&mut self, out: &mut Vec<u8>) {
        if self.message_started {
            return;
        }
        self.message_started = true;
        let data = json!({
            "type": "message_start",
            "message": {
                "id": self.message_id,
                "type": "message",
                "role": "assistant",
                "model": self.model,
                "content": [],
                "stop_reason": null,
                "stop_sequence": null,
                "usage": { "input_tokens": self.input_tokens, "output_tokens": 0 }
            }
        });
        out.extend(sse_frame("message_start", &data));
    }

    /// 关闭当前打开的 block（若有）。
    fn close_open_block(&mut self, out: &mut Vec<u8>) {
        if self.open != OpenBlock::None {
            let data = json!({ "type": "content_block_stop", "index": self.open_index });
            out.extend(sse_frame("content_block_stop", &data));
            self.open = OpenBlock::None;
        }
    }

    /// 处理一个解析后的 OpenAI chunk，把转换出的 Anthropic 事件写入 `out`。
    pub fn feed_chunk(&mut self, chunk: &Value, out: &mut Vec<u8>) {
        // usage 可能在末尾的空 choices chunk 里
        if let Some(usage) = chunk.get("usage").filter(|u| !u.is_null()) {
            if let Some(n) = usage.get("prompt_tokens").and_then(|v| v.as_u64()) {
                self.input_tokens = n;
            }
            if let Some(n) = usage.get("completion_tokens").and_then(|v| v.as_u64()) {
                self.output_tokens = n;
            }
        }

        let choice = match chunk
            .get("choices")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
        {
            Some(c) => c,
            None => return,
        };

        self.ensure_started(out);

        // 文本增量
        if let Some(text) = choice
            .get("delta")
            .and_then(|d| d.get("content"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            if self.open != OpenBlock::Text {
                self.close_open_block(out);
                self.open_index = self.next_index;
                self.next_index += 1;
                self.open = OpenBlock::Text;
                let data = json!({
                    "type": "content_block_start",
                    "index": self.open_index,
                    "content_block": { "type": "text", "text": "" }
                });
                out.extend(sse_frame("content_block_start", &data));
            }
            let data = json!({
                "type": "content_block_delta",
                "index": self.open_index,
                "delta": { "type": "text_delta", "text": text }
            });
            out.extend(sse_frame("content_block_delta", &data));
        }

        // 工具调用增量
        if let Some(calls) = choice
            .get("delta")
            .and_then(|d| d.get("tool_calls"))
            .and_then(|v| v.as_array())
        {
            for call in calls {
                let oi = call.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                // 首次见到这个 OpenAI 工具索引 → 开新块
                if !self.tool_index_map.contains_key(&oi) {
                    self.close_open_block(out);
                    let idx = self.next_index;
                    self.next_index += 1;
                    self.tool_index_map.insert(oi, idx);
                    self.open_index = idx;
                    self.open = OpenBlock::Tool(oi);
                    let id = call.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let name = call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let data = json!({
                        "type": "content_block_start",
                        "index": idx,
                        "content_block": { "type": "tool_use", "id": id, "name": name, "input": {} }
                    });
                    out.extend(sse_frame("content_block_start", &data));
                }
                // arguments 片段 → input_json_delta，原样透传不解析
                if let Some(args) = call
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                {
                    let idx = *self.tool_index_map.get(&oi).unwrap_or(&self.open_index);
                    let data = json!({
                        "type": "content_block_delta",
                        "index": idx,
                        "delta": { "type": "input_json_delta", "partial_json": args }
                    });
                    out.extend(sse_frame("content_block_delta", &data));
                }
            }
        }

        // finish_reason
        if let Some(fr) = choice.get("finish_reason").and_then(|v| v.as_str()) {
            self.stop_reason = Some(map_stop_reason(Some(fr)).to_string());
        }
    }

    /// 正常收尾：关块 + message_delta + message_stop。
    pub fn finish(&mut self, out: &mut Vec<u8>) {
        if self.closed {
            return;
        }
        self.closed = true;
        self.ensure_started(out);
        self.close_open_block(out);

        let stop_reason = self.stop_reason.clone().unwrap_or_else(|| "end_turn".into());
        let delta = json!({
            "type": "message_delta",
            "delta": { "stop_reason": stop_reason, "stop_sequence": null },
            "usage": { "input_tokens": self.input_tokens, "output_tokens": self.output_tokens }
        });
        out.extend(sse_frame("message_delta", &delta));
        out.extend(sse_frame("message_stop", &json!({ "type": "message_stop" })));
    }

    /// 上游出错：发 Anthropic error 事件再收尾，避免客户端卡死。
    pub fn emit_error(&mut self, message: &str, out: &mut Vec<u8>) {
        if self.closed {
            return;
        }
        self.ensure_started(out);
        self.close_open_block(out);
        let data = json!({
            "type": "error",
            "error": { "type": "api_error", "message": message }
        });
        out.extend(sse_frame("error", &data));
        out.extend(sse_frame("message_stop", &json!({ "type": "message_stop" })));
        self.closed = true;
    }
}

struct StreamState<S> {
    upstream: S,
    buf: String,
    conv: SseConverter,
    finished: bool,
}

/// 把上游 OpenAI SSE 字节流转换成 Anthropic SSE 字节流。
///
/// 逐块累积到行缓冲，解析 `data: <json>` / `data: [DONE]`，驱动 `SseConverter`。
pub fn anthropic_sse_stream<S>(
    upstream: S,
    model: String,
) -> impl Stream<Item = Result<Bytes, std::io::Error>>
where
    S: Stream<Item = reqwest::Result<Bytes>> + Send + Unpin + 'static,
{
    let state = StreamState {
        upstream,
        buf: String::new(),
        conv: SseConverter::new(model),
        finished: false,
    };

    futures_util::stream::unfold(state, |mut st| async move {
        loop {
            if st.finished {
                return None;
            }
            match st.upstream.next().await {
                Some(Ok(chunk)) => {
                    st.buf.push_str(&String::from_utf8_lossy(&chunk));
                    let mut out: Vec<u8> = Vec::new();
                    while let Some(pos) = st.buf.find('\n') {
                        let line = st.buf[..pos].trim_end_matches('\r').to_string();
                        st.buf.drain(..=pos);
                        let payload = match line.strip_prefix("data:") {
                            Some(p) => p.trim(),
                            None => continue, // 忽略空行、event: 行等
                        };
                        if payload == "[DONE]" {
                            st.conv.finish(&mut out);
                            continue;
                        }
                        if let Ok(json) = serde_json::from_str::<Value>(payload) {
                            st.conv.feed_chunk(&json, &mut out);
                        }
                    }
                    if out.is_empty() {
                        continue; // 这块没凑出完整事件，继续拉
                    }
                    return Some((Ok(Bytes::from(out)), st));
                }
                Some(Err(e)) => {
                    let mut out: Vec<u8> = Vec::new();
                    st.conv.emit_error(&e.to_string(), &mut out);
                    st.finished = true;
                    return Some((Ok(Bytes::from(out)), st));
                }
                None => {
                    // 上游正常结束但没见到 [DONE]：补收尾
                    let mut out: Vec<u8> = Vec::new();
                    st.conv.finish(&mut out);
                    st.finished = true;
                    if out.is_empty() {
                        return None;
                    }
                    return Some((Ok(Bytes::from(out)), st));
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把适配器产出的 Anthropic SSE 字节解析回 (event_type, json) 列表。
    fn parse_frames(bytes: &[u8]) -> Vec<(String, Value)> {
        let s = String::from_utf8_lossy(bytes);
        let mut out = Vec::new();
        for block in s.split("\n\n") {
            let (mut ev, mut data) = (None, None);
            for line in block.lines() {
                if let Some(r) = line.strip_prefix("event: ") {
                    ev = Some(r.to_string());
                } else if let Some(r) = line.strip_prefix("data: ") {
                    data = Some(r.to_string());
                }
            }
            if let (Some(e), Some(d)) = (ev, data) {
                if let Ok(j) = serde_json::from_str::<Value>(&d) {
                    out.push((e, j));
                }
            }
        }
        out
    }

    #[test]
    fn request_maps_system_and_stream_options() {
        let anthropic = json!({
            "model": "claude-x",
            "max_tokens": 100,
            "stream": true,
            "system": [{"type":"text","text":"you are helpful"}],
            "stop_sequences": ["STOP"],
            "messages": [{"role":"user","content":"hi"}]
        });
        let req = build_openai_request(&anthropic, "glm-4.6");
        assert_eq!(req["model"], "glm-4.6");
        assert_eq!(req["messages"][0]["role"], "system");
        assert_eq!(req["messages"][0]["content"], "you are helpful");
        assert_eq!(req["messages"][1]["role"], "user");
        assert_eq!(req["max_tokens"], 100);
        assert_eq!(req["stop"][0], "STOP");
        assert_eq!(req["stream_options"]["include_usage"], true);
    }

    #[test]
    fn request_splits_tool_use_and_tool_result() {
        let anthropic = json!({
            "model": "claude-x",
            "max_tokens": 100,
            "messages": [
                {"role":"assistant","content":[
                    {"type":"text","text":"let me check"},
                    {"type":"tool_use","id":"call_1","name":"get_weather","input":{"city":"SF"}}
                ]},
                {"role":"user","content":[
                    {"type":"tool_result","tool_use_id":"call_1","content":"sunny"}
                ]}
            ]
        });
        let req = build_openai_request(&anthropic, "glm-4.6");
        let msgs = req["messages"].as_array().unwrap();
        // assistant 带 tool_calls
        assert_eq!(msgs[0]["role"], "assistant");
        assert_eq!(msgs[0]["tool_calls"][0]["id"], "call_1");
        assert_eq!(msgs[0]["tool_calls"][0]["function"]["name"], "get_weather");
        // arguments 是字符串
        assert_eq!(
            msgs[0]["tool_calls"][0]["function"]["arguments"],
            "{\"city\":\"SF\"}"
        );
        // tool_result 拆成独立 tool 消息
        assert_eq!(msgs[1]["role"], "tool");
        assert_eq!(msgs[1]["tool_call_id"], "call_1");
        assert_eq!(msgs[1]["content"], "sunny");
    }

    #[test]
    fn nonstream_response_converts_text_and_tool() {
        let openai = json!({
            "id": "chatcmpl-1",
            "model": "glm-4.6",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "done",
                    "tool_calls": [{
                        "id": "call_9",
                        "function": {"name": "f", "arguments": "{\"a\":1}"}
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 11, "completion_tokens": 7}
        });
        let a = openai_response_to_anthropic(&openai, "fallback");
        assert_eq!(a["type"], "message");
        assert_eq!(a["content"][0]["type"], "text");
        assert_eq!(a["content"][0]["text"], "done");
        assert_eq!(a["content"][1]["type"], "tool_use");
        assert_eq!(a["content"][1]["name"], "f");
        assert_eq!(a["content"][1]["input"]["a"], 1);
        assert_eq!(a["stop_reason"], "tool_use");
        assert_eq!(a["usage"]["input_tokens"], 11);
        assert_eq!(a["usage"]["output_tokens"], 7);
    }

    /// 最易错路径：流式文本 + 工具调用，arguments 分多个 chunk 增量到达。
    #[test]
    fn sse_state_machine_text_then_tool() {
        let mut conv = SseConverter::new("glm-4.6".into());
        let mut out = Vec::new();
        conv.feed_chunk(&json!({"choices":[{"delta":{"content":"Hi"}}]}), &mut out);
        conv.feed_chunk(
            &json!({"choices":[{"delta":{"tool_calls":[
                {"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\"ci"}}
            ]}}]}),
            &mut out,
        );
        conv.feed_chunk(
            &json!({"choices":[{"delta":{"tool_calls":[
                {"index":0,"function":{"arguments":"ty\":\"SF\"}"}}
            ]}}]}),
            &mut out,
        );
        conv.feed_chunk(
            &json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}),
            &mut out,
        );
        conv.feed_chunk(
            &json!({"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}),
            &mut out,
        );
        conv.finish(&mut out);

        let frames = parse_frames(&out);
        let types: Vec<&str> = frames.iter().map(|(e, _)| e.as_str()).collect();
        // 首尾事件
        assert_eq!(types.first(), Some(&"message_start"));
        assert_eq!(types.last(), Some(&"message_stop"));
        // 文本块 index 0、工具块 index 1
        let text_start = frames
            .iter()
            .find(|(e, d)| e == "content_block_start" && d["content_block"]["type"] == "text")
            .unwrap();
        assert_eq!(text_start.1["index"], 0);
        let tool_start = frames
            .iter()
            .find(|(e, d)| e == "content_block_start" && d["content_block"]["type"] == "tool_use")
            .unwrap();
        assert_eq!(tool_start.1["index"], 1);
        assert_eq!(tool_start.1["content_block"]["name"], "get_weather");
        assert_eq!(tool_start.1["content_block"]["id"], "call_1");
        // arguments 增量拼接后是合法 JSON
        let partial: String = frames
            .iter()
            .filter(|(e, d)| e == "content_block_delta" && d["delta"]["type"] == "input_json_delta")
            .map(|(_, d)| d["delta"]["partial_json"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(partial, "{\"city\":\"SF\"}");
        let parsed: Value = serde_json::from_str(&partial).unwrap();
        assert_eq!(parsed["city"], "SF");
        // 收尾事件
        let delta = frames.iter().find(|(e, _)| e == "message_delta").unwrap();
        assert_eq!(delta.1["delta"]["stop_reason"], "tool_use");
        assert_eq!(delta.1["usage"]["output_tokens"], 5);
    }

    // ── 在线端到端（默认 #[ignore]，需 GLM_API_KEY；打真实 OpenAI 兼容端点）──

    fn live_env() -> (String, String, String) {
        let key = std::env::var("GLM_API_KEY").expect("GLM_API_KEY 未设置");
        let base = std::env::var("GLM_BASE")
            .unwrap_or_else(|_| "https://open.bigmodel.cn/api/coding/paas/v4".into());
        let model = std::env::var("GLM_MODEL").unwrap_or_else(|_| "glm-4.6".into());
        (key, base, model)
    }

    async fn live_collect(anthropic: Value) -> Vec<(String, Value)> {
        let (key, base, model) = live_env();
        let req = build_openai_request(&anthropic, &model);
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/chat/completions", base.trim_end_matches('/')))
            .header("authorization", format!("Bearer {}", key))
            .json(&req)
            .send()
            .await
            .expect("请求发送失败");
        let status = resp.status();
        if !status.is_success() {
            panic!("上游 {}: {}", status, resp.text().await.unwrap_or_default());
        }
        let stream = anthropic_sse_stream(resp.bytes_stream(), model);
        futures_util::pin_mut!(stream);
        let mut all = Vec::new();
        while let Some(chunk) = stream.next().await {
            all.extend(chunk.expect("流块错误"));
        }
        parse_frames(&all)
    }

    #[tokio::test]
    #[ignore]
    async fn live_glm_text_stream() {
        let frames = live_collect(json!({
            "model": "claude-x", "max_tokens": 256, "stream": true,
            "messages": [{"role":"user","content":"用一句话介绍你自己，并说明你是什么模型。"}]
        }))
        .await;
        let types: Vec<&str> = frames.iter().map(|(e, _)| e.as_str()).collect();
        eprintln!("事件序列: {:?}", types);
        let text: String = frames
            .iter()
            .filter(|(e, d)| e == "content_block_delta" && d["delta"]["type"] == "text_delta")
            .map(|(_, d)| d["delta"]["text"].as_str().unwrap_or("").to_string())
            .collect();
        eprintln!("助手回复: {}", text);
        assert_eq!(types.first(), Some(&"message_start"));
        assert_eq!(types.last(), Some(&"message_stop"));
        assert!(!text.is_empty(), "未产出任何文本");
    }

    #[tokio::test]
    #[ignore]
    async fn live_glm_tool_stream() {
        let frames = live_collect(json!({
            "model": "claude-x", "max_tokens": 512, "stream": true,
            "tools": [{
                "name": "get_weather",
                "description": "查询指定城市的实时天气",
                "input_schema": {
                    "type": "object",
                    "properties": {"city": {"type":"string","description":"城市名称"}},
                    "required": ["city"]
                }
            }],
            "tool_choice": {"type":"auto"},
            "messages": [{"role":"user","content":"北京现在天气怎么样？请调用 get_weather 工具查询。"}]
        }))
        .await;
        let types: Vec<&str> = frames.iter().map(|(e, _)| e.as_str()).collect();
        eprintln!("事件序列: {:?}", types);
        assert_eq!(types.first(), Some(&"message_start"));
        assert_eq!(types.last(), Some(&"message_stop"));

        let tool = frames
            .iter()
            .find(|(e, d)| e == "content_block_start" && d["content_block"]["type"] == "tool_use");
        let (_, d) = tool.expect("模型未发起工具调用");
        eprintln!("工具名: {}", d["content_block"]["name"]);
        let args: String = frames
            .iter()
            .filter(|(e, d)| e == "content_block_delta" && d["delta"]["type"] == "input_json_delta")
            .map(|(_, d)| d["delta"]["partial_json"].as_str().unwrap_or("").to_string())
            .collect();
        eprintln!("工具参数: {}", args);
        let parsed: Value = serde_json::from_str(&args).expect("工具参数不是合法 JSON");
        assert!(parsed.get("city").is_some(), "工具参数缺少 city");
    }
}
