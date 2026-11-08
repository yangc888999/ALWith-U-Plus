// 定时任务跨窗口事件协议（settings-bridge 风格：emitTo / listen）。
//
// 设置窗口没有 ACP client，主窗口有。定时调度本身已经在主窗口常驻
// （automation-scheduler.ts），这条事件现在只服务设置窗口的「立即运行」按钮。
// 主窗口用 client 建会话 + 发 prompt，并统一写运行记录；回传结果只给设置窗口弹提示。
// 非 Tauri 环境（Storybook / 单测）直接 no-op，避免 listen 抛未处理的 rejection。

import { isTauri } from "@tauri-apps/api/core"
import { emitTo, listen } from "@tauri-apps/api/event"

import type { AutomationRunRequest, AutomationRunResult, OnRunTask } from "./types"

export const AUTOMATION_RUN_REQUEST = "automation:run-request"
export const AUTOMATION_RUN_RESULT = "automation:run-result"

/** 设置窗口：请求主窗口执行一次任务（定时器到期或「立即运行」）。 */
export function requestAutomationRun(request: AutomationRunRequest): void {
  if (!isTauri()) return
  void emitTo("main", AUTOMATION_RUN_REQUEST, request).catch(() => undefined)
}

/** 设置窗口：订阅主窗口回传的运行结果。返回取消订阅函数。 */
export function subscribeAutomationRunResult(listener: (result: AutomationRunResult) => void): () => void {
  if (!isTauri()) return () => {}
  let disposed = false
  const stop = listen<AutomationRunResult>(AUTOMATION_RUN_RESULT, (event) => {
    if (!disposed) listener(event.payload)
  })
  return () => {
    disposed = true
    void stop.then((fn) => fn()).catch(() => undefined)
  }
}

/**
 * 主窗口：执行链路的接入点。`run` 由 app.tsx 用现有 client 实现（类型 OnRunTask，
 * 真实存在、非空 TODO）。收到请求 → 执行 → 把结果 emit 回设置窗口。
 */
export function serveAutomationBridge(run: OnRunTask): { stop: () => void } {
  if (!isTauri()) return { stop: () => {} }
  let disposed = false
  const stop = listen<AutomationRunRequest>(AUTOMATION_RUN_REQUEST, (event) => {
    if (disposed) return
    void run(event.payload)
      .then((result) => emitTo("settings", AUTOMATION_RUN_RESULT, result))
      .catch((error: unknown) => {
        // 执行实现本身应返回 failed 结果；这里兜底任何未预期的抛错，仍给设置窗口一个答复。
        const result: AutomationRunResult = {
          runId: event.payload.runId,
          taskId: event.payload.taskId,
          status: "failed",
          summary: "",
          sessionId: null,
          error: error instanceof Error ? error.message : String(error),
          finishedAt: Date.now()
        }
        return emitTo("settings", AUTOMATION_RUN_RESULT, result)
      })
      .catch(() => undefined)
  })
  return {
    stop: () => {
      disposed = true
      void stop.then((fn) => fn()).catch(() => undefined)
    }
  }
}
