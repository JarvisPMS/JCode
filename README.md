# JCode

一个 Claude Code 多平台启动器：一处管理多家平台，**配置隔离、多开互不影响**，并提供协议转换、批量测试与 Token 统计。

![JCode 首页截图](doc/home.png)



## 功能亮点

- ⭐ **配置隔离 · 多开互不影响**：每个平台独立 `CLAUDE_CONFIG_DIR`，每次启动单开一个终端，可同时运行多个 Claude Code，授权、历史、会话互不污染。
- **协议自动转换**：Anthropic 原生直连；OpenAI 兼容端点经本地代理转成 Claude Code 可用的 Messages API。
- **一键启动**：点图标或拖入文件夹即启动，自动注入 Key、Base URL、模型、配置目录、权限模式与网络代理。
- **多平台预设**：内置 Claude、阿里百炼、DeepSeek、Kimi、智谱、火山方舟、OpenRouter、Ollama 等十余个平台，也可自定义。
- **平台编排**：启用/隐藏、拖拽排序、默认目录、启动参数、模型标签一站管理。
- **本地代理**：支持按平台直连与按模型名映射转发，适配第三方客户端。
- **批量测试**：多平台并发跑同一提示词，实时看输出、工具调用、耗时与 Token。
- **Token 统计**：会话数、消息数、消耗、活跃天数、热力图、模型排行一览。
- **密钥安全**：本地加密存储，支持从旧版系统 Keychain 迁移。
- **配置备份**：平台配置一键导入/导出，便于迁移与多机同步。

## 技术栈

- **前端**: React + TypeScript + Tailwind CSS + Vite
- **后端**: Tauri 2 (Rust)
- **本地服务**: Axum + Reqwest（本地代理与协议适配）
- **存储**: tauri-plugin-store + 本地加密密钥存储（支持从旧版 OS Keychain 迁移）

## 开发

```bash
# 安装依赖
npm install

# 启动开发模式
npm run tauri dev

# 构建发布包
npm run tauri build
```

## 安全提示

- API Key 保存在本机用户配置目录的加密文件中，不应提交到版本库。
- 设置页的“导出配置”会包含明文 API Key，导出的 JSON 文件请自行妥善保管，不要公开分享。
- 本地代理只监听 `127.0.0.1`，用于把 Claude Code 请求转发到已配置的平台。

## 项目结构

```
jcode/
├── doc/                     # 截图与文档素材
├── public/platform-icons/   # 平台 SVG 图标
├── src/
│   ├── components/          # UI 组件
│   ├── lib/presets.ts       # 平台预设配置
│   ├── pages/               # 页面
│   ├── store/               # Zustand 状态管理
│   └── types/               # TypeScript 类型
├── src-tauri/
│   ├── src/commands/        # Rust 后端命令
│   └── capabilities/        # Tauri 权限配置
└── .github/workflows/       # 发布工作流
```
