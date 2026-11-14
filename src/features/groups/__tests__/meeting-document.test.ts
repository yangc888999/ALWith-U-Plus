// The document every member reads is assembled per round-start: direction, topic, a live index of
// the material folders, the minutes tail carried forward from past sessions, then the standing
// group.md. These are the wiring tests for that order and for the failure paths (a folder that
// vanished, a memory file that does not exist yet) — a discussion must still run.

import { beforeEach, expect, test, vi } from "vitest"

import type { GroupConfig } from "@/lib/groups"

const native = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => ""),
  groupMaterialIndex: vi.fn(async (_args: { path: string }) => ({ markdown: "" })),
  groupTailText: vi.fn(async (_args: { path: string; maxChars: number }) => ({ text: "", truncated: false }))
}))

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => true }))
// use-group-discussion imports the client at module scope; a bare object keeps the import cheap.
vi.mock("@/lib/client", () => ({ client: { state: { sessions: {} } } }))
vi.mock("@/lib/chat-window-client", () => ({ RemoteChatClient: class {} }))
// The bindings module also exports the event catalog, which other imports touch at module scope.
vi.mock("@/bindings", () => ({
  commands: {
    groupMaterialIndex: native.groupMaterialIndex,
    groupTailText: native.groupTailText
  },
  events: new Proxy({}, { get: () => ({ name: "stub" }) })
}))

import { readDocument } from "../use-group-discussion"

function group(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    id: "g1",
    name: "定价会",
    roles: [],
    rounds: 2,
    directory: "/tmp/groups/定价会",
    document: "/tmp/groups/定价会/group.md",
    topic: "",
    focus: "",
    materialFolders: [],
    sessionId: null,
    autoDiscuss: true,
    ...overrides
  }
}

beforeEach(() => {
  native.invoke.mockReset()
  native.invoke.mockResolvedValue("")
  native.groupMaterialIndex.mockReset()
  native.groupMaterialIndex.mockResolvedValue({ markdown: "### 定价\n- a.md，约 2 KB" })
  native.groupTailText.mockReset()
  native.groupTailText.mockResolvedValue({ text: "", truncated: false })
})

test("with neither focus nor materials the doc is the document plus topic, as before", async () => {
  native.invoke.mockResolvedValue("# 群说明\n背景若干")
  const document = await readDocument(group({ topic: "余额下降是谁的锅" }))
  expect(document).toBe("## 本次议题\n余额下降是谁的锅\n\n# 群说明\n背景若干")
  // No folders means no index scan at all; the minutes read happens but its empty result adds no section.
  expect(native.groupMaterialIndex).not.toHaveBeenCalled()
})

test("sections land in reading order: direction, topic, materials, minutes, document", async () => {
  native.groupTailText.mockResolvedValue({ text: "第 2 场结论：弹性 -0.4", truncated: true })
  native.invoke.mockResolvedValue("# 群说明\n背景若干")
  const document = await readDocument(
    group({
      focus: "补贴退坡后的毛利弹性",
      topic: "Q4 怎么定价",
      materialFolders: ["/Users/me/BI导出/定价"]
    })
  )
  const order = [
    document.indexOf("## 分析方向"),
    document.indexOf("## 本次议题"),
    document.indexOf("## 材料索引"),
    document.indexOf("## 历轮纪要"),
    document.indexOf("# 群说明")
  ]
  expect(order.every((at) => at >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  // The index carries the read-don't-guess instruction.
  expect(document).toContain("需要内容时读文件，不要猜")
})

test("an unreachable material folder is marked, not fatal", async () => {
  native.groupMaterialIndex.mockRejectedValue(new Error("材料文件夹不存在"))
  const document = await readDocument(group({ materialFolders: ["/gone/预算"] }))
  expect(document).toContain("该文件夹当前不可访问")
  expect(document).toContain("预算")
})

test("a missing minutes file simply means nothing to carry forward", async () => {
  native.groupTailText.mockRejectedValue(new Error("no such file"))
  native.invoke.mockResolvedValue("群说明")
  const document = await readDocument(group())
  expect(document).toBe("群说明")
})

test("a focus of only whitespace injects nothing (legacy groups behave as before)", async () => {
  native.invoke.mockResolvedValue("群说明")
  const document = await readDocument(group({ focus: "   " }))
  expect(document).toBe("群说明")
})
