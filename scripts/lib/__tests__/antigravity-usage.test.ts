import { expect, mock, test } from "bun:test"

import { parseAntigravityUsage } from "../../../src/features/antigravity/usage"
import { AntigravityUsageReader } from "../antigravity-usage"

const quotaReport = [
  "### Session Usage",
  "- **Session total:** 1,200 tokens",
  "",
  "### Quota Limits",
  "- **Gemini Models**",
  "  - **Weekly Limit Remaining:** 73% remaining (resets Nov 29, 2026, 11:30 UTC)",
  "  - **Burst Limit:** 0% remaining",
  "- **Shared Credits**",
  "  - **Credits:** 1,280 units remaining",
  "  - **Other:** Available"
].join("\n")

test("Google quota rows preserve percentages, reset times and unit-based limits", () => {
  expect(parseAntigravityUsage(quotaReport)).toEqual({
    status: "ready",
    limits: [
      {
        group: "Gemini Models",
        label: "Weekly Limit Remaining",
        remainingPercent: 73,
        resetsAt: Date.UTC(2026, 10, 29, 11, 30)
      },
      { group: "Gemini Models", label: "Burst Limit", remainingPercent: 0, resetsAt: null },
      { group: "Shared Credits", label: "Credits", remainingUnits: 1280, resetsAt: null }
    ]
  })
})

test("failed, missing and invalid quota data never turn into fabricated progress bars", () => {
  expect(parseAntigravityUsage("### Quota Limits\n- Unable to retrieve quota status (network failure)")).toEqual({
    status: "error"
  })
  expect(parseAntigravityUsage("### Quota Limits\n- No quota limits reported.")).toEqual({ status: "unavailable" })
  expect(parseAntigravityUsage("### Session Usage\n- **Session total:** 1,200 tokens")).toEqual({
    status: "unavailable"
  })
  expect(parseAntigravityUsage("### Quota Limits\n- **Gemini Models**\n  - **Weekly:** 300% remaining")).toEqual({
    status: "unavailable"
  })
})

test("quota refreshes reuse a dedicated advertised session and capture only its output", async () => {
  const reader = new AntigravityUsageReader()
  const tier = { name: "Google AI Pro" }
  const transport = {
    open: mock(async () => {
      reader.commands("quota", true)
      return { sessionId: "quota", tier }
    }),
    prompt: mock(async (sessionId: string, text: string) => {
      expect(text).toBe("/usage")
      expect(sessionId).toBe("quota")
      reader.text("chat", "The normal chat response must not become quota data.")
      reader.text(sessionId, quotaReport.slice(0, 51))
      reader.text(sessionId, quotaReport.slice(51))
      return { stopReason: "end_turn" }
    }),
    close: mock(() => {})
  }
  try {
    for (let refresh = 0; refresh < 2; refresh++) {
      expect(await reader.read(transport, AbortSignal.timeout(1_000))).toEqual({
        tier,
        usage: parseAntigravityUsage(quotaReport)
      })
    }
    expect(transport.open).toHaveBeenCalledTimes(1)
    expect(transport.prompt).toHaveBeenCalledTimes(2)
  } finally {
    await reader.clear()
  }
  expect(transport.close).toHaveBeenCalledTimes(1)
})

test("an older runtime cannot turn a quota refresh into a model prompt", async () => {
  const reader = new AntigravityUsageReader()
  const transport = {
    open: async () => {
      setTimeout(() => {
        reader.commands("other-chat", true)
        reader.commands("quota", false)
      }, 0)
      return { sessionId: "quota" }
    },
    prompt: mock(async () => ({ stopReason: "end_turn" })),
    close: mock(() => {})
  }
  try {
    expect((await reader.read(transport, AbortSignal.timeout(1_000))).usage).toEqual({ status: "unavailable" })
    expect(transport.prompt).not.toHaveBeenCalled()
  } finally {
    await reader.clear()
  }
})
