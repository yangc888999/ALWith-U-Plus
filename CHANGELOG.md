# Changelog

## 0.2.29

- 新增定时任务功能，支持通过飞书CLI助手信息通知本人及其他指定账户。
- 新增飞书CLI作为组件接入ALWith L，支持应用内安装和更新、登录及权限申请。
- 新增本地免登录模式，在 ALwith 账号无法正常登录时使用。
- 取数采用校验 BI device key，适配新的取数请求头，避免取数异常。
- 优化「设置 - 用量」页打开速度。
- 优化模型调用状态提醒逻辑。
- 云盘告警语音本地化（中文适配）。
- 优化冷启动逻辑，提升 ALWith L 打开速度。
- 修复冷启动时，一处 provider 表发生变化引起的报错信息。
- 聊天和项目逻辑区分：1）聊天仅临时会话，不支持分工、不可打开预览栏和文件栏，属即用即走；2）项目支持四分栏展示、分工、引用功能等。

## 0.2.28

- 新增自定义任务功能，支持配置循环触发的功能；
- 优化模型调用状态指示及修复 Effort 一处异常 bug；
- 修复 Command+Q 可能异常黑屏的 BUG；
- 设置 - 用量 新增词云、偏好时段统计等功能；
- 调整仅聊天窗口展示宽度；
- 自适应显示器和双屏显示优化；
- 聊天窗口优化：1）支持调整高度；2）优化功能布局；
- 模型处理期间显示实时进度：当前模型、effort、正在做的事、已等待时长；60 秒无新内容给出提示，不再只是「正在思考」；
- 放宽等待上限：空闲判定 90 秒 → 20 分钟，单轮硬上限 10 分钟 → 60 分钟，长任务不再被误判为卡死；
- 上游过载（`server_is_overloaded` / `retry-after` 约 5 分钟）时弹出提醒，可一键停止等待并切换模型；
- 修复「没输出就劝换模型」的误判：执行工具（取数、构建等）或等待确认期间不再出现「切换默认模型」，也不会被标成「重连中」；只有上游明确过载、或请求已被接受但 2 分钟一个字节都没返回时，才建议换模型；
- 进度条不再用秒表推断上游，也不再提供「换模型」：静默 90 秒中性显示「本步已 X」（原为「已有 X 没有新内容」）并给一个「催一下」，往当前回合补一句「继续」，和你在输入框里催它走同一条路径；换模型统一收到底部模型选择器，状态行不再改默认模型、也不再取消本轮，上游过载时只报事实并把处置指向选择器；不再描琥珀色边框、不再判「重连中」；「为什么等这么久」改为悬停提示，不再弹浮层压住正文；
- 修复从网关模型（如千问）切到 6.1 Sol / Terra 时报 `Invalid 'input[n].id' ... Expected an ID that begins with 'rs'`：历史里跨厂商的 item id 会按类型自动修正，旧会话切换模型后可直接续聊；
- 修复「上下文窗口」设置不生效：设置页的数值现在写入 Codex 的 `model_context_window`，原生 ChatGPT 会话也能用上，Codex 会按账号上限自动裁剪；
- 修复原生模型网关连接失败时请求悬空的问题：立即返回明确错误并自动重试一次；
- 定时任务（自动化运行）产生的对话从「项目」移到独立的「自动化运行」分组，标题去掉 markdown 的 `#`；

## 0.2.27

- 新增群聊功能，支持自定义角色和技能；
- 对话框布局优化：1）支持高度可调，更简洁；2）聊天文字支持直接插入图片和可预览；
- 修复模型下轮切换功能，减少切换失败概率；

## 0.2.26

- 优化历史会话加载响应速度；
- 优化历史/新建会话模型加载速度；
- 内置模型/自定义API模型的上下文、Effort、加速的调用优化，支持调整模型顺序及删除保护；
- 软件主窗口自适应显示器分辨率；
- 内嵌「在线 BI」，直接APP内看报表；
- 自定义模型 JSON 模板新增「上下文窗口（contextWindow）」字段，可与 Effort、默认 Effort 一并配置。
- 新增模型用量统计，支持自定义模型及对应价格；

## 0.1.0 (unreleased)

Rebuilt from the browser MVP into a Tauri 2 desktop app.

- The agent process is owned by the ALwith Runtime (`alwith-runtime` sidecar, closed) and
  reached through the open `@alwith/api` client: a webview reload re-attaches to
  the running agent, gets its pending permissions back and replays the handshake from
  the Runtime's cache; the Runtime's `done` state and global `markRead` drive the sidebar

- Tauri shell with `alwith-runtime`, `codex`, `codex-code-mode-host` and a compiled
  `codex-acp-v2` bundled as sidecars; `alwith-runtime` is pinned in `runtime.json` and
  downloaded from its release with checksum verification when built without the Runtime source
- CI (typecheck, tests, lint, web build) and a six-target release workflow
- One ACP v2 client for every session, backed by an immutable session reducer and
  a zustand store
- Threads listed from Codex's own store, grouped by project; archive, restore,
  delete and fork
- Codex desktop chat look: markdown, reasoning, command cards with terminal output,
  diffs, edited-files card, plans, compaction markers, turn errors
- Reduced from ALwith Desktop: the input area (image paste/drop, slash completion,
  model/effort/mode selects), form-elicitation dialog, diff modal, image lightbox,
  find in thread, sidebar search, virtualized turn list, native menu, single instance,
  error boundary, GitHub-Releases auto-updater with minisign verification
- alwith-runtime crash recovery: the port is reset and Reconnect starts a fresh process
- Model providers (DeepSeek, OpenRouter, Qwen, xAI): an API key per provider in Settings
  puts its models into every chat's model picker under its own group; each chat picks its
  own model and nothing global changes
- Composer with image attachments, slash commands, per-session model, reasoning
  effort, permission mode and collaboration mode
- Inline approvals and MCP form or URL elicitations
- ChatGPT, device-code and API-key login through Codex
- Context usage meter, desktop notifications, command palette, settings, themes,
  English and Simplified Chinese
