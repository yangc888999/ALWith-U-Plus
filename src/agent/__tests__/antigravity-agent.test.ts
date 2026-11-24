import { applyUpdate, createSession, type Session } from "@alwith/api"
import { expect, test } from "vitest"

import { textUpdate, toolUpdate } from "../antigravity-agent"

function session(): Session {
  return createSession("s1", "/tmp/project")
}

test("streamed text chunks with one messageId form a single assistant bubble", () => {
  const first = applyUpdate(session(), textUpdate("Hello ", "m1") as never)
  const second = applyUpdate(first, textUpdate("world", "m1") as never)
  const assistants = second.items.filter((item) => item.kind === "assistant")
  expect(assistants).toHaveLength(1)
  expect(JSON.stringify(assistants[0])).toContain("Hello world")
})

test("tool calls become tool items with the agent's real status", () => {
  const event = { toolCall: { toolCallId: "t1", kind: "edit", name: "write_file", title: "Edit file" } }
  // A tool announced without a status stays pending; the agent reports progress separately.
  const started = applyUpdate(session(), toolUpdate(event, "pending") as never)
  const tools = started.items.filter((item) => item.kind === "tool")
  expect(tools).toHaveLength(1)
  // The real tool name must reach the card, not the generic "Tool" fallback.
  expect(tools[0]?.kind === "tool" && tools[0].name).toBe("write_file")
  expect(tools[0]?.kind === "tool" && tools[0].status).toBe("pending")
})

test("tool progress comes from the agent, not from the event name", () => {
  // Regression: every `tool_call_update` used to be reported as "completed", so a card looked
  // finished on its first progress tick and genuine failures were hidden.
  const base = applyUpdate(
    session(),
    toolUpdate({ toolCall: { toolCallId: "t1", name: "run", title: "Run", status: "pending" } }, "pending") as never
  )
  const running = applyUpdate(
    base,
    toolUpdate({ toolCall: { toolCallId: "t1", status: "in_progress" } }, "in_progress") as never
  )
  expect(running.items.find((item) => item.kind === "tool")?.kind === "tool").toBe(true)
  const runningItem = running.items.find((item) => item.kind === "tool")
  expect(runningItem?.kind === "tool" && runningItem.status).toBe("in_progress")

  const failed = applyUpdate(
    running,
    toolUpdate({ toolCall: { toolCallId: "t1", status: "failed" } }, "in_progress") as never
  )
  const failedItem = failed.items.find((item) => item.kind === "tool")
  expect(failedItem?.kind === "tool" && failedItem.status).toBe("failed")
})