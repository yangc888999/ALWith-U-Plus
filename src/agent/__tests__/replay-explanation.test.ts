import { expect, test } from "vitest"

import { initI18n } from "@/lib/i18n"

import { explainReplayFailure } from "../client"

await initI18n("zh-CN")

test("a provider change on resume becomes one provider-locked explanation", () => {
  const text =
    "failed to load configuration: Cannot change this thread's model provider from `alwith` to `openai` on resume."
  expect(explainReplayFailure(text)).toContain("alwith")
  expect(explainReplayFailure(text)).toContain("openai")
})

test("a replayed-history refusal becomes the history explanation", () => {
  expect(explainReplayFailure("Invalid 'input[112].content': array too long")).toContain("历史无法用当前模型重放")
})

test("a removed provider names the provider", () => {
  expect(
    explainReplayFailure('This chat uses model provider "acme", which is no longer configured')
  ).toContain("acme")
})
