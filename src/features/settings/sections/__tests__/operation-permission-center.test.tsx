import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeAll, beforeEach, expect, test, vi } from "vitest"

import { commands } from "@/bindings"
import { initI18n } from "@/lib/i18n"

import { OperationPermissionCenter } from "../operation-permission-center"

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }))
vi.mock("@/lib/platform", () => ({ isMac: () => true }))
vi.mock("@/bindings", () => ({
  commands: {
    permissionsCenterStatus: vi.fn(async () => [
      { id: "accessibility", granted: true, state: "authorized" },
      { id: "screenRecording", granted: false, state: "notAuthorized" },
      { id: "inputMonitoring", granted: false, state: "notDetermined" },
      { id: "fullDiskAccess", granted: false, state: "notAuthorized" },
      { id: "camera", granted: true, state: "authorized" },
      { id: "microphone", granted: false, state: "denied" }
    ]),
    permissionsCenterRequest: vi.fn(async () => null),
    permissionsCenterOpenSettings: vi.fn(async () => null),
    permissionsCenterOpenUrl: vi.fn(async () => null)
  }
}))

beforeAll(async () => {
  await initI18n("en")
})

beforeEach(() => {
  vi.clearAllMocks()
})

test("shows observable statuses and opens the correct authorization path", async () => {
  const { container } = render(<OperationPermissionCenter />)
  await waitFor(() => expect(screen.getByText("Observable permissions: 2/6 granted")).toBeTruthy())
  expect(screen.getByText("Accessibility")).toBeTruthy()
  expect(screen.getByText("Full Disk Access")).toBeTruthy()
  expect(screen.getByText("Files and folders")).toBeTruthy()

  const inputMonitoring = container.querySelector('[data-permission="inputMonitoring"]')
  if (inputMonitoring === null) throw new Error("input monitoring row missing")
  fireEvent.click(inputMonitoring.querySelector("button") as HTMLButtonElement)
  await waitFor(() =>
    expect(vi.mocked(commands.permissionsCenterRequest)).toHaveBeenCalledWith({ permission: "inputMonitoring" })
  )

  const screenRecording = container.querySelector('[data-permission="screenRecording"]')
  if (screenRecording === null) throw new Error("screen recording row missing")
  fireEvent.click(screenRecording.querySelector("button") as HTMLButtonElement)
  await waitFor(() =>
    expect(vi.mocked(commands.permissionsCenterOpenSettings)).toHaveBeenCalledWith({ permission: "screenRecording" })
  )
})

test("settings-only permissions use the backend System Settings deep link", async () => {
  const { container } = render(<OperationPermissionCenter />)
  const files = container.querySelector('[data-permission="filesAndFolders"]')
  if (files === null) throw new Error("files row missing")
  fireEvent.click(files.querySelector("button") as HTMLButtonElement)
  await waitFor(() =>
    expect(vi.mocked(commands.permissionsCenterOpenUrl)).toHaveBeenCalledWith({
      url: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"
    })
  )
})
