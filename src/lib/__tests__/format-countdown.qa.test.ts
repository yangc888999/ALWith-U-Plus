// QA probe: the two countdown formats, at their boundaries.
//
// `formatRemaining` is the only formatter the usage page's reset card uses, and its ≥86400 branch
// (`Xd HH:mm:ss`) had no test anywhere: the card's own suite asserts the *label* for a 7-day window
// but never the remaining string, so a regression to `167:59:59` would have shipped silently.
// `formatCountdown` is the Lark QR countdown and must keep folding nothing into hours.

import { expect, test } from "vitest"

import { formatCountdown, formatRemaining } from "../format-countdown"

test("below a day the remaining clock is HH:mm:ss and agrees with the QR formatter", () => {
  // The two formats overlap below 24h on purpose: 5h, 1h, 1m and 1s.
  for (const seconds of [0, 1, 59, 60, 61, 3_599, 3_600, 3_601, 18_000, 86_399]) {
    const hours = Math.floor(seconds / 3_600)
    const minutes = Math.floor((seconds % 3_600) / 60)
    const rest = seconds % 60
    const expected = [hours, minutes, rest].map((part) => String(part).padStart(2, "0")).join(":")
    expect(formatRemaining(seconds)).toBe(expected)
  }
  // The one case the two share exactly: under an hour this is plain mm:ss.
  expect(formatRemaining(90)).toBe("00:01:30")
  expect(formatCountdown(90)).toBe("01:30")
})

test("a day or more is spelled out as Xd HH:mm:ss, never as a huge hour count", () => {
  // 86400 must cross the boundary, not sit at "24:00:00".
  expect(formatRemaining(86_400)).toBe("1d 00:00:00")
  expect(formatRemaining(86_401)).toBe("1d 00:00:01")
  // A 7-day rate-limit window is the case the card actually renders.
  expect(formatRemaining(7 * 86_400)).toBe("7d 00:00:00")
  // "six days, twenty-three hours" is how a reader says it.
  expect(formatRemaining(6 * 86_400 + 23 * 3_600 + 59 * 60 + 59)).toBe("6d 23:59:59")
  // One second short of two days must not round up into "2d".
  expect(formatRemaining(2 * 86_400 - 1)).toBe("1d 23:59:59")
})

test("a countdown never renders a negative or fractional clock", () => {
  expect(formatRemaining(0)).toBe("00:00:00")
  expect(formatRemaining(-1)).toBe("00:00:00")
  expect(formatRemaining(-86_400)).toBe("00:00:00")
  // Fractional seconds are floored, not rounded: a countdown must not award a second.
  expect(formatRemaining(90.9)).toBe("00:01:30")
  expect(formatRemaining(0.999)).toBe("00:00:00")
  // Non-finite input is clamped instead of rendering "NaN:NaN:NaN".
  expect(formatRemaining(Number.NaN)).toBe("00:00:00")
  expect(formatRemaining(Number.POSITIVE_INFINITY)).toBe("00:00:00")
})

test("the QR countdown keeps mm:ss and does not fold minutes into hours", () => {
  // 7000s used to be the argument for folding; the QR window is short and its format is pinned by
  // existing screenshots, so it stays mm:ss even when the number grows.
  expect(formatCountdown(7_000)).toBe("116:40")
  expect(formatCountdown(0)).toBe("00:00")
  expect(formatCountdown(59)).toBe("00:59")
  expect(formatCountdown(3_600)).toBe("60:00")
})
