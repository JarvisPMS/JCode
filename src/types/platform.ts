export interface PlatformConfig {
  id: string;
  name: string;
  icon: string;
  /** Anthropic 协议端点。空表示无原生 Anthropic 端点。 */
  baseUrl: string;
  /** OpenAI 兼容协议端点（填到 /v1 为止，代理自动拼 /chat/completions）。空表示无。 */
  openaiBaseUrl?: string;
  /** 「通过本地代理兼容 Anthropic」开关：仅当只有 OpenAI 端点时有意义。 */
  anthropicCompatViaProxy?: boolean;
  defaultModel: string;
  models: string;
  defaultWorkDir: string;
  configDir: string;
  extraArgs: string;
  order: number;
  enabled: boolean;
}

export interface TerminalInfo {
  name: string;
  path: string;
  available: boolean;
}
