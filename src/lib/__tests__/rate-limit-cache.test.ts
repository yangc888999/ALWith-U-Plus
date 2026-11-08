// The usage panel survives a restart inside a network outage only because the last good snapshot
// is on disk. A corrupt or half-written payload must degrade to "nothing cached", never throw.

import { expect, test } from "vitest"

import { hasRateLimitWindows, readCachedRateLimits, writeCachedRateLimits } from "../rate-limit-cache"

const snapshot = {
  limitId: null,
  limitName: null,
  credits: null,
  spendControlReached: null,
  planType: "pro",
  primary: { usedPercent: 27, windowDurationMins: 10080, resetsAt: null },
  secondary: null
} as const

test("a stored snapshot round-trips with its capture time", () => {
  localStorage.clear()
  writeCachedRateLimits({ snapshot, capturedAt: 1_700_000_000_000 })
  expect(readCachedRateLimits()).toEqual({ snapshot, capturedAt: 1_700_000_000_000 })
})

test("an empty store has nothing to offer", () => {
  localStorage.clear()
  expect(readCachedRateLimits()).toBeNull()
})

test("a corrupt payload is treated as no cache instead of throwing", () => {
  localStorage.clear()
  localStorage.setItem("alwith.rate-limits", "{not json")
  expect(readCachedRateLimits()).toBeNull()
})

test("a payload without a usable timestamp is ignored", () => {
  localStorage.clear()
  localStorage.setItem("alwith.rate-limits", JSON.stringify({ snapshot, capturedAt: "yesterday" }))
  expect(readCachedRateLimits()).toBeNull()
})

test("a 200 with no windows is not data and must not replace the cache", () => {
  expect(hasRateLimitWindows(snapshot)).toBe(true)
  expect(
    hasRateLimitWindows({
      ...snapshot,
      primary: null,
      secondary: { usedPercent: 5, windowDurationMins: 60, resetsAt: null }
    })
  ).toBe(true)
  expect(hasRateLimitWindows({ ...snapshot, primary: null, secondary: null })).toBe(false)
  expect(hasRateLimitWindows(null)).toBe(false)

  localStorage.clear()
  writeCachedRateLimits({ snapshot, capturedAt: 1_700_000_000_000 })
  // The caller skips writeCachedRateLimits for an empty answer; the good snapshot survives.
  expect(readCachedRateLimits()?.snapshot.primary?.usedPercent).toBe(27)
})
