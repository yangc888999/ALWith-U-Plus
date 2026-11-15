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

/**
 * 原生存储层只加载一次。两个调用方（订阅注册与启动 hydrate）会在同一 tick 里同时要它；
 * 各发一次 `import()` 既浪费，也会让其中一个 promise 在测试的模块 mock 下迟迟不 settle。
 * 记住同一个 promise 后两者共享一次加载，语义与生产构建里 ES 模块的去重一致。
 *
 * 失败不能永久缓存：加载失败（原生层还没就绪、chunk 暂时读不到）只说明这一次不行，缓存住
 * 一个 null 会让整个进程内的跨窗口同步静默失效到重启为止。所以 catch 里清空缓存，下一次
 * 调用重新尝试。`??=` 的赋值在 catch 之后才完成，此时对模块级变量赋 null 是安全的 ——
 * 随后 return 的仍然是本次的 null，不改变本次调用的返回值。
 */
let remoteModule: Promise<typeof import("./automation-remote-store") | null> | null = null

/** 动态加载原生存储层：非 Tauri 环境完全不碰 @tauri-apps / bindings，也不缓存。 */
function remote(): Promise<typeof import("./automation-remote-store") | null> {
  if (!IN_TAURI) return Promise.resolve(null)
  remoteModule ??= import("./automation-remote-store").catch((error: unknown) => {
    console.warn("[automation] native store unavailable; will retry on next use", error)
    remoteModule = null
    return null
  })
  return remoteModule
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
    error: typeof value.error === "string" ? value.error : null,
    needsAuth: value.needsAuth === true
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

/**
 * 已排队但尚未落地的本地写入数。`applyRemote` 用它判断「手里的远端快照是否已经过时」：
 * 只要还有本地写入在途，内存里的状态就比这次读更新，用远端整份替换只会把排期推进 / 运行
 * 记录回滚（见 applyRemote 的注释）。归零由每条写入自己的 finally 负责，串行链保证计数准确。
 */
let pendingWrites = 0

/** 启动那次 KV 读取的 in-flight promise；见 whenHydrated() 的注释。null = 还没开始读。 */
let hydration: Promise<void> | null = null

function persist(): void {
  const state = snapshot
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 存储不可用或写满：内存副本仍服务本次会话。
  }
  pendingWrites += 1
  remoteWrites = remoteWrites
    .then(async () => {
      const module = await remote()
      await module?.writeRemoteState(state)
    })
    .catch(() => undefined)
    .finally(() => {
      pendingWrites -= 1
    })
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

/**
 * 用共享 KV 的值替换内存副本；值相同则忽略（自己写出的 store-changed 会回到这里）。
 *
 * 本地写入在途时直接丢弃这份远端快照：`readRemoteState` 是在某个时刻发起的，返回时本轮可能
 * 已经 `markTaskFired`（推进 nextRunAt）、`startAutomationRun`（写 running）并把这些写入了
 * 队列。若此刻用读到的旧快照整份替换内存，排期会被回滚到过去 —— 下一轮 tick 该任务仍在
 * 60s 补跑窗内，于是**重复执行一次**，运行记录的 running 也会被抹掉。
 *
 * 丢弃不会丢数据：本地写入是最后落地的一份，磁盘上的 KV 最终就是它。
 *
 * 代价说明（实测，勿臆测）：被丢弃的那份远端变更**不会**自动重投 —— `store-changed` 只在
 * 对方窗口再次写入时才来，不是"队列保证送达"。因此两个窗口真正并发编辑时，仍按 last-write-wins
 * 处理，一次写入可能被对方覆盖。这是「整份快照持久化」的既有局限（本文件一直是整份写、整份
 * 替换，没有字段级合并），不是这道闸门引入的；闸门只是把"读旧后回滚"这个更严重的失效
 * （重复执行、在途记录被抹）换成"并发编辑可能丢一侧"这个已知且更轻的失效。
 */
function applyRemote(value: unknown): void {
  if (pendingWrites > 0) return
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

/**
 * `startAutomationSync` 发起的那一次 KV 读取的完成信号；`selfHealAutomationState` 复用它。
 *
 * 只允许这一次：selfHeal 是在**首轮 tick 之后**才 await 的，那时本轮已经 `markTaskFired` /
 * `startAutomationRun`。若在那里再发一次 `readRemoteState`，读到的可能是不含这些写入的旧
 * 快照，`applyRemote` 整份替换就把排期和 running 记录一起回滚（→ 下一轮重复执行）。
 * 启动那次读取的发起时刻早于任何派发，复用它就没有这个窗口。
 * 非 Tauri（单测）环境下 startAutomationSync 直接返回、hydration 保持 null，这里立即 resolve。
 */
export function whenHydrated(): Promise<void> {
  return hydration ?? Promise.resolve()
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
  hydration = hydrateAutomation().catch(() => undefined)
  return () => {
    disposed = true
    unlisten?.()
  }
}

/**
 * 主窗口启动自愈：等启动那次 hydrate 把 KV 真源合并进内存后，落定僵尸 running 记录、
 * 清扫陈旧排期。只在主窗口调度器启动路径调用一次 —— 设置窗口也调 startAutomationSync，
 * 若把清扫挂在 hydrate 内部，两个窗口会各自重算并回写 KV，形成双写竞态。
 *
 * **必须**等 `whenHydrated()` 而不是自己再 `hydrateAutomation()`：本函数在首轮 tick 之后
 * 才跑到 await，此刻本轮已经推进过排期、写过 running 记录；再发一次读取拿到的可能是这些
 * 写入落地前的旧快照，applyRemote 会把它们整份回滚（→ 任务下一轮重复执行）。
 *
 * @param startedBefore 僵尸记录的时间水位（调度器启动时刻）。必须这么传：调用方同一轮 tick
 *   早已同步派发过到期任务、写下了真实的 running 记录；没有水位就会把这条在途运行误判成
 *   僵尸。默认正无穷，保持"落定全部 running"的裸语义。
 */
export async function selfHealAutomationState(startedBefore?: number): Promise<void> {
  await whenHydrated()
  finalizeStaleRunningRuns(Date.now(), startedBefore)
  sweepStaleSchedules()
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

/** A persisted nextRunAt can be days old after sleep or a relaunch. Only a task whose schedule
 * is still inside its validity and just missed its slot counts as due; anything older is skipped
 * rather than replayed, matching the "missed runs are not caught up" rule. */
const CATCH_UP_WINDOW_MS = 60_000

/** 到期的任务（已启用 + 有排期 + 排期 <= now + 仍在有效期内 + 未过期太久）。 */
export function dueTasks(now: number = Date.now()): ScheduledTask[] {
  return snapshot.tasks.filter(
    (task) =>
      task.enabled &&
      task.nextRunAt !== null &&
      task.nextRunAt <= now &&
      now - task.nextRunAt <= CATCH_UP_WINDOW_MS &&
      now <= validityEnd(task.validUntil)
  )
}

// ── 陈旧状态自愈（仅主窗口调度器路径调用） ─────────────────────────────────

/**
 * 排期清扫：把「早已错过补跑窗」的启用任务的 nextRunAt 从现在重算一次。
 *
 * 存在的理由：nextRunAt() 只在 createTask/updateTask/setTaskEnabled/markTaskFired 时调用。
 * App 关闭期间错过的时刻既不会被 dueTasks 补跑（超出 60s 窗），也没有任何路径推进排期，
 * 陈旧值会永久停留在过去 —— 每日 08:05 的任务周末错过后，周一启动就「永不 due、永不推进」，
 * 任务实际失效。清扫恢复后续排期，语义不变：错过的那一次不补跑。
 *
 * 幂等、可每个 tick 反复调用（引擎长时间未就绪时排期同样需要自愈）；无任务变更时不
 * commit，避免每 30s 空写一次存储。sweep 与 due 判定互斥：sweep 只碰 now - nextRunAt >
 * CATCH_UP_WINDOW_MS 的任务，dueTasks 只认 <= 窗口的，同一时刻不会既补跑又顺延。
 * 仅在主窗口的调度器里调用（tick + 启动自愈），设置窗口只读展示、不重排。
 *
 * once 语义：nextRunAt() 对 once 只认创建当天/次日那一次，既定时刻已过恒为 null。与
 * markTaskFired 的「once 触发即自动停用」对齐 —— 从未触发但已过期同样置 null 并停用，
 * 不留「启用却永无排期」的僵尸任务。重复任务重算为 null（有效期已过）时保持启用，
 * 与既有「validityEnd 之后不再 due、可改有效期恢复」的行为一致。
 *
 * @returns 被重算的任务数
 */
export function sweepStaleSchedules(now: number = Date.now()): number {
  let swept = 0
  const tasks = snapshot.tasks.map((task) => {
    if (!task.enabled || task.nextRunAt === null) return task
    if (now - task.nextRunAt <= CATCH_UP_WINDOW_MS) return task
    const next = nextRunAt(task, now)
    swept += 1
    if (task.repeat === "once" && next === null) {
      return { ...task, nextRunAt: null, enabled: false, updatedAt: now }
    }
    return { ...task, nextRunAt: next, updatedAt: now }
  })
  if (swept > 0) commit({ ...snapshot, tasks })
  return swept
}

/**
 * 僵尸运行记录落定：把停留在 "running" 的记录写成 failed（"应用退出中断"）。
 *
 * 运行记录只由主窗口写入，且执行链（executeAutomationRun / withSerialTimeout）都随主
 * 窗口进程存亡：会话还「在跑」时 App 退出，重启后这条 running 永远等不到 finish。needsAuth
 * 的 waiting 展示同样依赖 status === "running"，一并落定。只在启动路径调用一次 —— 运行中
 * 新写的 running 记录是真实在途，每个 tick 调这个会把健康运行烧成 failed。
 *
 * `startedBefore` 是时间水位：只有「开始时间早于它」的记录才算僵尸。没有这道水位，启动自愈
 * 会误伤本轮新起的运行 —— selfHealAutomationState 内部先 await hydrateAutomation()，而调度器
 * 的同一轮 tick 早已同步往下跑完 sweep / canRun / startAutomationRun：等 await 返回，那条刚
 * 写下的真实 running 记录就成了「无差别把所有 running 改成 failed」的受害者。水位取调度器
 * 启动时刻（早于任何一次派发），上一世遗留的记录 startedAt 必然更早，仍会被正确落定。
 *
 * 严格小于（而非 <=）：同一毫秒内无法区分"上一世遗留"与"本轮刚起"，宁可漏掉一条僵尸
 * （用户下一轮 tick 也看不到它，只是显示成运行中）也不能烧掉一条真实在途的运行。
 *
 * @param now 落定时间；记录的 finishedAt 为空时用它兜底
 * @param startedBefore 时间水位，默认正无穷（无水位：落定全部 running）
 * @returns 被落定的记录数
 */
export function finalizeStaleRunningRuns(
  now: number = Date.now(),
  startedBefore: number = Number.POSITIVE_INFINITY
): number {
  const isStale = (run: RunRecord): boolean => run.status === "running" && run.startedAt < startedBefore
  const stale = snapshot.runs.filter(isStale).length
  if (stale === 0) return 0
  const runs = snapshot.runs.map((run) =>
    isStale(run)
      ? {
          ...run,
          status: "failed" as RunStatus,
          finishedAt: run.finishedAt ?? now,
          error: "应用退出中断"
        }
      : run
  )
  commit({ ...snapshot, runs })
  return stale
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
