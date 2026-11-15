import { beforeEach, expect, test, vi } from "vitest"

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))

import {
  cachedProviderQuotas,
  formatQuotaClock,
  formatQuotaStamp,
  formatQuotaWindow,
  freeAllowance,
  freeResetHint,
  openrouterFreeUsage,
  queryProviderQuota,
  quotaCountdownSeconds,
  unixMillis,
  type FreeUsage,
  type ProviderQuota
} from "../provider-quota"

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(null)
})

function quota(overrides: Partial<ProviderQuota> = {}): ProviderQuota {
  return {
    providerId: "openrouter",
    status: "ok",
    kind: "credits",
    remaining: 12.4,
    limit: 60,
    used: 47.6,
    unit: "usd",
    resetAt: null,
    expiresAt: null,
    plan: null,
    detail: null,
    unsupportedReason: null,
    fetchedAt: 1_767_225_600,
    ...overrides
  }
}

test("the three commands keep the names the Rust side exposes", async () => {
  await cachedProviderQuotas()
  await queryProviderQuota("openrouter")
  await openrouterFreeUsage()
  expect(invokeMock.mock.calls).toEqual([
    ["provider_quota_cached"],
    ["provider_quota_query", { providerId: "openrouter" }],
    ["openrouter_free_usage"]
  ])
})

test("a timestamp is read as seconds or milliseconds, never as the wrong decade", () => {
  // 1_767_225_600 is 2026-01-01 in seconds and 1970 in milliseconds; the heuristic must pick
  // seconds, or every quota window would print a date in 1970.
  expect(unixMillis(1_767_225_600)).toBe(1_767_225_600_000)
  expect(unixMillis(1_767_225_600_000)).toBe(1_767_225_600_000)
  expect(unixMillis(null)).toBeNull()
  expect(unixMillis(0)).toBeNull()
  expect(unixMillis(Number.NaN)).toBeNull()
})

test("the reset countdown is seconds left, clamped at zero", () => {
  const now = 1_767_225_600_000
  expect(quotaCountdownSeconds(1_767_225_600 + 90, now)).toBe(90)
  expect(quotaCountdownSeconds(1_767_225_600_000 + 90_000, now)).toBe(90)
  // Already past: a countdown never renders -00:00:04.
  expect(quotaCountdownSeconds(1_767_225_500, now)).toBe(0)
  expect(quotaCountdownSeconds(null, now)).toBeNull()
})

test("stamps are rendered in the local clock, month and day padded", () => {
  const stamp = new Date(2026, 0, 2, 3, 4, 5).getTime()
  expect(formatQuotaStamp(stamp)).toBe("2026/01/02 03:04")
  expect(formatQuotaClock(stamp)).toBe("03:04")
})

test("a money window is the remaining balance and its limit", () => {
  const window = formatQuotaWindow(quota())
  expect(window?.figure).toEqual({ kind: "usd", remaining: 12.4, limit: 60 })
  expect(window?.stale).toBe(false)
})

test("an unlimited plan carries no limit, and no zero is invented for it", () => {
  const window = formatQuotaWindow(quota({ limit: null, remaining: 12.4 }))
  expect(window?.figure).toEqual({ kind: "usd", remaining: 12.4, limit: null })
})

test("a counter unit keeps its own unit instead of being read as money", () => {
  const window = formatQuotaWindow(quota({ unit: "requests", remaining: 812, limit: 1_000, used: 188 }))
  expect(window?.figure).toEqual({ kind: "count", remaining: 812, unit: "requests" })
})

test("no remaining means no figure — a limit and a used count do not add up to one", () => {
  // 100 - 30 is 70, but the vendor never said 70: inventing it is how a settings page lies.
  const window = formatQuotaWindow(quota({ remaining: null, limit: 100, used: 30 }))
  expect(window?.figure).toBeNull()
  expect(window?.resetAt).toBeNull()
})

test("a console-only vendor carries no figures at all", () => {
  const window = formatQuotaWindow(quota({ status: "console", remaining: null, limit: null, used: null }))
  expect(window?.status).toBe("console")
  expect(window?.figure).toBeNull()
})

test("an unreachable read keeps the last figures and marks them stale", () => {
  const window = formatQuotaWindow(quota({ status: "unreachable" }))
  expect(window?.figure).toEqual({ kind: "usd", remaining: 12.4, limit: 60 })
  expect(window?.stale).toBe(true)
  // ...and so does the cache-first paint of a perfectly good reading.
  expect(formatQuotaWindow(quota(), { fromCache: true })?.stale).toBe(true)
  expect(formatQuotaWindow(quota(), { fromCache: false })?.stale).toBe(false)
})

test("a replayed snapshot is stale even though its status says ok", () => {
  // `preserve_recent_success` serves a ≤24h old reading with `status: "ok"` and every number
  // intact; the only marker is the `stale` token. Rendering it unmarked presents day-old numbers as
  // if they had just been fetched, which is worse than showing nothing.
  const window = formatQuotaWindow(quota({ detail: "stale" }))
  expect(window?.status).toBe("ok")
  expect(window?.figure).toEqual({ kind: "usd", remaining: 12.4, limit: 60 })
  expect(window?.stale).toBe(true)
})

test("prose in `detail` is neither a stale marker nor an unlimited one", () => {
  // `detail` is a shared channel: the failure paths put sentences there. Matching by substring
  // would eventually paint 「不限量」 over a real error.
  for (const detail of [
    "New API: quota exhausted; billing: HTTP 500",
    "unlimited; free tier; rate limit 20/10s",
    "stale token inside a sentence",
    "HTTP 401"
  ]) {
    const window = formatQuotaWindow(quota({ detail }))
    expect(window?.stale, detail).toBe(false)
    expect(window?.unlimited, detail).toBe(false)
  }
})

test("a vendor that states there is no ceiling is unlimited, not empty", () => {
  const window = formatQuotaWindow(quota({ remaining: null, limit: null, used: null, detail: "unlimited" }))
  expect(window?.unlimited).toBe(true)
  // ...and it carries no figure, because "unlimited" is the absence of a number.
  expect(window?.figure).toBeNull()
  expect(window?.stale).toBe(false)
})

test("an unlimited token on a provider that does report numbers is ignored", () => {
  // Defensive: if both ever arrive, the numbers win — they are the more specific statement.
  expect(formatQuotaWindow(quota({ detail: "unlimited", limit: 10 }))?.unlimited).toBe(false)
  expect(formatQuotaWindow(quota({ detail: "unlimited", remaining: 3 }))?.unlimited).toBe(false)
  // A non-ok status is never "unlimited": it is a failure that happens to say the word.
  expect(formatQuotaWindow(quota({ status: "error", remaining: null, limit: null, detail: "unlimited" }))?.unlimited).toBe(false)
})

test("nothing is drawn for a provider that has never reported anything", () => {
  expect(formatQuotaWindow(null)).toBeNull()
})

/** The vendor's allowance and this machine's tally travel together; see `FreeUsage`. */
function freeUsage(overrides: Partial<FreeUsage> = {}): FreeUsage {
  return {
    date: "2026-01-02",
    calls: 0,
    limit: null,
    remaining: null,
    resetAt: null,
    resetSource: null,
    blocked: false,
    ...overrides
  }
}

test("the free allowance is the vendor's pair, never the local tally divided by it", () => {
  expect(freeAllowance(freeUsage({ calls: 3, limit: 1_000, remaining: 988 }))).toEqual({
    kind: "pair",
    remaining: 988,
    limit: 1_000
  })
  // A local tally of 3 with a vendor remainder of 988 stays exactly that: nothing is subtracted.
  expect(freeAllowance(freeUsage({ calls: 12, limit: 1_000, remaining: 988 }))).toEqual({
    kind: "pair",
    remaining: 988,
    limit: 1_000
  })
})

test("a half-known free allowance keeps only the half the vendor stated", () => {
  expect(freeAllowance(freeUsage({ limit: 1_000, remaining: null }))).toEqual({ kind: "limitOnly", limit: 1_000 })
  expect(freeAllowance(freeUsage({ limit: null, remaining: 4 }))).toEqual({ kind: "remainingOnly", remaining: 4 })
  // Nothing known stays nothing known — no zero, no derived value.
  expect(freeAllowance(freeUsage({ limit: null, remaining: null, calls: 7 }))).toBeNull()
  // A non-finite number is not a number the vendor stated.
  expect(freeAllowance(freeUsage({ limit: Number.NaN, remaining: Number.POSITIVE_INFINITY }))).toBeNull()
})

test("a zero remainder survives as a stated zero", () => {
  // 0 is a real reading (the allowance is spent); it must reach the row as `0 / 50`.
  expect(freeAllowance(freeUsage({ limit: 50, remaining: 0 }))).toEqual({ kind: "pair", remaining: 0, limit: 50 })
})

test("the free reset carries its source, and an unknown source yields no countdown", () => {
  const now = 1_767_225_600_000
  const inAnHour = 1_767_225_600 + 3_600
  expect(freeResetHint(freeUsage({ resetAt: inAnHour, resetSource: "vendor" }), now)).toEqual({
    kind: "vendor",
    seconds: 3_600
  })
  expect(freeResetHint(freeUsage({ resetAt: inAnHour, resetSource: "utcDay" }), now)).toEqual({
    kind: "utcDay",
    seconds: 3_600
  })
  // A timestamp with no provenance is not drawable: we would be guessing where it came from.
  expect(freeResetHint(freeUsage({ resetAt: inAnHour, resetSource: null }), now)).toBeNull()
  expect(freeResetHint(freeUsage({ resetAt: null, resetSource: "vendor" }), now)).toBeNull()
  // An elapsed window says nothing about a reset that is already in the past.
  expect(freeResetHint(freeUsage({ resetAt: 1_767_225_600 - 60, resetSource: "vendor" }), now)).toBeNull()
  // A computed UTC rollover with no usable timestamp still names the rule.
  expect(freeResetHint(freeUsage({ resetAt: null, resetSource: "utcDay" }), now)).toEqual({
    kind: "utcDay",
    seconds: null
  })
})
