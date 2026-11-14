// The create-meeting dialog runs the three steps in order — folder, config, enter — and keeps
// failures on the dialog instead of only in a toast. These tests pin the contract the sidebar
// relies on: name required, suggested roster prefilled, collision confirmed before joining, and
// a failed directory creation retryable without losing what was typed.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const native = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string) => ""),
  commands: {
    groupDirectoryCreate: vi.fn(async (_args: { name: string; parent: string | null }) => ({
      directory: "/Users/me/Documents/ALWith/groups/Q4",
      document: "/Users/me/Documents/ALWith/groups/Q4/group.md"
    })),
    pickGroupDirectory: vi.fn(async (): Promise<string | null> => null),
    groupMaterialIndex: vi.fn(async (_args: { path: string }) => ({ markdown: "### ok\n- a.md" })),
    groupTailText: vi.fn(async (_args: { path: string; maxChars: number }) => ({ text: "", truncated: false }))
  }
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => true }))
vi.mock("@/bindings", () => ({
  commands: native.commands,
  events: new Proxy({}, { get: () => ({ name: "stub" }) })
}))
vi.mock("@/lib/window-manager", () => ({ openSettingsWindow: vi.fn(async () => {}) }))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } })
}))

import { CreateMeetingDialog } from "../create-meeting-dialog"
import { setGroup } from "@/lib/groups"
import { setGroupRole } from "@/lib/group-roles"

const memory = new Map<string, string>()

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key)
  })
  memory.clear()
  native.commands.groupDirectoryCreate.mockClear()
  native.commands.groupDirectoryCreate.mockResolvedValue({
    directory: "/Users/me/Documents/ALWith/groups/Q4",
    document: "/Users/me/Documents/ALWith/groups/Q4/group.md"
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function seedRoles(): void {
  for (const [id, name] of [
    ["r1", "策略"],
    ["r2", "数据"],
    ["r3", "CFO"],
    ["r4", "法务"]
  ]) {
    setGroupRole({ id, name, model: "m", effort: null, persona: { kind: "inline", text: "" }, skill: null, moderator: false })
  }
}

test("submit is blocked until a name exists; opening prefills the suggested roster", () => {
  seedRoles()
  render(<CreateMeetingDialog open group={null} onClose={() => undefined} onCreated={() => undefined} />)
  const submit = screen.getByText("groups.createSubmit").closest("button")
  expect(submit?.disabled).toBe(true)
  // The first three stored roles become the suggested roster (last = summarizer).
  expect(screen.getByText("策略")).toBeTruthy()
  expect(screen.getByText("数据")).toBeTruthy()
  expect(screen.getByText("CFO")).toBeTruthy()
  expect(screen.getByText("groups.roleSummarizerBadge")).toBeTruthy()
})

test("the happy path creates the folder, stores focus and materials, then enters", async () => {
  seedRoles()
  const user = userEvent.setup()
  const created: Array<{ directory: string; focus: string; materials: number }> = []
  render(
    <CreateMeetingDialog
      open
      group={null}
      onClose={() => undefined}
      onCreated={(record, directory) =>
        created.push({ directory, focus: record.focus, materials: record.materialFolders.length })
      }
    />
  )
  await user.type(screen.getByPlaceholderText("groups.createNamePlaceholder"), "Q4 定价")
  await user.type(screen.getByPlaceholderText("groups.createFocusPlaceholder"), "毛利弹性")
  native.commands.pickGroupDirectory.mockResolvedValueOnce("/Users/me/BI导出/定价")
  await user.click(screen.getByText("groups.createAddFolder"))
  await waitFor(() => expect(screen.getByText("定价")).toBeTruthy())
  await user.click(screen.getByText("groups.createSubmit"))
  await waitFor(() => expect(created).toHaveLength(1))
  expect(native.commands.groupDirectoryCreate).toHaveBeenCalledWith({ name: "Q4 定价", parent: null })
  expect(created[0]).toEqual({
    directory: "/Users/me/Documents/ALWith/groups/Q4",
    focus: "毛利弹性",
    materials: 1
  })
})

test("a name that collides with an existing meeting asks for confirmation before joining", async () => {
  seedRoles()
  setGroup({
    id: "existing",
    name: "Q4 定价",
    roles: [],
    rounds: 2,
    directory: "/Users/me/Documents/ALWith/groups/Q4-定价",
    document: "",
    topic: "",
    focus: "",
    materialFolders: [],
    sessionId: null,
    autoDiscuss: true
  })
  const user = userEvent.setup()
  render(<CreateMeetingDialog open group={null} onClose={() => undefined} onCreated={() => undefined} />)
  await user.type(screen.getByPlaceholderText("groups.createNamePlaceholder"), "Q4 定价")
  await user.click(screen.getByText("groups.createSubmit"))
  // First click only raises the warning; nothing was created yet.
  expect(await screen.findByText("groups.createCollision")).toBeTruthy()
  expect(native.commands.groupDirectoryCreate).not.toHaveBeenCalled()
  await user.click(screen.getByText("groups.createCollisionConfirm"))
  await waitFor(() => expect(native.commands.groupDirectoryCreate).toHaveBeenCalled())
})

test("a failed directory creation stays on the dialog for a retry", async () => {
  seedRoles()
  native.commands.groupDirectoryCreate.mockRejectedValueOnce(new Error("disk full"))
  const user = userEvent.setup()
  render(<CreateMeetingDialog open group={null} onClose={() => undefined} onCreated={() => undefined} />)
  await user.type(screen.getByPlaceholderText("groups.createNamePlaceholder"), "Q4 定价")
  await user.click(screen.getByText("groups.createSubmit"))
  expect(await screen.findByText("disk full")).toBeTruthy()
  // The typed name survives the failure so the retry is one click.
  expect(screen.getByDisplayValue("Q4 定价")).toBeTruthy()
  await user.click(screen.getByText("groups.createSubmit"))
  await waitFor(() => expect(native.commands.groupDirectoryCreate).toHaveBeenCalledTimes(2))
})

test("picking a parent folder previews <parent>/<slug> and submits with that parent; reset restores the default", async () => {
  seedRoles()
  const user = userEvent.setup()
  render(<CreateMeetingDialog open group={null} onClose={() => undefined} onCreated={() => undefined} />)
  await user.type(screen.getByPlaceholderText("groups.createNamePlaceholder"), "Q4 定价")
  // Before any pick, the preview already names the default target so nothing is a surprise.
  expect(screen.getByText("groups.createFolderTarget", { exact: false }).textContent).toContain(
    "~/Documents/ALWith/groups/Q4-定价"
  )
  native.commands.pickGroupDirectory.mockResolvedValueOnce("/Users/me/会议/")
  await user.click(screen.getByText("groups.createPickParent"))
  await waitFor(() =>
    expect(screen.getByText("groups.createFolderTarget", { exact: false }).textContent).toContain(
      "/Users/me/会议/Q4-定价"
    )
  )
  await user.click(screen.getByText("groups.createSubmit"))
  await waitFor(() =>
    expect(native.commands.groupDirectoryCreate).toHaveBeenCalledWith({ name: "Q4 定价", parent: "/Users/me/会议" })
  )
})

test("resetting the parent returns the preview to the default location", async () => {
  seedRoles()
  const user = userEvent.setup()
  render(<CreateMeetingDialog open group={null} onClose={() => undefined} onCreated={() => undefined} />)
  await user.type(screen.getByPlaceholderText("groups.createNamePlaceholder"), "周会")
  native.commands.pickGroupDirectory.mockResolvedValueOnce("/Users/me/工作")
  await user.click(screen.getByText("groups.createPickParent"))
  await waitFor(() =>
    expect(screen.getByText("groups.createFolderTarget", { exact: false }).textContent).toContain("/Users/me/工作/周会")
  )
  await user.click(screen.getByText("groups.createUseAuto"))
  expect(screen.getByText("groups.createFolderTarget", { exact: false }).textContent).toContain(
    "~/Documents/ALWith/groups/周会"
  )
})

// The topic and the auto-discuss switch used to live only in the settings page's duplicate
// meeting list; the dialog owns them now, in both create and edit mode.
test("the dialog stores the topic and the auto-discuss switch", async () => {
  seedRoles()
  const user = userEvent.setup()
  const created: Array<{ topic: string; autoDiscuss: boolean }> = []
  render(
    <CreateMeetingDialog
      open
      group={null}
      onClose={() => undefined}
      onCreated={(record) => created.push({ topic: record.topic, autoDiscuss: record.autoDiscuss })}
    />
  )
  await user.type(screen.getByPlaceholderText("groups.createNamePlaceholder"), "Q4 定价")
  await user.type(screen.getByPlaceholderText("groups.fieldTopicPlaceholder"), "余额下降到底是谁的锅？")
  await user.click(screen.getByLabelText("groups.groupAutoDiscuss"))
  await user.click(screen.getByText("groups.createSubmit"))
  await waitFor(() => expect(created).toHaveLength(1))
  expect(created[0]).toEqual({ topic: "余额下降到底是谁的锅？", autoDiscuss: false })
})

test("edit mode prefills the topic and keeps it on save", async () => {
  seedRoles()
  const existing = {
    id: "g-edit",
    name: "Q4 定价",
    roles: ["r1", "r2"],
    rounds: 2,
    directory: "/Users/me/Documents/ALWith/groups/Q4",
    document: "/Users/me/Documents/ALWith/groups/Q4/group.md",
    topic: "旧议题",
    focus: "",
    materialFolders: [],
    sessionId: null,
    autoDiscuss: false
  }
  setGroup(existing)
  const user = userEvent.setup()
  const saved: Array<{ topic: string; autoDiscuss: boolean }> = []
  render(
    <CreateMeetingDialog
      open
      group={existing}
      onClose={() => undefined}
      onCreated={(record) => saved.push({ topic: record.topic, autoDiscuss: record.autoDiscuss })}
    />
  )
  expect(screen.getByDisplayValue("旧议题")).toBeTruthy()
  const topicField = screen.getByPlaceholderText("groups.fieldTopicPlaceholder")
  await user.clear(topicField)
  // fireEvent.change sets the whole value at once — userEvent.type sends CJK one char at a time
  // and the controlled textarea can drop characters mid-composition.
  fireEvent.change(topicField, { target: { value: "新议题" } })
  await user.click(screen.getByText("groups.createSave"))
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(saved[0]).toEqual({ topic: "新议题", autoDiscuss: false })
  // Editing never re-creates the folder.
  expect(native.commands.groupDirectoryCreate).not.toHaveBeenCalled()
})

test("a missing material folder shows the retry control", async () => {
  seedRoles()
  native.commands.groupMaterialIndex.mockRejectedValueOnce(new Error("missing"))
  const user = userEvent.setup()
  render(<CreateMeetingDialog open group={null} onClose={() => undefined} onCreated={() => undefined} />)
  native.commands.pickGroupDirectory.mockResolvedValueOnce("/gone/path")
  await user.click(screen.getByText("groups.createAddFolder"))
  expect(await screen.findByText("groups.createMaterialRetry")).toBeTruthy()
})
