import { applyUpdate, createSession } from "@alwith/api"
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

    expect(input.selectionStart).toBe(7)
    expect(input.selectionEnd).toBe(7)
  } finally {
    act(() => client.store.setState(original, true))
    view.unmount()
  }
})
