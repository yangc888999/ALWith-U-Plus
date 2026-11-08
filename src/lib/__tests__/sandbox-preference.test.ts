import { afterEach, expect, test } from "vitest"

import {
  DEFAULT_SANDBOX,
  sandboxCapability,
  sandboxGrants,
  sandboxMode,
  sandboxSettings,
  setSandboxSettings
} from "../sandbox-preference"

afterEach(() => setSandboxSettings(DEFAULT_SANDBOX))

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
