import { applyUpdate, createSession } from "@alwith/api"
import { renderHook } from "@testing-library/react"
import { expect, test } from "vitest"

import { useComposerSession } from "../composer-session"

test("streamed transcript items do not replace the composer's session projection", () => {
  const base = createSession("session", "/tmp/project")
  const { result, rerender } = renderHook(({ session }) => useComposerSession(session), {
    initialProps: { session: base }
  })
  const first = result.current

  const streamed = applyUpdate(base, {
    sessionUpdate: "agent_message_chunk",
    messageId: "answer",
    content: { type: "text", text: "streaming" }
  })
  rerender({ session: streamed })
  expect(result.current).toBe(first)
  expect(result.current.items).toHaveLength(0)

  rerender({ session: { ...streamed, state: "running" } })
  expect(result.current).not.toBe(first)
  expect(result.current.state).toBe("running")
})
