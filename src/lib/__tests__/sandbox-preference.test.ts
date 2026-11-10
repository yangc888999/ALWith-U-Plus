import { afterEach, expect, test } from "vitest"

import {
  DEFAULT_SANDBOX,
  sandboxAllows,
  sandboxCapabilities,
  sandboxCapability,
  sandboxGrants,
  sandboxMode,
  sandboxSettings,
  setSandboxSettings,
  subscribeSandbox
} from "../sandbox-preference"

afterEach(() => setSandboxSettings(DEFAULT_SANDBOX))

/** The settings window is a separate webview: a write reaches this window only as a storage event. */
function applyElsewhere(value: string | null) {
  if (value === null) localStorage.removeItem("alwith:sandbox")
  else localStorage.setItem("alwith:sandbox", value)
  window.dispatchEvent(new StorageEvent("storage", { key: "alwith:sandbox", newValue: value }))
}

test("the sandbox is off by default, so conversations start with full access", () => {
  expect(sandboxSettings().enabled).toBe(false)
  expect(sandboxMode()).toBe("agent-full-access")
})

test("the sandbox preset follows the file-write permission", () => {
  setSandboxSettings({ enabled: true, projectWrite: true })
  expect(sandboxMode()).toBe("workspace-write")
  setSandboxSettings({ projectWrite: false })
  expect(sandboxMode()).toBe("read-only")
})

test("additional sandbox permissions map to the capability they ask for", () => {
  const network = {
    sessionId: "s1",
    params: {
      subject: { type: "tool_call", toolCall: { input: { permissions: { network: { enabled: true } } } } }
    }
  }
  expect(sandboxCapability(network, "/work")).toBe("network")
  const outside = {
    sessionId: "s1",
    params: {
      subject: {
        type: "tool_call",
        toolCall: { input: { permissions: { fileSystem: { write: ["/elsewhere/file.md"] } } } }
      }
    }
  }
  expect(sandboxCapability(outside, "/work")).toBe("outsideWrite")
  const inside = {
    sessionId: "s1",
    params: {
      subject: { type: "tool_call", toolCall: { input: { permissions: { fileSystem: { write: ["/work/a.md"] } } } } }
    }
  }
  expect(sandboxCapability(inside, "/work")).toBe("projectWrite")
})

test("commands and installs are told apart, and only switched-on capabilities pre-approve", () => {
  const install = { sessionId: "s1", params: { subject: { type: "command", command: "brew install jq" } } }
  const command = { sessionId: "s1", params: { subject: { type: "command", command: "ls -la" } } }
  expect(sandboxCapability(install, "/work")).toBe("install")
  expect(sandboxCapability(command, "/work")).toBe("commands")
  expect(sandboxGrants({ ...DEFAULT_SANDBOX, enabled: true, install: false }, "install")).toBe(false)
  expect(sandboxGrants({ ...DEFAULT_SANDBOX, enabled: true, install: true }, "install")).toBe(true)
  // A sandbox that is off never pre-approves: the agent does not ask in the first place.
  expect(sandboxGrants({ ...DEFAULT_SANDBOX, enabled: false, install: true }, "install")).toBe(false)
})

test("a composite network + file-write request is not pre-approved when outside writes are off", () => {
  const permissions = { network: { enabled: true }, fileSystem: { write: ["/outside/report.md"] } }
  const capabilities = sandboxCapabilities(permissions, "/work")
  expect(capabilities).toEqual(["network", "outsideWrite"])
  // The legacy single-capability classifier still reports network first (its behaviour is kept),
  // and network alone is granted — this is exactly the silent approval the composite check fixes.
  const legacy = {
    sessionId: "s1",
    params: { subject: { type: "tool_call", toolCall: { input: { permissions } } } }
  }
  expect(sandboxCapability(legacy, "/work")).toBe("network")
  const settings = { ...DEFAULT_SANDBOX, enabled: true, network: true, outsideWrite: false }
  expect(sandboxGrants(settings, "network")).toBe(true)
  expect(sandboxAllows(capabilities, settings)).toBe(false)
})

test("a composite request is pre-approved only when every capability is granted", () => {
  const capabilities = sandboxCapabilities(
    { network: { enabled: true }, fileSystem: { write: ["/work/a.md"] } },
    "/work"
  )
  expect(capabilities).toEqual(["network", "projectWrite"])
  expect(
    sandboxAllows(capabilities, { ...DEFAULT_SANDBOX, enabled: true, network: true, projectWrite: true })
  ).toBe(true)
})

test("read and entries paths are judged, and glob/special entries block pre-approval", () => {
  expect(sandboxCapabilities({ fileSystem: { read: ["/elsewhere/a.md"] } }, "/work")).toEqual(["outsideWrite"])
  expect(
    sandboxCapabilities({ fileSystem: { entries: [{ path: { type: "path", path: "/work/a.md" } }] } }, "/work")
  ).toEqual(["projectWrite"])
  // A glob cannot be bounded to the workspace, so the whole request stays unapproved.
  expect(
    sandboxCapabilities(
      { network: { enabled: true }, fileSystem: { entries: [{ path: { type: "glob_pattern", pattern: "**/*.ts" } }] } },
      "/work"
    )
  ).toEqual([])
  expect(sandboxAllows([], { ...DEFAULT_SANDBOX, enabled: true })).toBe(false)
})

test("the /workspace-other sibling is outside the /workspace boundary", () => {
  expect(sandboxCapabilities({ fileSystem: { write: ["/workspace-other/file.md"] } }, "/workspace")).toEqual([
    "outsideWrite"
  ])
  expect(sandboxCapabilities({ fileSystem: { write: ["/workspace/file.md"] } }, "/workspace")).toEqual([
    "projectWrite"
  ])
  // The legacy classifier had the same startsWith bug and must be fixed too.
  const request = {
    sessionId: "s1",
    params: {
      subject: {
        type: "tool_call",
        toolCall: { input: { permissions: { fileSystem: { write: ["/workspace-other/file.md"] } } } }
      }
    }
  }
  expect(sandboxCapability(request, "/workspace")).toBe("outsideWrite")
})

test("trailing slashes, Windows separators and . / .. segments are normalized", () => {
  expect(sandboxCapabilities({ fileSystem: { write: ["C:\\work\\a.md"] } }, "C:\\work")).toEqual(["projectWrite"])
  expect(sandboxCapabilities({ fileSystem: { write: ["C:\\work-other\\a.md"] } }, "C:\\work")).toEqual([
    "outsideWrite"
  ])
  expect(sandboxCapabilities({ fileSystem: { write: ["/work/./a.md"] } }, "/work/")).toEqual(["projectWrite"])
  expect(sandboxCapabilities({ fileSystem: { write: ["/work/../elsewhere/a.md"] } }, "/work")).toEqual([
    "outsideWrite"
  ])
})

test("an Apply in the settings window reaches a running chat without a reload", () => {
  const seen: string[] = []
  const unsubscribe = subscribeSandbox(() => seen.push(sandboxMode()))
  applyElsewhere(JSON.stringify({ enabled: true, projectWrite: false }))
  expect(sandboxMode()).toBe("read-only")
  expect(seen).toEqual(["read-only"])
  unsubscribe()
})

test("an unrelated key does not republish sandbox settings", () => {
  let calls = 0
  const unsubscribe = subscribeSandbox(() => calls++)
  window.dispatchEvent(new StorageEvent("storage", { key: "chat.something-else", newValue: "1" }))
  expect(calls).toBe(0)
  expect(sandboxMode()).toBe("agent-full-access")
  unsubscribe()
})

test("clearing the stored value falls back to the default", () => {
  setSandboxSettings({ enabled: true, projectWrite: false })
  expect(sandboxMode()).toBe("read-only")
  applyElsewhere(null)
  expect(sandboxMode()).toBe("agent-full-access")
})

test("a storage event with the current value does not jitter listeners", () => {
  let calls = 0
  const unsubscribe = subscribeSandbox(() => calls++)
  applyElsewhere(JSON.stringify(sandboxSettings()))
  expect(calls).toBe(0)
  unsubscribe()
})

test("a storage event with a null key re-reads too", () => {
  localStorage.setItem("alwith:sandbox", JSON.stringify({ enabled: true }))
  window.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null }))
  expect(sandboxMode()).toBe("workspace-write")
})
