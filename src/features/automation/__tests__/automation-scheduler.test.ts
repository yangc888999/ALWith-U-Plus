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
  store.createTask({
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
