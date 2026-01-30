# HAPI（中文说明）

在本地运行官方 Claude Code / Codex / Gemini / OpenCode 会话，并通过 Web / PWA / Telegram Mini App 远程控制。

> 本仓库 fork 自上游项目 tiann/hapi: https://github.com/tiann/hapi  
> 英文版说明请见 [README.md](README.md)

## 最近改动（本地分支）

- **Codex 上下文剩余** - 在 Web 输入框状态栏显示剩余上下文百分比，并对齐 Codex TUI 算法（`total_tokens` + 12k baseline）。
- **Codex 会话续接（Reattach）** - 通过 `codexSessionId` 查找 resume 目标并 reattach 到原会话，避免重开 session。
- **iOS PWA 安全区** - 聊天输入框适配 `safe-area-inset-bottom`，避免被 Home 指示条遮挡。
- **权限交互优化** - 防止权限弹窗堆叠导致新消息被遮挡。
- **Bark 通知** - 可选 Bark 推送，用于远程活动提醒（可配置）。

## 功能

- **无缝接力（Seamless Handoff）** - 本地工作，需要时切到远程，再切回也行；不丢上下文，不需要重启会话。
- **原生优先（Native First）** - HAPI 包装你的 AI agent，而不是替换它：同一个终端，同一套操作习惯。
- **离开也不停（AFK Without Stopping）** - 离开电脑也能在手机上一键批准 AI 的权限请求。
- **模型随你选（Your AI, Your Choice）** - Claude Code / Codex / Gemini / OpenCode，多模型统一流程。
- **随处终端（Terminal Anywhere）** - 手机或浏览器直接连接工作机终端执行命令。
- **语音控制（Voice Control）** - 内置语音助手，解放双手。

## 演示

https://github.com/user-attachments/assets/38230353-94c6-4dbe-9c29-b2a2cc457546

## 快速开始

```bash
npx @twsxtd/hapi hub --relay     # 启动 Hub（E2E 加密 relay）
npx @twsxtd/hapi                 # 运行 Claude Code（也支持 Codex / Gemini / OpenCode）
```

`hapi server` 仍作为别名支持。

终端会显示一个 URL 和二维码。用手机扫码或打开 URL 即可访问 Web 端。

> relay 使用 WireGuard + TLS 做端到端加密；数据从你的设备到你的机器全程加密。

需要自建方案（Cloudflare Tunnel、Tailscale 等），见 [Installation](docs/guide/installation.md)。

## 文档

- [App](docs/guide/pwa.md)
- [How it Works](docs/guide/how-it-works.md)
- [Voice Assistant](docs/guide/voice-assistant.md)
- [Why HAPI](docs/guide/why-hapi.md)
- [FAQ](docs/guide/faq.md)

## 从源码构建

```bash
bun install
bun run build:single-exe
```

## 致谢

HAPI 意为“哈皮”，是对 [Happy](https://github.com/slopus/happy) 的中文音译。向原项目致敬。

