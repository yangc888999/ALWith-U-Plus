import { RuntimeRequestError } from "@alwith/api"
import { error as logError } from "@tauri-apps/plugin-log"
import { toast } from "sonner"
import { beforeEach, expect, test, vi } from "vitest"

import { errorDetails, logBackgroundError, reportBackgroundError } from "../background-errors"
import { armStartupWindow, markStartupReady, resetStartupWindow } from "../startup-window"

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))
beforeEach(() => vi.clearAllMocks())

test("background logging preserves the cause without showing a notice", () => {
  logBackgroundError("pet-sync/resource/pet-id", new Error("Download failed", { cause: new Error("TLS failure") }))
  expect(logError).toHaveBeenCalledWith(expect.stringContaining("pet-sync/resource/pet-id"))
  expect(logError).toHaveBeenCalledWith(expect.stringContaining("TLS failure"))
  expect(toast.error).not.toHaveBeenCalled()
})

test("concurrent operation failures share a notice id while each cause is logged", () => {
  reportBackgroundError("drive-startup", new Error("offline"))
  reportBackgroundError("drive-startup", new Error("timeout"))
  expect(toast.error).toHaveBeenNthCalledWith(1, "offline", expect.objectContaining({ id: "drive-startup" }))
  expect(toast.error).toHaveBeenNthCalledWith(2, "timeout", expect.objectContaining({ id: "drive-startup" }))
  expect(logError).toHaveBeenCalledTimes(2)
})

test("plain native errors and circular causes can be logged", () => {
  expect(errorDetails({ kind: "network", message: "reset" })).toContain("reset")
  const error = new Error("outer")
  error.cause = error
  expect(errorDetails(error)).toContain("[circular error cause]")
})

test("Runtime errors retain ACP code and data alongside the stack", () => {
  const error = new RuntimeRequestError("acpRequest", {
    code: -32600,
    message: "Invalid request",
    data: "ACP v2 initialize may only be requested once per connection"
  })
  const details = errorDetails(error)
  expect(details).toContain("-32600")
  expect(details).toContain("initialize may only be requested once")
  expect(details).toContain("acpRequest")
})

test("a startup failure is logged but never toasted while the silent window is open", () => {
  // This module calls `sonner` directly, so it used to be the one exit that ignored the startup
  // gate: `connect()` sets `connection = "ready"` before providers are applied, and a failure in
  // between painted the raw `acpRequest: …` line in the corner for a second (2026-11-08).
  resetStartupWindow()
  armStartupWindow()
  try {
    reportBackgroundError(
      "provider-startup",
      new Error("acpRequest: Codex process has exited with code 1: Error: Model provider 'alwith' not found")
    )
    expect(toast.error).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledTimes(1)
  } finally {
    resetStartupWindow()
  }
})

test("the same failure is toasted once the engine is ready", () => {
  resetStartupWindow()
  armStartupWindow()
  markStartupReady()
  try {
    reportBackgroundError("provider-startup", new Error("engine is gone"))
    expect(toast.error).toHaveBeenCalledWith("engine is gone", expect.objectContaining({ id: "provider-startup" }))
  } finally {
    resetStartupWindow()
  }
})
