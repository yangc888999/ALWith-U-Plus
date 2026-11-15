import { applyUpdate, createSession } from "@alwith/api"
import { act, fireEvent, render } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { ThemeProvider } from "@/components/theme-provider"
import { client } from "@/lib/client"
import { initI18n } from "@/lib/i18n"

import { ChatView } from "../chat-view"
import { navigationSoundStore } from "../codex/navigation-sound-store"

vi.mock("../chat-actions-menu", () => ({ ChatActionsMenu: () => null }))
vi.mock("../composer", () => ({ ChatComposer: () => null }))
vi.mock("../dialogs/chat-search", () => ({ ChatSearch: () => null }))
vi.mock("../dialogs/image-lightbox", () => ({
  ImageLightbox: () => null,
  openImageLightbox: vi.fn(),
  openImageGallery: vi.fn()
}))
vi.mock("@tauri-apps/plugin-log", () => ({ info: async () => {} }))

await initI18n("en")
navigationSoundStore.setState({ soundMode: "none" })

test("a stopped chat keeps its transcript and reconnects that session", async () => {
  const original = client.state
  const open = vi.spyOn(client, "open").mockResolvedValue()
  const session = applyUpdate(createSession("stopped", "/tmp/stopped"), {
    sessionUpdate: "user_message",
    messageId: "question",
    content: [{ type: "text", text: "Retained question" }]
  })
  client.store.setState({ connection: "ready" })
  const view = render(
    <ThemeProvider>
      <ChatView session={{ ...session, attached: false }} onNewChat={() => {}} onDeleted={() => {}} />
    </ThemeProvider>
  )
  try {
    expect(view.getByText("Retained question")).toBeInTheDocument()
    await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Reconnect" }))))
    expect(open).toHaveBeenCalledExactlyOnceWith("stopped", "/tmp/stopped")
    view.rerender(
      <ThemeProvider>
        <ChatView session={{ ...session, attached: true }} onNewChat={() => {}} onDeleted={() => {}} />
      </ThemeProvider>
    )
    expect(view.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument()
    expect(view.getByText("Retained question")).toBeInTheDocument()
  } finally {
    view.unmount()
    open.mockRestore()
    client.store.setState(original, true)
  }
})

test("a read-only chat retries its own session and disables retry while restoring", async () => {
  const original = client.state
  const open = vi.spyOn(client, "open").mockResolvedValue()
  const session = { ...createSession("locked", "/tmp/locked"), attached: false, readOnly: true }
  client.store.setState({ connection: "ready" })
  const renderChat = (restoring: boolean, readOnly = true) => (
    <ThemeProvider>
      <ChatView session={{ ...session, restoring, readOnly }} onNewChat={() => {}} onDeleted={() => {}} />
    </ThemeProvider>
  )
  const view = render(renderChat(false))
  try {
    expect(view.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument()
    await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Try again" }))))
    expect(open).toHaveBeenCalledExactlyOnceWith("locked", "/tmp/locked")
    view.rerender(renderChat(true))
    const retry = view.getByRole("button", { name: "Restoring conversation" })
    expect(retry).toBeDisabled()
    fireEvent.click(retry)
    expect(open).toHaveBeenCalledTimes(1)
    view.rerender(renderChat(false))
    expect(view.getByRole("button", { name: "Try again" })).toBeEnabled()
    view.rerender(renderChat(false, false))
    expect(view.queryByText("Open in another client")).not.toBeInTheDocument()
  } finally {
    view.unmount()
    open.mockRestore()
    client.store.setState(original, true)
  }
})
test("a revoked account model is a notice, not a read-only park", async () => {
  const original = client.state
  const session = { ...createSession("revoked", "/tmp/revoked"), attached: false, readOnly: false }
  client.store.setState({ connection: "ready", accountModelRecovery: { revoked: true } })
  const view = render(
    <ThemeProvider>
      <ChatView session={session} onNewChat={() => {}} onDeleted={() => {}} />
    </ThemeProvider>
  )
  try {
    // No marker and no read-only banner: the recovery explanation is one line inside the composer,
    // and the session is no longer parked read-only, so the package's "open in another client"
    // banner would be claiming a cause that is not there.
    expect(view.container.querySelector("[data-account-recovery]")).toBeNull()
    expect(view.queryByText("Open in another client")).not.toBeInTheDocument()
    // A session that really is read-only (another client holds it) keeps its banner and its 重试
    // button even while the recovery flag is set — those are two different causes.
    view.rerender(
      <ThemeProvider>
        <ChatView
          session={{ ...session, attached: false, readOnly: true }}
          onNewChat={() => {}}
          onDeleted={() => {}}
        />
      </ThemeProvider>
    )
    expect(view.getByText("Open in another client")).toBeInTheDocument()
    expect(view.getByRole("button", { name: "Try again" })).toBeInTheDocument()
  } finally {
    view.unmount()
    client.store.setState(original, true)
  }
})
