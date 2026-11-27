import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeAll, beforeEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  quickChatDirectory: vi.fn(),
  loadPreferences: vi.fn(),
  savePreference: vi.fn(),
  primeQuickChatRoot: vi.fn()
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }))
vi.mock("@/bindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/bindings")>()
  return {
    ...actual,
    commands: { ...actual.commands, quickChatDirectory: mocks.quickChatDirectory }
  }
})
vi.mock("@/lib/preferences", () => ({
  loadPreferences: mocks.loadPreferences,
  savePreference: mocks.savePreference
}))
vi.mock("@/lib/quick-chat", () => ({ primeQuickChatRoot: mocks.primeQuickChatRoot }))
vi.mock("@/features/chat/open-in-editor", () => ({
  ProjectAppIcon: () => null,
  useExternalApps: () => []
}))
vi.mock("@/features/drive/use-drive-visible", () => ({ useDriveVisible: () => false }))
vi.mock("../autostart-row", () => ({ AutostartRow: () => null }))
vi.mock("../prevent-sleep-row", () => ({ PreventSleepRow: () => null }))
vi.mock("../sandbox-row", () => ({ SandboxRow: () => null }))
vi.mock("../memory-injection-row", () => ({ MemoryInjectionRow: () => null }))

import { GeneralSection } from "../general-section"

beforeAll(async () => {
  await initI18n("en")
})

beforeEach(() => {
  mocks.open.mockReset()
  mocks.quickChatDirectory.mockReset().mockResolvedValue("/Users/me/Documents/Codex")
  mocks.loadPreferences.mockReset().mockResolvedValue({
    externalEditor: null,
    chatWindowShortcut: "Alt+Space",
    defaultStartSurface: "chat",
    chatDirectory: null
  })
  mocks.savePreference.mockReset().mockResolvedValue(undefined)
  mocks.primeQuickChatRoot.mockReset().mockResolvedValue(undefined)
})

test("choosing and resetting the default chat folder persists the preference", async () => {
  mocks.open.mockResolvedValue("/Volumes/Work/ALWith Chats")
  render(<GeneralSection />)

  const path = screen.getByRole("textbox", { name: "Default chat folder" })
  await waitFor(() => expect(path).toHaveValue("/Users/me/Documents/Codex"))
  fireEvent.click(screen.getByRole("button", { name: "Choose folder" }))
  await waitFor(() =>
    expect(mocks.savePreference).toHaveBeenCalledWith("chatDirectory", "/Volumes/Work/ALWith Chats")
  )
  expect(mocks.primeQuickChatRoot).toHaveBeenCalled()
  await waitFor(() => expect(path).toHaveValue("/Volumes/Work/ALWith Chats"))

  fireEvent.click(screen.getByRole("button", { name: "Restore default location" }))
  await waitFor(() => expect(mocks.savePreference).toHaveBeenLastCalledWith("chatDirectory", null))
  await waitFor(() => expect(path).toHaveValue("/Users/me/Documents/Codex"))
})
