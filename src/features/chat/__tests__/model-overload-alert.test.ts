import type { Session } from "@alwith/api"
import { beforeEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

const host = vi.hoisted(() => ({
  listeners: [] as ((event: { payload: { model: string; reason?: "overloaded" | "no_ack"; retryAfter: number | null } }) => void)[],
  warning: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  sessions: {} as Record<string, Session | undefined>,
  runStates: {} as Record<string, { state: string } | undefined>
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, callback: (event: { payload: unknown }) => void) => {
    host.listeners.push(callback as never)
    return () => {}
  })
}))
vi.mock("@tauri-apps/plugin-log", () => ({ info: vi.fn(async () => {}) }))
vi.mock("sonner", () => ({
  toast: { warning: host.warning, info: host.info, success: host.success, error: host.error }
}))
// The module reads the store and nothing else now: switching models moved to the composer picker.
vi.mock("@/lib/client", () => ({
  client: {
    state: { get sessions() { return host.sessions }, get runStates() { return host.runStates } }
  }
}))

function session(current: string): Session {
  return {
    id: "chat-1",
    cwd: "/tmp/project",
    title: null,
    state: "running",
    attached: true,
    restoring: false,
    readOnly: false,
    error: null,
    items: [],
    configOptions: [
      {
        configId: "model",
        category: "model",
        type: "select",
        currentValue: current,
        options: [
          { value: current, name: "6.1 Sol" },
          { value: "gpt-6.1-terra", name: "6.1 Terra" },
          { value: "deepseek-v4-pro", name: "V4 Pro" }
        ]
      }
    ] as never,
    usage: null,
    lastTurnUsage: null,
    turnUsage: {},
    turnEndedAt: {},
    clock: Date.now(),
    lastStopReason: null,
    commands: [],
    terminals: {},
    updatedAt: null,
    _meta: null,
    appliedThrough: 0,
    configRevision: null
  }
}

async function subscribe() {
  // A fresh module per test also resets the module-level "one notice per minute" dedupe.
  vi.resetModules()
  const mod = await import("../model-overload-alert")
  await mod.startModelOverloadAlerts()
  return mod
}

function emit(model: string, retryAfter: number | null = 324, reason: "overloaded" | "no_ack" = "overloaded") {
  for (const listener of host.listeners) listener({ payload: { model, retryAfter, reason } })
}

/** A tool still running locally: the upstream request is over, so a stall must not be claimed. */
function runningTool() {
  const at = Date.now()
  return [
    { id: "u1", at, replayed: false, _meta: null, kind: "user", content: [], echo: null },
    {
      id: "t1",
      at,
      replayed: false,
      _meta: null,
      kind: "tool",
      name: "shell",
      title: "python3 daily_update.py",
      toolKind: "execute",
      status: "in_progress",
      content: [],
      locations: [],
      rawInput: null,
      rawOutput: null,
      endedAt: null
    }
  ] as never
}

beforeEach(async () => {
  await initI18n("zh-CN")
  host.listeners.length = 0
  host.warning.mockClear()
  host.info.mockClear()
  host.success.mockClear()
  host.error.mockClear()
  host.sessions = {}
  host.runStates = {}
})

test("an overload event publishes a notice for the running session, not a floating toast", async () => {
  host.sessions["chat-1"] = session("gpt-6.1-sol")
  const mod = await subscribe()
  emit("gpt-6.1-sol", 324)
  const notice = mod.overloadNotice()
  expect(notice?.sessionId).toBe("chat-1")
  expect(notice?.modelName).toBe("6.1 Sol")
  expect(notice?.minutes).toBe(5)
  expect(host.warning).not.toHaveBeenCalled()
})

test("repeated retries of the same turn do not republish the notice", async () => {
  host.sessions["chat-1"] = session("gpt-6.1-sol")
  const mod = await subscribe()
  let published = 0
  mod.subscribeOverload(() => published++)
  emit("gpt-6.1-sol")
  emit("gpt-6.1-sol")
  expect(published).toBe(1)
})

test("no running session on that model means no notice", async () => {
  host.sessions["chat-1"] = session("gpt-6.1-terra")
  const mod = await subscribe()
  emit("gpt-6.1-sol")
  expect(mod.overloadNotice()).toBeNull()
})

test("the close button only dismisses its own session's notice", async () => {
  host.sessions["chat-1"] = session("gpt-6.1-sol")
  const mod = await subscribe()
  emit("gpt-6.1-sol")
  mod.dismissOverload("another-chat")
  expect(mod.overloadNotice()).not.toBeNull()
  mod.dismissOverload("chat-1")
  expect(mod.overloadNotice()).toBeNull()
})

test("an upstream that never acknowledged is reported with its own reason", async () => {
  host.sessions["chat-1"] = session("gpt-6.1-sol")
  const mod = await subscribe()
  emit("gpt-6.1-sol", null, "no_ack")
  const notice = mod.overloadNotice()
  expect(notice?.reason).toBe("no_ack")
  expect(notice?.retryAfter).toBeNull()
})

test("a stall event is ignored once the turn is running a tool locally", async () => {
  // The bridge watches one request; by the time the event lands the turn may have moved on to a
  // local command, which means the request it described is already finished.
  const running = session("gpt-6.1-sol")
  running.items = runningTool()
  host.sessions["chat-1"] = running
  const mod = await subscribe()
  emit("gpt-6.1-sol", null, "no_ack")
  expect(mod.overloadNotice()).toBeNull()
})
