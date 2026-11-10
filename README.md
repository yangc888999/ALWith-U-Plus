# ALWith U

在 30 分钟内启动你自己的 Agent 产品。

ALwith U 是一个基于 Tauri 3 的桌面客户端，使用 ALwith 现成组件构建、由 Codex CLI 驱动。它把多模型对话、项目工作区、云盘、自动化任务和飞书通知整合在一个本地应用里，界面、品牌与能力都可以按自己的需要定制。

## 主要功能

- **多模型对话**：内置 ChatGPT，支持 OpenRouter、DeepSeek、Qwen、xAI 等第三方模型；同一会话可随时切换模型与推理强度。
- **项目工作区**：按项目组织会话与文件，支持读写、预览、搜索和跨厂商历史续聊。
- **云盘集成**：同步连接云盘服务，支持会话归档、知识注入、冲突副本过滤，以及防旧版本覆盖本地文件。
- **自动化与通知**：定时任务按调度自动执行，结果可推送到飞书；登录不可用时支持本地口令登录兜底。
- **定制与本地化**：中英文界面、主题、快捷键与默认模型均可配置，所有会话与凭据保存在本机。

## 用户指南

阅读 [ALwith U 指南](guide/index.md)，或点击应用内账号旁的问号按钮。英文指南随应用一同打包，并在独立窗口中打开。

## 从源码安装

安装 `package.json` 中固定的 Bun 版本、Rust stable，以及对应平台的 [Tauri 依赖](https://v2.tauri.app/start/prerequisites/)。macOS 需要 Apple Silicon 与 26.0 以上系统。

```sh
git clone https://github.com/yangc888999/alwith-l.git
cd alwith-l
bun install
```

## 运行

```sh
bun run dev:tauri
```

登录 ALwith 后，在设置中配置 Codex 或模型厂商即可开始对话。

## 构建

```sh
bun tauri build
```

安装包生成在 `src-tauri/target/release/bundle/`。macOS 打开 `.dmg` 将 ALwith U 拖入「应用程序」；Windows 运行生成的安装程序。
