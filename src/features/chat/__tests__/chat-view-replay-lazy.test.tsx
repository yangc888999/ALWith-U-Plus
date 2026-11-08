// Opening a long history is lazy: the first page paints the moment it lands, the pill names what is
// still arriving, and the transcript itself is refreshed on a calm cadence while the replay runs.
import { applyUpdate, createSession } from "@alwith/api"
import { act, render } from "@testing-library/react"
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

test("a replaying chat paints the first page, counts progress, and refreshes on a calm cadence", async () => {
  const original = client.state
  client.store.setState({ connection: "ready" })
  vi.useFakeTimers()
  try {
    const first = applyUpdate({ ...createSession("replaying", "/tmp/replay"), restoring: true }, {
      sessionUpdate: "user_message",
      messageId: "q1",
      content: [{ type: "text", text: "First question" }]
    })
    const view = render(
      <ThemeProvider>
        <ChatView session={first} onNewChat={() => {}} onDeleted={() => {}} />
      </ThemeProvider>
    )
    // The first page paints at once — no waiting for the whole replay to finish.
    expect(view.getByText("First question")).toBeInTheDocument()
    const pill = () => view.container.querySelector("[data-history-loading]")
    expect(pill()?.textContent).toContain("1")

    // A later page lands while the replay runs: the pill counts it live…
    const second = applyUpdate(first, {
      sessionUpdate: "agent_message_chunk",
      messageId: "a1",
      content: { type: "text", text: "Later answer" }
    })
    view.rerender(
      <ThemeProvider>
        <ChatView session={second} onNewChat={() => {}} onDeleted={() => {}} />
      </ThemeProvider>
    )
    expect(pill()?.textContent).toContain("2")
    // …while the transcript itself waits for the next pulse instead of re-painting per batch.
    expect(view.queryByText("Later answer")).toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    expect(view.getByText("Later answer")).toBeInTheDocument()

    // The replay ends: the pill goes and the tail window is the live one again.
    view.rerender(
      <ThemeProvider>
        <ChatView session={{ ...second, restoring: false }} onNewChat={() => {}} onDeleted={() => {}} />
      </ThemeProvider>
    )
    expect(pill()).toBeNull()
    expect(view.getByText("Later answer")).toBeInTheDocument()
    view.unmount()
    await act(async () => {})
  } finally {
    vi.useRealTimers()
    client.store.setState(original, true)
  }
})
