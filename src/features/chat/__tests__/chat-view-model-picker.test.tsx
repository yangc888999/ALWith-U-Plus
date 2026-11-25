import { createSession } from "@alwith/api"
import { render } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { ThemeProvider } from "@/components/theme-provider"
import { client } from "@/lib/client"
import { initI18n } from "@/lib/i18n"

import { ChatView } from "../chat-view"

// The surface always hands the composer one entry; rendering it is what makes the decision
// observable. The composer's own chrome is not part of this test.
vi.mock("../composer", () => ({
  ChatComposer: ({ modelSelector }: { modelSelector?: unknown }) => (
    <div data-testid="slot">{modelSelector as never}</div>
  )
}))
// The recovery picker needs a provider snapshot and a lot of chrome. Its own behaviour is covered
// where that component lives; here only the decision to mount it counts.
vi.mock("../composer/recovery-model-select", () => ({
  RecoveryModelSelect: () => <div data-testid="recovery-picker" />
}))
vi.mock("../chat-actions-menu", () => ({ ChatActionsMenu: () => null }))
vi.mock("../dialogs/chat-search", () => ({ ChatSearch: () => null }))
vi.mock("../dialogs/image-lightbox", () => ({
  ImageLightbox: () => null,
  openImageLightbox: vi.fn(),
  openImageGallery: vi.fn()
}))
vi.mock("@tauri-apps/plugin-log", () => ({ info: async () => {} }))

await initI18n("en")

/** The model option as the engine reports it, and as a chat that lost its account model reports it. */
const modelOption = {
  type: "select" as const,
  configId: "model",
  name: "Model",
  category: "model",
  currentValue: "deepseek-flash",
  options: [{ value: "deepseek-flash", name: "Flash" }]
}
const effortOption = {
  type: "select" as const,
  configId: "reasoning_effort",
  name: "Effort",
  category: "thought_level",
  currentValue: "medium",
  options: [{ value: "medium", name: "Medium" }]
}

function renderWithSession(configOptions: readonly unknown[], extra: Record<string, unknown> = {}) {
  const session = { ...createSession("chat", "/tmp/model-picker"), configOptions: configOptions as never, ...extra }
  client.store.setState({ connection: "ready" })
  return render(
    <ThemeProvider>
      <ChatView session={session} onNewChat={() => {}} onDeleted={() => {}} />
    </ThemeProvider>
  )
}

test("a chat still loading its options keeps the plain engine picker", () => {
  // `createSession` starts every chat at `configOptions: []` and the engine fills it in during the
  // replay. Treating that as "model revoked" flashed the fallback picker on every chat as it opened.
  const view = renderWithSession([], { restoring: true })
  try {
    // The slot is always filled now — the surface no longer decides — and the entry it holds must
    // not be the recovery picker while the list is merely still loading.
    expect(view.getByTestId("slot")).toBeInTheDocument()
    expect(view.queryByTestId("recovery-picker")).not.toBeInTheDocument()
    // Main chat header: the old overflow menu and favourite/shortcut cluster are gone; only the
    // rename and find icons remain beside the send-mode switch.
    expect(view.queryByRole("button", { name: "More actions" })).toBeNull()
    expect(view.getByRole("button", { name: "Rename" })).toBeInTheDocument()
    expect(view.getByRole("button", { name: "Find in chat" })).toBeInTheDocument()
  } finally {
    view.unmount()
  }
})

test("a chat whose options include a model gets the engine menu, not the fallback", () => {
  const view = renderWithSession([effortOption, modelOption])
  try {
    expect(view.getByTestId("model-trigger")).toBeInTheDocument()
    expect(view.queryByTestId("recovery-picker")).not.toBeInTheDocument()
  } finally {
    view.unmount()
  }
})

test("a chat whose options loaded without a model still gets a picker", () => {
  // The state a revoked account model leaves behind: the shared menu renders nothing at all when
  // the list has no `model` entry, while the composer keeps telling the reader to use it.
  const view = renderWithSession([effortOption])
  try {
    expect(view.getByTestId("recovery-picker")).toBeInTheDocument()
    expect(view.queryByTestId("model-trigger")).not.toBeInTheDocument()
  } finally {
    view.unmount()
  }
})
