// The roster speaks in the same conversation, so a member's own turn must never trigger another
// round — and the moderator's prompt has to ask for one plan instead of another opinion.

import { createSession, type Session } from "@alwith/api"
import { expect, test } from "vitest"

import { groupTurnPrompt, GROUP_TURN_PREFIX, type GroupTurn } from "@/agent/group-turns"

import { groupTurnTarget } from "../use-group-discussion"

type Item = Session["items"][number]

function message(kind: "user" | "assistant", text: string, id: string): Item {
  return {
    id,
    at: 0,
    replayed: false,
    _meta: null,
    kind,
    content: [{ type: "text", text }],
    echo: null
  } as Item
}

function sessionWith(items: Item[]): Session {
  return { ...createSession("s1", "/tmp/group"), items }
}

const architect: GroupTurn = {
  id: "r1",
  name: "架构师",
  model: "gpt-6.1-sol",
  effort: "high",
  instruction: "关注可扩展性与长期维护成本。",
  moderator: false
}

test("a member's turn asks for a position, not another plan", () => {
  const prompt = groupTurnPrompt(architect, 0, "# 群说明\n要做支付告警收敛。", "speech", "")
  expect(prompt).toContain("架构师")
  expect(prompt).toContain("第 1 轮")
  expect(prompt).toContain("要做支付告警收敛。")
  expect(prompt).toContain("关注可扩展性与长期维护成本。")
  expect(prompt).toContain("明确表态")
})

test("the moderator summarizes each round on the configured template", () => {
  const moderator: GroupTurn = { ...architect, id: "r3", name: "主持人", moderator: true }
  const template = "结论：\n- \n\n待办：\n- \n\n风险："
  const prompt = groupTurnPrompt(moderator, 2, "群说明", "summary", template)
  expect(prompt).toContain("主持人")
  expect(prompt).toContain("第 3 轮已经结束")
  // The user's own skeleton is quoted verbatim, headings included.
  expect(prompt).toContain("风险：")
  expect(prompt).toContain("结论：")
  // A summary must not ask for another opinion.
  expect(prompt).not.toContain("明确表态")
})

test("a group document longer than the cap is trimmed from the front", () => {
  const long = "x".repeat(9000)
  const prompt = groupTurnPrompt(architect, 0, long, "speech", "")
  expect(prompt).not.toContain("x".repeat(6001))
})

test("a member's own turn is not a new discussion to run", () => {
  const target = groupTurnTarget(
    sessionWith([
      message("user", "原始问题", "u1"),
      message("assistant", "初稿", "a1"),
      message("user", `${GROUP_TURN_PREFIX}架构师】第 1 轮`, "u2"),
      message("assistant", "架构师的意见", "a2")
    ])
  )
  expect(target).toBeNull()
})

test("a user turn is a discussion to run", () => {
  const target = groupTurnTarget(
    sessionWith([message("user", "原始问题", "u1"), message("assistant", "初稿", "a1")])
  )
  expect(target?.question).toBe("原始问题")
  expect(target?.answer).toBe("初稿")
})
