// The sidebar's meeting panel: the create entry lives here (not only in settings), the empty state
// carries the primary action, and a meeting whose folder was never materialised creates it on the
// click of 新开一场 instead of greying the button out with a hint to visit settings.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { openPath } from "@tauri-apps/plugin-opener"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const native = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => ""),
  commands: {
    groupDirectoryCreate: vi.fn(async (_args: { name: string; parent: string | null }) => ({
      directory: "/Users/me/Documents/ALWith/groups/定价会",
      document: "/Users/me/Documents/ALWith/groups/定价会/group.md"
    })),
    groupDirectoryHeal: vi.fn(async (_args: { name: string; directory: string }) => null as { directory: string; document: string } | null),
    pickGroupDirectory: vi.fn(async () => null),
    groupMaterialIndex: vi.fn(async (_args: { path: string }) => ({ markdown: "### x\n- a.md" })),
    groupTailText: vi.fn(async (_args: { path: string; maxChars: number }) => ({ text: "", truncated: false }))
  }
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => true }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(async () => {}) }))
vi.mock("@/bindings", () => ({
  commands: native.commands,
  events: new Proxy({}, { get: () => ({ name: "stub" }) })
}))
vi.mock("@/lib/client", () => ({ client: { state: { sessions: {} } }, useApp: () => undefined }))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } })
}))

import { GroupPanel } from "../group-panel"
import { projectDirectoryFor } from "@/features/workspace/project-directory"
import { rememberGroupSessionRow, replaceGroupSessionRows } from "@/lib/group-sessions"
import { setGroup, type GroupConfig } from "@/lib/groups"
import { setGroupRole } from "@/lib/group-roles"

const memory = new Map<string, string>()

function group(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    id: "g1",
    name: "定价会",
    roles: ["role-a", "role-b"],
    rounds: 2,
    directory: "/Users/me/Documents/ALWith/groups/定价会",
    document: "/Users/me/Documents/ALWith/groups/定价会/group.md",
    topic: "",
    focus: "毛利弹性",
    materialFolders: ["/Users/me/BI导出/定价"],
    sessionId: null,
    autoDiscuss: true,
    ...overrides
  }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key)
  })
  memory.clear()
  native.commands.groupDirectoryCreate.mockClear()
  native.commands.groupDirectoryHeal.mockClear()
  native.commands.groupDirectoryHeal.mockResolvedValue(null)
  replaceGroupSessionRows([])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test("the empty state puts the create action on the panel itself", () => {
  render(<GroupPanel onSelect={() => undefined} onNewChat={() => undefined} />)
  expect(screen.getAllByText("groups.createEntry").length).toBeGreaterThan(0)
})

test("a meeting card shows the summarizer tag, the material count and the focus chip", () => {
  setGroupRole({ id: "role-a", name: "策略", model: "m", effort: null, persona: { kind: "inline", text: "" }, skill: null, moderator: false })
  setGroupRole({ id: "role-b", name: "CFO", model: "m", effort: null, persona: { kind: "inline", text: "" }, skill: null, moderator: false })
  setGroup(group())
  render(<GroupPanel onSelect={() => undefined} onNewChat={() => undefined} />)
  expect(screen.getByText("定价会")).toBeTruthy()
  // The roster line marks the last member as the summarizer and counts the material folders —
  // one element, so match the composed line with one pattern.
  expect(screen.getByText(/CFO（groups\.panelSummarizerTag）.*groups\.panelMaterialsTag/)).toBeTruthy()
  // Without any session row, 继续上次 is disabled with the explanatory tooltip.
  const continueButton = screen.getByText("groups.panelContinue").closest("button")
  expect(continueButton?.disabled).toBe(true)
})

test("继续上次 opens the latest session row of that meeting's directory", () => {
  setGroup(group())
  const opened: string[] = []
  const row = { sessionId: "s2", cwd: "/Users/me/Documents/ALWith/groups/定价会", title: "第二场", updatedAt: "2026-11-13T10:00:00Z", archived: false }
  rememberGroupSessionRow(row as never)
  render(
    <GroupPanel
      onSelect={(selected) => opened.push(selected.sessionId)}
      onNewChat={() => undefined}
    />
  )
  const button = screen.getByText("groups.panelContinue").closest("button")
  expect(button?.disabled).toBeFalsy()
  button?.click()
  expect(opened).toEqual(["s2"])
})

// Regression: the sessions menu's heading used Menu.GroupLabel without a Menu.Group, which threw
// Base UI error #31 the moment the menu opened and dropped the whole window into the error boundary.
test("opening the sessions menu renders its heading without crashing", async () => {
  setGroup(group())
  render(<GroupPanel onSelect={() => undefined} onNewChat={() => undefined} />)
  const trigger = screen.getByLabelText("groups.panelSessions")
  await act(async () => {
    trigger.click()
  })
  // The menu is open and its label is on screen — no boundary fallback anywhere.
  expect(await screen.findByText("groups.panelSessions", { selector: "[data-slot='dropdown-menu-label']" })).toBeTruthy()
  expect(screen.queryByText("errorBoundary.title")).toBeNull()
})

// Regression: the retired settings "attach" flow pinned a meeting onto `groups/` itself while its
// conversations ran in `groups/<会议名>/`. On mount the panel heals the record into the named
// subfolder, so 继续上一次 lights up and 新开一场 enters the meeting's own folder — not the parent.
test("a parent-pinned record heals into its named subfolder on mount", async () => {
  setGroup(group({ directory: "/Users/me/Documents/ALWith/groups/", document: "/Users/me/Documents/ALWith/groups/group.md" }))
  native.commands.groupDirectoryHeal.mockResolvedValue({
    directory: "/Users/me/Documents/ALWith/groups/定价会",
    document: "/Users/me/Documents/ALWith/groups/定价会/group.md"
  })
  const row = { sessionId: "s9", cwd: "/Users/me/Documents/ALWith/groups/定价会", title: "上一场", updatedAt: "2026-11-13T10:00:00Z", archived: false }
  rememberGroupSessionRow(row as never)
  const entered: string[] = []
  render(<GroupPanel onSelect={() => undefined} onNewChat={(cwd) => entered.push(cwd)} />)
  await act(async () => {})
  expect(native.commands.groupDirectoryHeal).toHaveBeenCalledWith({
    name: "定价会",
    directory: "/Users/me/Documents/ALWith/groups/"
  })
  const stored = JSON.parse(memory.get("alwith:groups") ?? "[]") as Array<{ directory: string }>
  expect(stored[0]?.directory).toBe("/Users/me/Documents/ALWith/groups/定价会")
  // The session in the subfolder now matches: 继续上一次 is enabled.
  const continueButton = screen.getByText("groups.panelContinue").closest("button")
  expect(continueButton?.disabled).toBeFalsy()
  // And 新开一场 enters the healed folder, not the parent.
  await act(async () => {
    screen.getByText("groups.panelNew").closest("button")?.click()
  })
  expect(entered).toEqual(["/Users/me/Documents/ALWith/groups/定价会"])
})

test("a record with no named subfolder is left alone (heal returns null)", async () => {
  setGroup(group({ directory: "/Users/me/项目/定价资料", document: "" }))
  render(<GroupPanel onSelect={() => undefined} onNewChat={() => undefined} />)
  await act(async () => {})
  const stored = JSON.parse(memory.get("alwith:groups") ?? "[]") as Array<{ directory: string }>
  expect(stored[0]?.directory).toBe("/Users/me/项目/定价资料")
})

test("新开一场 on a folder-less draft materialises the directory, stores it, then enters", async () => {
  setGroup(group({ directory: "", document: "" }))
  const entered: string[] = []
  render(<GroupPanel onSelect={() => undefined} onNewChat={(cwd) => entered.push(cwd)} />)
  const button = screen.getByText("groups.panelNew").closest("button")
  expect(button?.disabled).toBeFalsy()
  await act(async () => {
    button?.click()
  })
  expect(native.commands.groupDirectoryCreate).toHaveBeenCalledWith({
    name: "定价会",
    parent: null,
    topic: null,
    focus: "毛利弹性"
  })
  expect(entered).toEqual(["/Users/me/Documents/ALWith/groups/定价会"])
  // And the stored config now carries the directory, so a second click does not re-create it.
  const stored = JSON.parse(memory.get("alwith:groups") ?? "[]") as Array<{ directory: string }>
  expect(stored[0]?.directory).toBe("/Users/me/Documents/ALWith/groups/定价会")
})

// Regression: 新开一场 on a folder-less meeting used to have no pending state — a second click
// (button or sessions menu) while the first groupDirectoryCreate was still in flight launched a
// concurrent create and a second enter, racing two writers over the same meeting folder.
test("新开一场 locks the card while the folder create is in flight; no concurrent second create", async () => {
  let resolveCreate!: (value: { directory: string; document: string }) => void
  native.commands.groupDirectoryCreate.mockImplementationOnce(
    () => new Promise((resolve) => void (resolveCreate = resolve))
  )
  setGroup(group({ directory: "", document: "" }))
  const entered: string[] = []
  render(<GroupPanel onSelect={() => undefined} onNewChat={(cwd) => entered.push(cwd)} />)
  const button = screen.getByText("groups.panelNew").closest("button")
  await act(async () => {
    button?.click()
  })
  expect(native.commands.groupDirectoryCreate).toHaveBeenCalledTimes(1)
  // While pending, the card shows the spinner copy on a disabled button.
  const pending = screen.getByText("groups.panelOpening").closest("button")
  expect(pending?.disabled).toBe(true)
  expect(pending?.querySelector(".animate-spin")).not.toBeNull()
  expect(entered).toEqual([])
  // A fast second click (fireEvent dispatches even on the disabled button; the in-flight guard
  // must swallow it) starts nothing new.
  await act(async () => {
    fireEvent.click(pending as HTMLElement)
  })
  expect(native.commands.groupDirectoryCreate).toHaveBeenCalledTimes(1)
  // Resolving the create enters once, stores the folder, and unlocks the card again.
  await act(async () => {
    resolveCreate({
      directory: "/Users/me/Documents/ALWith/groups/定价会",
      document: "/Users/me/Documents/ALWith/groups/定价会/group.md"
    })
  })
  expect(entered).toEqual(["/Users/me/Documents/ALWith/groups/定价会"])
  const restored = screen.getByText("groups.panelNew").closest("button")
  expect(restored?.disabled).toBeFalsy()
})

// The guard above this test's second click is the `disabled` attribute — that click lands after
// a re-render. This one pins the other half: both clicks inside a single act() with no flush
// between them, so only the synchronous `startingRef` short-circuit inside startNew can stop the
// second create (dropping that ref check turns this red while every other case stays green).
test("two same-frame clicks on 新开一场 are swallowed by the in-flight ref guard, not the disabled prop", async () => {
  let resolveCreate!: (value: { directory: string; document: string }) => void
  native.commands.groupDirectoryCreate.mockImplementationOnce(
    () => new Promise((resolve) => void (resolveCreate = resolve))
  )
  setGroup(group({ directory: "", document: "" }))
  const entered: string[] = []
  render(<GroupPanel onSelect={() => undefined} onNewChat={(cwd) => entered.push(cwd)} />)
  const button = screen.getByText("groups.panelNew").closest("button") as HTMLElement
  await act(async () => {
    fireEvent.click(button)
    fireEvent.click(button)
  })
  expect(native.commands.groupDirectoryCreate).toHaveBeenCalledTimes(1)
  expect(entered).toEqual([])
  // Unlock at the end so no create promise is left dangling into the next case.
  await act(async () => {
    resolveCreate({
      directory: "/Users/me/Documents/ALWith/groups/定价会",
      document: "/Users/me/Documents/ALWith/groups/定价会/group.md"
    })
  })
  expect(entered).toEqual(["/Users/me/Documents/ALWith/groups/定价会"])
})

test("with a create in flight the sessions menu 新开一场 is disabled and cannot double-fire", async () => {
  let resolveCreate!: (value: { directory: string; document: string }) => void
  native.commands.groupDirectoryCreate.mockImplementationOnce(
    () => new Promise((resolve) => void (resolveCreate = resolve))
  )
  setGroup(group({ directory: "", document: "" }))
  render(<GroupPanel onSelect={() => undefined} onNewChat={() => undefined} />)
  // Start the create from the card button so the menu opens straight into the pending state.
  await act(async () => {
    screen.getByText("groups.panelNew").closest("button")?.click()
  })
  expect(native.commands.groupDirectoryCreate).toHaveBeenCalledTimes(1)
  await act(async () => {
    screen.getByLabelText("groups.panelSessions").click()
  })
  const pendingItem = await screen.findByRole("menuitem", { name: "groups.panelOpening" })
  expect(pendingItem.hasAttribute("data-disabled")).toBe(true)
  await act(async () => {
    fireEvent.click(pendingItem)
  })
  // The menu item click bypasses nothing: still exactly one create.
  expect(native.commands.groupDirectoryCreate).toHaveBeenCalledTimes(1)
  await act(async () => {
    resolveCreate({
      directory: "/Users/me/Documents/ALWith/groups/定价会",
      document: "/Users/me/Documents/ALWith/groups/定价会/group.md"
    })
  })
  expect(await screen.findByRole("menuitem", { name: "groups.panelNew" })).toBeTruthy()
})

test("a failed create keeps the existing toast behaviour and unlocks the card for a retry", async () => {
  native.commands.groupDirectoryCreate.mockRejectedValueOnce(new Error("disk full"))
  setGroup(group({ directory: "", document: "" }))
  render(<GroupPanel onSelect={() => undefined} onNewChat={() => undefined} />)
  await act(async () => {
    screen.getByText("groups.panelNew").closest("button")?.click()
  })
  // The rejection clears the pending flag, so the button is clickable again.
  const retry = await screen.findByText("groups.panelNew")
  expect(retry.closest("button")?.disabled).toBeFalsy()
})

test("查看会议文件 opens the meeting folder on the current surface without a new chat", async () => {
  setGroup(group())
  const onViewFiles = vi.fn()
  const onNewChat = vi.fn()
  render(
    <GroupPanel onSelect={() => undefined} onNewChat={onNewChat} onViewFiles={onViewFiles} />
  )
  const trigger = screen.getByLabelText("groups.panelSessions")
  await act(async () => {
    trigger.click()
  })
  const item = await screen.findByRole("menuitem", { name: "groups.openMeetingFiles" })
  await act(async () => {
    fireEvent.click(item)
  })
  expect(onViewFiles).toHaveBeenCalledWith("/Users/me/Documents/ALWith/groups/定价会", "g1")
  expect(onNewChat).not.toHaveBeenCalled()
  // The 在访达中显示 entry is still there.
  expect(screen.getByText("groups.openFolder")).toBeTruthy()
})

test("查看会议文件 with a session opens that conversation and binds its meeting directory", async () => {
  setGroup(group())
  const onSelect = vi.fn()
  const row = {
    sessionId: "view-files-s1",
    cwd: "/Users/me/Documents/ALWith/groups/定价会",
    title: "上一场",
    updatedAt: "2026-11-13T10:00:00Z",
    archived: false
  }
  rememberGroupSessionRow(row as never)
  render(<GroupPanel onSelect={onSelect} onNewChat={() => undefined} onViewFiles={vi.fn()} />)
  const trigger = screen.getByLabelText("groups.panelSessions")
  await act(async () => {
    trigger.click()
  })
  const item = await screen.findByRole("menuitem", { name: "groups.openMeetingFiles" })
  await act(async () => {
    fireEvent.click(item)
  })
  expect(onSelect).toHaveBeenCalledWith(row)
  expect(projectDirectoryFor("view-files-s1")?.directory).toBe("/Users/me/Documents/ALWith/groups/定价会")
  expect(projectDirectoryFor("view-files-s1")?.groupId).toBe("g1")
})

test("a healed directory is written into the project-directory binding", async () => {
  setGroup(group({ directory: "/Users/me/Documents/ALWith/groups/", document: "" }))
  native.commands.groupDirectoryHeal.mockResolvedValue({
    directory: "/Users/me/Documents/ALWith/groups/定价会",
    document: "/Users/me/Documents/ALWith/groups/定价会/group.md"
  })
  const row = {
    sessionId: "heal-bind-s1",
    cwd: "/Users/me/Documents/ALWith/groups/定价会",
    title: "上一场",
    updatedAt: "2026-11-13T10:00:00Z",
    archived: false
  }
  rememberGroupSessionRow(row as never)
  render(<GroupPanel onSelect={() => undefined} onNewChat={() => undefined} />)
  await act(async () => {})
  expect(projectDirectoryFor("heal-bind-s1")?.directory).toBe("/Users/me/Documents/ALWith/groups/定价会")
  expect(projectDirectoryFor("heal-bind-s1")?.groupId).toBe("g1")
})

// Base UI 1.9's Menu.Item fires `onClick`; the old `onSelect` handlers were DOM selection
// handlers and never ran, so the preserved 在访达中显示 entry was a dead click.
test("在访达中显示 still opens the meeting folder from the menu", async () => {
  vi.mocked(openPath).mockClear()
  setGroup(group())
  render(<GroupPanel onSelect={() => undefined} onNewChat={() => undefined} />)
  await act(async () => {
    screen.getByLabelText("groups.panelSessions").click()
  })
  const item = await screen.findByRole("menuitem", { name: "groups.openFolder" })
  await act(async () => {
    fireEvent.click(item)
  })
  expect(openPath).toHaveBeenCalledWith("/Users/me/Documents/ALWith/groups/定价会")
})
