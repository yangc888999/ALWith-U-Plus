// The stores are the user's work: a role or a group that the app refuses to load after a
// restart is work lost. The parsers therefore keep only what they understand and drop the rest.

import { beforeEach, expect, test } from "vitest"

import { groupRoleFor, groupRoles, importBuiltinBots, newRoleId, removeGroupRole, setGroupRole, type GroupRole } from "@/lib/group-roles"
import { groupByDirectory, groups, newGroupId, removeGroup, setGroup, type GroupConfig } from "@/lib/groups"

function role(overrides: Partial<GroupRole> = {}): GroupRole {
  return {
    id: newRoleId(),
    name: "架构师",
    title: "",
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
    focus: "",
    materialFolders: [],
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

// v2 added `focus` and `materialFolders`; groups stored before that must load with sensible
// defaults instead of being dropped — a lost meeting is lost work.
test("a pre-v2 group migrates with empty focus and no material folders", () => {
  localStorage.setItem(
    "alwith:groups",
    JSON.stringify([
      {
        id: "old-group",
        name: "老会",
        roles: ["role-a"],
        rounds: 2,
        directory: "/tmp/groups/old",
        document: "/tmp/groups/old/group.md",
        topic: "",
        sessionId: null,
        autoDiscuss: true
      }
    ])
  )
  const loaded = groups().find((entry) => entry.id === "old-group")
  expect(loaded).toBeTruthy()
  expect(loaded?.focus).toBe("")
  expect(loaded?.materialFolders).toEqual([])
})

test("material folders drop blanks and trim the rest", () => {
  const entry = group({ focus: "  ", materialFolders: ["/tmp/a ", "", "  ", "/tmp/b", 5 as unknown as string] })
  setGroup(entry)
  const stored = groups().find((g) => g.id === entry.id)
  expect(stored?.focus).toBe("")
  expect(stored?.materialFolders).toEqual(["/tmp/a", "/tmp/b"])
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

test("a fresh roster starts empty and the retired built-ins never come back", async () => {
  const { ensureDefaultGroupRoles, resetGroupRoles } = await import("@/lib/group-roles")
  // The bundled personas were removed on request: a fresh install seeds nothing.
  expect(ensureDefaultGroupRoles()).toEqual([])
  // "Restore built-in roles" is a no-op now — there is nothing to restore.
  expect(resetGroupRoles()).toEqual([])
  // A roster the user builds by hand is preserved.
  const { setGroupRole } = await import("@/lib/group-roles")
  setGroupRole({ id: "mine", name: "我的角色", model: "gpt-6.1-sol", effort: null, persona: { kind: "inline", text: "" }, skill: null, moderator: false })
  expect(ensureDefaultGroupRoles()).toHaveLength(1)
})

// 「导入内置机器人」: the library folder is the source of truth, and importing must be additive —
// re-clicking the button can neither duplicate a bot nor overwrite a role the user edited.
test("importing built-in bots brings persona and config, and never duplicates", () => {
  const bots = [
    {
      bot: "elsa",
      persona: "/tmp/rob_models/elsa/skill-elsa.md",
      config: JSON.stringify({ model: "gpt-6.1-sol", effort: "max", moderator: true, name: "Elsa" })
    },
    { bot: "donny", persona: "/tmp/rob_models/donny/skill-donny.md", config: null }
  ]
  const first = importBuiltinBots(bots, "fallback-model")
  expect(first.added).toHaveLength(2)
  expect(first.skipped).toEqual([])
  const elsa = groupRoles().find((role) => role.name === "Elsa")!
  expect(elsa).toMatchObject({
    model: "gpt-6.1-sol",
    effort: "max",
    moderator: true,
    persona: { kind: "file", path: "/tmp/rob_models/elsa/skill-elsa.md" }
  })
  // A bot without config still gets a storable role: the fallback model and a readable name.
  const donny = groupRoles().find((role) => role.name === "Donny")!
  expect(donny.model).toBe("fallback-model")
  expect(donny.effort).toBeNull()

  // Second click: both are already present, so nothing is added and nothing is overwritten.
  const again = importBuiltinBots(bots, "fallback-model")
  expect(again.added).toHaveLength(0)
  expect(again.skipped).toEqual(["elsa", "donny"])
  expect(groupRoles().filter((role) => role.name === "Elsa")).toHaveLength(1)
})

test("a bot config that is not JSON still imports its persona", () => {
  const result = importBuiltinBots(
    [{ bot: "matt", persona: "/tmp/rob_models/matt/skill-matt.md", config: "{broken" }],
    "fallback-model"
  )
  expect(result.added).toHaveLength(1)
  expect(result.added[0]).toMatchObject({ model: "fallback-model", effort: null, moderator: false })
})

test("importing keeps a role the user edited instead of resetting it", () => {
  importBuiltinBots([{ bot: "liz", persona: "/tmp/rob_models/liz/skill-liz.md", config: null }], "fallback-model")
  const stored = groupRoles().find((role) => role.name === "Liz")!
  setGroupRole({ ...stored, name: "我的 Liz", effort: "high" })
  importBuiltinBots([{ bot: "liz", persona: "/tmp/rob_models/liz/skill-liz.md", config: null }], "fallback-model")
  const kept = groupRoles().find((role) => role.id === stored.id)!
  expect(kept.name).toBe("我的 Liz")
  expect(kept.effort).toBe("high")
})
