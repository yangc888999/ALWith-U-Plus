// 定时任务的数据层：纯函数（下次执行时间 / 重复规则） + 双层持久化 +
// 订阅（useSyncExternalStore 可直接用）。不依赖 React，便于单测。
//
// localStorage 是同步缓存，让组件挂载当帧就有数据；Rust 命名 KV（app_data_dir）是
// 跨窗口的真源，主窗口/设置窗口读同一份，`store-changed` 事件负责实时同步。
// 之所以必须双层：Tauri 各 webview 的 localStorage 不保证共享、storage 事件也不跨
// webview，只靠设置窗口的定时器就做不到「只要 App 开着就跑」。
// 不往 settingsStore 的 Rust 白名单加键。

import {
  isRepeatRule,
  type AutomationState,
  type AutomationRunRequest,
  type AutomationRunResult,
  type LarkTarget,
  type RepeatRule,
  type RunRecord,
  type RunStatus,
  type ScheduleSpec,
  type ScheduledTask,
  type TaskDraft
} from "./types"

const STORAGE_KEY = "alwith.automation.v1"
const DAY_MS = 86_400_000

/**
 * 运行记录只保留最近这么多条。它们是审计线索，不是无限日志：不裁剪的话每跑一次就多一行，
 * 长期开着的机器会积累成千上万条，拖慢列表渲染和 KV 写入。超出部分从最旧的一端丢弃。
 */
const MAX_RUNS = 200

/** 把运行记录裁剪到上限（保留最新的，即列表头部）。 */
function capRuns(runs: RunRecord[]): RunRecord[] {
  return runs.length > MAX_RUNS ? runs.slice(0, MAX_RUNS) : runs
}

/** Tauri 注入的全局；用它判断要不要加载原生命令，单测/浏览器里不需要 mock bindings。 */
const IN_TAURI = typeof globalThis !== "undefined" && "__TAURI_INTERNALS__" in globalThis

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** 动态加载原生存储层：非 Tauri 环境完全不碰 @tauri-apps / bindings。 */
async function remote(): Promise<typeof import("./automation-remote-store") | null> {
  if (!IN_TAURI) return null
  try {
    return await import("./automation-remote-store")
  } catch {
    return null
  }
}

function newId(): string {
  try {
    return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
  } catch {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

/** 运行记录的关联 id，也用作 RunRecord.id。 */
export function newRunId(): string {
  return newId()
}

// ── 时间与重复规则（纯函数，可独立单测） ─────────────────────────────────────

function parseTime(time: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (match === null) return [0, 0]
  const hour = Math.min(23, Math.max(0, Number(match[1])))
  const minute = Math.min(59, Math.max(0, Number(match[2])))
  return [hour, minute]
}

/** 有效期结束时刻（当天 23:59:59.999）。null 或非法日期视为长期有效。 */
function validityEnd(validUntil: string | null): number {
  if (validUntil === null) return Number.POSITIVE_INFINITY
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(validUntil)
  if (match === null) return Number.POSITIVE_INFINITY
  const [, y, m, d] = match
  return new Date(Number(y), Number(m) - 1, Number(d), 23, 59, 59, 999).getTime()
}

function mondayOf(date: Date): number {
  const offset = (date.getDay() + 6) % 7
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset).getTime()
}

/** 某个日历日是否命中重复规则；origin 是任务创建时间，作为周/月/年的锚点。 */
function matchesRepeat(repeat: RepeatRule, day: Date, origin: Date): boolean {
  switch (repeat) {
    case "daily":
      return true
    case "weekly":
      return day.getDay() === origin.getDay()
    case "biweekly": {
      if (day.getDay() !== origin.getDay()) return false
      // DST 会让两个本地午夜相差 ±1h；除以 7 天后取整仍是整周数。
      const weeks = Math.round((mondayOf(day) - mondayOf(origin)) / (7 * DAY_MS))
      return weeks >= 0 && weeks % 2 === 0
    }
    case "monthly":
      // 锚点是创建日的「日」；没有该日的月份自然跳过（如 31 号遇 2 月）。
      return day.getDate() === origin.getDate()
    case "yearly":
      return day.getMonth() === origin.getMonth() && day.getDate() === origin.getDate()
    default:
      return false
  }
}

/**
 * 计算严格晚于 `from` 的下一次执行时刻，返回 epoch ms；没有排期（单次已过、
 * 有效期已过 / 之后无命中日）返回 null。
 *
 * - interval：从创建时间起每隔 intervalMinutes 分钟一次，与 time 无关。
 * - once：创建当天（已过则次日）的 time 为唯一一次；过时不补跑。
 * - daily/weekly/biweekly/monthly/yearly：从 from 起逐日找第一个命中 time
 *   且满足规则的时刻；周/双周/月/年以创建日为锚点。
 * - 任何候选晚于有效期结束时刻即视为无排期。
 */
export function nextRunAt(spec: ScheduleSpec, from: number = Date.now()): number | null {
  const limit = validityEnd(spec.validUntil)
  if (limit < from) return null
  const [hour, minute] = parseTime(spec.time)

  if (spec.repeat === "interval") {
    const step = Math.max(1, Math.floor(spec.intervalMinutes) || 1) * 60_000
    const k = Math.max(1, Math.floor((from - spec.createdAt) / step) + 1)
    const candidate = spec.createdAt + k * step
    return candidate > limit ? null : candidate
  }

  const at = (day: Date): number =>
    new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0).getTime()

  if (spec.repeat === "once") {
    const created = new Date(spec.createdAt)
    const sameDay = new Date(created.getFullYear(), created.getMonth(), created.getDate())
    const nextDay = new Date(created.getFullYear(), created.getMonth(), created.getDate() + 1)
    const single = at(sameDay) > spec.createdAt ? at(sameDay) : at(nextDay)
    if (single <= from) return null
    return single > limit ? null : single
  }

  const base = new Date(from)
  const origin = new Date(spec.createdAt)
  // 覆盖 8 年足够命中每月/每年（含 2/29）规则；超出视为无排期。
  for (let offset = 0; offset < 366 * 8; offset += 1) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)
    const instant = at(day)
    if (instant <= from) continue
    if (instant > limit) return null
    if (matchesRepeat(spec.repeat, day, origin)) return instant
  }
  return null
}

// ── 持久化与订阅 ────────────────────────────────────────────────────────────

function emptyState(): AutomationState {
  return { tasks: [], runs: [] }
}

/** Old snapshots have none of these keys; malformed targets are dropped rather than crashing a load. */
function coerceTargets(raw: unknown): LarkTarget[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): LarkTarget[] => {
    if (typeof entry !== "object" || entry === null) return []
    const value = entry as Record<string, unknown>
    if (typeof value.id !== "string" || typeof value.name !== "string") return []
    return [{ id: value.id, name: value.name, kind: value.kind === "user" ? "user" : "chat" }]
  })
}

function coerceTask(raw: unknown): ScheduledTask | null {
  if (typeof raw !== "object" || raw === null) return null
  const value = raw as Record<string, unknown>
  if (typeof value.id !== "string" || typeof value.name !== "string") return null
  const repeat = isRepeatRule(String(value.repeat)) ? (value.repeat as RepeatRule) : "daily"
  return {
    id: value.id,
    name: value.name,
    prompt: typeof value.prompt === "string" ? value.prompt : "",
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    fullAccess: value.fullAccess === true,
    // Tasks saved before model selection existed simply follow the session default.
    model: typeof value.model === "string" ? value.model : "",
    effort: typeof value.effort === "string" ? value.effort : "",
    fastMode: value.fastMode === true,
    larkNotify: value.larkNotify === true,
    larkTargets: coerceTargets(value.larkTargets),
    // 旧快照（没有 monitorSessionId 字段）里的任务默认存的是 user，而普通 CLI 登录不含
    // im:message.send_as_user，按本人身份推送必然失败。把这一代旧任务一次性拨回开箱可用的
    // 飞书 CLI 助手；新版保存的任务都带该字段，用户之后主动选 user 会被原样保留。
    larkIdentity:
      "monitorSessionId" in value && value.larkIdentity === "user" ? "user" : "bot",
    repeat,
    intervalMinutes: typeof value.intervalMinutes === "number" ? value.intervalMinutes : 60,
    time: typeof value.time === "string" ? value.time : "09:00",
    validUntil: typeof value.validUntil === "string" ? value.validUntil : null,
    enabled: value.enabled === true,
    nextRunAt: typeof value.nextRunAt === "number" ? value.nextRunAt : null,
    monitorSessionId: typeof value.monitorSessionId === "string" ? value.monitorSessionId : null,
    createdAt: typeof value.createdAt === "number" ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now()
  }
}

function coerceRun(raw: unknown): RunRecord | null {
  if (typeof raw !== "object" || raw === null) return null
  const value = raw as Record<string, unknown>
  if (typeof value.id !== "string" || typeof value.taskId !== "string") return null
  const status: RunStatus =
    value.status === "running" || value.status === "success" || value.status === "failed" ? value.status : "failed"
  return {
    id: value.id,
    taskId: value.taskId,
    taskName: typeof value.taskName === "string" ? value.taskName : "",
    startedAt: typeof value.startedAt === "number" ? value.startedAt : Date.now(),
    finishedAt: typeof value.finishedAt === "number" ? value.finishedAt : null,
    status,
    summary: typeof value.summary === "string" ? value.summary : "",
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    error: typeof value.error === "string" ? value.error : null
  }
}

/** 解析任意来源（localStorage 字符串 / Rust KV 对象 / 事件 payload）为合法状态。 */
function parseState(raw: unknown): AutomationState {
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw
    if (value === null || typeof value !== "object") return emptyState()
    const parsed = value as Partial<AutomationState>
    const tasks = Array.isArray(parsed.tasks)
      ? parsed.tasks.map(coerceTask).filter((t): t is ScheduledTask => t !== null)
      : []
    const runs = Array.isArray(parsed.runs)
      ? parsed.runs.map(coerceRun).filter((r): r is RunRecord => r !== null)
      : []
    return { tasks, runs }
  } catch {
    // 配额错误或旧版本写入的坏数据：当作空状态，不阻塞 UI。
    return emptyState()
  }
}

function load(): AutomationState {
  try {
    const raw = storage()?.getItem(STORAGE_KEY)
    return raw === null || raw === undefined ? emptyState() : parseState(raw)
  } catch {
    return emptyState()
  }
}

let snapshot: AutomationState = load()
const listeners = new Set<() => void>()

/** 原生写入串行化：连续两次提交不能乱序落到 KV，否则最后一次可能被旧值覆盖。 */
let remoteWrites: Promise<void> = Promise.resolve()

function persist(): void {
  const state = snapshot
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 存储不可用或写满：内存副本仍服务本次会话。
  }
  remoteWrites = remoteWrites
    .then(async () => {
      const module = await remote()
      await module?.writeRemoteState(state)
    })
    .catch(() => undefined)
}

function commit(next: AutomationState): void {
  snapshot = next
  persist()
  for (const listener of listeners) listener()
}

export function subscribeAutomation(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** useSyncExternalStore 的 getSnapshot / getServerSnapshot；对象身份仅在变更时改变。 */
export function getAutomationSnapshot(): AutomationState {
  return snapshot
}

/**
 * 从 localStorage 重读并通知订阅者。另一个 webview 改了数据时同步用。
 * 只更新内存副本、不回写：否则两个窗口会借 storage 事件互相触发写入，形成死循环。
 */
export function reloadFromStorage(): void {
  const next = load()
  if (JSON.stringify(next) === JSON.stringify(snapshot)) return
  snapshot = next
  for (const listener of listeners) listener()
}

/** 用共享 KV 的值替换内存副本；值相同则忽略（自己写出的 store-changed 会回到这里）。 */
function applyRemote(value: unknown): void {
  const next = parseState(value)
  if (JSON.stringify(next) === JSON.stringify(snapshot)) return
  snapshot = next
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // 缓存写不进去不影响内存里的真源。
  }
  for (const listener of listeners) listener()
}

/**
 * 启动时从 Rust 命名 KV 拉一次全量状态。App 重启后主窗口自己的 localStorage 可能是空的，
 * 这一步让常驻调度器拿到真源。KV 还没有数据时把本地旧数据迁移上去，避免升级后丢任务。
 */
export async function hydrateAutomation(): Promise<void> {
  const module = await remote()
  if (module === null) return
  try {
    const raw = await module.readRemoteState()
    if (raw === null || raw === undefined) {
      if (snapshot.tasks.length > 0 || snapshot.runs.length > 0) await module.writeRemoteState(snapshot)
      return
    }
    applyRemote(raw)
  } catch {
    // 原生存储暂时不可用：内存/本地缓存仍可用，下一轮订阅或重启会再试。
  }
}

/** 订阅跨窗口变更。主窗口和设置窗口各自调用一次，各自清理自己那条订阅。 */
export function startAutomationSync(): () => void {
  if (!IN_TAURI) return () => {}
  let disposed = false
  let unlisten: (() => void) | null = null
  void remote()
    .then((module) => {
      if (!disposed && module !== null) unlisten = module.onRemoteStateChanged(applyRemote)
    })
    .catch(() => undefined)
  void hydrateAutomation()
  return () => {
    disposed = true
    unlisten?.()
  }
}

// 同一 origin 的其它 webview 写入时尽量实时同步（best-effort，兜底用）。
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) reloadFromStorage()
  })
}

// ── 任务 CRUD ──────────────────────────────────────────────────────────────

export function listTasks(): ScheduledTask[] {
  return snapshot.tasks
}

export function listRuns(): RunRecord[] {
  return snapshot.runs
}

export function getTask(id: string): ScheduledTask | undefined {
  return snapshot.tasks.find((task) => task.id === id)
}

export function createTask(draft: TaskDraft): ScheduledTask {
  const now = Date.now()
  const task: ScheduledTask = {
    ...draft,
    id: newId(),
    nextRunAt: null,
    monitorSessionId: null,
    createdAt: now,
    updatedAt: now
  }
  task.nextRunAt = nextRunAt(task, now)
  commit({ ...snapshot, tasks: [task, ...snapshot.tasks] })
  return task
}

export function updateTask(id: string, patch: Partial<TaskDraft>): void {
  const existing = getTask(id)
  if (existing === undefined) return
  const now = Date.now()
  const updated: ScheduledTask = { ...existing, ...patch, updatedAt: now }
  // 规则/时间/有效期/启停变化都要重新排期，从现在起算，避免编辑后立刻补跑。
  updated.nextRunAt = nextRunAt(updated, now)
  commit({
    ...snapshot,
    tasks: snapshot.tasks.map((task) => (task.id === id ? updated : task))
  })
}

export function removeTask(id: string): void {
  commit({
    tasks: snapshot.tasks.filter((task) => task.id !== id),
    runs: snapshot.runs.filter((run) => run.taskId !== id)
  })
}

/**
 * 记录 / 更换这条监控使用的固定会话。只改 id，不重排期：写会话 id 属于运行副作用，
 * 不该把「下次执行」从现在重新算一遍（那会让每天的任务凭空顺延一天）。
 */
export function setTaskMonitorSession(taskId: string, sessionId: string): void {
  if (!snapshot.tasks.some((task) => task.id === taskId)) return
  commit({
    ...snapshot,
    tasks: snapshot.tasks.map((task) =>
      task.id === taskId ? { ...task, monitorSessionId: sessionId, updatedAt: Date.now() } : task
    )
  })
}

/** 启用 / 暂停。重新启用时从现在重算下次执行，暂停期间错过的次数不补跑。 */
export function setTaskEnabled(id: string, enabled: boolean): void {
  const existing = getTask(id)
  if (existing === undefined) return
  const now = Date.now()
  const nextRun = enabled ? nextRunAt(existing, now) : existing.nextRunAt
  commit({
    ...snapshot,
    tasks: snapshot.tasks.map((task) =>
      task.id === id ? { ...task, enabled, nextRunAt: nextRun, updatedAt: now } : task
    )
  })
}

/**
 * 标记一次任务「已触发」并推进排期（在发出运行请求前调用，防止定时器 30s
 * 内重复触发）。单次任务触发后自动停用；重复任务若下次为 null 只是不再有排期。
 */
export function markTaskFired(id: string, at: number = Date.now()): void {
  const existing = getTask(id)
  if (existing === undefined) return
  const next = nextRunAt(existing, at)
  const enabled = existing.repeat === "once" ? false : existing.enabled
  commit({
    ...snapshot,
    tasks: snapshot.tasks.map((task) =>
      task.id === id ? { ...task, nextRunAt: next, enabled, updatedAt: at } : task
    )
  })
}

/** 到期的任务（已启用 + 有排期 + 排期 <= now）。 */
export function dueTasks(now: number = Date.now()): ScheduledTask[] {
  return snapshot.tasks.filter(
    (task) => task.enabled && task.nextRunAt !== null && task.nextRunAt <= now
  )
}

// ── 运行记录 ────────────────────────────────────────────────────────────────

/** 开始一次运行：写入一条 running 记录（id 用请求的 runId 关联）。 */
export function startAutomationRun(request: AutomationRunRequest): RunRecord {
  const record: RunRecord = {
    id: request.runId,
    taskId: request.taskId,
    taskName: request.taskName,
    startedAt: Date.now(),
    finishedAt: null,
    status: "running",
    summary: "",
    sessionId: null,
    error: null
  }
  commit({ ...snapshot, runs: capRuns([record, ...snapshot.runs]) })
  return record
}

/** 用主窗口回传的结果把 running 记录落定为 success / failed。 */
export function finishAutomationRun(result: AutomationRunResult): void {
  if (snapshot.runs.some((run) => run.id === result.runId)) {
    commit({
      ...snapshot,
      runs: capRuns(
        snapshot.runs.map((run) =>
          run.id === result.runId
            ? {
                ...run,
                finishedAt: result.finishedAt,
                status: result.status,
                summary: result.summary,
                sessionId: result.sessionId,
                error: result.error
              }
            : run
        )
      )
    })
    return
  }
  // 兜底：结果先于 start 到达（窗口刚重载等）时也别丢这条记录。
  const record: RunRecord = {
    id: result.runId,
    taskId: result.taskId,
    taskName: "",
    startedAt: result.finishedAt,
    finishedAt: result.finishedAt,
    status: result.status,
    summary: result.summary,
    sessionId: result.sessionId,
    error: result.error
  }
  commit({ ...snapshot, runs: capRuns([record, ...snapshot.runs]) })
}

export function clearRuns(): void {
  commit({ ...snapshot, runs: [] })
}

/** 运行中更新一条记录的部分字段（如 needsAuth 置位），不影响其它字段与排序。 */
export function patchRunRecord(id: string, patch: Partial<RunRecord>): void {
  if (!snapshot.runs.some((run) => run.id === id)) return
  commit({
    ...snapshot,
    runs: snapshot.runs.map((run) => (run.id === id ? { ...run, ...patch } : run))
  })
}
