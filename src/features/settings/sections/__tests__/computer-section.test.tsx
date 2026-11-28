import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { must } from "@/lib/__tests__/must"
const native = vi.hoisted(() => ({
  permissionStatus: vi.fn(),
  permissionRequest: vi.fn(),
  permissionSettings: vi.fn(),
  enable: vi.fn(),
  stop: vi.fn(),
  reconnect: vi.fn(),
  phase: "disabled",
  lastError: null as string | null,
  enabled: false,
  permitted: false
}))
vi.mock("@/bindings", () => ({
  commands: {
    permissionsCenterStatus: native.permissionStatus,
    permissionsCenterRequest: native.permissionRequest,
    permissionsCenterOpenSettings: native.permissionSettings
  }
}))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }))
vi.mock("@/lib/open", () => ({ openExternal: vi.fn() }))
vi.mock("@/lib/platform", () => ({ isMac: () => true }))
vi.mock("@/features/computer/computer-control", () => ({
  useComputerStatus: () => ({
    status: {
      available: true,
      phase: native.phase,
      lastError: native.lastError,
      enabled: native.enabled,
      permissions: {
        supported: true,
        accessibility: native.permitted,
        screenCapture: native.permitted
      }
    },
    error: null
  })
}))
vi.mock("@/features/computer/operations", () => ({
  enableComputer: native.enable,
  stopComputer: native.stop,
  reconnectComputer: native.reconnect
}))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))
import { ComputerSection } from "../computer-section"
beforeEach(() => {
  native.phase = "disabled"
  native.lastError = null
  native.enabled = false
  native.permitted = false
  native.permissionStatus.mockResolvedValue([
    { id: "accessibility", granted: false, state: "notDetermined" },
    { id: "screenRecording", granted: false, state: "notAuthorized" }
  ])
  native.permissionRequest.mockResolvedValue(null)
  native.permissionSettings.mockResolvedValue(null)
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
test("permission settings stay reachable across requests and reopening the page", async () => {
  const first = render(<ComputerSection />)
  expect(screen.queryByRole("combobox")).toBeNull()
  await waitFor(() => expect(native.permissionStatus).toHaveBeenCalled())
  await waitFor(() => expect(screen.getByText("computer.permissionCenterState.notDetermined")).toBeTruthy())
  fireEvent.click(must(screen.getAllByRole("button", { name: "computer.permissionCenterOpen" })[0], "permission request"))
  await waitFor(() => expect(native.permissionRequest).toHaveBeenCalledWith({ permission: "accessibility" }))
  fireEvent.click(must(screen.getAllByRole("button", { name: "computer.permissionCenterOpen" })[1], "screen settings"))
  await waitFor(() => expect(native.permissionSettings).toHaveBeenCalledWith({ permission: "screenRecording" }))
  first.unmount()
  render(<ComputerSection />)
  await waitFor(() => expect(native.permissionStatus).toHaveBeenCalledTimes(2))
})

test("switch requires system permissions to enable and can stop globally after permissions are revoked", async () => {
  const view = render(<ComputerSection />)
  expect(screen.getByRole("switch")).toHaveAttribute("aria-disabled", "true")
  native.permitted = true
  view.rerender(<ComputerSection />)
  fireEvent.click(screen.getByRole("switch"))
  await waitFor(() => expect(native.enable).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.getByRole("switch")).not.toHaveAttribute("aria-disabled", "true"))
  native.enabled = true
  native.permitted = false
  view.rerender(<ComputerSection />)
  expect(screen.getByRole("switch")).toBeChecked()
  fireEvent.click(screen.getByRole("switch"))
  await waitFor(() => expect(native.stop).toHaveBeenCalledOnce())
})

test("failed capability verification remains visible and reconnect waits for completion", async () => {
  native.permitted = true
  native.phase = "failed"
  native.lastError = "capture unavailable"
  let resolve!: () => void
  native.reconnect.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done
      })
  )
  render(<ComputerSection />)
  expect(screen.getByRole("alert")).toHaveTextContent("capture unavailable")
  fireEvent.click(screen.getByRole("button", { name: "computer.reconnect" }))
  expect(native.reconnect).toHaveBeenCalledOnce()
  expect(screen.getByRole("button", { name: "computer.verifying" })).toBeDisabled()
  resolve()
  await waitFor(() => expect(screen.getByRole("button", { name: "computer.reconnect" })).not.toBeDisabled())
})
