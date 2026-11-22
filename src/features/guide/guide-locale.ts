export type GuideLanguage = "en" | "zh"

export type GuideCopy = {
  windowTitle: string
  welcomeTitle: string
  chaptersAria: string
  brand: string
  edition: string
  heroTitle: [string, string]
  heroBody: string
  startAction: string
  exploreAction: string
  availability: string
  pathAria: string
  path: Array<{ title: string; body: string }>
  topicsTitle: string
  topicsDesc: string
  firstTaskLabel: string
  firstTaskTitle: string
  firstTaskBody: string
  firstTaskQuote: string
  footerTitle: string
  footerTagline: string
  bundled: string
  editionShort: string
  guideHome: string
  inThisChapter: string
  workThrough: string
  adjacentAria: string
  previous: string
  next: string
  groups: {
    overview: string
    gettingStarted: string
    dailyWork: string
    makeItYours: string
    support: string
  }
  details: Array<{ summary: string; group: string; takeaway: string }>
  interface: {
    label: string
    yourProjects: string
    myProject: string
    firstTask: string
    conversation: string
    request: string
    response: [string, string, string]
    describeNext: string
    openFiles: string
    clickPart: string
  }
}

const en: GuideCopy = {
  windowTitle: "ALWith U⁺ Guide",
  welcomeTitle: "Welcome",
  chaptersAria: "Guide chapters",
  brand: "ALWith U⁺",
  edition: "The ALWith U⁺ handbook",
  heroTitle: ["Turn a clear request", "into work you can verify."],
  heroBody:
    "Get comfortable with your independent desktop client: start a conversation, bring the right files into context, and review what your assistant produces.",
  startAction: "Start your first task",
  exploreAction: "Explore the interface",
  availability: "English edition. Included with your app. Available offline.",
  pathAria: "Getting started path",
  path: [
    { title: "Connect", body: "Sign in and configure model access." },
    { title: "Give context", body: "Choose a project and define the outcome." },
    { title: "Review", body: "Inspect changes and check the evidence." }
  ],
  topicsTitle: "What would you like to do?",
  topicsDesc: "Jump into the part of the workflow you need.",
  firstTaskLabel: "Try it in your next chat",
  firstTaskTitle: "A small task is the best place to start.",
  firstTaskBody: "Choose a project folder, then ask the assistant to explain it before editing anything.",
  firstTaskQuote:
    "Read this project's README and explain how to run it. Do not change files. Tell me which steps you verified and which ones remain untested.",
  footerTitle: "ALWith U⁺ Guide",
  footerTagline: "An independent client powered by Codex CLI.",
  bundled: "Bundled with ALWith U⁺",
  editionShort: "English edition",
  guideHome: "Guide home",
  inThisChapter: "In this chapter",
  workThrough: "Work through the steps with your own project open beside the guide.",
  adjacentAria: "Adjacent chapters",
  previous: "Previous",
  next: "Next",
  groups: {
    overview: "Overview",
    gettingStarted: "Getting started",
    dailyWork: "Daily work",
    makeItYours: "Make it yours",
    support: "Support"
  },
  details: [
    {
      summary: "A practical handbook for your everyday work with ALWith U⁺.",
      group: "Overview",
      takeaway: "Choose a task below, or follow the getting-started path."
    },
    {
      summary: "Set up access, choose a project, and complete your first useful task.",
      group: "Getting started",
      takeaway: "ALwith login and model access are configured separately."
    },
    {
      summary: "Learn where conversations, tools, files, and settings live.",
      group: "Getting started",
      takeaway: "Keep the conversation and its project files in view together."
    },
    {
      summary: "Write a clear request, manage a running turn, and review the result.",
      group: "Daily work",
      takeaway: "Ask for a concrete outcome and evidence that it works."
    },
    {
      summary: "Connect a provider and select the right model for each conversation.",
      group: "Daily work",
      takeaway: "The selected model belongs to the conversation you are working in."
    },
    {
      summary: "Navigate, preview, edit, and review files alongside the assistant.",
      group: "Daily work",
      takeaway: "Confirm the project folder before allowing file changes."
    },
    {
      summary: "Understand skills, Codex plugins, and application extensions.",
      group: "Make it yours",
      takeaway: "Inspect what an integration does and what access it needs."
    },
    {
      summary: "Check cloud transfers and resolve failed items.",
      group: "Make it yours",
      takeaway: "Verify transfer status before relying on a cloud copy."
    },
    {
      summary: "Adjust your workspace and learn the shortcuts you will use most.",
      group: "Make it yours",
      takeaway: "Use button tooltips to discover shortcuts as you work."
    },
    {
      summary: "Diagnose connection, model, file, and integration problems.",
      group: "Support",
      takeaway: "Capture the exact error and check for partial changes before retrying."
    }
  ],
  interface: {
    label: "Interface map",
    yourProjects: "Your projects",
    myProject: "My project",
    firstTask: "First task",
    conversation: "A conversation with context",
    request: "Explain this project before making changes.",
    response: ["Read the files.", "Explain the approach.", "Review the result."],
    describeNext: "Describe your next task",
    openFiles: "Open files",
    clickPart: "Click a part of the workspace to learn how it works."
  }
}

const zh: GuideCopy = {
  windowTitle: "ALWith U⁺ 指南",
  welcomeTitle: "欢迎",
  chaptersAria: "指南章节",
  brand: "ALWith U⁺",
  edition: "ALWith U⁺ 使用手册",
  heroTitle: ["把清晰的需求", "变成可验证的成果。"],
  heroBody: "从新建会话、引入正确文件，到检查助手产出的结果，快速熟悉这款独立桌面客户端。",
  startAction: "开始第一个任务",
  exploreAction: "探索界面",
  availability: "中文版本，随应用离线提供。",
  pathAria: "入门路径",
  path: [
    { title: "连接", body: "登录账号并配置模型访问。" },
    { title: "提供上下文", body: "选择项目并明确想要的结果。" },
    { title: "检查", body: "查看改动并核对真实证据。" }
  ],
  topicsTitle: "你想完成什么？",
  topicsDesc: "直接跳到当前工作流需要的部分。",
  firstTaskLabel: "在下一个会话中试试",
  firstTaskTitle: "从一个小任务开始最稳妥。",
  firstTaskBody: "先选择项目文件夹，让助手解释项目，再决定是否修改。",
  firstTaskQuote:
    "读取这个项目的 README，说明如何运行。不要修改文件。告诉我哪些步骤实际验证过，哪些仍未验证。",
  footerTitle: "ALWith U⁺ 指南",
  footerTagline: "由 Codex CLI 驱动的独立客户端。",
  bundled: "随 ALWith U⁺ 一起提供",
  editionShort: "中文版",
  guideHome: "指南首页",
  inThisChapter: "本章内容",
  workThrough: "打开自己的项目，跟着步骤一起操作。",
  adjacentAria: "相邻章节",
  previous: "上一章",
  next: "下一章",
  groups: {
    overview: "概览",
    gettingStarted: "入门",
    dailyWork: "日常工作",
    makeItYours: "个性化与扩展",
    support: "支持"
  },
  details: [
    {
      summary: "面向日常工作的 ALWith U⁺ 实用手册。",
      group: "概览",
      takeaway: "选择下方任务，或按入门路径开始。"
    },
    {
      summary: "完成访问配置、选择项目，并做完第一个有价值的任务。",
      group: "入门",
      takeaway: "ALwith 登录与模型访问需要分别配置。"
    },
    {
      summary: "了解会话、工具、文件和设置分别在哪里。",
      group: "入门",
      takeaway: "让对话与项目文件保持同时可见。"
    },
    {
      summary: "写清需求、管理运行中的回合，并检查结果。",
      group: "日常工作",
      takeaway: "要求明确结果，并核对确实有效的证据。"
    },
    {
      summary: "连接服务商，为每个会话选择合适的模型。",
      group: "日常工作",
      takeaway: "当前模型属于正在工作的这个会话。"
    },
    {
      summary: "在对话旁浏览、预览、编辑并检查文件。",
      group: "日常工作",
      takeaway: "允许修改文件前先确认项目文件夹。"
    },
    {
      summary: "理解技能、Codex 插件与应用扩展。",
      group: "个性化与扩展",
      takeaway: "启用前确认集成做什么、需要哪些权限。"
    },
    {
      summary: "查看云盘传输并处理失败项。",
      group: "个性化与扩展",
      takeaway: "依赖云端副本前先确认传输状态。"
    },
    {
      summary: "调整工作区并掌握最常用的快捷键。",
      group: "个性化与扩展",
      takeaway: "把鼠标停在按钮上即可发现快捷键。"
    },
    {
      summary: "排查连接、模型、文件和集成问题。",
      group: "支持",
      takeaway: "记录原始错误，确认是否存在部分改动后再重试。"
    }
  ],
  interface: {
    label: "界面示意",
    yourProjects: "你的项目",
    myProject: "我的项目",
    firstTask: "第一个任务",
    conversation: "带上下文的对话",
    request: "修改前先解释这个项目。",
    response: ["读取文件。", "说明方案。", "检查结果。"],
    describeNext: "描述下一个任务",
    openFiles: "打开文件",
    clickPart: "点击工作区的任一区域，了解它的作用。"
  }
}

export function guideCopy(language: string | undefined): GuideCopy {
  return language?.toLowerCase().startsWith("zh") ? zh : en
}
