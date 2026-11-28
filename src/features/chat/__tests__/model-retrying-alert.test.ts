import type { Session } from "@alwith/api"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

const host = vi.hoisted(() => ({
  listeners: [] as ((event: { payload: { model: string; retries: number; requestId?: string } }) => void)[],
  toasts: [] as { message: unknown; options: Record<string, unknown> }[],
  jumpToSession: vi.fn(),
  info: vi.fn(),
  sessions: {} as Record<string, Session | undefined>,
  runStates: {} as Record<string, { state: string } | undefined>
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, callback: (event: { payload: unknown }) => void) => {
    host.listeners.push(callback as never)
    return () => {}
  })
}))
vi.mock("@tauri-apps/plugin-log", () => ({ info: host.info }))
vi.mock("sonner", () => {
  const dismiss = vi.fn()
  // Sonner exposes `dismiss` as a property on the callable `toast`, not as a sibling export.
  const toast = Object.assign(
    vi.fn((message: unknown, options: Record<string, unknown>) => {
      const entry = { message, options }
      host.toasts.push(entry)
      return entry
    }),
    { dismiss }
  )
  return { toast, dismiss }
})
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
// Keep the real `summaryOf`; only intercept the jump so the test can assert where the user lands.
vi.mock("@/features/chat/session-jump", async (importActual) => {
  const actual = await importActual<typeof import("@/features/chat/session-jump")>()
  return { ...actual, jumpToSession: host.jumpToSession }
})

function session(current: string, id = "chat-1"): Session {
  return {
    id,
    cwd: "/tmp/project",
    title: "我的会话",
    state: "running",
    attached: true,
    restoring: false,
    readOnly: false,
    error: null,
    items: [
      { id: "user-1", at: Date.now() - 60_000, replayed: false, _meta: null, kind: "user", content: [], echo: null }
    ] as never,
    configOptions: [
      {
        configId: "model",
        category: "model",
        type: "select",
        currentValue: current,
        // `label()` matches by option `value`; giving the first option `name === current` makes the
        // toast message contain the model string deterministically (a gateway name stays raw, mirroring
        // the overload module, because `deepseek/deepseek-flash` ≠ the option value `gateway:...`).
        options: [
          { value: current, name: current },
          { value: "gpt-6.1-terra", name: "gpt-6.1-terra" }
        ]
      }
    ] as never,
    usage: null,
    lastTurnUsage: null,
    turnUsage: {},
    turnEndedAt: {},
    clock: Date.now() - 60_000,
    lastStopReason: null,
    commands: [],
    terminals: {},
    updatedAt: "2026-11-15T00:00:00Z",
    _meta: null,
    appliedThrough: 0,
    configRevision: null
  }
}

async function subscribe() {
  vi.resetModules()
  const mod = await import("../model-retrying-alert")
  await mod.startModelRetryingAlerts()
  return mod
}

function emit(model: string, retries: number, requestId?: string) {
  for (const listener of host.listeners) listener({ payload: { model, retries, requestId } })
}

beforeEach(async () => {
  await initI18n("zh-CN")
  host.listeners.length = 0
  host.toasts.length = 0
  host.jumpToSession.mockClear()
  host.info.mockClear()
  host.sessions = {}
  host.runStates = {}
})

afterEach(() => {
  vi.useRealTimers()
})

test("a retrying event for a running session raises one toast with a jump button", async () => {
  host.sessions["chat-1"] = session("gateway:deepseek:deepseek-flash")
  await subscribe()
  emit("deepseek/deepseek-flash", 11, "req-1")
  expect(host.toasts).toHaveLength(1)
  const { message, options } = host.toasts[0]
  expect(String(message)).toContain("11")
  expect(String(message)).toContain("deepseek/deepseek-flash")
  // Resolving the session means the jump button is offered.
  expect(options.action).toBeDefined()
  // Clicking it lands the user on the right conversation with a summary the navigator accepts.
  const action = options.action as { onClick: () => void }
  action.onClick()
  expect(host.jumpToSession).toHaveBeenCalledTimes(1)
  expect(host.jumpToSession).toHaveBeenCalledWith({
    sessionId: "chat-1",
    cwd: "/tmp/project",
    title: "我的会话",
    updatedAt: "2026-11-15T00:00:00Z",
    archived: false
  })
})

test("a retry event that arrives after output resumed is ignored", async () => {
  const live = session("gpt-6.1-sol")
  live.clock = Date.now()
  host.sessions["chat-1"] = live
  await subscribe()
  emit("gpt-6.1-sol", 11, "req-after-output")
  expect(host.toasts).toHaveLength(0)
})

test("a healthy sibling on the same model does not swallow a stalled chat's alert", async () => {
  const stalled = session("gpt-6.1-sol", "stalled")
  stalled.clock = Date.now() - 60_000
  const streaming = session("gpt-6.1-sol", "streaming")
  streaming.clock = Date.now()
  host.sessions = { stalled, streaming }
  await subscribe()
  emit("gpt-6.1-sol", 11, "req-stalled-sibling")
  expect(host.toasts).toHaveLength(1)
  expect(host.toasts[0].options.action).toBeDefined()
})

test("the same upstream request is not alerted twice", async () => {
  host.sessions["chat-1"] = session("gpt-6.1-sol")
  await subscribe()
  emit("gpt-6.1-sol", 11, "req-dup")
  emit("gpt-6.1-sol", 11, "req-dup")
  expect(host.toasts).toHaveLength(1)
})

test("two requests on one model are queued, shown one at a time, in arrival order", async () => {
  host.sessions["chat-1"] = session("gpt-6.1-sol")
  await subscribe()
  emit("gpt-6.1-sol", 11, "req-a")
  emit("gpt-6.1-sol", 12, "req-b")
  // Only the first is on screen; the second waits its turn.
  expect(host.toasts).toHaveLength(1)
  const first = host.toasts[0]
  expect(String(first.message)).toContain("11")
  // Dismissing the first releases the next.
  ;(first.options.onDismiss as () => void)()
  expect(host.toasts).toHaveLength(2)
  expect(String(host.toasts[1].message)).toContain("12")
})

test("when several sessions share the model the jump falls back to the most recent", async () => {
  // Two running chats on the same model cannot be told apart from the model name alone; the strict
  // resolver returns null, so the alert must still offer a jump to the most recently updated one.
  const older = session("gpt-6.1-sol", "older")
  older.updatedAt = "2026-11-15T00:00:00Z"
  const newer = session("gpt-6.1-sol", "newer")
  newer.updatedAt = "2026-11-15T01:00:00Z"
  host.sessions = { older, newer }
  await subscribe()
  emit("gpt-6.1-sol", 11, "req-ambiguous")
  expect(host.toasts).toHaveLength(1)
  expect(host.toasts[0].options.action).toBeDefined()
  ;(host.toasts[0].options.action as { onClick: () => void }).onClick()
  expect(host.jumpToSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "newer" }))
})

test("a retrying event with no matching session still warns, but offers no jump", async () => {
  // The session is on a different model; the bridge cannot point at a conversation, so the button is omitted.
  host.sessions["chat-1"] = session("gpt-6.1-terra")
  await subscribe()
  emit("gpt-6.1-sol", 11, "req-none")
  expect(host.toasts).toHaveLength(1)
  expect(host.toasts[0].options.action).toBeUndefined()
})

test("chronological order holds even when alerts arrive out of order", async () => {
  vi.useFakeTimers()
  host.sessions["chat-1"] = session("gpt-6.1-sol")
  await subscribe()
  // Emitted first (real-time) grabs the screen; its `at` is later (2000) than the one below (1000).
  vi.setSystemTime(2_000)
  emit("gpt-6.1-sol", 11, "req-late")
  // Arrives second but happened earlier: it must wait in the queue, sorted before req-late.
  vi.setSystemTime(1_000)
  emit("gpt-6.1-sol", 9, "req-early")
  // The first to arrive is on screen.
  expect(host.toasts).toHaveLength(1)
  expect(String(host.toasts[0].message)).toContain("11")
  // After it leaves, the queue — sorted by `at` — shows the earlier event next.
  ;(host.toasts[0].options.onDismiss as () => void)()
  expect(host.toasts).toHaveLength(2)
  expect(String(host.toasts[1].message)).toContain("9")
})
