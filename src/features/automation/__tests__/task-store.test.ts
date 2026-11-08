import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import type { AutomationRunRequest, AutomationRunResult, ScheduleSpec, TaskDraft } from "../types"

const STORAGE_KEY = "alwith.automation.v1"
const DAY_MS = 86_400_000

/** 本地时间 → epoch ms，与时区无关（比较也用同样的构造）。 */
const at = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime()

function draft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    name: "每日群消息汇总",
    prompt: "读取飞书群消息并生成日报",
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
    enabled: true,
    ...overrides
  }
}

function spec(overrides: Partial<ScheduleSpec> = {}): ScheduleSpec {
  return {
    repeat: "daily",
    time: "08:05",
    intervalMinutes: 60,
    validUntil: null,
    createdAt: at(2026, 1, 1, 10, 0),
    ...overrides
  }
}

/** 每个用例拿到全新模块实例 + 干净 localStorage，避免单例状态串味。 */
async function fresh() {
  vi.resetModules()
  localStorage.clear()
  return import("../task-store")
}

/** 只换模块实例、不清理存储：用于验证持久化往返。 */
async function reloaded() {
  vi.resetModules()
  return import("../task-store")
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── nextRunAt：各重复规则 ────────────────────────────────────────────────────

describe("nextRunAt 重复规则", () => {
  test("每天：下一次是紧接的 08:05，跨过已过的当天时刻", async () => {
    const { nextRunAt } = await fresh()
    const s = spec()
    expect(nextRunAt(s, at(2026, 1, 1, 10, 0))).toBe(at(2026, 1, 2, 8, 5))
    expect(nextRunAt(s, at(2026, 1, 1, 7, 0))).toBe(at(2026, 1, 1, 8, 5))
    expect(nextRunAt(s, at(2026, 1, 2, 8, 5))).toBe(at(2026, 1, 3, 8, 5))
  })

  test("每周：锚定创建日的星期（周四），下一次是 7 天后", async () => {
    const { nextRunAt } = await fresh()
    const s = spec({ repeat: "weekly" })
    expect(nextRunAt(s, at(2026, 1, 1, 10, 0))).toBe(at(2026, 1, 8, 8, 5))
    expect(new Date(nextRunAt(s, at(2026, 1, 1, 10, 0))!).getDay()).toBe(new Date(s.createdAt).getDay())
  })

  test("每双周：锚定创建周，下一次是 14 天后", async () => {
    const { nextRunAt } = await fresh()
    const s = spec({ repeat: "biweekly" })
    expect(nextRunAt(s, at(2026, 1, 1, 10, 0))).toBe(at(2026, 1, 15, 8, 5))
    expect(nextRunAt(s, at(2026, 1, 15, 9, 0))).toBe(at(2026, 1, 29, 8, 5))
  })

  test("每月：锚定创建日的「日」，下一次是下月同一天", async () => {
    const { nextRunAt } = await fresh()
    const s = spec({ repeat: "monthly" })
    expect(nextRunAt(s, at(2026, 1, 1, 10, 0))).toBe(at(2026, 2, 1, 8, 5))
    // 31 号创建的任务跳过没有 31 号的 2 月，落到 3 月 31 号。
    const s31 = spec({ repeat: "monthly", createdAt: at(2026, 1, 31, 10, 0) })
    expect(nextRunAt(s31, at(2026, 1, 31, 10, 0))).toBe(at(2026, 3, 31, 8, 5))
  })

  test("每年：下一次是明年同月同日", async () => {
    const { nextRunAt } = await fresh()
    const s = spec({ repeat: "yearly" })
    expect(nextRunAt(s, at(2026, 1, 1, 10, 0))).toBe(at(2027, 1, 1, 8, 5))
  })

  test("单次：只有一次，创建当天时刻已过则顺延次日；过时不补跑", async () => {
    const { nextRunAt } = await fresh()
    const s = spec({ repeat: "once" })
    expect(nextRunAt(s, at(2026, 1, 1, 10, 0))).toBe(at(2026, 1, 2, 8, 5))
    expect(nextRunAt(s, at(2026, 1, 3, 0, 0))).toBeNull()
    // 创建当天时刻尚未到：就排在当天。
    const early = spec({ repeat: "once", createdAt: at(2026, 1, 1, 7, 0) })
    expect(nextRunAt(early, at(2026, 1, 1, 7, 0))).toBe(at(2026, 1, 1, 8, 5))
  })

  test("间隔：从创建时间起每隔 N 分钟，与 time 无关", async () => {
    const { nextRunAt } = await fresh()
    const s = spec({ repeat: "interval", intervalMinutes: 90 })
    expect(nextRunAt(s, at(2026, 1, 1, 10, 0))).toBe(at(2026, 1, 1, 11, 30))
    // from 落在第 1、2 个间隔之间 → 跳到第 2 个间隔（O(1)，不逐次循环）。
    // 出现时刻为 11:30 / 13:00 / 14:30 …，12:10 之后的第一个是 13:00。
    expect(nextRunAt(s, at(2026, 1, 1, 12, 10))).toBe(at(2026, 1, 1, 13, 0))
  })

  test("intervalMinutes 非法值（0 / 负数 / NaN）退化为至少 1 分钟", async () => {
    const { nextRunAt } = await fresh()
    const s = spec({ repeat: "interval", intervalMinutes: 0 })
    expect(nextRunAt(s, s.createdAt)).toBe(s.createdAt + 60_000)
  })
})

// ── 有效期 ──────────────────────────────────────────────────────────────────

describe("nextRunAt 有效期", () => {
  test("长期有效：正常给出下一次", async () => {
    const { nextRunAt } = await fresh()
    expect(nextRunAt(spec({ validUntil: null }), at(2026, 1, 1, 10, 0))).toBe(at(2026, 1, 2, 8, 5))
  })

  test("有效期到今天：当天剩余时段内没有命中 → null", async () => {
    const { nextRunAt } = await fresh()
    // 每天 08:05，今天 10:00 时下一次是明天 08:05，已超出「今天」的有效期。
    expect(nextRunAt(spec({ validUntil: "2026-01-01" }), at(2026, 1, 1, 10, 0))).toBeNull()
  })

  test("有效期覆盖到未来某天：命中日照常给出", async () => {
    const { nextRunAt } = await fresh()
    expect(nextRunAt(spec({ validUntil: "2026-01-10" }), at(2026, 1, 1, 10, 0))).toBe(at(2026, 1, 2, 8, 5))
    // from 已越过有效期结束日 → 直接 null（早退分支）。
    expect(nextRunAt(spec({ validUntil: "2026-01-01" }), at(2026, 1, 5, 10, 0))).toBeNull()
  })

  test("有效期当天内、命中时刻仍在当天：可用", async () => {
    const { nextRunAt } = await fresh()
    // 每天 23:40，今天 10:00 → 今天 23:40 仍在「今天」有效期内。
    expect(nextRunAt(spec({ time: "23:40", validUntil: "2026-01-01" }), at(2026, 1, 1, 10, 0))).toBe(
      at(2026, 1, 1, 23, 40)
    )
  })
})

// ── CRUD / 启停 / 排期推进 ───────────────────────────────────────────────────

describe("任务 CRUD 与启停", () => {
  test("createTask 落库并算出 nextRunAt；updateTask / removeTask", async () => {
    const store = await fresh()
    const created = store.createTask(draft())
    expect(created.id).toBeTruthy()
    expect(created.nextRunAt).toBeGreaterThan(created.createdAt)
    expect(store.listTasks()).toHaveLength(1)
    expect(store.getTask(created.id)?.name).toBe("每日群消息汇总")

    store.updateTask(created.id, { name: "改名", time: "09:30" })
    const updated = store.getTask(created.id)!
    expect(updated.name).toBe("改名")
    expect(updated.time).toBe("09:30")
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)

    store.removeTask(created.id)
    expect(store.listTasks()).toHaveLength(0)
  })

  test("Lark delivery is opt-in: a task saved without it never carries targets", async () => {
    const store = await fresh()
    const created = store.createTask(draft())
    expect(created.larkNotify).toBe(false)
    expect(created.larkTargets).toEqual([])

    // A task written by an older build has no `larkNotify` at all; it must not inherit delivery
    // from the mere existence of the feature.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tasks: [
          {
            id: "legacy",
            name: "老任务",
            prompt: "hi",
            cwd: "",
            fullAccess: true,
            model: "",
            repeat: "daily",
            intervalMinutes: 60,
            time: "08:05",
            validUntil: null,
            enabled: true,
            nextRunAt: null,
            createdAt: at(2026, 1, 1, 0, 0),
            updatedAt: at(2026, 1, 1, 0, 0)
          }
        ],
        runs: []
      })
    )
    const restored = await reloaded()
    expect(restored.getTask("legacy")).toMatchObject({ larkNotify: false, larkTargets: [] })
  })

  test("setTaskEnabled 暂停 / 启用；重新启用会重算下次执行、不补跑暂停期间", async () => {
    const store = await fresh()
    vi.useFakeTimers()
    vi.setSystemTime(at(2026, 1, 1, 10, 0))
    const task = store.createTask(draft())
    const first = task.nextRunAt!
    expect(first).toBe(at(2026, 1, 2, 8, 5))

    store.setTaskEnabled(task.id, false)
    expect(store.getTask(task.id)?.enabled).toBe(false)
    // 暂停 3 天后重新启用：从「现在」重算，不会立刻补跑错过的 3 次。
    vi.setSystemTime(at(2026, 1, 4, 12, 0))
    store.setTaskEnabled(task.id, true)
    const resumed = store.getTask(task.id)!
    expect(resumed.enabled).toBe(true)
    expect(resumed.nextRunAt).toBeGreaterThan(Date.now())
    expect(resumed.nextRunAt).toBe(at(2026, 1, 5, 8, 5))
  })

  test("markTaskFired：单次任务触发后自动停用并清空排期；每天任务推进到下一次", async () => {
    const store = await fresh()
    vi.useFakeTimers()
    vi.setSystemTime(at(2026, 1, 1, 10, 0))
    const once = store.createTask(draft({ repeat: "once" }))
    const daily = store.createTask(draft())
    const dailyNext = daily.nextRunAt!

    store.markTaskFired(once.id, at(2026, 1, 2, 8, 6))
    expect(store.getTask(once.id)?.enabled).toBe(false)
    expect(store.getTask(once.id)?.nextRunAt).toBeNull()

    store.markTaskFired(daily.id, at(2026, 1, 2, 8, 6))
    expect(store.getTask(daily.id)?.nextRunAt).toBe(at(2026, 1, 3, 8, 5))
    expect(store.getTask(daily.id)?.nextRunAt).toBeGreaterThan(dailyNext)
  })

  test("dueTasks 只返回已启用且已到点的任务", async () => {
    const store = await fresh()
    vi.useFakeTimers()
    vi.setSystemTime(at(2026, 1, 1, 10, 0))
    const task = store.createTask(draft())
    expect(store.dueTasks()).toHaveLength(0)
    store.setTaskEnabled(task.id, false)
    vi.setSystemTime(at(2026, 1, 3, 9, 0))
    expect(store.dueTasks()).toHaveLength(0) // 暂停的不算
    store.setTaskEnabled(task.id, true)
    // 刚启用会重算到未来，手动把排期推进到「已到点」再验证筛选。
    store.markTaskFired(task.id, at(2026, 1, 4, 9, 0))
    expect(store.dueTasks(at(2026, 1, 5, 9, 0))).toHaveLength(1)
  })

  test("createTask：有效期已过 → nextRunAt 为 null", async () => {
    const store = await fresh()
    vi.useFakeTimers()
    vi.setSystemTime(at(2026, 6, 1, 10, 0))
    const task = store.createTask(draft({ validUntil: "2026-01-01" }))
    expect(task.nextRunAt).toBeNull()
    expect(task.validUntil).toBe("2026-01-01")
  })
})

// ── 运行记录 ────────────────────────────────────────────────────────────────

describe("运行记录", () => {
  const request: AutomationRunRequest = {
    runId: "run-1",
    taskId: "task-1",
    taskName: "每日群消息汇总",
    prompt: "读取飞书群消息",
    cwd: "",
    fullAccess: true,
    model: "",
    effort: "",
    fastMode: false,
    larkNotify: false,
    larkTargets: [],
    larkIdentity: "bot",
  }
  const result: AutomationRunResult = {
    runId: "run-1",
    taskId: "task-1",
    status: "success",
    summary: "end_turn",
    sessionId: "session-9",
    error: null,
    finishedAt: at(2026, 1, 2, 8, 10)
  }

  test("start → finish 把 running 落定为 success，并保留会话 id", async () => {
    const store = await fresh()
    const record = store.startAutomationRun(request)
    expect(record.status).toBe("running")
    expect(store.listRuns()).toHaveLength(1)
    store.finishAutomationRun(result)
    const runs = store.listRuns()
    expect(runs[0].status).toBe("success")
    expect(runs[0].sessionId).toBe("session-9")
    expect(runs[0].finishedAt).toBe(result.finishedAt)
  })

  test("finish 对未知 runId 兜底插入，不丢记录", async () => {
    const store = await fresh()
    store.finishAutomationRun(result)
    expect(store.listRuns()).toHaveLength(1)
    expect(store.listRuns()[0].id).toBe("run-1")
  })

  test("removeTask 同时清掉该任务的运行记录；clearRuns 清空全部", async () => {
    const store = await fresh()
    const task = store.createTask(draft())
    store.startAutomationRun({ ...request, taskId: task.id })
    store.startAutomationRun({ ...request, runId: "run-2", taskId: "other" })
    expect(store.listRuns()).toHaveLength(2)
    store.removeTask(task.id)
    expect(store.listRuns().map((r) => r.id)).toEqual(["run-2"])
    store.clearRuns()
    expect(store.listRuns()).toHaveLength(0)
  })
})

// ── 持久化往返 & 订阅 ───────────────────────────────────────────────────────

describe("localStorage 持久化往返", () => {
  test("写入后能从 localStorage 读出，并由全新模块实例还原", async () => {
    const a = await fresh()
    const task = a.createTask(draft({ name: "往返任务", model: "gateway:qwen:qwen-flash" }))
    a.startAutomationRun({
      runId: "run-rt",
      taskId: task.id,
      taskName: task.name,
      prompt: task.prompt,
      cwd: task.cwd,
      fullAccess: task.fullAccess,
      model: task.model,
      effort: "",
      fastMode: false,
      larkNotify: false,
      larkTargets: [],
      larkIdentity: "bot",
    })
    a.finishAutomationRun({
      runId: "run-rt",
      taskId: task.id,
      status: "failed",
      summary: "",
      sessionId: null,
      error: "offline",
      finishedAt: at(2026, 1, 2, 9, 0)
    })

    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { tasks: unknown[]; runs: unknown[] }
    expect(parsed.tasks).toHaveLength(1)
    expect(parsed.runs).toHaveLength(1)

    const b = await reloaded()
    const state = b.getAutomationSnapshot()
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0].name).toBe("往返任务")
    expect(state.tasks[0].enabled).toBe(true)
    expect(state.tasks[0].model).toBe("gateway:qwen:qwen-flash")
    expect(state.tasks[0].nextRunAt).toBe(task.nextRunAt)
    expect(state.runs[0].status).toBe("failed")
    expect(state.runs[0].error).toBe("offline")
  })

  test("坏数据不抛错、退回空状态；reloadFromStorage 重新读取外部写入", async () => {
    const store = await fresh()
    localStorage.setItem(STORAGE_KEY, "{not json")
    expect(() => store.reloadFromStorage()).not.toThrow()
    expect(store.getAutomationSnapshot().tasks).toHaveLength(0)

    const valid = {
      tasks: [
        {
          id: "x",
          name: "外部写入",
          prompt: "p",
          cwd: "",
          fullAccess: false,
          repeat: "weekly",
          intervalMinutes: 60,
          time: "07:00",
          validUntil: null,
          // Old snapshots may still carry the removed WeCom placeholder; unknown keys are ignored.
          pushToWeCom: true,
          enabled: true,
          nextRunAt: 123,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      runs: []
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(valid))
    store.reloadFromStorage()
    expect(store.getAutomationSnapshot().tasks[0].name).toBe("外部写入")
    expect("pushToWeCom" in store.getAutomationSnapshot().tasks[0]).toBe(false)
  })

  test("subscribe 在每次变更时收到通知，取消后不再收到", async () => {
    const store = await fresh()
    const listener = vi.fn()
    const unsubscribe = store.subscribeAutomation(listener)
    store.createTask(draft())
    expect(listener).toHaveBeenCalledTimes(1)
    const snapshotA = store.getAutomationSnapshot()
    expect(store.getAutomationSnapshot()).toBe(snapshotA) // 身份稳定
    unsubscribe()
    store.createTask(draft())
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

test("DAY_MS 常量与本地计算自洽（防止 DST 断言写死）", () => {
  expect(DAY_MS).toBe(24 * 60 * 60 * 1000)
})

// ── 运行中标记 & 记录裁剪 ──────────────────────────────────────────────────────

describe("运行记录裁剪与运行中标记", () => {
  function req(overrides: Partial<AutomationRunRequest> = {}): AutomationRunRequest {
    return {
      runId: "run-1",
      taskId: "task-1",
      taskName: "每日群消息汇总",
      prompt: "读取飞书群消息并生成日报",
      cwd: "",
      fullAccess: false,
      model: "",
      effort: "",
      fastMode: false,
      larkNotify: false,
      larkTargets: [],
      larkIdentity: "bot",
      ...overrides
    }
  }

  test("patchRunRecord 只改指定字段，不动排序与其它字段", async () => {
    const store = await fresh()
    const run = store.startAutomationRun(req())
    expect(run.needsAuth).toBeUndefined()
    store.patchRunRecord(run.id, { needsAuth: true })
    const after = store.listRuns()[0]
    expect(after.needsAuth).toBe(true)
    expect(after.status).toBe("running")
    expect(after.taskName).toBe("每日群消息汇总")
    // 对不存在的 id 是空操作，不新增也不报错
    store.patchRunRecord("nope", { needsAuth: true })
    expect(store.listRuns()).toHaveLength(1)
  })

  test("运行记录超过上限后只保留最近 200 条，最旧的被丢弃", async () => {
    const store = await fresh()
    const total = 205
    for (let i = 0; i < total; i++) {
      store.startAutomationRun(req({ runId: `run-${i}`, taskId: `task-${i}` }))
    }
    const runs = store.listRuns()
    expect(runs).toHaveLength(200)
    // 列表头部是最新写入的
    expect(runs[0].id).toBe(`run-${total - 1}`)
    // 最早写入的 run-0 已被裁剪
    expect(runs.some((r) => r.id === "run-0")).toBe(false)
  })
})
