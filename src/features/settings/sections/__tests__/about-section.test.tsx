import * as core from "@tauri-apps/api/core"
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks"
import { act, render, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { afterEach, expect, test, vi } from "vitest"

import { useUpdaterStore } from "@/features/updater/store"
import { initI18n } from "@/lib/i18n"
import * as bridge from "@/lib/settings-bridge"

import { AboutSection } from "../about-section"

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({ ...(await importOriginal<object>()) }))

await initI18n("en")

afterEach(() => clearMocks())

test("About shows the installed app and executable versions instead of the ACP adapter version", async () => {
  const native = vi.spyOn(core, "isTauri").mockReturnValue(true)
  const init = vi.spyOn(useUpdaterStore.getState(), "init").mockResolvedValue()
  const agent = vi.spyOn(bridge, "useSettingsAgent").mockReturnValue({
    name: "Codex",
    version: "0.7.4",
    authMethods: [],
    actions: []
  })
  mockIPC((command) => {
    if (command === "plugin:app|version") return "0.2.0"
    if (command === "codex_version") return "0.159.2"
    throw new Error(`Unexpected command: ${command}`)
  })
  const view = render(<AboutSection />)
  try {
    await waitFor(() => {
      expect(view.getByText(/Version v0\.2\.0/)).toBeDefined()
      expect(view.getByText("Codex CLI 0.159.2")).toBeDefined()
    })
    expect(view.queryByText("Codex 0.7.4")).toBeNull()
    expect(view.queryByText("Version", { exact: true })).toBeNull()
    // The build carries its author on the same line as the version.
    expect(view.getByText("@Leo")).toBeDefined()
  } finally {
    view.unmount()
    native.mockRestore()
    init.mockRestore()
    agent.mockRestore()
  }
})

test("a failed Codex version check reports the error and still displays the app version", async () => {
  const native = vi.spyOn(core, "isTauri").mockReturnValue(true)
  const init = vi.spyOn(useUpdaterStore.getState(), "init").mockResolvedValue()
  const error = vi.spyOn(toast, "error").mockImplementation(() => "error-toast")
  mockIPC(
    (command) => {
      if (command === "plugin:app|version") return "0.2.0"
      if (command === "codex_version") throw new Error("Codex version check failed")
      return undefined
    },
    { shouldMockEvents: true }
  )
  const view = render(<AboutSection />)
  try {
    await act(async () => {})
    await waitFor(() => expect(view.getByText(/Version v0\.2\.0/)).toBeDefined())
    expect(view.getByText("Codex CLI —")).toBeDefined()
    expect(error).toHaveBeenCalledWith("Codex version check failed")
  } finally {
    view.unmount()
    native.mockRestore()
    init.mockRestore()
    error.mockRestore()
  }
})

test("a failed update check shows the error instead of claiming the app is up to date", async () => {
  const native = vi.spyOn(core, "isTauri").mockReturnValue(true)
  const init = vi.spyOn(useUpdaterStore.getState(), "init").mockResolvedValue()
  const originalState = useUpdaterStore.getState()
  useUpdaterStore.setState({ state: { type: "checkFailed", message: "network unreachable" } })
  mockIPC((command) => {
    if (command === "plugin:app|version") return "0.2.0"
    if (command === "codex_version") return "0.159.2"
    throw new Error(`Unexpected command: ${command}`)
  })
  const view = render(<AboutSection />)
  try {
    await waitFor(() => {
      expect(view.getByText("Update check failed: network unreachable")).toBeDefined()
    })
    expect(view.queryByText("Up to date")).toBeNull()
  } finally {
    view.unmount()
    useUpdaterStore.setState(originalState, true)
    native.mockRestore()
    init.mockRestore()
  }
})

test("the update log opens from the version row instead of sitting on the page", async () => {
  const native = vi.spyOn(core, "isTauri").mockReturnValue(true)
  const init = vi.spyOn(useUpdaterStore.getState(), "init").mockResolvedValue()
  mockIPC((command) => {
    if (command === "plugin:app|version") return "0.2.0"
    if (command === "codex_version") return "0.159.2"
    throw new Error(`Unexpected command: ${command}`)
  })
  const view = render(<AboutSection />)
  try {
    await waitFor(() => expect(view.getByText(/Version v0\.2\.0/)).toBeDefined())
    // The change bullets are not on the page until the link is used.
    expect(view.queryByRole("listitem")).toBeNull()

    await act(() =>
      Promise.try(() => {
        view.getByRole("button", { name: "Update log" }).click()
      })
    )
    // Opens in a dialog grouped by version; the title and the current version are shown together
    // with the change bullets.
    await waitFor(() => expect(view.getByText("Update log:")).toBeDefined())
    expect(view.getByText("v0.2.0")).toBeDefined()
    expect(view.getAllByRole("listitem").length).toBeGreaterThan(0)
  } finally {
    view.unmount()
    native.mockRestore()
    init.mockRestore()
  }
})
