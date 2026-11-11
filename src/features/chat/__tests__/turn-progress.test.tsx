import type { Session } from "@alwith/api"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"
import { setQueueSendMode } from "@/lib/chat-display-preferences"

import { TurnProgressBar } from "../turn-progress"

const nudgeTurn = vi.hoisted(() => vi.fn())
const overload = vi.hoisted(() => ({
  notice: null as null | {
    sessionId: string
    model: string
    modelName: string
    minutes: number | null
    retryAfter: number | null
    reason: "overloaded" | "no_ack"
    at: number
  }
}))
// `model-overload-alert` (pulled in by the strip) imports sonner; keep it inert in tests.
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock("../nudge-turn", () => ({ nudgeTurn }))
// The real matcher is covered in model-overload-alert.test.ts; here we only need to control the
// module-level notice and prove the row binds it to the model this turn is running on.
vi.mock("../model-overload-alert", () => ({
  matchesReportedModel: (selected: string | null, reported: string) => selected === reported,
  overloadNotice: () => overload.notice,
  dismissOverload: vi.fn(),
  subscribeOverload: (_listener: () => void) => () => {}
}))

await initI18n("zh-CN")

afterEach(() => {
  cleanup()
})

function session(overrides: Partial<Session>): Session {
  return {
    id: "turn-progress",
    cwd: "/tmp/project",
    title: null,
    state: "running",
    attached: true,
    restoring: false,
    readOnly: false,
    error: null,
    items: [],
    configOptions: [],
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
    configRevision: null,
    ...overrides
  }
}

function tool(id: string, status: "completed" | "in_progress", at = Date.now()) {
  return {
    id,
    at,
    replayed: false,
    _meta: null,
    kind: "tool" as const,
    name: "shell",
    title: status === "completed" ? "python3 check.py" : "python3 daily_update.py",
    toolKind: "execute",
    status,
    content: [],
    locations: [],
    rawInput: null,
    rawOutput: null,
    endedAt: status === "completed" ? at : null
  }
}

const user = (at = Date.now()) => ({ id: "u1", at, replayed: false, _meta: null, kind: "user" as const, content: [], echo: null })

test("an idle session shows no progress strip", () => {
  const view = render(<TurnProgressBar session={session({ id: "turn-idle", state: "idle" })} />)
  expect(view.container.querySelector("[data-turn-progress]")).toBeNull()
})

test("a turn that just started offers stop but no model switch", () => {
  // Stop moved from the toolbar (where the model picker crowded it out of reach in narrow
  // windows) to this full-width row, so it is present from the first moment a turn runs.
  const view = render(<TurnProgressBar session={session({ id: "turn-fresh" })} />)
  expect(view.getByRole("button", { name: "停止" })).toBeTruthy()
  expect(view.queryByRole("button", { name: "切换默认模型" })).toBeNull()
})

test("the stop button cancels the running turn", async () => {
  const { client } = await import("@/lib/client")
  const cancel = vi.spyOn(client, "cancel").mockResolvedValue(undefined)
  try {
    const view = render(<TurnProgressBar session={session({ id: "turn-stop" })} />)
    fireEvent.click(view.getByRole("button", { name: "停止" }))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith("turn-stop")
  } finally {
    cancel.mockRestore()
  }
})

test("the stop button stays reachable while the turn is quiet", () => {
  // The whole point of the move: even a long, silent turn keeps stop on screen. The row's text
  // truncates; the shrink-0 stop button never does.
  const view = render(<TurnProgressBar session={session({ id: "turn-stop-quiet", clock: Date.now() - 190_000 })} />)
  act(() => {})
  const stop = view.container.querySelector("[data-turn-stop]")
  expect(stop).not.toBeNull()
  expect(stop?.className).toContain("shrink-0")
})

test("a running turn shows one short connecting line and the elapsed clock", () => {
  const view = render(<TurnProgressBar session={session({ id: "turn-wait" })} />)
  expect(view.getByText(/连接中/)).toBeTruthy()
  expect(view.getByText("00:00")).toBeTruthy()
  // No effort badge, no tool counts, no long stage sentence on the row.
  expect(view.queryByText(/medium|本轮已完成|等待模型响应/)).toBeNull()
})

test("completed tools keep the short thinking state; the count is hover-only", () => {
  const view = render(
    <TurnProgressBar
      session={session({
        id: "turn-steps",
        items: [user(), tool("t1", "completed"), tool("t2", "completed"), tool("t3", "completed")]
      })}
    />
  )
  expect(view.getByText(/正在思考/)).toBeTruthy()
  expect(view.getByTitle("等待模型续写（本轮已完成 3 个工具）")).toBeTruthy()
  expect(view.queryByText(/本轮已完成 3 个工具/)).toBeNull()
})

test("a tool in flight gets its own short state, with the command only on hover", () => {
  const view = render(
    <TurnProgressBar session={session({ id: "turn-tool", items: [user(), tool("t1", "in_progress")] })} />
  )
  expect(view.getByText(/调用工具中/)).toBeTruthy()
  expect(view.getByTitle("正在执行 python3 daily_update.py")).toBeTruthy()
  expect(view.queryByText(/正在执行 python3/)).toBeNull()
})

test("a waiting-for-confirmation turn has its own short state", () => {
  const view = render(<TurnProgressBar session={session({ id: "turn-confirm", state: "requires_action" })} />)
  expect(view.getByText(/等待确认/)).toBeTruthy()
})

test("silence past a minute and a half is stated, not accused", () => {
  // The strip measures silence from the last applied update; an old clock means it has been quiet.
  const view = render(<TurnProgressBar session={session({ id: "turn-quiet", clock: Date.now() - 130_000 })} />)
  act(() => {})
  expect(view.getByText(/连接中/)).toBeTruthy()
  // Describes the step's duration. "No new output for 2 minutes" read as a fault report on a
  // reasoning model that was simply thinking, which is why the wording is neutral now.
  expect(view.getByText(/本步已/)).toBeTruthy()
  expect(view.queryByText(/没有新内容/)).toBeNull()
  // A minute and a half proves nothing about the upstream, so there is no fault wording at all —
  // only the nudge, which is safe to press because it changes nothing but the conversation.
  expect(view.queryByText(/重连中/)).toBeNull()
  expect(view.queryByRole("button", { name: /换模型|切换/ })).toBeNull()
  expect(view.container.querySelector("[data-turn-quiet]")).not.toBeNull()
})

test("a long tool run is this machine working, never a stalled model", () => {
  // The tool call ended the upstream response, so there is no request in flight while the command
  // runs. Offering "switch model" here used to cancel a data pull that was three minutes in.
  const started = Date.now() - 190_000
  const view = render(
    <TurnProgressBar
      session={session({
        id: "turn-tool-long",
        clock: started,
        items: [user(started), tool("t1", "in_progress", started)]
      })}
    />
  )
  act(() => {})
  expect(view.getByText(/调用工具中/)).toBeTruthy()
  // Nudging a command that is already running would just stack another instruction on top of it.
  expect(view.queryByRole("button", { name: "催一下" })).toBeNull()
  // "quiet" and "reconnecting" are upstream judgements; a running tool is neither.
  expect(view.queryByText(/本步已/)).toBeNull()
  expect(view.queryByText(/重连中/)).toBeNull()
})

test("a turn parked on a prompt never offers a model switch", () => {
  const started = Date.now() - 190_000
  const view = render(
    <TurnProgressBar
      session={session({ id: "turn-parked", state: "requires_action", clock: started, items: [user(started)] })}
    />
  )
  act(() => {})
  expect(view.getByText(/等待确认/)).toBeTruthy()
  expect(view.queryByRole("button", { name: "催一下" })).toBeNull()
})

test("a long silence offers a nudge, never a model switch", () => {
  const view = render(<TurnProgressBar session={session({ id: "turn-quiet-long", clock: Date.now() - 190_000 })} />)
  act(() => {})
  // The renderer cannot see the upstream, so it never calls a stopwatch "reconnecting": a four
  // minute reasoning step was being painted amber as if the gateway had dropped the connection.
  expect(view.queryByText(/重连中/)).toBeNull()
  expect(view.getByText(/本步已/)).toBeTruthy()
  // Switching models has one entrance — the picker under the composer. The row may only push the
  // turn along, which is the same thing as typing into the composer mid-turn.
  expect(view.queryByRole("button", { name: /换模型|切换/ })).toBeNull()
  const button = view.getByRole("button", { name: "催一下" })
  fireEvent.click(button)
  expect(nudgeTurn).toHaveBeenCalledTimes(1)
  // The explanation is the badge's own hover text — no floating card over the document.
  expect(view.getByText(/本步已/).getAttribute("title")).toMatch(/推理模型/)
  expect(view.getByRole("button", { name: "为什么等这么久" }).getAttribute("title")).toMatch(/推理模型/)
})

test("a queued-send surface is not offered a nudge it could not deliver", () => {
  // In queued mode the composer holds mid-turn messages until the turn settles, so this button
  // would not push the model along — it would queue "继续" and open a new turn afterwards.
  setQueueSendMode("queued")
  try {
    const view = render(<TurnProgressBar session={session({ id: "turn-queued", clock: Date.now() - 190_000 })} />)
    act(() => {})
    expect(view.getByText(/本步已/)).toBeTruthy()
    expect(view.queryByRole("button", { name: "催一下" })).toBeNull()
  } finally {
    // The strip subscribes to the preference, so resetting it re-renders a still-mounted row.
    cleanup()
    act(() => setQueueSendMode("immediate"))
  }
})

function noticeFor(model: string, sessionId: string, at: number) {
  return {
    sessionId,
    model,
    modelName: model,
    minutes: 5,
    retryAfter: 300,
    reason: "overloaded" as const,
    at
  }
}

function modelOption(currentValue: string) {
  return [
    {
      configId: "model",
      category: "model",
      type: "select",
      currentValue,
      options: [{ value: currentValue, name: currentValue }]
    }
  ] as never
}

test("a capacity notice for another model never paints this turn amber", () => {
  const at = Date.now() - 45_000
  overload.notice = noticeFor("gpt-6.1-sol", "turn-model-mismatch", at)
  try {
    // Everything else says "show the overload": same session, long silence, retry-after live.
    // Only the model id differs — the notice belongs to a turn that is no longer this one.
    const view = render(
      <TurnProgressBar
        session={session({ id: "turn-model-mismatch", clock: at, configOptions: modelOption("gpt-6.1-terra") })}
      />
    )
    expect(view.container.textContent).not.toContain("过载")
    expect(view.getByText(/连接中/)).toBeTruthy()
  } finally {
    overload.notice = null
  }
})

test("a capacity notice for this model still paints the row amber", () => {
  const at = Date.now() - 45_000
  overload.notice = noticeFor("gpt-6.1-sol", "turn-model-match", at)
  try {
    const view = render(
      <TurnProgressBar
        session={session({ id: "turn-model-match", clock: at, configOptions: modelOption("gpt-6.1-sol") })}
      />
    )
    expect(view.container.textContent).toContain("过载")
  } finally {
    overload.notice = null
  }
})

test("picking another model mid-turn stops the stalled model's amber row", async () => {
  // A mid-turn pick is parked until the turn settles, so `configOptions` keep naming the old
  // model. Reading only those kept the amber "at capacity" row on screen after the reader had
  // already chosen DeepSeek — the row must follow the picker (the pending choice), not the config.
  const at = Date.now() - 45_000
  overload.notice = noticeFor("gpt-6.1-sol", "turn-model-pending", at)
  const { client } = await import("@/lib/client")
  const pending = vi.spyOn(client, "pendingModelFor").mockReturnValue("deepseek-v4-pro")
  try {
    const view = render(
      <TurnProgressBar
        session={session({ id: "turn-model-pending", clock: at, configOptions: modelOption("gpt-6.1-sol") })}
      />
    )
    expect(view.container.textContent).not.toContain("过载")
  } finally {
    pending.mockRestore()
    overload.notice = null
  }
})

test("a turn ending mid-flight keeps the hook order stable", () => {
  // The strip bails out to null once the turn ends, and the two store subscriptions used to sit
  // below that bail-out — so finishing a turn changed the hook count and React tore the whole app
  // down with "rendered fewer/more hooks than expected" (#300 / #310), i.e. the error page.
  const running = session({ id: "turn-hook-order", items: [user()] })
  const view = render(<TurnProgressBar session={running} />)
  expect(view.container.querySelector("[data-turn-progress]")).not.toBeNull()

  expect(() => view.rerender(<TurnProgressBar session={{ ...running, state: "idle" }} />)).not.toThrow()
  expect(view.container.querySelector("[data-turn-progress]")).toBeNull()

  expect(() => view.rerender(<TurnProgressBar session={running} />)).not.toThrow()
  expect(view.container.querySelector("[data-turn-progress]")).not.toBeNull()
})
