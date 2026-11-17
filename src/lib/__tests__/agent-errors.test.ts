import { expect, test } from "vitest"

import { isAgentOwnershipError, isThreadNotLoadedError } from "../agent-errors"

// The plugins page heals by reconnecting, so these two sentences decide whether a page recovers or
// sits on a red line forever. Both were reachable on 2026-11-17: the Runtime answered
// `agent is not owned by this connection` after being replaced, and `agent codex exited` once the
// engine process itself was gone.

test("a replaced Runtime and a dead engine both count as a lost agent", () => {
  expect(isAgentOwnershipError(new Error("acpRequest: agent is not owned by this connection: codex"))).toBe(true)
  expect(isAgentOwnershipError(new Error("插件加载失败: acpRequest: agent codex exited"))).toBe(true)
  // The agent name is whatever the Runtime spawned, not always `codex`.
  expect(isAgentOwnershipError("acpRequest: agent claude exited")).toBe(true)
})

test("an ordinary request failure is not a lost agent", () => {
  expect(isAgentOwnershipError(new Error("acpRequest: Internal error"))).toBe(false)
  expect(isAgentOwnershipError(new Error("thread not loaded: 01a1e9e4"))).toBe(false)
  expect(isAgentOwnershipError(null)).toBe(false)
  expect(isAgentOwnershipError({ message: "" })).toBe(false)
})

test("a thread the engine does not hold is named by its own sentence", () => {
  expect(isThreadNotLoadedError(new Error("acpRequest: thread not loaded: 01a1e9e4"))).toBe(true)
  expect(isThreadNotLoadedError(new Error("acpRequest: agent codex exited"))).toBe(false)
})
