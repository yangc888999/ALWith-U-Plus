import { expect, test, vi } from "vitest"

import { deliverLarkResult } from "../lark-delivery"

const larkTargets = [
  { id: "self", name: "Me", kind: "user" },
  { id: "group", name: "Team", kind: "chat" }
]
const request = { taskName: "Daily", larkTargets, larkEmptyResultNoticeToSelf: true }

test.each(["no_content", "success"] as const)(
  "%s without a body never sends, even for legacy tasks",
  async (status) => {
    const send = vi.fn()
    const result = { status, summary: " \n", error: null }
    expect(await deliverLarkResult(request, result, "Failed", "Run failed", send)).toEqual(
      larkTargets.map(({ id, name, kind }) => ({
        targetId: id,
        targetName: name,
        kind,
        status: "skipped",
        error: "no_content"
      }))
    )
    expect(await deliverLarkResult({ ...request, larkTargets: [] }, result, "Failed", "Run failed", send)).toEqual([])
    expect(send).not.toHaveBeenCalled()
  }
)

test.each([
  { status: "success" as const, summary: " Today's report  ", error: null, suffix: "\n\nToday's report" },
  { status: "failed" as const, summary: "", error: "Timed out", suffix: " · Failed\n\nTimed out" }
])("$status still sends the report or failure to the configured recipients", async ({ suffix, ...result }) => {
  const send = vi.fn().mockResolvedValue([])
  await deliverLarkResult(request, result, "Failed", "Run failed", send)
  expect(send).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledWith(larkTargets, expect.stringContaining(suffix))
})

test("a rejected model leaves local skipped receipts without calling either recipient", async () => {
  const send = vi.fn()
  const result = { status: "failed" as const, failureKind: "model" as const, summary: "", error: "Model unavailable" }
  expect(await deliverLarkResult(request, result, "Failed", "Run failed", send)).toEqual(
    larkTargets.map(({ id, name, kind }) => ({
      targetId: id,
      targetName: name,
      kind,
      status: "skipped",
      error: "model_error"
    }))
  )
  expect(send).not.toHaveBeenCalled()
})
