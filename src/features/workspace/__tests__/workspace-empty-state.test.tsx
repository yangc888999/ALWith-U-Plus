/**
 * QA regression for the "one-click repair" error paths. A fix that returns `null` or throws must
 * say something visible to the reader — the old bare `return` in FileWorkspace made 文件栏 a dead
 * click, and a silent heal would recreate exactly that failure. A successful heal must also write
 * the binding back so 查看会议文件 does not keep pointing at the Groups root.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const native = vi.hoisted(() => ({
  heal: vi.fn(async (_args: { name: string; directory: string }) => null as { directory: string; document: string } | null),
  pick: vi.fn(async () => null as string | null),
  pickGroup: vi.fn(async () => null as string | null),
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn()
}))

vi.mock("@/bindings", () => ({
  commands: {
    groupDirectoryHeal: native.heal,
    pickProjectDirectory: native.pick,
    pickGroupDirectory: native.pickGroup
  },
  events: new Proxy({}, { get: () => ({ name: "stub" }) })
}))
vi.mock("sonner", () => ({
  toast: { info: native.info, error: native.error, success: native.success }
}))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } })
}))
vi.mock("@/lib/groups", () => ({ groupByDirectory: () => null }))

import { projectDirectoryFor } from "../project-directory"
import { WorkspaceEmptyState } from "../workspace-empty-state"

const ROOT = "/Users/me/Documents/ALWith/groups"
const HEALED = "/Users/me/Documents/ALWith/groups/定价会"

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  native.heal.mockResolvedValue(null)
  native.pick.mockResolvedValue(null)
  native.pickGroup.mockResolvedValue(null)
})

test.each([
  ["heal finds no named subfolder", null, "info"],
  ["heal throws", new Error("heal failed"), "error"]
] as const)("%s still gives visible feedback instead of failing silently", async (_name, outcome, channel) => {
  if (outcome === null) native.heal.mockResolvedValue(null)
  else native.heal.mockRejectedValue(outcome)
  const onRetry = vi.fn()
  render(
    <WorkspaceEmptyState reason="invalid" directory={ROOT} bindingKey="qa-heal-failure" onRetry={onRetry} />
  )
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "workspace.fixDirectory" }))
  })
  // Wait for the async heal to settle; either channel must have fired exactly once.
  await waitFor(() => expect(native[channel]).toHaveBeenCalledTimes(1))
  if (channel === "error") expect(native.error).toHaveBeenCalledWith("heal failed")
  else expect(native.info).toHaveBeenCalledWith("groups.noMeetingSession")
  expect(native.success).not.toHaveBeenCalled()
  expect(projectDirectoryFor("qa-heal-failure")).toBeNull()
})

// Task #5 / ③: an invalid directory must never be a dead end when heal returns null. The manual
// picker is always rendered in that state and uses the group folder picker.
test("an invalid directory always offers a manual folder picker that binds the chosen meeting", async () => {
  native.pickGroup.mockResolvedValue(HEALED)
  const onRetry = vi.fn()
  render(
    <WorkspaceEmptyState reason="invalid" directory={ROOT} bindingKey="qa-manual-picker" onRetry={onRetry} />
  )
  expect(screen.getByRole("button", { name: "workspace.selectFileHint" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "workspace.fixDirectory" })).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "workspace.selectFileHint" }))
  })
  await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1))
  expect(native.pickGroup).toHaveBeenCalledTimes(1)
  expect(native.heal).not.toHaveBeenCalled()
  expect(projectDirectoryFor("qa-manual-picker")?.directory).toBe(HEALED)
  expect(native.success).toHaveBeenCalledWith("workspace.folderBound")
})

// Task #5 / ②: picking the Groups root used to toast "Project folder bound" while nothing changed.
// It must now be rejected with a reason and leave an invalid (not successful) binding.
test("picking the Groups root is rejected with a reason and never reports success", async () => {
  native.pick.mockResolvedValue(ROOT)
  const onRetry = vi.fn()
  render(
    <WorkspaceEmptyState reason="missing" bindingKey="qa-root-picked" onRetry={onRetry} />
  )
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "workspace.selectFileHint" }))
  })
  await waitFor(() => expect(native.error).toHaveBeenCalledWith("workspace.groupsRootPicked"))
  expect(native.success).not.toHaveBeenCalled()
  expect(native.info).not.toHaveBeenCalledWith("workspace.folderBound")
  expect(projectDirectoryFor("qa-root-picked")).toBeNull()
  expect(onRetry).toHaveBeenCalledTimes(1)
})

test("a successful heal writes the binding back and reopens the column", async () => {
  native.heal.mockResolvedValue({ directory: HEALED, document: `${HEALED}/group.md` })
  const onRetry = vi.fn()
  render(
    <WorkspaceEmptyState reason="invalid" directory={ROOT} bindingKey="qa-heal-success" onRetry={onRetry} />
  )
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "workspace.fixDirectory" }))
  })
  await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1))
  expect(native.heal).toHaveBeenCalledWith({ name: "groups", directory: ROOT })
  expect(projectDirectoryFor("qa-heal-success")?.directory).toBe(HEALED)
  expect(native.success).toHaveBeenCalledWith("groups.directoryHealed")
  expect(screen.getByText("workspace.directoryFixedHint")).toBeTruthy()
})
