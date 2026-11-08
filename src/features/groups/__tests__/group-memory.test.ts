// A discussion is read later, not while it runs: the record has to answer "which round, who,
// what did they argue, and what did we decide" without replaying the transcript.

import { expect, test } from "vitest"

import type { GroupRoundRecord } from "@/agent/group-turns"

import { buildRoundMemoryBlock } from "../group-memory"

const record: GroupRoundRecord = {
  round: 1,
  startedAt: "2026-11-04 14:32",
  summary: "结论：\n- 先补口径\n\n待办：\n- Leo 拉 8 月数据",
  speeches: [
    { name: "Leo", at: "2026-11-04 14:26", text: "口径不一致。\n\n九月的退货没扣掉，所以看着像跌。", },
    { name: "Elsa", at: "2026-11-04 14:29", text: "**我反对**先改口径，应该先看人数。" }
  ]
}

test("a round heading carries the round number, the time and the topic", () => {
  const block = buildRoundMemoryBlock(record, 3, "余额下降归因")
  expect(block).toContain("## 第 2/3 轮 · 2026-11-04 14:32 · 主题：余额下降归因")
})

test("the moderator's summary comes before the speeches it summarizes", () => {
  const block = buildRoundMemoryBlock(record, 3, "余额下降归因")
  expect(block.indexOf("本轮结论与待办")).toBeLessThan(block.indexOf("发言（2 次）"))
  expect(block).toContain("Leo 拉 8 月数据")
})

test("each speech is stamped with who, which turn, a gist and the full text", () => {
  const block = buildRoundMemoryBlock(record, 3, "余额下降归因")
  expect(block).toContain("#### 2026-11-04 14:26 · Leo · 第 1 次发言")
  expect(block).toContain("主旨：口径不一致。")
  expect(block).toContain("九月的退货没扣掉")
  // Markdown emphasis in the answer must not leak into the one-line gist.
  expect(block).toContain("主旨：我反对先改口径，应该先看人数。")
})

test("a round whose moderator failed still records what was said", () => {
  const block = buildRoundMemoryBlock({ ...record, summary: "" }, 1, "议题")
  expect(block).not.toContain("本轮结论与待办")
  expect(block).toContain("第 2/1 轮")
  expect(block).toContain("**发言（2 次）**")
})
