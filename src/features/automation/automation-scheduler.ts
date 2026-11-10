// 定时任务的常驻调度器，只在主窗口运行。
//
// 第一版把 setInterval 放在设置窗口，结果「设置窗口没打开过就不跑」。现在调度、执行、
// 运行记录全部收归主窗口：只要 App 开着（主窗口在），到点就新建会话执行任务；设置窗口
// 退化成纯 UI，关掉、隐藏、从未打开过都不影响。任务数据来自 Rust 命名 KV，两个窗口共享。

import {
  dueTasks,
  finishAutomationRun,
  markTaskFired,
  newRunId,
  startAutomationRun,
  startAutomationSync
} from "./task-store"
import type { AutomationRunRequest, AutomationRunResult, OnRunTask } from "./types"

const TICK_MS = 30_000
const KICKOFF_MS = 5_000
// A single agent turn that never resolves would block the entire serial queue: every later task
// waits behind it. The engine's own idle watchdog is ~20 min, so 15 min is long enough that a
// legitimately heavy run is never cut short, yet short enough that a genuinely hung turn cannot
// stall the queue for the whole session. The timeout only frees the queue — the task's engine turn
// keeps running and records its true result when it eventually lands.
const SERIAL_TASK_TIMEOUT_MS = 15 * 60 * 1000

export type AutomationExecutor = (request: AutomationRunRequest) => Promise<AutomationRunResult>

/** 一次执行 = 写 running → 跑 agent → 落定 success/failed。运行记录只由主窗口写。 */
export function executeAutomationRun(run: OnRunTask, request: AutomationRunRequest): Promise<AutomationRunResult> {
  startAutomationRun(request)
  return run(request)
    .then((result) => {
      finishAutomationRun(result)
      return result
    })
    .catch((error: unknown) => {
      const failed: AutomationRunResult = {
        runId: request.runId,
        taskId: request.taskId,
        status: "failed",
        summary: "",
        sessionId: null,
        error: error instanceof Error ? error.message : String(error),
        finishedAt: Date.now()
      }
      finishAutomationRun(failed)
      return failed
    })
}

/**
 * 所有会话（包括定时任务）共用一个 Codex 引擎进程：一轮 turn 卡住会占住这个进程，idle 看门狗
 * 要 20 分钟才释放，期间其他会话的 replay 只能排队等。调度器把同一 tick 到期的任务全部并行
 * 发起，等于让它们互相抢同一个进程，还会给主窗口同时灌两条回放流。
 *
 * 串行化放在唯一的分发点：定时器和设置窗口「立即运行」两条入口共用这一个队列，而不是各加
 * 一道闸。失败的任务不能堵住后面的任务。
 */
/**
 * Caps a single task so a turn that never resolves cannot block the whole queue. On timeout it
 * resolves with a synthetic failed result so the queue can advance; the scheduler discards this
 * value (it only needs the queue to move on). The real run keeps executing and records its true
 * outcome later via `finishAutomationRun`.
 */
function withSerialTimeout(
  promise: Promise<AutomationRunResult>,
  request: AutomationRunRequest
): Promise<AutomationRunResult> {
  return new Promise<AutomationRunResult>((resolve, reject) => {
    const timer = window.setTimeout(
      () =>
        resolve({
          runId: request.runId,
          taskId: request.taskId,
          status: "failed",
          summary: "",
          sessionId: null,
          error: `定时任务运行超过 ${Math.round(SERIAL_TASK_TIMEOUT_MS / 60000)} 分钟未结束，已解除队列阻塞（引擎可能仍在执行，请到主窗口确认最终结果）`,
          finishedAt: Date.now()
        }),
      SERIAL_TASK_TIMEOUT_MS
    )
    promise.then(
      (result) => {
        window.clearTimeout(timer)
        resolve(result)
      },
      (error: unknown) => {
        window.clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** Re-checked at dequeue time: a task deleted, disabled or edited while queued must not start. */
export type RunStillValid = (request: AutomationRunRequest) => boolean

export function serialAutomationExecutor(
  run: AutomationExecutor,
  stillValid: RunStillValid = () => true
): AutomationExecutor {
  let tail: Promise<void> = Promise.resolve()
  return (request) => {
    // `run(request)` is invoked only once the previous task has settled, preserving the serial
    // guarantee; the timeout wraps the actual run so a hung turn still frees the queue. A queued
    // request can be up to 15 minutes old, so validity is checked here rather than at enqueue.
    const result = tail.then((): Promise<AutomationRunResult> => {
      if (!stillValid(request)) {
        const skipped: AutomationRunResult = {
          runId: request.runId,
          taskId: request.taskId,
          status: "failed",
          summary: "",
          sessionId: null,
          error: "任务在排队期间被删除、停用或修改，已跳过本次执行",
          finishedAt: Date.now()
        }
        return Promise.resolve(skipped)
      }
      return withSerialTimeout(run(request), request)
    })
    tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

/**
 * `canRun` 让主窗口在引擎还没连上时跳过这一轮（不消耗排期、不写 failed 记录）。
 * 返回的函数同时停掉定时器和跨窗口订阅。
 */
export function startAutomationScheduler(
  execute: AutomationExecutor,
  canRun: () => boolean = () => true
): () => void {
  const stopSync = startAutomationSync()
  let ticking = false
  const tick = (): void => {
    if (ticking || !canRun()) return
    ticking = true
    try {
      const now = Date.now()
      for (const task of dueTasks(now)) {
        // Snapshot the task before advancing the schedule: markTaskFired rewrites updatedAt,
        // and the dequeue check compares that timestamp against this tick.
        const request: AutomationRunRequest = {
          runId: newRunId(),
          taskId: task.id,
          taskName: task.name,
          prompt: task.prompt,
          cwd: task.cwd,
          fullAccess: task.fullAccess,
          model: task.model,
          effort: task.effort,
          fastMode: task.fastMode,
          larkNotify: task.larkNotify,
          larkTargets: task.larkTargets,
          larkIdentity: task.larkIdentity,
          monitorSessionId: task.monitorSessionId,
          taskFiredAt: now
        }
        // 先推进排期再执行，避免 30s 内重复触发；单次任务会在这里自动停用。
        markTaskFired(task.id, now)
        void execute(request).catch(() => undefined)
      }
    } finally {
      ticking = false
    }
  }
  // 启动后稍等一下，别和引擎冷启动抢资源；之后每 30s 检查一次。
  const kickoff = window.setTimeout(tick, KICKOFF_MS)
  const interval = window.setInterval(tick, TICK_MS)
  return () => {
    window.clearTimeout(kickoff)
    window.clearInterval(interval)
    stopSync()
  }
}
