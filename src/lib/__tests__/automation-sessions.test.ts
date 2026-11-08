import { expect, test } from "vitest"

import {
  automationSessionRows,
  automationTitleOf,
  isAutomationSessionId,
  rememberAutomationSessionId,
  replaceAutomationSessionRows,
  subscribeAutomationSessionRows
} from "@/lib/automation-sessions"

test("a scheduled run's markdown heading is recognised and stripped", () => {
  expect(automationTitleOf("# 提额监控表盘每日更新任务")).toBe("提额监控表盘每日更新任务")
  expect(automationTitleOf("## 周报\n第二行")).toBe("周报")
  expect(automationTitleOf("帮我看下这个")).toBeNull()
  expect(automationTitleOf("#")).toBeNull()
  expect(automationTitleOf("# \n正文")).toBeNull()
  expect(automationTitleOf(null)).toBeNull()
})

test("the run store sorts newest first and notifies its subscribers", () => {
  let notified = 0
  const stop = subscribeAutomationSessionRows(() => {
    notified += 1
  })
  replaceAutomationSessionRows([
    { sessionId: "old", cwd: "/tmp/p", title: "# 旧", updatedAt: "2026-11-01T10:00:00Z", archived: false },
    { sessionId: "new", cwd: "/tmp/p", title: "# 新", updatedAt: "2026-11-04T10:00:00Z", archived: false }
  ])
  stop()
  expect(notified).toBe(1)
  expect(automationSessionRows().map((row) => row.sessionId)).toEqual(["new", "old"])
  replaceAutomationSessionRows([])
})

test("a session the scheduler created is remembered by id, not by title", () => {
  // A task launched through newSession has an ordinary title, so the `#` heading test cannot
  // recognise it: without the recorded id its run would sit inside 项目.
  expect(automationTitleOf("读取飞书群消息并生成日报")).toBeNull()
  expect(isAutomationSessionId("session-scheduled")).toBe(false)

  rememberAutomationSessionId("session-scheduled")
  expect(isAutomationSessionId("session-scheduled")).toBe(true)

  // Persisted for the next launch: the sidebar has to divert the row before any task runs again.
  const stored = JSON.parse(localStorage.getItem("alwith.automation.session-ids.v1") ?? "[]") as string[]
  expect(stored).toContain("session-scheduled")
})
