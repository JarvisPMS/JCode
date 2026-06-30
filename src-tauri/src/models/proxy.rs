use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyMapping {
    pub id: String,
    /// 第三方软件请求时使用的模型名（如 "claude-sonnet-4-7-...""）
    pub source_model: String,
    /// 实际转发的目标平台 ID（对应 platforms.json 中的某条记录）
    pub target_platform_id: String,
    /// 实际请求时使用的模型名
    pub target_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub mappings: Vec<ProxyMapping>,
}

fn default_port() -> u16 {
    8765
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            port: default_port(),
            mappings: Vec::new(),
        }
    }
}
