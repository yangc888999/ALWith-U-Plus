// The cloud is only useful if it reflects the user's questions: filler words must not win, and a
// word seen once must not take space away from one the user actually repeats.
import { expect, test } from "vitest"

import { topTerms } from "../usage-word-cloud"

test("repeated words outrank filler, and filler is dropped entirely", () => {
  const terms = topTerms([
    "帮我看看用量页的模型价格，为什么模型价格更新不了",
    "用量页的模型价格需要按厂商分开",
    "这个模型价格不对，帮我检查用量"
  ])
  const counts = new Map(terms.map((term) => [term.text, term.count]))
  // "模型价格" appears twice in the first prompt, so the shared noun is seen four times.
  expect(counts.get("模型")).toBe(4)
  expect(counts.get("价格")).toBe(4)
  expect(counts.get("用量")).toBe(3)
  // Pronouns and request verbs are structural, not topic words.
  expect(counts.has("帮我")).toBe(false)
  expect(counts.has("这个")).toBe(false)
  // Ranked descending.
  expect(terms[0]?.count).toBeGreaterThanOrEqual(terms.at(-1)?.count ?? 0)
})

test("a word seen only once never enters the cloud", () => {
  expect(topTerms(["完全不同的句子", "另一次性的词汇"])).toEqual([])
})
