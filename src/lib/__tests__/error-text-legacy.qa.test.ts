// QA probe: the legacy English sentences that `providers/managed.rs` and `enterprise.rs` can still
// emit, run through the real `describeError` table.
//
// The claim being verified is not "a regex contains these words" but "the reader never sees this
// English". So each case starts from a string copied out of the Rust source and asserts on the
// resolved *text*. Two of the six added alternatives turn out to be shadowed by the generic
// timeout rule that sits earlier in the table; that is recorded here rather than assumed away —
// the reader still gets Chinese, just a less specific sentence.

import { beforeAll, expect, test } from "vitest"

import i18n, { initI18n } from "@/lib/i18n"

import { describeError } from "../error-text"

beforeAll(async () => {
  await initI18n("zh-CN")
})

/** Verbatim from `src-tauri/src/providers/managed.rs` teardown paths. */
const TEARDOWN = [
  "Runtime unavailable; ALwith cleanup is unconfirmed",
  "ALwith request admission did not settle",
  "ALwith turn cancellation timed out",
  "ALwith Runtime cleanup failed (invalid_request)",
  "ALwith account transition did not settle; cleanup is incomplete",
  "ALwith provider configuration did not settle; cleanup is incomplete",
  "ALwith provider cleanup timed out; execution remains blocked",
  "ALwith provider cleanup is incomplete; wait for active sessions and retry",
  "Previous ALwith provider cleanup is incomplete; retry logout",
  "Runtime changed during ALwith cleanup"
]

test("every teardown sentence is answered in Chinese, never echoed back in English", () => {
  for (const raw of TEARDOWN) {
    const text = describeError(new Error(raw))
    expect(text, `${raw} → ${text}`).not.toBe(raw)
    expect(text, `${raw} → ${text}`).toMatch(/[\u4e00-\u9fff]/)
  }
})

test("each teardown sentence lands on a Chinese remedy — three keys, first match wins", () => {
  // Not one key for all of them, and that is correct: two earlier rules are deliberately more
  // precise. `/ALwith Runtime cleanup failed \(([^)]+)\)/` keeps the ACP error code (declared just
  // above the general cleanup rule for exactly this reason), and `/\btimed out\b/` claims the two
  // timeout sentences before the cleanup rule can see them. What must hold for every one of them:
  // the reader gets Chinese and a next step, and the English sentence does not come through.
  const cleanup = i18n.t("error.accountCleanupPending")
  const cases: Array<[string, string]> = [
    ["Runtime unavailable; ALwith cleanup is unconfirmed", cleanup],
    ["ALwith request admission did not settle", cleanup],
    ["ALwith account transition did not settle; cleanup is incomplete", cleanup],
    ["ALwith provider configuration did not settle; cleanup is incomplete", cleanup],
    ["ALwith provider cleanup is incomplete; wait for active sessions and retry", cleanup],
    ["Previous ALwith provider cleanup is incomplete; retry logout", cleanup],
    ["Runtime changed during ALwith cleanup", cleanup],
    // The code survives into the sentence: better than the general remedy.
    ["ALwith Runtime cleanup failed (invalid_request)", i18n.t("error.accountCleanupFailed", { code: "invalid_request" })],
    // Shadowed by the generic timeout rule declared above the cleanup rule.
    ["ALwith turn cancellation timed out", i18n.t("error.timeout")],
    ["ALwith provider cleanup timed out; execution remains blocked", i18n.t("error.timeout")]
  ]
  for (const [raw, expected] of cases) {
    expect(expected, raw).not.toMatch(/^error\./)
    expect(describeError(raw), raw).toBe(expected)
  }
})

test("a cleanup timeout is reported as a plain timeout — the earlier rule wins", () => {
  // CHARACTERIZATION: `cancellation timed out` and `cleanup timed out` in the new rule are
  // unreachable, because `/…|\btimed out\b/i` → `error.timeout` is declared above it and
  // `describeError` returns the first match. Reported to the implementer as a precision gap,
  // not as an English leak: the reader still gets Chinese.
  const timeout = i18n.t("error.timeout")
  expect(describeError("ALwith turn cancellation timed out")).toBe(timeout)
  expect(describeError("ALwith provider cleanup timed out; execution remains blocked")).toBe(timeout)
})

test("the internal invariants get no remedy sentence of their own, as the table documents", () => {
  const cleanup = i18n.t("error.accountCleanupPending")
  const changed = i18n.t("error.accountChanged")
  for (const raw of [
    "Provider revision exhausted",
    "Account generation exhausted",
    "ALwith account changes belong to the main window",
    "Use structured Runtime requests for session operations",
    "Explicit model recovery requires a model"
  ]) {
    const text = describeError(raw)
    // The engine's own sentence survives verbatim (it is what makes a bug report actionable)…
    expect(text, raw).toContain(raw)
    // …and none of the account remedies claims it, which is the property the comment states.
    expect(text, raw).not.toBe(cleanup)
    expect(text, raw).not.toBe(changed)
  }
})
