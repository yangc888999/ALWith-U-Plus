import { describe, expect, test } from "vitest"

import type { UsagePoint } from "@/bindings"

import {
  ALL_CLIENT_SOURCES,
  ALL_GROUP,
  ALL_SCOPES,
  bucketKeys,
  cacheHitRate,
  cutoff,
  dailyBuckets,
  dayKey,
  heatLevel,
  localDateOf,
  localDateOfTimestamp,
  localizeUsageReport,
  longestStreak,
  monthBlocks,
  monthKeysEndingAt,
  peakDay,
  ranking,
  seriesByGroup,
  sum,
  sumWithUnknownCost,
  filterByClientSource,
  filterByScope,
  scopeOf,
  utcDayOf,
  within
} from "../usage-data"

function point(partial: Partial<UsagePoint> & { date: string }): UsagePoint {
  return {
    date: partial.date,
    hour: partial.hour ?? 0,
    provider: partial.provider ?? "codex",
    model: partial.model ?? "gpt-6-luna",
    requests: partial.requests ?? 1,
    input: partial.input ?? 100,
    cached: partial.cached ?? 0,
    output: partial.output ?? 10,
    reasoning: partial.reasoning ?? 0,
    tokens: partial.tokens ?? 110
  }
}

const TODAY = new Date(2026, 10, 2) // 2026-11-02, local midnight

describe("client source and pricing helpers", () => {
  const sourcedRows = [
    point({ date: "2026-11-01" }),
    { ...point({ date: "2026-11-01" }), clientSource: "workbuddy" as const },
    { ...point({ date: "2026-11-01" }), clientSource: "qwen_office" as const },
    { ...point({ date: "2026-11-01" }), clientSource: "other_agent" as const }
  ]

  test("ALL includes legacy rows and every known source", () => {
    expect(filterByClientSource(sourcedRows, ALL_CLIENT_SOURCES)).toHaveLength(4)
    expect(ALL_CLIENT_SOURCES).toBe("all")
  })

  test("legacy rows default to alwith_l", () => {
    expect(filterByClientSource(sourcedRows, "alwith_l")).toHaveLength(1)
  })

  test("external source with no matching rows is empty", () => {
    expect(filterByClientSource(sourcedRows, "other_agent")).toHaveLength(1)
    expect(filterByClientSource(sourcedRows, "workbuddy").map((row) => (row as { clientSource?: string }).clientSource)).toEqual(["workbuddy"])
  })

  test("unknown pricing is excluded from known cost and counted separately", () => {
    const rows = [
      { ...point({ date: "2026-11-01", tokens: 100 }), cost: 2 },
      point({ date: "2026-11-01", tokens: 50 }),
      { ...point({ date: "2026-11-01", tokens: 25 }), cost: Number.NaN }
    ]
    expect(sumWithUnknownCost(rows)).toEqual({
      requests: 3,
      input: 300,
      cached: 0,
      output: 30,
      tokens: 175,
      cost: 2,
      unknownTokenCount: 75,
      unknownCostRows: 2
    })
  })
})

describe("call scope filtering", () => {
  const rows = [
    point({ date: "2026-11-01", model: "legacy" }),
    { ...point({ date: "2026-11-01", model: "own" }), clientSource: "alwith_l" as const },
    { ...point({ date: "2026-11-01", model: "wb" }), clientSource: "workbuddy" as const },
    { ...point({ date: "2026-11-01", model: "qw" }), clientSource: "qwen_office" as const },
    { ...point({ date: "2026-11-01", model: "agent" }), clientSource: "other_agent" as const }
  ]

  test("scopeOf reads only clientSource and treats a missing one as an ALWith L call", () => {
    expect(scopeOf({})).toBe("internal")
    expect(scopeOf({ clientSource: undefined })).toBe("internal")
    expect(scopeOf({ clientSource: "alwith_l" })).toBe("internal")
    expect(scopeOf({ clientSource: "workbuddy" })).toBe("external")
    expect(scopeOf({ clientSource: "qwen_office" })).toBe("external")
    expect(scopeOf({ clientSource: "other_agent" })).toBe("external")
  })

  test("model, provider and request-path names never stand in for the caller", () => {
    const internal = { model: "workbuddy-proxy", provider: "qwen_office", path: "/workbuddy/v1", clientSource: "alwith_l" }
    const external = { model: "gpt-6-luna", provider: "codex", path: "/v1/chat", clientSource: "workbuddy" }
    expect(scopeOf(internal)).toBe("internal")
    expect(scopeOf(external)).toBe("external")
    expect(scopeOf({ model: "workbuddy-proxy", provider: "workbuddy" } as { clientSource?: string })).toBe("internal")
  })

  test("all returns the original rows untouched", () => {
    expect(ALL_SCOPES).toBe("all")
    expect(filterByScope(rows, ALL_SCOPES)).toBe(rows)
    expect(filterByScope(rows, "all")).toHaveLength(rows.length)
  })

  test("internal and external are disjoint and their union is the whole ledger", () => {
    const internal = filterByScope(rows, "internal")
    const external = filterByScope(rows, "external")
    expect(internal.map((row) => (row as { model: string }).model)).toEqual(["legacy", "own"])
    expect(external.map((row) => (row as { model: string }).model)).toEqual(["wb", "qw", "agent"])
    expect(internal.some((row) => external.includes(row))).toBe(false)
    expect(rows.every((row) => internal.includes(row) || external.includes(row))).toBe(true)
    expect([...internal, ...external]).toHaveLength(rows.length)
    expect(new Set([...internal, ...external])).toEqual(new Set(rows))
  })

  test("unknown cost semantics survive scope filtering", () => {
    const priced = [
      { ...point({ date: "2026-11-01", tokens: 100 }), cost: 2 },
      { ...point({ date: "2026-11-01", tokens: 50 }), clientSource: "workbuddy" as const },
      { ...point({ date: "2026-11-01", tokens: 25 }), clientSource: "qwen_office" as const, cost: Number.NaN }
    ]
    const all = sumWithUnknownCost(filterByScope(priced, "all"))
    const internal = sumWithUnknownCost(filterByScope(priced, "internal"))
    const external = sumWithUnknownCost(filterByScope(priced, "external"))
    expect(all).toEqual({
      requests: 3,
      input: 300,
      cached: 0,
      output: 30,
      tokens: 175,
      cost: 2,
      unknownTokenCount: 75,
      unknownCostRows: 2
    })
    expect(internal.cost).toBe(2)
    expect(internal.unknownCostRows).toBe(0)
    expect(external.cost).toBe(0)
    expect(external.unknownTokenCount).toBe(75)
    expect(external.unknownCostRows).toBe(2)
    expect(internal.tokens + external.tokens).toBe(all.tokens)
    expect(internal.unknownCostRows + external.unknownCostRows).toBe(all.unknownCostRows)
  })
})

describe("cutoff", () => {
  test("counts today as one of the days", () => {
    expect(cutoff("30d", TODAY)).toBe("2026-10-04")
    expect(cutoff("90d", TODAY)).toBe("2026-08-05")
    expect(cutoff("1y", TODAY)).toBe("2025-11-03")
  })
})

describe("sum", () => {
  test("adds every column and keeps an empty list at zero", () => {
    const total = sum([point({ date: "2026-11-01", requests: 2, input: 30, cached: 70, output: 5, tokens: 105 })])
    expect(total).toMatchObject({ requests: 2, input: 30, cached: 70, output: 5, tokens: 105, cost: 0 })
    expect(sum([])).toMatchObject({ requests: 0, input: 0, cached: 0, output: 0, tokens: 0, cost: 0 })
  })
})

describe("cacheHitRate", () => {
  test("divides cached reads by everything the provider read", () => {
    expect(cacheHitRate({ requests: 1, input: 100, cached: 900, output: 10, tokens: 1010, cost: 0, unknownTokenCount: 0, unknownCostRows: 0 })).toBeCloseTo(0.9)
  })

  test("stays at zero rather than NaN before anything ran", () => {
    expect(cacheHitRate(sum([]))).toBe(0)
  })
})

describe("dailyBuckets", () => {
  test("fills the days between two rows so a gap is a zero, not a missing column", () => {
    const days = dailyBuckets([point({ date: "2026-10-30" }), point({ date: "2026-11-01" })], "2026-10-30", "2026-11-01")
    expect(days.map((day) => day.date)).toEqual(["2026-10-30", "2026-10-31", "2026-11-01"])
    expect(days[1]?.tokens).toBe(0)
    expect(days[1]?.requests).toBe(0)
  })

  test("merges several models on the same day into one column", () => {
    const days = dailyBuckets(
      [
        point({ date: "2026-11-01", model: "a", tokens: 100, requests: 1 }),
        point({ date: "2026-11-01", model: "b", tokens: 250, requests: 3 })
      ],
      "2026-11-01",
      "2026-11-01"
    )
    expect(days).toHaveLength(1)
    expect(days[0]?.tokens).toBe(350)
    expect(days[0]?.requests).toBe(4)
  })
})

describe("bucketKeys", () => {
  test("lists one key per day, gap or not", () => {
    expect(bucketKeys("2026-10-30", "2026-11-02", "day")).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"])
  })

  test("starts a week on Monday and a month on its first day", () => {
    expect(bucketKeys("2026-10-07", "2026-10-20", "week")).toEqual(["2026-10-05", "2026-10-12", "2026-10-19"])
    expect(bucketKeys("2026-10-07", "2026-12-02", "month")).toEqual(["2026-10", "2026-11", "2026-12"])
  })
})

describe("seriesByGroup", () => {
  const rows = [
    point({ date: "2026-10-05", model: "a", tokens: 10 }),
    point({ date: "2026-10-06", model: "a", tokens: 20 }),
    // 35 rather than 30: a tie with `a` would make the "orders by size" assertion a coin flip.
    point({ date: "2026-10-12", model: "b", tokens: 35, requests: 3 }),
    point({ date: "2026-11-02", model: "c", tokens: 40 })
  ]

  test("keeps a column for every day so the axis stays linear", () => {
    const series = seriesByGroup([rows[0]!, rows[3]!], "day", "model", "tokens", 5, "2026-10-05", "2026-10-07")
    expect(series.buckets.map((bucket) => bucket.key)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"])
    expect(series.buckets[1]?.values.every((value) => value === 0)).toBe(true)
  })

  test("orders groups by size and folds the tail into one band", () => {
    const series = seriesByGroup(rows, "day", "model", "tokens", 2, "2026-10-05", "2026-11-02")
    expect(series.groups.map((group) => group.label)).toEqual(["c", "b", "…"])
    expect(series.groups.at(-1)?.total).toBe(30)
  })

  test("ranks by requests when that is the metric", () => {
    const series = seriesByGroup(rows, "day", "model", "requests", 1, "2026-10-05", "2026-11-02")
    expect(series.groups[0]?.label).toBe("b")
  })

  test("week and month grains fold the same rows together", () => {
    const weekly = seriesByGroup(rows, "week", "model", "tokens", 3, "2026-10-05", "2026-10-12")
    expect(weekly.buckets.map((bucket) => bucket.key)).toEqual(["2026-10-05", "2026-10-12"])
    const monthly = seriesByGroup(rows, "month", "model", "tokens", 3, "2026-10-05", "2026-11-02")
    expect(monthly.buckets.map((bucket) => bucket.key)).toEqual(["2026-10", "2026-11"])
  })

  test("ignores rows outside the window, in the axis and in the ranking", () => {
    const outside = point({ date: "2026-09-01", model: "old", tokens: 999 })
    const series = seriesByGroup([...rows, outside], "day", "model", "tokens", 2, "2026-10-05", "2026-10-06")
    expect(series.buckets.map((bucket) => bucket.key)).toEqual(["2026-10-05", "2026-10-06"])
    expect(series.groups.map((group) => group.label)).toEqual(["a"])
  })
})

describe("ranking", () => {
  const rows = [
    point({ date: "2026-11-01", model: "big", tokens: 600, requests: 1 }),
    point({ date: "2026-11-01", model: "small", tokens: 400, requests: 9 }),
    point({ date: "2026-11-01", model: "tiny", tokens: 0, requests: 2 })
  ]

  test("ranks by the chosen metric and shares of that same metric", () => {
    const byTokens = ranking(rows, "model", "tokens", 2)
    expect(byTokens.map((entry) => entry.key)).toEqual(["big", "small"])
    expect(byTokens[0]?.share).toBeCloseTo(0.6)
    expect(byTokens[1]?.share).toBeCloseTo(0.4)
  })

  test("switching the metric reorders the same rows", () => {
    const byRequests = ranking(rows, "model", "requests", 3)
    expect(byRequests.map((entry) => entry.key)).toEqual(["small", "tiny", "big"])
    expect(byRequests[0]?.share).toBeCloseTo(9 / 12)
  })

  test("a provider group folds its models together", () => {
    const byProvider = ranking(
      [point({ date: "2026-11-01", provider: "kimi", model: "a", tokens: 10 }), point({ date: "2026-11-01", provider: "kimi", model: "b", tokens: 30 })],
      "provider",
      "tokens",
      5
    )
    expect(byProvider).toHaveLength(1)
    expect(byProvider[0]?.tokens).toBe(40)
    expect(byProvider[0]?.share).toBe(1)
  })

  test("the ALL group folds every model and provider into one share", () => {
    const all = ranking(
      [
        point({ date: "2026-11-01", provider: "kimi", model: "a", tokens: 10 }),
        point({ date: "2026-11-01", provider: "codex", model: "b", tokens: 30 })
      ],
      "all",
      "tokens",
      5
    )
    expect(all).toHaveLength(1)
    expect(all[0]?.key).toBe(ALL_GROUP)
    expect(all[0]?.tokens).toBe(40)
    expect(all[0]?.share).toBe(1)
  })

  test("the cost metric ranks and sums costed rows", () => {
    const rows = [
      { ...point({ date: "2026-11-01", model: "a" }), cost: 3 },
      { ...point({ date: "2026-11-02", model: "b" }), cost: 7 }
    ]
    expect(sum(rows).cost).toBe(10)
    const byCost = ranking(rows, "model", "cost", 2)
    expect(byCost.map((entry) => entry.key)).toEqual(["b", "a"])
    expect(byCost[0]?.share).toBeCloseTo(0.7)
  })
})

describe("longestStreak", () => {
  test("counts consecutive active days and ignores empty ones between", () => {
    const days = dailyBuckets(
      [
        point({ date: "2026-10-28" }),
        point({ date: "2026-10-29" }),
        point({ date: "2026-10-30" }),
        point({ date: "2026-11-01" })
      ],
      "2026-10-27",
      "2026-11-01"
    )
    expect(longestStreak(days)).toBe(3)
  })

  test("is zero when nothing ran", () => {
    expect(longestStreak(dailyBuckets([], "2026-11-01", "2026-11-02"))).toBe(0)
  })
})

describe("peakDay", () => {
  test("picks the heaviest day, not the last one", () => {
    const days = dailyBuckets(
      [point({ date: "2026-10-30", tokens: 50 }), point({ date: "2026-11-01", tokens: 900 })],
      "2026-10-30",
      "2026-11-01"
    )
    expect(peakDay(days)?.date).toBe("2026-11-01")
    expect(peakDay(dailyBuckets([], "2026-11-01", "2026-11-02"))?.tokens).toBe(0)
  })
})

describe("monthKeysEndingAt", () => {
  test("walks back across a year boundary, oldest first", () => {
    expect(monthKeysEndingAt("2026-02", 3)).toEqual(["2025-12", "2026-01", "2026-02"])
    expect(monthKeysEndingAt("2026-11", 1)).toEqual(["2026-11"])
    expect(monthKeysEndingAt("not-a-month", 3)).toEqual([])
  })
})

describe("monthBlocks", () => {
  const rows = [
    point({ date: "2026-09-30", tokens: 10, requests: 1 }),
    point({ date: "2026-10-01", tokens: 40, requests: 2 }),
    point({ date: "2026-10-31", tokens: 20, requests: 3 })
  ]

  test("draws exactly the days the month has, February included", () => {
    const blocks = monthBlocks(rows, ["2026-02", "2026-09", "2026-10"])
    expect(blocks.map((block) => block.days)).toEqual([28, 30, 31])
    expect(blocks.map((block) => block.cells.length)).toEqual([28, 30, 31])
    expect(new Set(blocks[2]?.cells.map((cell) => cell.date)).size).toBe(31)
  })

  test("lays the days out left to right, six per row, with no weekday gaps", () => {
    const october = monthBlocks(rows, ["2026-10"])[0]
    // 31 days → five full rows plus one cell on the sixth.
    expect(october?.cells[0]).toMatchObject({ date: "2026-10-01", row: 0, column: 0 })
    expect(october?.cells[5]).toMatchObject({ date: "2026-10-06", row: 0, column: 5 })
    expect(october?.cells[6]).toMatchObject({ date: "2026-10-07", row: 1, column: 0 })
    expect(october?.cells.at(-1)).toMatchObject({ date: "2026-10-31", row: 5, column: 0 })
    expect(october?.columns).toBe(6)
  })

  test("carries the day's numbers and leaves quiet days at zero", () => {
    const october = monthBlocks(rows, ["2026-10"])[0]
    expect(october?.cells[0]).toMatchObject({ tokens: 40, requests: 2 })
    expect(october?.cells[1]).toMatchObject({ tokens: 0, requests: 0 })
    expect(monthBlocks(rows, ["2026-09"])[0]?.cells.at(-1)).toMatchObject({ date: "2026-09-30", tokens: 10 })
  })
})

describe("heatLevel", () => {
  test("maps a share of the busiest day onto five steps", () => {
    expect(heatLevel(0, 100)).toBe(0)
    expect(heatLevel(5, 100)).toBe(1)
    expect(heatLevel(20, 100)).toBe(2)
    expect(heatLevel(50, 100)).toBe(3)
    expect(heatLevel(100, 100)).toBe(4)
    expect(heatLevel(10, 0)).toBe(0)
  })
})

describe("within", () => {
  test("drops rows before the cutoff and keeps the boundary day", () => {
    const rows = [point({ date: "2026-10-03" }), point({ date: "2026-10-04" })]
    expect(within(rows, "2026-10-04").map((row) => row.date)).toEqual(["2026-10-04"])
  })

  test("an explicit end closes the window like 分析 and the log do", () => {
    const rows = [
      point({ date: "2026-10-03" }),
      point({ date: "2026-10-04" }),
      point({ date: "2026-10-05" })
    ]
    expect(within(rows, "2026-10-04", "2026-10-04").map((row) => row.date)).toEqual(["2026-10-04"])
  })
})

describe("UTC ledger days -> the reader's calendar", () => {
  // In UTC+8 this is 01:00 on 11-05, but the engine files it under 2026-11-04.
  const at = "2026-11-04T17:00:00.000Z"
  const expected = dayKey(new Date(at))

  test("a turn and its hour bucket both move to the local calendar day", () => {
    expect(localDateOfTimestamp(at, "2026-11-04")).toBe(expected)
    expect(localDateOf("2026-11-04", 17)).toBe(expected)
    if (new Date().getTimezoneOffset() < 0) expect(expected).not.toBe("2026-11-04")
  })

  test("a malformed stamp keeps the engine's day instead of dropping the row", () => {
    expect(localDateOfTimestamp("not-a-date", "2026-11-04")).toBe("2026-11-04")
    expect(localDateOf("", 3)).toBe("")
    // Test fixtures and older caches may have no hour at all.
    expect(localDateOf("2026-11-04", undefined)).toBe(dayKey(new Date("2026-11-04T00:00:00Z")))
  })

  test("localizing a report keeps the original UTC day for peak/off-peak pricing", () => {
    const raw = {
      points: [point({ date: "2026-11-04", hour: 17 })],
      recent: [
        {
          at,
          date: "2026-11-04",
          provider: "codex",
          model: "gpt-6-luna",
          input: 1,
          cached: 0,
          output: 1,
          tokens: 2
        }
      ],
      sessions: 1,
      scanned: 1,
      first: "2026-11-04",
      last: "2026-11-04",
      source: "<CODEX_HOME>/sessions",
      prompts: []
    }
    const report = localizeUsageReport(raw)
    expect(report.points[0]?.date).toBe(expected)
    expect(report.recent[0]?.date).toBe(expected)
    expect(utcDayOf(report.points[0]!)).toBe("2026-11-04")
    expect(utcDayOf(report.recent[0]!)).toBe("2026-11-04")
  })
})
