// 运行记录默认只占一行：时间 + 状态 + 一句结果，完整输出点开才出现。
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeAll, beforeEach, expect, test } from "vitest"

import { initI18n } from "@/lib/i18n"

import { RunRecords } from "../run-records"
import { clearRuns, finishAutomationRun, startAutomationRun } from "../task-store"
import type { AutomationRunRequest } from "../types"

const request = (overrides: Partial<AutomationRunRequest> = {}): AutomationRunRequest => ({
  runId: "run-1",
  taskId: "task-1",
  taskName: "每日群消息汇总",
  prompt: "读取飞书群消息并生成日报",
  cwd: "",
  fullAccess: true,
  model: "",
  effort: "",
  fastMode: false,
  larkNotify: false,
  larkTargets: [],
  larkIdentity: "bot",
  ...overrides
})

beforeAll(async () => {
  await initI18n("en")
})

beforeEach(() => {
  clearRuns()
})

test("a finished run shows one summary line and hides the detail until it is opened", () => {
  const run = request()
  startAutomationRun(run)
  finishAutomationRun({
    runId: run.runId,
    taskId: run.taskId,
    status: "success",
    summary: "已生成日报并写入桌面",
    sessionId: "session-1",
    error: null,
    finishedAt: Date.now()
  })

  render(<RunRecords />)

  // The one-line summary is there; the long form (session id, result block) is not.
  expect(screen.getByText("已生成日报并写入桌面")).toBeTruthy()
  expect(screen.queryByText("session-1")).toBeNull()
  expect(screen.queryByText("Result")).toBeNull()

  // Click the row's own disclosure button (the run summary text lives inside it), not the
  // "clear records" trigger which is also a button with aria-expanded.
  fireEvent.click(screen.getByText("已生成日报并写入桌面").closest("button")!)

  expect(screen.getByText("session-1")).toBeTruthy()
  expect(screen.getByText("Result")).toBeTruthy()
})

test("a running task is a single status line, with no result block", () => {
  startAutomationRun(request({ runId: "run-live", taskId: "task-live", taskName: "跑到一半" }))

  render(<RunRecords />)

  expect(screen.getByText("Running — open for details")).toBeTruthy()
  expect(screen.getByText("Running")).toBeTruthy()
  expect(screen.queryByText("Result")).toBeNull()
})

test("a failure leads with its error instead of the empty summary", () => {
  const run = request({ runId: "run-fail" })
  startAutomationRun(run)
  finishAutomationRun({
    runId: run.runId,
    taskId: run.taskId,
    status: "failed",
    summary: "",
    sessionId: null,
    error: "engine gone",
    finishedAt: Date.now()
  })

  render(<RunRecords />)
  expect(screen.getByText("engine gone")).toBeTruthy()
})
