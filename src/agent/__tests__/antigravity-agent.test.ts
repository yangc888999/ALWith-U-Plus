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

test("tool calls become tool items with in_progress then completed status", () => {
  const event = { toolCall: { toolCallId: "t1", kind: "edit", title: "Edit file" } }
  const started = applyUpdate(session(), toolUpdate(event, "in_progress") as never)
  const tools = started.items.filter((item) => item.kind === "tool")
  expect(tools).toHaveLength(1)
  expect(tools[0]?.kind === "tool" && tools[0].status).toBe("in_progress")
  const done = applyUpdate(started, toolUpdate(event, "completed") as never)
  const after = done.items.filter((item) => item.kind === "tool")
  expect(after[0]?.kind === "tool" && after[0].status).toBe("completed")
})
