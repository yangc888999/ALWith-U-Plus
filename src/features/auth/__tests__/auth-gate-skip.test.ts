import { beforeEach, expect, test } from "vitest"

import { readSkipped, rememberSkipped } from "../auth-gate"

// The account service only answers inside the company network, so "continue without signing in"
// is the reader's way past a wall they cannot climb from home. If this flag ever stops persisting,
// every launch asks again and the escape hatch is worthless.

beforeEach(() => localStorage.clear())

test("a fresh install asks for a sign-in", () => {
  expect(readSkipped()).toBe(false)
})

test("the choice survives a relaunch", () => {
  rememberSkipped()
  expect(readSkipped()).toBe(true)
  // A stored "0" or any other value must not count as consent.
  localStorage.setItem("alwith:platform-login-skipped", "0")
  expect(readSkipped()).toBe(false)
})

test("storage that refuses to write keeps the session usable instead of throwing", () => {
  const original = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")
  Object.defineProperty(Storage.prototype, "setItem", {
    configurable: true,
    value: () => {
      throw new Error("QuotaExceededError")
    }
  })
  try {
    expect(() => rememberSkipped()).not.toThrow()
  } finally {
    if (original) Object.defineProperty(Storage.prototype, "setItem", original)
  }
})
