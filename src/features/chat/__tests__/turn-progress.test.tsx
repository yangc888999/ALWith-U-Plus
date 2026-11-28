import type { Session } from "@alwith/api"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

import { setAutoNudgeEnabled } from "@/lib/auto-nudge"
import { setQueueSendMode } from "@/lib/chat-display-preferences"
import { initI18n } from "@/lib/i18n"

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

const user = (at = Date.now()) => ({
  id: "u1",
  at,
  replayed: false,
  _meta: null,
  kind: "user" as const,
  content: [],
  echo: null
})

test("an idle session shows no progress strip", () => {
  const view = render(<TurnProgressBar session={session({ id: "turn-idle", state: "idle" })} />)
  expect(view.container.querySelector("[data-turn-progress]")).toBeNull()
})

test("a turn that just started keeps the progress row informational", () => {
  // Send and stop are one mutually exclusive control in the composer toolbar. The progress row
  // must not introduce a second stop entry above the input.
  const view = render(<TurnProgressBar session={session({ id: "turn-fresh" })} />)
  expect(view.queryByRole("button", { name: "停止" })).toBeNull()
  expect(view.queryByRole("button", { name: "切换默认模型" })).toBeNull()
})

test("the progress row never owns cancellation", () => {
  const view = render(<TurnProgressBar session={session({ id: "turn-stop" })} />)
  expect(view.container.querySelector("[data-turn-stop]")).toBeNull()
})

test("a quiet turn keeps cancellation out of the progress row", () => {
  const view = render(<TurnProgressBar session={session({ id: "turn-stop-quiet", clock: Date.now() - 190_000 })} />)
  act(() => {})
  expect(view.container.querySelector("[data-turn-stop]")).toBeNull()
})

test("a running turn shows one short thinking line and the elapsed clock", () => {
  const view = render(<TurnProgressBar session={session({ id: "turn-wait" })} />)
  expect(view.getByText(/正在思考/)).toBeTruthy()
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
  expect(view.getByText(/正在思考/)).toBeTruthy()
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

test("a long silence offers a nudge, never a model switch", async () => {
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
  // The badge keeps its native hover text; the "?" opens the same explanation through the app's
  // portal tooltip, so it appears immediately instead of waiting for the browser's title delay.
  expect(view.getByText(/本步已/).getAttribute("title")).toMatch(/推理模型/)
  const help = view.getByRole("button", { name: "为什么等这么久" })
  expect(help).not.toHaveAttribute("title")
  await act(() => Promise.try(() => help.focus()))
  expect(await view.findByRole("tooltip")).toHaveTextContent(/推理模型/)
})

test("a turn state that cannot fit marquees instead of truncating", async () => {
  const offsetWidth = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(240)
  const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100)
  try {
    const view = render(<TurnProgressBar session={session({ id: "turn-marquee" })} />)
    await act(() => Promise.resolve())
    expect(view.container.querySelector("[data-turn-state-marquee]")).not.toBeNull()
    expect(view.container.querySelector(".alwith-marquee")).not.toBeNull()
  } finally {
    offsetWidth.mockRestore()
    clientWidth.mockRestore()
  }
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
    expect(view.getByText(/正在思考/)).toBeTruthy()
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
  client.store.setState({ pendingModels: { "turn-model-pending": "deepseek-v4-pro" } })
  try {
    const view = render(
      <TurnProgressBar
        session={session({ id: "turn-model-pending", clock: at, configOptions: modelOption("gpt-6.1-sol") })}
      />
    )
    expect(view.container.textContent).not.toContain("过载")
    expect(view.container.textContent).not.toContain("下一轮")
    expect(view.container.querySelector("[data-turn-state]")?.getAttribute("title")).not.toContain("下一轮")
  } finally {
    act(() => client.store.setState({ pendingModels: {} }))
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

test("forty-five seconds of silence are stated inside the same line, not on a second card", () => {
  const view = render(<TurnProgressBar session={session({ id: "turn-quiet-text", clock: Date.now() - 62_000 })} />)
  // 「已 62s 无输出」 rides on the state line itself; the row stays one line tall.
  const suffix = view.container.querySelector("[data-turn-quiet-for]")
  expect(suffix).not.toBeNull()
  expect(suffix?.textContent).toMatch(/62/)
  expect(suffix?.textContent).toMatch(/无输出/)
  expect(view.container.querySelectorAll("[data-turn-progress]")).toHaveLength(1)
  // Below the threshold the row says nothing at all about silence.
  cleanup()
  const fresh = render(
    <TurnProgressBar session={session({ id: "turn-quiet-text-fresh", clock: Date.now() - 20_000 })} />
  )
  expect(fresh.container.querySelector("[data-turn-quiet-for]")).toBeNull()
})

test("a silent turn is nudged automatically after ninety seconds, at most twice", () => {
  nudgeTurn.mockClear()
  vi.useFakeTimers()
  try {
    const started = Date.now() - 200_000
    const view = render(<TurnProgressBar session={session({ id: "turn-auto-nudge", clock: started })} />)
    // Mounting on an already-quiet turn does not nudge: the row has just started watching, and a
    // reload must not leave a stray 「继续」 in the transcript for silence nobody saw.
    expect(nudgeTurn).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(89_000)
    })
    expect(nudgeTurn).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(nudgeTurn).toHaveBeenCalledTimes(1)
    // The row says what it did, replacing the plain silence wording.
    expect(view.container.querySelector("[data-turn-auto-nudged]")?.textContent).toMatch(/1/)

    act(() => {
      vi.advanceTimersByTime(91_000)
    })
    expect(nudgeTurn).toHaveBeenCalledTimes(2)

    act(() => {
      vi.advanceTimersByTime(300_000)
    })
    expect(nudgeTurn).toHaveBeenCalledTimes(2)
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

test("a turn running a tool is never nudged on a stopwatch", () => {
  nudgeTurn.mockClear()
  vi.useFakeTimers()
  try {
    const started = Date.now() - 200_000
    render(
      <TurnProgressBar
        session={session({
          id: "turn-auto-nudge-tool",
          clock: started,
          items: [user(started), tool("t1", "in_progress", started)]
        })}
      />
    )
    act(() => {
      vi.advanceTimersByTime(200_000)
    })
    // The upstream has no request in flight while a local command runs.
    expect(nudgeTurn).not.toHaveBeenCalled()
  } finally {
    cleanup()
    vi.useRealTimers()
  }
})

test("queued-send mode is never nudged automatically", () => {
  // In queued mode the nudge would arrive after the turn settles and open a second turn, which is
  // the opposite of pushing this one along.
  nudgeTurn.mockClear()
  setQueueSendMode("queued")
  vi.useFakeTimers()
  try {
    const started = Date.now() - 200_000
    render(<TurnProgressBar session={session({ id: "turn-auto-nudge-queued", clock: started })} />)
    act(() => {
      vi.advanceTimersByTime(200_000)
    })
    expect(nudgeTurn).not.toHaveBeenCalled()
  } finally {
    cleanup()
    vi.useRealTimers()
    act(() => setQueueSendMode("immediate"))
  }
})

test("turning the switch off leaves the manual nudge as the only way to push a turn", () => {
  nudgeTurn.mockClear()
  setAutoNudgeEnabled(false)
  vi.useFakeTimers()
  try {
    const started = Date.now() - 200_000
    const view = render(<TurnProgressBar session={session({ id: "turn-auto-nudge-off", clock: started })} />)
    act(() => {
      vi.advanceTimersByTime(200_000)
    })
    expect(nudgeTurn).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole("button", { name: "催一下" }))
    expect(nudgeTurn).toHaveBeenCalledTimes(1)
  } finally {
    cleanup()
    vi.useRealTimers()
    act(() => setAutoNudgeEnabled(true))
  }
})
