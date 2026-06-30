# JCode

一个基于 Tauri 的 Claude Code 启动器，支持多平台 API 一键切换。

## 功能

- 管理多个 AI 平台配置（API Key、模型、Base URL）
- 点击图标一键启动 Claude Code，自动注入对应平台的环境变量
- 支持拖拽文件夹到图标上启动
- 卡片拖拽排序
- 每个平台独立配置目录，互不干扰

## 技术栈

- **前端**: React + TypeScript + Tailwind CSS + Vite
- **后端**: Tauri 2 (Rust)
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
├── public/platform-icons/   # 平台 SVG 图标
├── src/
│   ├── components/          # UI 组件
│   ├── lib/presets.ts       # 平台预设配置
│   ├── pages/               # 页面
│   ├── store/               # Zustand 状态管理
│   └── types/               # TypeScript 类型
├── src-tauri/
│   └── src/commands/        # Rust 后端命令
└── docs/
    └── troubleshooting.md   # 踩坑记录
```
