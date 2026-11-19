# ALWith U Plus

一个本地优先的 AI Agent 桌面客户端：多模型对话、项目工作区、云盘同步、自动化任务，全部跑在自己的 Mac 上。

基于 [ALWith U](https://github.com/ALwith-ai/alwith-u) 开源项目二次开发，使用 Tauri 3 与 Codex CLI，按自己的工作方式定制界面、模型与流程。


## 主要功能

- **多模型对话**：内置 ChatGPT，支持 OpenRouter、DeepSeek、Qwen、xAI 等第三方模型；同一会话可随时切换模型与推理强度，跨厂商历史也能续聊。
- **项目工作区**：按项目组织会话与文件，支持读写、预览、搜索；对话与文件并排查看。
- **云盘集成**：连接云盘服务，支持会话归档、知识注入、冲突副本过滤，以及防止旧版本覆盖本地文件。
- **自动化与通知**：定时任务按调度自动执行，结果可推送到飞书；在线登录不可用时可用本地口令登录。
- **本地优先**：会话、凭据与配置保存在本机；中英文界面、主题、快捷键与默认模型均可调整。
- **稳定性**：模型过载、限流与异常响应按可配置策略静默重试，长任务不会被误判为卡死。

## 用户指南

阅读 [使用指南](guide/index.md)，或点击应用内账号旁的问号按钮。指南随应用一同打包，在独立窗口中打开。

## 从源码安装

安装 `package.json` 中固定的 Bun 版本、Rust stable，以及对应平台的 [Tauri 依赖](https://v2.tauri.app/start/prerequisites/)。macOS 需要 Apple Silicon。

```sh
git clone https://github.com/yangc888999/ALWith-U-Plus.git
cd ALWith-U-Plus
bun install
```

## 运行

```sh
bun run dev:tauri
```

在设置中配置 Codex 或模型厂商后即可开始对话。

## 构建

```sh
bun tauri build
```

安装包生成在 `src-tauri/target/release/bundle/`。macOS 打开 `.dmg` 将应用拖入「应用程序」；Windows 运行生成的安装程序。

## 致谢

本项目基于 [ALWith U](https://github.com/ALwith-ai/alwith-u) 开源项目二次开发。特别感谢 ALWith U 团队的出色工作与开源贡献，让本地优先的 AI Agent 桌面客户端得以站在坚实的基础上生长。
