import { applyUpdate, createSession, type Session } from "@alwith/api"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { client } from "@/lib/client"
import { initI18n } from "@/lib/i18n"

import { Composer } from "./timeline-host"

vi.mock("@tauri-apps/plugin-log", () => ({ info: async () => {} }))

await initI18n("en")

test("a streaming commit does not move an earlier caret to the end", () => {
  const original = client.state
  const id = "caret-stream"
  const session = { ...createSession(id, "/tmp/caret"), attached: true, state: "running" as const }
  client.store.setState({ sessions: { ...original.sessions, [id]: session } })
  const view = render(<Composer session={session} />)
  try {
    const input = screen.getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: "please keep this order" } })
    input.focus()
    input.setSelectionRange(7, 7)
    fireEvent.keyUp(input, { key: "ArrowLeft" })

    // WKWebView can move the selection to the end while React commits an unchanged value.
    input.setSelectionRange(input.value.length, input.value.length)
    const next = applyUpdate(session, {
      sessionUpdate: "agent_message_chunk",
      messageId: "answer",
      content: { type: "text", text: "stream" }
    })
    act(() => client.store.setState({ sessions: { ...client.state.sessions, [id]: next } }))

    // The live status row may re-render on this token, but the textarea keeps the reader's text.
    expect(input.value).toBe("please keep this order")
    expect(input.selectionStart).toBe(7)
    expect(input.selectionEnd).toBe(7)
  } finally {
    act(() => client.store.setState(original, true))
    view.unmount()
  }
})

test("an IME composition is never interrupted by a streaming caret restore", () => {
  const original = client.state
  const id = "caret-ime"
  const session = { ...createSession(id, "/tmp/caret-ime"), attached: true, state: "running" as const }
  client.store.setState({ sessions: { ...original.sessions, [id]: session } })
  const view = render(<Composer session={session} />)
  try {
    const input = screen.getByRole("textbox") as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: "please keep this order" } })
    input.focus()
    input.setSelectionRange(7, 7)
    fireEvent.keyUp(input, { key: "ArrowLeft" })

    // The IME is now composing; its candidate caret is not the last committed caret. A token
    // arriving at this moment must not reset the selection (which commits/cancels the pinyin).
    fireEvent.compositionStart(input)
    input.setSelectionRange(12, 12)
    const next = applyUpdate(session, {
      sessionUpdate: "agent_message_chunk",
      messageId: "answer",
      content: { type: "text", text: "stream" }
    })
    act(() => client.store.setState({ sessions: { ...client.state.sessions, [id]: next } }))

    expect(input.value).toBe("please keep this order")
    expect(input.selectionStart).toBe(12)
    expect(input.selectionEnd).toBe(12)
  } finally {
    act(() => client.store.setState(original, true))
    view.unmount()
  }
})

test("the live status row sees tools even though the composer gets an items-free projection", () => {
  const original = client.state
  const id = "caret-live-status"
  const at = Date.now()
  const live: Session = {
    ...createSession(id, "/tmp/caret-live-status"),
    attached: true,
    state: "running",
    clock: at - 150_000,
    items: [
      {
        id: "u",
        at: at - 200_000,
        replayed: false,
        _meta: null,
        kind: "user",
        content: [{ type: "text", text: "run it" }],
        echo: null
      },
      {
        id: "t",
        at: at - 150_000,
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
    ]
  }
  // `useComposerSession` deliberately hands the input a stable empty transcript. The status row
  // must not inherit that projection: it has to read the live session or it says "连接中" while a
  // tool is visibly running.
  const projection: Session = { ...live, items: [] }
  client.store.setState({ sessions: { ...original.sessions, [id]: live } })
  const view = render(<Composer session={projection} />)
  try {
    expect(view.getByText(/running a tool/i)).toBeTruthy()
    expect(view.queryByText(/thinking/i)).toBeNull()
    // A long local tool is work, not silence: the nudge must not be offered here.
    expect(view.queryByRole("button", { name: "Nudge" })).toBeNull()
  } finally {
    act(() => client.store.setState(original, true))
    view.unmount()
  }
})
