import { describe, expect, test } from "vitest"
import type { Session } from "@alwith/api"

import { buildTurnMemoryBlock } from "../project-memory"

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    cwd: "/project",
    title: "这个标题非常长已经超过十五个字了呀",
    items: [
      { kind: "user", id: "u1", content: [{ type: "text", text: "请帮我分析交易指标" }] },
      { kind: "assistant", id: "a1", content: [{ type: "text", text: "先跑一遍数据" }] },
      { kind: "assistant", id: "a2", content: [{ type: "text", text: "结论：指标正常，详见报表。" }] }
    ],
    ...over
  } as unknown as Session
}

describe("buildTurnMemoryBlock", () => {
  test("uses the requested format: timestamp + ≤15-char title, then 用户/助手 lines", () => {
    const block = buildTurnMemoryBlock(fakeSession())
    expect(block).not.toBeNull()
    const head = block!.split("\n")[0]!
    expect(head).toMatch(/^\*\*\d{4}-\d{2}-\d{2} \d{2}:\d{2}  .+\*\*$/)
    const title = head.slice(20, -2)
    expect(Array.from(title).length).toBeLessThanOrEqual(15)
    expect(block).toContain("用户：请帮我分析交易指标")
  })

  test("keeps only the final assistant answer, not the tool-call chatter", () => {
    const block = buildTurnMemoryBlock(fakeSession())
    expect(block).toContain("助手：结论：指标正常，详见报表。")
    expect(block).not.toContain("先跑一遍数据")
  })

  test("still carries the idempotency marker", () => {
    const block = buildTurnMemoryBlock(fakeSession())
    expect(block).toContain("\u2063alwith-turn:s1:a2\u2063")
  })

  test("falls back to the user's own words when the session has no title", () => {
    const block = buildTurnMemoryBlock(fakeSession({ title: "" }))
    const title = block!.split("\n")[0]!.slice(20, -2)
    expect(Array.from(title).length).toBeLessThanOrEqual(15)
    expect(block).toContain("用户：请帮我分析交易指标")
  })
})
