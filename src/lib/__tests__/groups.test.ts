// The stores are the user's work: a role or a group that the app refuses to load after a
// restart is work lost. The parsers therefore keep only what they understand and drop the rest.

import { beforeEach, expect, test } from "vitest"

import { groupRoleFor, groupRoles, newRoleId, removeGroupRole, setGroupRole, type GroupRole } from "@/lib/group-roles"
import { groupByDirectory, groups, newGroupId, removeGroup, setGroup, type GroupConfig } from "@/lib/groups"

function role(overrides: Partial<GroupRole> = {}): GroupRole {
  return {
    id: newRoleId(),
    name: "架构师",
    model: "gpt-6.1-sol",
    effort: null,
    persona: { kind: "inline", text: "看架构" },
    skill: null,
    moderator: false,
    ...overrides
  }
}

function group(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    id: newGroupId(),
    name: "支付告警",
    roles: [],
    rounds: 2,
    directory: "/Users/me/Documents/ALWith/groups/支付告警",
    document: "/Users/me/Documents/ALWith/groups/支付告警/group.md",
    topic: "",
    sessionId: null,
    autoDiscuss: true,
    ...overrides
  }
}

beforeEach(() => {
  localStorage.clear()
})

test("a role round-trips through storage", () => {
  const entry = role()
  setGroupRole(entry)
  expect(groupRoleFor(entry.id)).toEqual(entry)
})

// The pre-2026-11 shape stored one `definition`; a stored role must survive the split into
// persona + skill instead of being dropped as unreadable.
test("a legacy definition is migrated, not dropped", () => {
  localStorage.setItem(
    "alwith:group-roles",
    JSON.stringify([{ id: "old", name: "老角色", model: "m", definition: { kind: "skill", id: "yup-kb" } }])
  )
  expect(groupRoleFor("old")?.skill).toBe("yup-kb")
})

test("a role can point at a markdown file or a skill", () => {
  const fromFile = role({ persona: { kind: "file", path: "/tmp/role.md" } })
  const fromSkill = role({ persona: { kind: "inline", text: "" }, skill: "yup-kb" })
  setGroupRole(fromFile)
  setGroupRole(fromSkill)
  expect(groupRoleFor(fromFile.id)?.persona).toEqual({ kind: "file", path: "/tmp/role.md" })
  expect(groupRoleFor(fromSkill.id)?.skill).toBe("yup-kb")
})

test("a broken role in storage is dropped instead of breaking the list", () => {
  localStorage.setItem(
    "alwith:group-roles",
    JSON.stringify([{ id: "ok", name: "评审", model: "m", definition: { kind: "inline", text: "x" } }, { id: "bad" }])
  )
  // The store caches; a fresh read happens on the next launch, so clear the cache by reloading.
  localStorage.setItem(
    "alwith:group-roles",
    JSON.stringify([{ id: "bad", model: "m", definition: { kind: "inline", text: "x" } }])
  )
  // A missing name is a broken record and gets dropped; an empty name is a rename mid-flight and
  // stays, otherwise clearing the field while retyping would delete the role.
  expect(groupRoles().every((entry) => entry.id !== "bad")).toBe(true)
})

test("removing a role takes it out of the list", () => {
  const entry = role()
  setGroupRole(entry)
  removeGroupRole(entry.id)
  expect(groupRoleFor(entry.id)).toBeNull()
})

test("a group round-trips and is found by its directory", () => {
  const entry = group()
  setGroup(entry)
  expect(groups()).toHaveLength(1)
  expect(groupByDirectory(entry.directory)?.id).toBe(entry.id)
  expect(groupByDirectory("/somewhere/else")).toBeNull()
})

test("a group's round count stays inside a sane range", () => {
  const entry = group({ rounds: 99 })
  setGroup(entry)
  expect(groups()[0]?.rounds).toBe(5)
  setGroup({ ...entry, rounds: 0 })
  expect(groups()[0]?.rounds).toBe(1)
})

test("removing a group takes it out of the list", () => {
  const entry = group()
  setGroup(entry)
  removeGroup(entry.id)
  expect(groups()).toHaveLength(0)
})

test("the list keeps one reference until storage changes", () => {
  const entry = group()
  setGroup(entry)
  // `useSyncExternalStore` compares snapshots by identity: handing it a freshly parsed array made
  // the 群 panel re-render without end (React #185, surfaced as "出了问题" on open).
  expect(groups()).toBe(groups())
  setGroup({ ...entry, name: "换个名字" })
  expect(groups()[0]?.name).toBe("换个名字")
  expect(groups()).toBe(groups())
})

test("a fresh roster is seeded from the bundled rob_models folder", async () => {
  const { ensureDefaultGroupRoles, resetGroupRoles } = await import("@/lib/group-roles")
  const seeded = ensureDefaultGroupRoles()
  expect(seeded.map((item) => item.name)).toEqual(["Elsa", "Matt", "Donny"])
  expect(seeded.find((item) => item.moderator)?.name).toBe("Donny")
  // One folder per bot, with the main persona markdown inside it.
  expect(seeded[0]?.persona).toEqual({
    kind: "file",
    path: "~/.codex/rob_models/elsa/skill-elsa.md"
  })
  // The personas are deletable: a deliberate clear sticks instead of being reseeded on the next open.
  for (const item of groupRoles()) removeGroupRole(item.id)
  expect(ensureDefaultGroupRoles()).toHaveLength(0)
  // "Restore built-in roles" puts them back and never clears what is already there.
  const restored = resetGroupRoles()
  expect(restored).toHaveLength(3)
  expect(restored.some((item) => item.name === "Elsa")).toBe(true)
})
