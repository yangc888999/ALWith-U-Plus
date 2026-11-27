// 常驻调度器的回归测试：App 开着（主窗口在）时到点就跑，且不依赖设置窗口。
// 这里不 mock Tauri：task-store 在非 Tauri 环境用 localStorage 同步缓存，足够验证调度语义。

import { afterEach, beforeEach, expect, test, vi } from "vitest"

import type { AutomationRunRequest, AutomationRunResult } from "../types"

const STORAGE_KEY = "alwith.automation.v1"

async function fresh() {
  vi.resetModules()
  localStorage.clear()
  const store = await import("../task-store")
  const scheduler = await import("../automation-scheduler")
  return { store, scheduler }
}

function overdue(store: typeof import("../task-store")): void {
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as {
    tasks: Array<Record<string, unknown>>
    runs: unknown[]
  }
  raw.tasks[0]!.nextRunAt = Date.now() - 1_000
  localStorage.setItem(STORAGE_KEY, JSON.stringify(raw))
  store.reloadFromStorage()
}

/** 直接改持久化快照：模拟「App 关闭数日」重启后仍停留在过去某次触发时刻的陈旧排期。 */
function staleSchedule(store: typeof import("../task-store"), epochMs: number): void {
  const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as {
    tasks: Array<Record<string, unknown>>
    runs: unknown[]
  }
  raw.tasks[0]!.nextRunAt = epochMs
  localStorage.setItem(STORAGE_KEY, JSON.stringify(raw))
  store.reloadFromStorage()
}

const dailyDraft = {
  name: "每日群消息汇总",
  prompt: "读取飞书群消息并生成日报",
  cwd: "",
  fullAccess: true,
  model: "gateway:qwen:qwen-flash",
  effort: "",
  fastMode: false,
  larkNotify: false,
  larkTargets: [],
  larkIdentity: "bot",
  repeat: "daily" as const,
  intervalMinutes: 60,
  time: "08:05",
  validUntil: null,
  enabled: true
}

function success(request: AutomationRunRequest): AutomationRunResult {
  return {
    runId: request.runId,
    taskId: request.taskId,
    status: "success",
    summary: "end_turn",
    sessionId: "session-1",
    error: null,
    finishedAt: Date.now()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 10, 6, 9, 0, 0))
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

test("an overdue task fires on the startup tick without the settings window", async () => {
  const { store, scheduler } = await fresh()
  store.createTask(dailyDraft)
  overdue(store)

  const run = vi.fn(async (request: AutomationRunRequest) => success(request))
  const execute = (request: AutomationRunRequest) => scheduler.executeAutomationRun(run, request)
  const stop = scheduler.startAutomationScheduler(execute)

  await vi.advanceTimersByTimeAsync(5_000)

  expect(run).toHaveBeenCalledOnce()
  expect(run.mock.calls[0]?.[0]).toMatchObject({
    taskName: "每日群消息汇总",
    prompt: "读取飞书群消息并生成日报",
    model: "gateway:qwen:qwen-flash",
    effort: "",
    fastMode: false,
    larkNotify: false,
    larkTargets: [],
    larkMessageFormat: "markdown",
    larkIdentity: "bot",
  })
  expect(store.listRuns()).toHaveLength(1)
  expect(store.listRuns()[0]).toMatchObject({ status: "success", summary: "end_turn", sessionId: "session-1" })
  // 排期已推进，下一轮 30s 之后不会重复跑同一个任务。
  expect(store.dueTasks()).toHaveLength(0)
  stop()
})

test("an engine that is not ready skips the tick without burning the schedule", async () => {
  const { store, scheduler } = await fresh()
  store.createTask({
    name: "等引擎连上",
    prompt: "hi",
    cwd: "",
    fullAccess: true,
    model: "",
    effort: "",
    fastMode: false,
    larkNotify: false,
    larkTargets: [],
    larkIdentity: "bot",
    repeat: "daily",
    intervalMinutes: 60,
    time: "08:05",
    validUntil: null,
    enabled: true
  })
  overdue(store)

  const run = vi.fn(async (request: AutomationRunRequest) => success(request))
  const execute = (request: AutomationRunRequest) => scheduler.executeAutomationRun(run, request)
  let ready = false
  const stop = scheduler.startAutomationScheduler(execute, () => ready)

  await vi.advanceTimersByTimeAsync(5_000)
  expect(run).not.toHaveBeenCalled()
  expect(store.listRuns()).toHaveLength(0)
  expect(store.dueTasks()).toHaveLength(1)

  ready = true
  await vi.advanceTimersByTimeAsync(30_000)
  expect(run).toHaveBeenCalledOnce()
  expect(store.listRuns()[0]?.status).toBe("success")
  stop()
})

test("a thrown execution still finalizes its record as failed", async () => {
  const { store, scheduler } = await fresh()
  const request: AutomationRunRequest = {
    runId: "run-throws",
    taskId: "task-1",
    taskName: "会失败的任务",
    prompt: "hi",
    cwd: "",
    fullAccess: false,
    model: "",
    effort: "",
    fastMode: false,
    larkNotify: false,
    larkTargets: [],
    larkIdentity: "bot",
  }
  const run = vi.fn(async () => {
    throw new Error("engine gone")
  })
  const result = await scheduler.executeAutomationRun(run, request)

  expect(result.status).toBe("failed")
  expect(result.error).toBe("engine gone")
  expect(store.listRuns()).toHaveLength(1)
  expect(store.listRuns()[0]).toMatchObject({ status: "failed", error: "engine gone" })
})

const request = (taskId: string): AutomationRunRequest => ({
  runId: `run-${taskId}`,
  taskId,
  taskName: taskId,
  prompt: "hi",
  cwd: "",
  fullAccess: false,
  model: "",
  effort: "",
  fastMode: false,
  larkNotify: false,
  larkTargets: [],
  larkIdentity: "bot",
})

test("two runs share one queue instead of starting together on the single agent", async () => {
  const { scheduler } = await fresh()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started: string[] = []
  const run = vi.fn(async (task: AutomationRunRequest) => {
    started.push(task.taskId)
    if (task.taskId === "a") await gate
    return success(task)
  })
  const execute = scheduler.serialAutomationExecutor(run)

  const first = execute(request("a"))
  const second = execute(request("b"))
  await Promise.resolve()
  await Promise.resolve()
  // The second run must still be waiting: starting it now would make both contend for the one
  // Codex process, and a stalled turn can hold that process for 20 minutes.
  expect(started).toEqual(["a"])

  release()
  await first
  expect(await second).toMatchObject({ status: "success", taskId: "b" })
  expect(started).toEqual(["a", "b"])
})

test("a failed run does not block the tasks behind it", async () => {
  const { scheduler } = await fresh()
  const run = vi.fn(async (task: AutomationRunRequest) => {
    if (task.taskId === "a") throw new Error("engine gone")
    return success(task)
  })
  const execute = scheduler.serialAutomationExecutor(run)

  await expect(execute(request("a"))).rejects.toThrow("engine gone")
  await expect(execute(request("b"))).resolves.toMatchObject({ status: "success" })
})

test("stopping the scheduler clears both timers", async () => {
  const { store, scheduler } = await fresh()
  store.createTask({
    name: "停止后不跑",
    prompt: "hi",
    cwd: "",
    fullAccess: true,
    model: "",
    effort: "",
    fastMode: false,
    larkNotify: false,
    larkTargets: [],
    larkIdentity: "bot",
    repeat: "daily",
    intervalMinutes: 60,
    time: "08:05",
    validUntil: null,
    enabled: true
  })
  overdue(store)
  const run = vi.fn(async (request: AutomationRunRequest) => success(request))
  const execute = (request: AutomationRunRequest) => scheduler.executeAutomationRun(run, request)
  const stop = scheduler.startAutomationScheduler(execute)
  stop()

  await vi.advanceTimersByTimeAsync(60_000)
  expect(run).not.toHaveBeenCalled()
  expect(store.listRuns()).toHaveLength(0)
})

test("a queued run is skipped when its task was deleted, disabled or edited before dequeue", async () => {
  const { store, scheduler } = await fresh()
  const draft = {
    name: "排队任务",
    prompt: "hi",
    cwd: "",
    fullAccess: true,
    model: "",
    effort: "",
    fastMode: false,
    larkNotify: false,
    larkTargets: [],
    larkIdentity: "bot",
    repeat: "daily" as const,
    intervalMinutes: 60,
    time: "08:05",
    validUntil: null,
    enabled: true
  }
  const deleted = store.createTask({ ...draft, name: "被删除" })
  const disabled = store.createTask({ ...draft, name: "被停用" })
  const edited = store.createTask({ ...draft, name: "被修改" })
  const healthy = store.createTask({ ...draft, name: "未改动" })
  const firedAt = Date.now()

  // Mirrors the production dequeue guard in app.tsx.
  const stillValid = (req: AutomationRunRequest): boolean => {
    if (req.taskFiredAt === undefined) return true
    const current = store.getTask(req.taskId)
    return current !== undefined && current.enabled && current.updatedAt <= req.taskFiredAt
  }
  const run = vi.fn(async (req: AutomationRunRequest) => success(req))
  const execute = scheduler.serialAutomationExecutor(run, stillValid)
  const queued = (taskId: string): AutomationRunRequest => ({
    runId: `run-${taskId}`,
    taskId,
    taskName: "排队任务",
    prompt: "hi",
    cwd: "",
    fullAccess: true,
    model: "",
    effort: "",
    fastMode: false,
    larkNotify: false,
    larkTargets: [],
    larkIdentity: "bot",
    monitorSessionId: null,
    taskFiredAt: firedAt
  })

  store.removeTask(deleted.id)
  store.setTaskEnabled(disabled.id, false)
  vi.advanceTimersByTime(1)
  store.updateTask(edited.id, { prompt: "changed" })

  await expect(execute(queued(deleted.id))).resolves.toMatchObject({ status: "failed" })
  await expect(execute(queued(disabled.id))).resolves.toMatchObject({ status: "failed" })
  await expect(execute(queued(edited.id))).resolves.toMatchObject({ status: "failed" })
  await expect(execute(queued(healthy.id))).resolves.toMatchObject({ status: "success" })
  // A run that never started must not leave a running record behind.
  expect(run).toHaveBeenCalledOnce()
})

// ── 排期永久卡死自愈（P0）──────────────────────────────────────────────────

test("a days-stale schedule is swept forward on the tick and fires at its next slot", async () => {
  // 复现事故场景：每日 08:05，周末 App 关着，周一 08:30 启动。修复前排期停在周六
  // 08:05（远超 60s 补跑窗）→ 永不 due、永不推进；修复后每个 tick 先清扫再取 due。
  const { store, scheduler } = await fresh()
  vi.setSystemTime(new Date(2026, 0, 1, 10, 0)) // 周四创建
  store.createTask(dailyDraft)
  vi.setSystemTime(new Date(2026, 0, 5, 8, 30)) // 周一 08:30 重启（排期仍是上周的某个 08:05）
  staleSchedule(store, new Date(2026, 0, 3, 8, 5).getTime()) // 周六 08:05 的陈旧值

  const run = vi.fn(async (request: AutomationRunRequest) => success(request))
  const execute = (request: AutomationRunRequest) => scheduler.executeAutomationRun(run, request)
  const stop = scheduler.startAutomationScheduler(execute)

  await vi.advanceTimersByTimeAsync(5_000) // kickoff
  // 清扫推进到下一个未来时刻，不补跑错过的那一次，也不误触发执行。
  expect(store.getTask(store.listTasks()[0].id)!.nextRunAt).toBe(new Date(2026, 0, 6, 8, 5).getTime())
  expect(store.listTasks()[0].enabled).toBe(true)
  expect(run).not.toHaveBeenCalled()

  // 到了周二 08:05 那一次：照常执行。
  vi.setSystemTime(new Date(2026, 0, 6, 8, 5, 10))
  await vi.advanceTimersByTimeAsync(30_000)
  expect(run).toHaveBeenCalledOnce()
  stop()
})

test("the schedule also self-heals while the engine is not ready", async () => {
  // canRun=false 只应挡住执行，不应挡住排期推进（否则引擎长时间离线时又退回永久卡死）。
  const { store, scheduler } = await fresh()
  vi.setSystemTime(new Date(2026, 0, 1, 10, 0))
  store.createTask(dailyDraft)
  vi.setSystemTime(new Date(2026, 0, 5, 9, 0))
  staleSchedule(store, new Date(2026, 0, 3, 8, 5).getTime())

  const run = vi.fn(async (request: AutomationRunRequest) => success(request))
  const execute = (request: AutomationRunRequest) => scheduler.executeAutomationRun(run, request)
  const stop = scheduler.startAutomationScheduler(execute, () => false)

  await vi.advanceTimersByTimeAsync(5_000)
  expect(run).not.toHaveBeenCalled()
  expect(store.getTask(store.listTasks()[0].id)!.nextRunAt).toBe(new Date(2026, 0, 6, 8, 5).getTime())
  stop()
})

test("a schedule that goes stale while the app stays open is swept by a later tick", async () => {
  // 这条用例守的是 per-tick sweep（不是启动自愈）。P0 的另一半场景：App 一直开着、合盖睡眠
  // 跨过了触发时刻 —— 启动自愈只在第一轮跑一次，睡醒后的陈旧排期只有 tick 内联清扫能救。
  //
  // 关键在时序：陈旧必须在第一轮 tick **之后**才发生。若像别的用例那样一启动就是陈旧值，
  // 首轮 tick 里 fire-and-forget 的 selfHealAutomationState 内部也会 sweep，把 tick 内联的
  // 那次完全遮蔽 —— 于是删掉 tick 里的 sweep 也全绿（QA 的变异实验正是如此）。这条用例
  // 因此在首轮 tick 时让排期落在未来，跳时钟后才变陈旧。
  const { store, scheduler } = await fresh()
  vi.setSystemTime(new Date(2026, 10, 6, 9, 0, 0)) // 11-06 09:00，晚于 08:05 → 排到次日
  store.createTask(dailyDraft)
  const scheduled = new Date(2026, 10, 7, 8, 5).getTime()
  expect(store.listTasks()[0].nextRunAt).toBe(scheduled)

  const run = vi.fn(async (request: AutomationRunRequest) => success(request))
  const execute = (request: AutomationRunRequest) => scheduler.executeAutomationRun(run, request)
  const stop = scheduler.startAutomationScheduler(execute)

  // 首轮 kickoff tick：排期在未来，自愈与清扫都不该动它。
  await vi.advanceTimersByTimeAsync(5_000)
  expect(store.listTasks()[0].nextRunAt).toBe(scheduled)
  expect(run).not.toHaveBeenCalled()

  // 合盖睡眠：时钟跳过 11-07 08:05，醒来已过 60s 补跑窗（08:05 → 08:10，宽限早过）。
  vi.setSystemTime(new Date(2026, 10, 7, 8, 10, 0))
  expect(store.listTasks()[0].nextRunAt).toBe(scheduled) // 睡醒但还没 tick：仍是陈旧值

  // 第二轮 tick（30s 周期，elapsed 5s → 30s）：内联 sweep 必须把排期推进到下一个未来时刻。
  await vi.advanceTimersByTimeAsync(25_000)

  const task = store.listTasks()[0]
  expect(task.nextRunAt).toBe(new Date(2026, 10, 8, 8, 5).getTime()) // 11-08 08:05
  expect(task.nextRunAt! > Date.now()).toBe(true)
  expect(task.enabled).toBe(true)
  // 错过的那一次不补跑：过了窗就不该再派发。
  expect(run).not.toHaveBeenCalled()
  expect(store.dueTasks()).toHaveLength(0)
  stop()
})

test("startup self-heal finalizes zombie running records left by a quit mid-run", async () => {
  const { store } = await fresh()
  // 上一世留下的 running 记录（App 在会话还在跑时退出）。
  store.startAutomationRun({
    runId: "run-zombie",
    taskId: "task-1",
    taskName: "被退出打断",
    prompt: "hi",
    cwd: "",
    fullAccess: false,
    model: "",
    effort: "",
    fastMode: false,
    larkNotify: false,
    larkTargets: [],
    larkIdentity: "bot"
  })
  expect(store.listRuns()[0].status).toBe("running")

  // 真实重启要经过一段时间才把调度器拉起来，那条记录的开始时刻严格早于新的调度器启动时刻
  // ——这正是水位（schedulerStart）判僵尸的依据。
  vi.setSystemTime(Date.now() + 30_000)
  // 换模块实例模拟重启，再走调度器启动路径 → kickoff tick 内触发一次性自愈。
  vi.resetModules()
  const store2 = await import("../task-store")
  const scheduler2 = await import("../automation-scheduler")
  expect(store2.listRuns()[0].status).toBe("running")
  const run = vi.fn(async (request: AutomationRunRequest) => success(request))
  const stop = scheduler2.startAutomationScheduler((request: AutomationRunRequest) =>
    scheduler2.executeAutomationRun(run, request)
  )
  await vi.advanceTimersByTimeAsync(5_000)
  const zombie = store2.listRuns().find((r) => r.id === "run-zombie")!
  expect(zombie.status).toBe("failed")
  expect(zombie.error).toBe("应用退出中断")
  expect(zombie.finishedAt).not.toBeNull()
  stop()
})

test("startup self-heal keeps a run started after the scheduler came up", async () => {
  // 竞态回归：selfHeal 要先 await KV hydrate，而同一轮 tick 已经同步派发了到期任务并写下
  // running 记录。没有时间水位时，hydrate 返回后的"落定所有 running"会把这条真实在途的
  // 运行烧成「应用退出中断」。
  const { store, scheduler } = await fresh()
  store.createTask(dailyDraft)
  overdue(store) // 启动瞬间就有任务在 60s 补跑窗内

  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const run = vi.fn(async (request: AutomationRunRequest) => {
    await gate
    return success(request)
  })
  const execute = (request: AutomationRunRequest) => scheduler.executeAutomationRun(run, request)
  const stop = scheduler.startAutomationScheduler(execute)

  // kickoff tick：先派发（写下 running），自愈的 hydrate 之后才继续。
  await vi.advanceTimersByTimeAsync(5_000)
  expect(run).toHaveBeenCalledOnce()
  const started = store.listRuns()[0]
  expect(started.status).toBe("running")
  // 让出微任务队列，给 fire-and-forget 的 selfHeal 跑完落定逻辑。
  await vi.advanceTimersByTimeAsync(0)
  await Promise.resolve()
  const afterHeal = store.listRuns()[0]
  expect(afterHeal.id).toBe(started.id)
  expect(afterHeal.status).toBe("running") // 刚起的运行必须原封不动
  expect(afterHeal.error).toBeNull()

  // 真实收尾照常落定为 success。
  release()
  await vi.advanceTimersByTimeAsync(0)
  expect(store.listRuns()[0]).toMatchObject({ status: "success", error: null })
  stop()
})
