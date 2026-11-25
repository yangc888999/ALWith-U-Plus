import { applyUpdate, createSession } from "@alwith/api"
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

import { client } from "@/lib/client"
import { initI18n } from "@/lib/i18n"

import { ChatHeaderActions } from "../chat-header-actions"

await initI18n("en")

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function readyClient(): () => void {
  const state = client.state
  client.store.setState({
    connection: "ready",
    agent: {
      protocolVersion: 2,
      info: { name: "fake-codex", version: "1" },
      capabilities: { _meta: { codex: { rename: true } } }
    }
  })
  return () => act(() => client.store.setState(state, true))
}

test("main chat header exposes rename and find without the old overflow or favourite controls", async () => {
  const restore = readyClient()
  const rename = vi.spyOn(client, "renameSession").mockResolvedValue()
  const session = applyUpdate(createSession("header-actions", "/tmp/project"), {
    sessionUpdate: "user_message",
    messageId: "message-1",
    content: [{ type: "text", text: "Hello" }]
  })
  const view = render(<ChatHeaderActions session={session} />)
  try {
    const renameButton = view.getByRole("button", { name: "Rename" })
    expect(view.queryByRole("button", { name: "More actions" })).toBeNull()
    await act(() => Promise.try(() => renameButton.click()))
    const dialog = within(view.getByRole("dialog"))
    const input = dialog.getByRole("textbox", { name: "Rename" })
    fireEvent.change(input, { target: { value: "Renamed chat" } })
    await act(() => Promise.try(() => dialog.getByRole("button", { name: "Rename" }).click()))
    await waitFor(() => expect(rename).toHaveBeenCalledWith("header-actions", "Renamed chat"))
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(renameButton).toHaveFocus())
  } finally {
    view.unmount()
    restore()
  }
})

test("find button uses the same chat search event as the shortcut", async () => {
  const restore = readyClient()
  const session = applyUpdate(createSession("header-find", "/tmp/project"), {
    sessionUpdate: "user_message",
    messageId: "message-1",
    content: [{ type: "text", text: "Hello" }]
  })
  const requests: string[] = []
  const listener = (event: Event) => requests.push((event as CustomEvent<string>).detail)
  window.addEventListener("chat:find", listener)
  const view = render(<ChatHeaderActions session={session} />)
  try {
    fireEvent.click(view.getByRole("button", { name: "Find in chat" }))
    expect(requests).toEqual(["header-find"])
  } finally {
    window.removeEventListener("chat:find", listener)
    view.unmount()
    restore()
  }
})
