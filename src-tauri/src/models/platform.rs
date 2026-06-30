use serde::{Deserialize, Serialize};

/// 平台对外暴露的协议端点。
///
/// 一个平台（= 一个供应商账号 + 一个 API Key + 一份模型列表）可以同时挂多种协议：
/// - `base_url`：Anthropic 协议端点（历史字段，语义不变，故沿用旧名以零迁移兼容）。
/// - `openai_base_url`：OpenAI 兼容协议端点（`/chat/completions` 之前的部分，如 `https://x/v1`）。
///
/// 由「启动器」（当前 Claude Code，未来 Codex / OpenCode）决定要哪种协议；
/// 当平台缺少启动器所需的原生端点、但开了对应兼容开关时，由本地代理做协议转换。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformConfig {
    pub id: String,
    pub name: String,
    pub icon: String,
    /// Anthropic 协议端点。空表示该平台没有原生 Anthropic 端点。
    pub base_url: String,
    /// OpenAI 兼容协议端点。空表示该平台没有 OpenAI 端点。旧数据缺省为空。
    #[serde(default)]
    pub openai_base_url: String,
    /// 「通过本地代理兼容 Anthropic」开关：仅当只有 OpenAI 端点（无原生 Anthropic 端点）时有意义。
    /// 开启后该平台可被 Claude Code 启动——由本地代理把 Anthropic 请求转成 OpenAI 协议。
    /// 旧数据缺省 false。
    #[serde(default)]
    pub anthropic_compat_via_proxy: bool,
    pub default_model: String,
    #[serde(default)]
    pub models: String,
    pub default_work_dir: String,
    pub config_dir: String,
    pub extra_args: String,
    pub order: u32,
    /// 是否在首屏显示。旧数据缺省该字段时默认启用。
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

/// 解析平台在「Claude Code（Anthropic 协议）」启动场景下的接入方式。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaudeRoute {
    /// 有原生 Anthropic 端点 → 直连（不经代理）。携带该端点 URL。
    DirectAnthropic(String),
    /// 仅 OpenAI 端点 + 兼容开关开启 → 经本地代理转协议。
    OpenAiViaProxy,
    /// 该平台无法被 Claude Code 启动。
    Unsupported,
}

impl PlatformConfig {
    /// 是否配置了原生 Anthropic 端点。
    pub fn has_anthropic(&self) -> bool {
        !self.base_url.trim().is_empty()
    }

    /// 是否配置了 OpenAI 兼容端点。
    pub fn has_openai(&self) -> bool {
        !self.openai_base_url.trim().is_empty()
    }

    /// Claude Code 启动该平台时的接入方式。原生端点永远优先于代理转换。
    pub fn claude_route(&self) -> ClaudeRoute {
        if self.has_anthropic() {
            ClaudeRoute::DirectAnthropic(self.base_url.trim().to_string())
        } else if self.has_openai() && self.anthropic_compat_via_proxy {
            ClaudeRoute::OpenAiViaProxy
        } else {
            ClaudeRoute::Unsupported
        }
    }
}

fn default_enabled() -> bool {
    true
}
