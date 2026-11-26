import * as core from "@tauri-apps/api/core"
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks"
import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { afterEach, expect, test, vi } from "vitest"

import { type UpdaterState, useUpdaterStore } from "@/features/updater/store"
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

test("a failed update check shows one retry-later status without a manual download", async () => {
  const native = vi.spyOn(core, "isTauri").mockReturnValue(true)
  const init = vi.spyOn(useUpdaterStore.getState(), "init").mockResolvedValue()
  const originalState = useUpdaterStore.getState()
  useUpdaterStore.setState({ state: { type: "checkFailed", reason: "network" } })
  mockIPC((command) => {
    if (command === "plugin:app|version") return "0.2.0"
    if (command === "codex_version") return "0.159.2"
    throw new Error(`Unexpected command: ${command}`)
  })
  const view = render(<AboutSection />)
  try {
    await waitFor(() => {
      expect(view.getByText("The update service is temporarily unavailable. Try again later.")).toBeDefined()
    })
    expect(view.queryByText("Up to date")).toBeNull()
    // The plugin's own wording (URLs, "release JSON") is diagnostics, never UI copy.
    expect(view.queryByText(/release JSON/)).toBeNull()
    expect(view.queryByRole("button", { name: "Download" })).toBeNull()
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

// The update state is one slot on the About page: a status capsule, or — in `ready` — the install
// button. A second element repeating the same sentence is the 1.0.2 bug this suite pins down.
const INSTALLING = "Installing…"
const READY_DESC = "Downloaded — click to update"
const update = { version: "1.0.3", filename: "update.tar.gz", signature: "sig", contentLength: 100 }
const pristine = useUpdaterStore.getState()

/** Mounts the About page with the updater pinned to `state`; init is stubbed so nothing resets it. */
function renderAbout(state: UpdaterState) {
  const native = vi.spyOn(core, "isTauri").mockReturnValue(true)
  const init = vi.spyOn(useUpdaterStore.getState(), "init").mockResolvedValue()
  mockIPC((command) => {
    if (command === "plugin:app|version") return "1.0.2"
    if (command === "codex_version") return "0.159.2"
    throw new Error(`Unexpected command: ${command}`)
  })
  useUpdaterStore.setState({ state })
  const view = render(<AboutSection />)
  return {
    view,
    dispose: () => {
      view.unmount()
      useUpdaterStore.setState({
        state: { type: "uninitialized" },
        confirmInstallAndRelaunch: pristine.confirmInstallAndRelaunch
      })
      native.mockRestore()
      init.mockRestore()
    }
  }
}

test.each<[string, UpdaterState, string]>([
  ["idle", { type: "idle" }, "Up to date"],
  ["checkingForUpdates", { type: "checkingForUpdates" }, "Checking…"],
  ["downloading", { type: "downloading", update, downloadedBytes: 42, totalBytes: 100 }, "Downloaded 42%"],
  ["availableForDownload", { type: "availableForDownload", update }, "Downloaded 0%"],
  ["ready", { type: "ready", update }, "Downloaded — click to update"],
  ["restarting", { type: "restarting", update }, INSTALLING],
  [
    "checkFailed",
    { type: "checkFailed", reason: "unavailable" },
    "The update service is temporarily unavailable. Try again later."
  ]
])("the %s state is stated exactly once on the About page", (_name, state, expected) => {
  const { view, dispose } = renderAbout(state)
  try {
    expect(view.getAllByText(expected)).toHaveLength(1)
    // One slot only: either the live status capsule or the single install button.
    const installButtons = view.queryAllByRole("button", { name: /Downloaded — click to update/ })
    const statuses = view.queryAllByRole("status")
    expect(statuses.length + installButtons.length).toBe(1)
  } finally {
    dispose()
  }
})

// Regression: the identity card used to render a dot capsule *and* a disabled button, both printing
// the installing sentence, so the About page showed it twice side by side.
test("installing is reported once — no second capsule or button repeats it", () => {
  const { view, dispose } = renderAbout({ type: "restarting", update })
  try {
    expect(view.getAllByText(INSTALLING)).toHaveLength(1)
    expect(view.getAllByRole("status")).toHaveLength(1)
    expect(view.queryAllByRole("button", { name: /Installing|Downloaded — click to update/ })).toHaveLength(0)
  } finally {
    dispose()
  }
})

test("a ready update turns the single slot into the install action", async () => {
  const confirm = vi.fn<() => Promise<void>>().mockResolvedValue()
  useUpdaterStore.setState({ confirmInstallAndRelaunch: confirm })
  const { view, dispose } = renderAbout({ type: "ready", update })
  try {
    const button = view.getByRole("button", { name: "Downloaded — click to update" })
    // The download confirmation is the tooltip, not a second visible line above the button.
    expect(button).toHaveAttribute("title", READY_DESC)
    await act(() => Promise.try(() => fireEvent.click(button)))
    expect(confirm).toHaveBeenCalledOnce()
  } finally {
    dispose()
  }
})

test("an install that fails drops back to the single ready action so it can be retried", async () => {
  const { view, dispose } = renderAbout({ type: "restarting", update })
  try {
    expect(view.getAllByText(INSTALLING)).toHaveLength(1)
    // Rust restores `ready` when the installer reports an error, so the row must not stay busy.
    await act(() => Promise.try(() => useUpdaterStore.setState({ state: { type: "ready", update } })))
    expect(view.getAllByText("Downloaded — click to update")).toHaveLength(1)
    expect(view.queryByText(INSTALLING)).toBeNull()
    expect(view.queryAllByRole("status")).toHaveLength(0)
  } finally {
    dispose()
  }
})
