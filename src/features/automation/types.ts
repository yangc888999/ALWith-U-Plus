// 自动任务 / 定时任务：纯数据类型与事件协议。
//
// 第一版的执行模型（重要）：定时任务「到点」时并不是在设置窗口里跑脚本，而是
// 让主窗口用现有的 ACP client 新建一个会话、把提示词发进去；跑脚本、飞书 CLI
// 读群、发消息都由 agent 在那个会话里按提示词自行完成。本文件只描述数据，不
// 依赖任何窗口或框架。

/** 重复规则。顺序即「重复」下拉里的顺序。 */
export const REPEAT_RULES = ["interval", "once", "daily", "weekly", "biweekly", "monthly", "yearly"] as const

export type RepeatRule = (typeof REPEAT_RULES)[number]

export function isRepeatRule(value: string): value is RepeatRule {
  return (REPEAT_RULES as readonly string[]).includes(value)
}

/** 计算下次执行时间所需的字段。`ScheduledTask` 结构兼容它，可直接传入。 */
export interface ScheduleSpec {
  repeat: RepeatRule
  /** 触发时刻 "HH:mm"，interval 规则下不参与计算。 */
  time: string
  /** interval 规则的间隔分钟数，其它规则忽略。 */
  intervalMinutes: number
  /** 有效期结束日 "YYYY-MM-DD"，null = 长期有效。 */
  validUntil: string | null
  /** 任务创建时间，作为每周 / 每双周 / 每月 / 每年的锚点。 */
  createdAt: number
}

/** 飞书推送目标：`chat` = 群（oc_…），`user` = 私聊（ou_…）。 */
export interface LarkTarget {
  id: string
  name: string
  kind: string
}

/** 新建 / 编辑弹窗提交的可编辑字段。 */
export interface TaskDraft {
  name: string
  prompt: string
  /** 工作空间（cwd）；空串表示跟随主窗口默认（快速会话目录）。 */
  cwd: string
  /** 允许完全访问：映射为会话的 codex sandbox mode。 */
  fullAccess: boolean
  /** 运行模型（引擎目录里的 id）；空串 = 跟随新会话的默认模型。 */
  model: string
  /** 推理档位；空串 = 跟随该模型的默认档位。 */
  effort: string
  /** 仅 GPT 组有效：开启加速（fast mode）。 */
  fastMode: boolean
  /** 运行结束后把结果推送到飞书。 */
  larkNotify: boolean
  larkTargets: LarkTarget[]
  /** `bot` = 机器人身份（默认，开箱可用）；`user` = 本人身份（需额外授权 scope）。 */
  larkIdentity: string
  repeat: RepeatRule
  intervalMinutes: number
  time: string
  validUntil: string | null
  enabled: boolean
}

/** 落库的任务定义。 */
export interface ScheduledTask extends ScheduleSpec, TaskDraft {
  id: string
  /** 下次执行时间（epoch ms），null = 已完成 / 已过期 / 无排期。 */
  nextRunAt: number | null
  /**
   * 这条监控对应的固定会话。首次运行创建并按任务命名，之后每天都把结果追加到同一个会话，
   * 侧边栏因此只显示一条「监控」，不会每天多出一条聊天。null = 还没跑过 / 会话已被删除。
   */
  monitorSessionId: string | null
  createdAt: number
  updatedAt: number
}

export type RunStatus = "running" | "success" | "no_content" | "failed"

/** One delivery attempt per Lark target, persisted with the run for an honest receipt. */
export interface DeliveryReceipt {
  targetId: string
  targetName: string
  kind: string
  status: "sent" | "failed" | "skipped"
  error: string | null
}

/** 运行记录。 */
export interface RunRecord {
  id: string
  taskId: string
  taskName: string
  startedAt: number
  finishedAt: number | null
  status: RunStatus
  /** 结果摘要（成功时取 prompt 的 stop reason）。 */
  summary: string
  /** 主窗口为这次运行创建的会话 id，失败时为 null。 */
  sessionId: string | null
  error: string | null
  deliveries?: DeliveryReceipt[]
  /** 运行中但会话已停在 requires_action：定时任务无人交互，需要用户去主窗口处理。 */
  needsAuth?: boolean
}

/** 持久化快照。 */
export interface AutomationState {
  tasks: ScheduledTask[]
  runs: RunRecord[]
}

// ── 跨窗口事件协议 ──────────────────────────────────────────────────────────
// 设置窗口持有任务与运行记录，主窗口持有 ACP client。两者通过 settings-bridge
// 风格的事件通信：设置窗口发「运行任务」请求，主窗口执行后回传结果。

/** 设置窗口 → 主窗口：请求执行一次任务（定时器到期或「立即运行」触发）。 */
export interface AutomationRunRequest {
  /** 关联 id，同时是 RunRecord 的 id。 */
  runId: string
  taskId: string
  taskName: string
  prompt: string
  cwd: string
  fullAccess: boolean
  /** Empty selects the current default at the start of every run. */
  model: string
  effort: string
  fastMode: boolean
  larkNotify: boolean
  larkTargets: LarkTarget[]
  larkIdentity: string
  /** 复用的监控会话；省略 / null 表示主窗口需要新建一条并回写任务（兼容旧版请求）。 */
  monitorSessionId?: string | null
  /** The scheduler tick that queued this run. Only scheduled requests carry it; the dequeue
   * check uses it to tell a stale queued request from a user-triggered "run now". */
  taskFiredAt?: number
}

/** 主窗口 → 设置窗口：一次执行的结果。 */
export interface AutomationRunResult {
  runId: string
  taskId: string
  status: "success" | "no_content" | "failed"
  failureKind?: "model"
  summary: string
  sessionId: string | null
  error: string | null
  deliveries?: DeliveryReceipt[]
  finishedAt: number
}

/** 主窗口真实的执行接口：由 app.tsx 用 client 实现，类型完整、非空 TODO。 */
export type OnRunTask = (request: AutomationRunRequest) => Promise<AutomationRunResult>

/** 列表页筛选条件。 */
export type TaskFilter = "all" | "enabled" | "paused"
