// The group settings page owns the ROLE LIBRARY and the discussion defaults only — the meetings
// themselves live in the sidebar panel. A second editable meeting list here was the same data
// twice (and its old "attach folder" flow pinned a meeting onto `groups/` itself), so it is gone.
// These tests pin that contract, plus the original regression: a role deleted while a group still
// names it must not blank the page.

import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const native = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string) => [] as unknown)
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => true }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(async () => {}) }))
vi.mock("@/lib/use-providers", () => ({ useProviders: () => null }))
// `undefined` is the bridge's real "not answered yet" value; the settings window has no session of
// its own, so the GPT group starts empty in these tests.
vi.mock("@/lib/settings-bridge", () => ({ useSettingsNativeModels: () => undefined }))
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" }
  })
}))

import { GroupSection } from "../group-section"
import { groupRoles, setGroupRole, removeGroupRole } from "@/lib/group-roles"
import { setGroup } from "@/lib/groups"

const memory = new Map<string, string>()

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key)
  })
  memory.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function seedGroupWithDanglingRole(): void {
  setGroupRole({
    id: "role-a",
    name: "架构师",
    model: "gpt-6.1-sol",
    effort: null,
    persona: { kind: "inline", text: "看架构" },
    skill: null,
    moderator: false
  })
  setGroupRole({
    id: "role-b",
    name: "评审",
    model: "gpt-6.1-sol",
    effort: null,
    persona: { kind: "inline", text: "挑错" },
    skill: null,
    moderator: false
  })
  setGroup({
    id: "group-1",
    name: "支付告警会",
    roles: ["role-a", "role-deleted", "role-b"],
    rounds: 2,
    directory: "/tmp/group",
    document: "",
    topic: "",
    focus: "",
    materialFolders: [],
    sessionId: null,
    autoDiscuss: true
  })
}

test("the page shows the role library and defaults, not a second meeting list", () => {
  seedGroupWithDanglingRole()
  render(<GroupSection />)
  // The role library is here…
  expect(screen.getByText("groups.rolesTitle")).toBeTruthy()
  expect(screen.getByDisplayValue("架构师")).toBeTruthy()
  expect(screen.getByDisplayValue("评审")).toBeTruthy()
  // …and the discussion defaults…
  expect(screen.getByText("groups.defaultsTitle")).toBeTruthy()
  // …but the stored meeting is NOT rendered as an editable card: meetings are managed from the
  // sidebar panel, so there is no name input, no location row and no attach button for it here.
  expect(screen.queryByDisplayValue("支付告警会")).toBeNull()
  expect(screen.queryByText("groups.addGroup")).toBeNull()
  expect(screen.queryByText("groups.chooseFolder")).toBeNull()
})

test("a group naming a deleted role still renders (dangling id, not a crash)", () => {
  seedGroupWithDanglingRole()
  render(<GroupSection />)
  // The page is alive: the two surviving roles are on screen; the deleted one contributes nothing.
  expect(screen.getByDisplayValue("架构师")).toBeTruthy()
  expect(screen.getByDisplayValue("评审")).toBeTruthy()
  expect(groupRoles().map((role) => role.id)).toEqual(["role-a", "role-b"])
})

test("removing a role a group still references does not blank the page", () => {
  setGroupRole({
    id: "role-c",
    name: "财务",
    model: "gpt-6.1-sol",
    effort: null,
    persona: { kind: "inline", text: "看成本" },
    skill: null,
    moderator: false
  })
  setGroup({
    id: "group-2",
    name: "预算会",
    roles: ["role-c"],
    rounds: 2,
    directory: "/tmp/group2",
    document: "",
    topic: "",
    focus: "",
    materialFolders: [],
    sessionId: null,
    autoDiscuss: true
  })
  const view = render(<GroupSection />)
  act(() => {
    removeGroupRole("role-c")
  })
  // A re-render with the now-dangling id in the group's roster must not throw.
  view.rerender(<GroupSection />)
  expect(screen.getByText("groups.rolesTitle")).toBeTruthy()
})