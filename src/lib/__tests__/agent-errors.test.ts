import { expect, test } from "vitest"

import { isThreadNotLoadedError } from "../agent-errors"

test("a thread the engine does not hold is named by its own sentence", () => {
  expect(isThreadNotLoadedError(new Error("acpRequest: thread not loaded: 01a1e9e4"))).toBe(true)
  expect(isThreadNotLoadedError(new Error("acpRequest: agent codex exited"))).toBe(false)
})
