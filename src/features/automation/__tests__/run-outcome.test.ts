import { applyUpdate, createSession, type Session } from "@alwith/api"
import { expect, test } from "vitest"

import { completedRun } from "../run-outcome"

const refusal = "The 'deepseek-flash' model is not supported when using Codex with a ChatGPT account."

function message(session: Session, user: boolean, id: string, text: string, codex?: Record<string, unknown>) {
  const fields = { messageId: id, content: [{ type: "text" as const, text }], ...(codex ? { _meta: { codex } } : {}) }
  return applyUpdate(
    session,
    user ? { sessionUpdate: "user_message", ...fields } : { sessionUpdate: "agent_message", ...fields }
  )
}

function monitor(): Session {
  let session = message(createSession("monitor", "/tmp"), true, "previous", "Yesterday")
  session = message(session, false, "old-error", refusal, { error: { message: refusal } })
  return { ...message(session, true, "today", "Today"), lastStopReason: "end_turn", turnEndedAt: { today: 42 } }
}

test.each(["modelNotFound", "model_not_found"])("uses %s even when the displayed error text is localized", (code) => {
  const partial = message(monitor(), false, "partial", "Checking today's numbers")
  const session = message(partial, false, "codex-error:abc", "模型不可用", {
    error: { message: "unavailable", codexErrorInfo: code }
  })
  expect(completedRun(session, "today")).toEqual({
    status: "failed",
    failureKind: "model",
    summary: "",
    error: "unavailable"
  })
})

test("recognizes the original account refusal with or without adapter metadata", () => {
  for (const meta of [undefined, { error: { message: refusal, codexErrorInfo: "badRequest" } }]) {
    expect(completedRun(message(monitor(), false, "error", refusal, meta), "today")).toEqual({
      status: "failed",
      failureKind: "model",
      summary: "",
      error: refusal
    })
  }
})

test("a valid report can quote a model refusal and never inherits yesterday's error", () => {
  const report = `Error analysis:\n${refusal}`
  const session = message(monitor(), false, "answer", report)
  expect(completedRun(session, "today")).toEqual({ status: "success", summary: report, error: null })
})

test("partial output with a terminal stream error is a failure, not a report", () => {
  const partial = message(monitor(), false, "partial", "Early numbers")
  const error = "upstream stream read failed"
  const expected = { status: "failed", summary: "", error }
  expect(completedRun(message(partial, false, "broken", error, { error: { message: error } }), "today")).toEqual(
    expected
  )
  expect(
    completedRun(
      { ...partial, error: { error: { code: -32603, message: error }, stopReason: "error", meta: null } },
      "today"
    )
  ).toEqual(expected)
  expect(completedRun({ ...partial, lastStopReason: "cancelled" }, "today")).toMatchObject({
    status: "failed",
    summary: ""
  })
})

test("an unsettled, missing or ambiguous receipt cannot publish a different turn's answer", () => {
  const session = message(monitor(), false, "reply", "content")
  expect(completedRun({ ...session, turnEndedAt: {} }, "today").status).toBe("failed")
  expect(completedRun({ ...session, turnEndedAt: { missing: 45 } }, "missing").status).toBe("failed")
  expect(completedRun(message(session, true, "other", "manual chat"), "today").status).toBe("failed")
})

test("notices and progress without a report do not become the report", () => {
  let session = message(monitor(), false, "progress", "Working", { phase: "commentary" })
  session = message(session, false, "retry", "Retrying", { retry: { message: "Retrying" } })
  session = message(session, false, "notice", "Warning", { notice: true })
  expect(completedRun(session, "today")).toEqual({ status: "no_content", summary: "", error: null })
})
