import type { Session } from "@alwith/api"
import { beforeEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

const host = vi.hoisted(() => ({
  listeners: [] as ((event: {
    payload: { model: string; reason?: string; retryAfter: number | null; attempt?: number; requestId?: string }
  }) => void)[],
  warning: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  sessions: {} as Record<string, Session | undefined>,
  runStates: {} as Record<string, { state: string } | undefined>,
  noticeEnabled: true
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
    state: {
      get sessions() {
        return host.sessions
      },
      get runStates() {
        return host.runStates
      }
    }
  }
}))
// The mute switch is read by the handler; a getter keeps the test in control of it.
vi.mock("@/lib/overload-retry-settings", () => ({
  overloadNoticeEnabled: () => host.noticeEnabled,
  setOverloadNoticeEnabled: () => {},
  subscribeOverloadNoticeEnabled: () => () => {}
}))

/** `clock` is the last applied update: old for a stalled turn, fresh while tokens are flowing. */
function session(current: string, clock: number = Date.now() - 60_000): Session {
  return {
    id: "chat-1",
    cwd: "/tmp/project",
    title: null,
    state: "running",
    attached: true,
    restoring: false,
    readOnly: false,
    error: null,
    items: [{ id: "user-1", at: clock, replayed: false, _meta: null, kind: "user", content: [], echo: null }] as never,
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
    clock,
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

function emit(
  model: string,
  retryAfter: number | null = 324,
  reason: string = "overloaded",
  extra: { attempt?: number; requestId?: string } = {}
) {
  for (const listener of host.listeners) listener({ payload: { model, retryAfter, reason, ...extra } })
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
  host.noticeEnabled = true
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

test("a gateway route id resolves to the picker display name", async () => {
  const routed = session("gateway:deepseek:deepseek-flash")
  routed.configOptions = [
    {
      configId: "model",
      category: "model",
      type: "select",
      currentValue: "gateway:deepseek:deepseek-flash",
      options: [{ value: "gateway:deepseek:deepseek-flash", name: "DeepSeek V4 Flash" }]
    }
  ] as never
  host.sessions["chat-1"] = routed
  const mod = await subscribe()
  emit("deepseek/deepseek-flash", 324)
  expect(mod.overloadNotice()?.modelName).toBe("DeepSeek V4 Flash")
})

test("the notice fades after the per-request throttle window", async () => {
  host.sessions["chat-1"] = session("gpt-6.1-sol")
  const mod = await subscribe()
  emit("gpt-6.1-sol", 324, "overloaded", { requestId: "req-1" })
  expect(mod.overloadNotice()?.sessionId).toBe("chat-1")
  mod.dismissOverload("chat-1")
  // A different upstream request within the same turn is a fresh stall, not a republish.
  emit("gpt-6.1-sol", 324, "overloaded", { requestId: "req-2" })
  expect(mod.overloadNotice()?.sessionId).toBe("chat-1")
})

test("repeated events from the same upstream request do not republish the notice", async () => {
  host.sessions["chat-1"] = session("gpt-6.1-sol")
  const mod = await subscribe()
  let published = 0
  mod.subscribeOverload(() => published++)
  emit("gpt-6.1-sol", 324, "overloaded", { requestId: "req-1" })
  emit("gpt-6.1-sol", 324, "overloaded", { requestId: "req-1" })
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

test("an unknown reason is never reported as an overload", async () => {
  host.sessions["chat-1"] = session("gpt-6.1-sol")
  const mod = await subscribe()
  emit("gpt-6.1-sol", 324, "something_else")
  expect(mod.overloadNotice()).toBeNull()
})

test("a gateway model is recognized under the bridge's <gateway>/<model> name", async () => {
  host.sessions["chat-1"] = session("gateway:deepseek:deepseek-flash")
  const mod = await subscribe()
  emit("deepseek/deepseek-flash", 324)
  expect(mod.overloadNotice()?.sessionId).toBe("chat-1")
})

test("a turn that is still producing output is not reported as stalled", async () => {
  // Tokens are being billed and the store just applied an update: a retry notice from an older
  // request must not stick to this turn and then to every turn after it.
  host.sessions["chat-1"] = session("gpt-6.1-sol", Date.now())
  const mod = await subscribe()
  emit("gpt-6.1-sol", 324)
  expect(mod.overloadNotice()).toBeNull()
})

test("a request id does not bypass the fresh-output check", async () => {
  // The bridge's gateway idle timer can fire after the stream has resumed. A request identity
  // separates upstream attempts, but it must not turn a live turn into a false "no output" row.
  host.sessions["chat-1"] = session("gpt-6.1-sol", Date.now())
  const mod = await subscribe()
  emit("gpt-6.1-sol", null, "no_ack", { requestId: "req-while-streaming" })
  expect(mod.overloadNotice()).toBeNull()
})

test("a notice is bound to one model id, not to every turn in the window", async () => {
  const mod = await subscribe()
  expect(mod.matchesReportedModel("gpt-6.1-sol", "gpt-6.1-sol")).toBe(true)
  expect(mod.matchesReportedModel("gpt-6.1-terra", "gpt-6.1-sol")).toBe(false)
  expect(mod.matchesReportedModel("gateway:deepseek:deepseek-flash", "deepseek/deepseek-flash")).toBe(true)
  expect(mod.matchesReportedModel("gateway:kimi:kimi-k3", "deepseek/deepseek-flash")).toBe(false)
})

test("the notice keeps the model id it was raised for", async () => {
  host.sessions["chat-1"] = session("gpt-6.1-sol")
  const mod = await subscribe()
  emit("gpt-6.1-sol", 324)
  // The progress row needs this to prove A's capacity is not B's.
  expect(mod.overloadNotice()?.model).toBe("gpt-6.1-sol")
})

test("multiple active sessions on one model suppress the notice rather than guessing", async () => {
  // Two chats running the same model cannot be told apart from the payload; a notice on the wrong
  // one is worse than no notice at all.
  const older = session("gpt-6.1-sol", Date.now() - 120_000)
  older.id = "older"
  const newer = session("gpt-6.1-sol", Date.now() - 90_000)
  newer.id = "newer"
  host.sessions = { older, newer }
  const mod = await subscribe()
  emit("gpt-6.1-sol", 324)
  expect(mod.overloadNotice()).toBeNull()
})

test("only the session matching the reported model is considered", async () => {
  // An unrelated running chat must not make the single real candidate ambiguous.
  const other = session("gpt-6.1-terra", Date.now() - 120_000)
  other.id = "chat-other"
  const active = session("gpt-6.1-sol", Date.now() - 90_000)
  active.id = "chat-active"
  host.sessions = { other, active }
  const mod = await subscribe()
  emit("gpt-6.1-sol", 324)
  expect(mod.overloadNotice()?.sessionId).toBe("chat-active")
})

test("with the reminder switched off an overload never becomes a notice", async () => {
  host.noticeEnabled = false
  host.sessions["chat-1"] = session("gpt-6.1-sol")
  const mod = await subscribe()
  emit("gpt-6.1-sol", 324, "overloaded", { requestId: "req-muted" })
  expect(mod.overloadNotice()).toBeNull()
})

test("the mute switch only silences overloads, not a silent upstream", async () => {
  host.noticeEnabled = false
  host.sessions["chat-1"] = session("gpt-6.1-sol")
  const mod = await subscribe()
  emit("gpt-6.1-sol", null, "no_ack")
  expect(mod.overloadNotice()?.reason).toBe("no_ack")
})
