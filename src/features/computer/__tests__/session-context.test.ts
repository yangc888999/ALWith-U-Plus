import { beforeEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"
const native = vi.hoisted(() => ({
  ready: vi.fn(),
  context: vi.fn(),
  revision: vi.fn(),
  bind: vi.fn(),
  prompt: vi.fn(),
  tauri: vi.fn(() => true)
}))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: native.tauri }))
vi.mock("@/bindings", () => ({
  commands: {
    computerReady: native.ready,
    computerContext: native.context,
    computerRevision: native.revision,
    computerBind: native.bind,
    globalPromptRead: native.prompt
  }
}))
vi.mock("@/features/drive/session-context", () => ({
  driveSessionContext: () => Promise.resolve({ mcpServers: [], appendSystemPrompt: "Workspace knowledge" })
}))
import { settingsStore } from "@/lib/settings-store"

import { computerContextRevision, hostSessionContext, prepareComputerTools } from "../session-context"
beforeEach(async () => {
  await initI18n("en")
  vi.clearAllMocks()
  native.tauri.mockReturnValue(true)
  native.context.mockResolvedValue(null)
  native.revision.mockResolvedValue("disabled")
  native.prompt.mockResolvedValue("ALWith prompt")
})
test("all new, resumed and forked conversations receive the application grant", async () => {
  native.context.mockResolvedValue({
    token: "token",
    connection: { generation: "global", command: "/driver", args: ["mcp"], env: [] }
  })
  for (const operation of [
    { kind: "new" },
    { kind: "resume", sessionId: "a" },
    { kind: "resume", sessionId: "b" },
    { kind: "fork", sourceSessionId: "a" }
  ] as const) {
    const context = await hostSessionContext("/project", operation)
    expect(context.mcpServers).toHaveLength(1)
    expect(context.revision).toBe("global")
    await context.bind?.("destination")
    expect(native.bind).toHaveBeenLastCalledWith({ token: "token", sessionId: "destination" })
    expect(context.appendSystemPrompt).toContain("Workspace knowledge")
    // New and forked sessions read ALWith.md; a resume already carries it.
    if (operation.kind === "resume") {
      expect(context.appendSystemPrompt).not.toContain("ALWith prompt")
    } else {
      expect(context.appendSystemPrompt).toContain("ALWith prompt")
    }
  }
  expect(native.context.mock.calls.every((args) => args.length === 0)).toBe(true)
})
test("the silent ALWith.md import can be disabled in settings", async () => {
  settingsStore.accept({
    revision: 1,
    values: { "memory.injectOnNewSession": false },
    browserMigrated: true
  })
  try {
    const context = await hostSessionContext("/project", { kind: "new" })
    expect(context.appendSystemPrompt).not.toContain("ALWith prompt")
    expect(native.prompt).not.toHaveBeenCalled()
  } finally {
    settingsStore.accept({
      revision: 2,
      values: { "memory.injectOnNewSession": true },
      browserMigrated: true
    })
  }
})

test("disabled native authority removes tools for every conversation", async () => {
  expect(await computerContextRevision()).toBe("disabled")
  expect((await hostSessionContext("/project", { kind: "new" })).mcpServers).toEqual([])
})
test("browser previews never invoke native commands", async () => {
  native.tauri.mockReturnValue(false)
  await hostSessionContext("/project", { kind: "new" })
  expect(await computerContextRevision()).toBe("disabled")
  expect(native.context).not.toHaveBeenCalled()
})

test("readiness uses the explicit conversation identity and fails before sending", async () => {
  native.ready.mockResolvedValue(undefined)
  await prepareComputerTools("conversation-a")
  expect(native.ready).toHaveBeenCalledExactlyOnceWith({ sessionId: "conversation-a" })
  native.ready.mockRejectedValue(new Error("missing required tools"))
  await expect(prepareComputerTools("conversation-b")).rejects.toThrow("missing required tools")
  native.ready.mockClear()
  native.tauri.mockReturnValue(false)
  await prepareComputerTools("preview")
  expect(native.ready).not.toHaveBeenCalled()
})
