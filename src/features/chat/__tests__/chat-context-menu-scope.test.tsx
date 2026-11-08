// The transcript's text menu is bound on the window in the capture phase, so it can see — and
// swallow — right-clicks meant for the app chrome. These two assertions are the contract: the chat
// body keeps the menu, the chrome around it must be left alone for its own component.
import { applyUpdate, createSession } from "@alwith/api"
import { fireEvent, render } from "@testing-library/react"
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

function renderChat(): HTMLElement {
  const session = applyUpdate(createSession("scope", "/tmp/scope"), {
    sessionUpdate: "user_message",
    messageId: "question",
    content: [{ type: "text", text: "Scoped question" }]
  })
  client.store.setState({ connection: "ready" })
  const view = render(
    <ThemeProvider>
      <ChatView session={{ ...session, attached: false }} onNewChat={() => {}} onDeleted={() => {}} />
    </ThemeProvider>
  )
  return view.getByText("Scoped question")
}

test("the transcript keeps its own text menu", () => {
  const message = renderChat()
  // fireEvent returns false when a handler called preventDefault — i.e. the menu took the click.
  expect(fireEvent.contextMenu(message)).toBe(false)
})

test("right-clicks in the app chrome are left to that surface", () => {
  renderChat()
  // The left navigation rail and a session row both live outside the conversation. Opening the
  // transcript menu there is what used to hide the tree's and the sidebar's own menus.
  for (const className of ["leading-navigation", "session-list-content", "alwith-file-tree"]) {
    const surface = document.createElement("div")
    surface.className = className
    surface.textContent = "chrome"
    document.body.append(surface)
    expect(fireEvent.contextMenu(surface)).toBe(true)
    surface.remove()
  }
})
