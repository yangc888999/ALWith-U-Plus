// What a provider says it has left, straight from the Rust side.
//
// Two rules decide this whole module:
//
//   1. **Never invent a number.** Every figure below is either something the vendor returned or
//      nothing at all. A missing `remaining` is rendered as nothing — not as `0`, not as `—` that
//      later reads as a real zero, and not as `limit - used` (which silently turns two numbers the
//      vendor reported for different windows into a third one it never said).
//   2. **The status is the verdict, the numbers are the evidence.** A provider that only shows its
//      plan inside a web console, or one with no public quota endpoint at all, still has a row —
//      it just carries a sentence instead of figures. That is why `status` travels with the data
//      instead of the UI guessing from a null.
//
// The row itself is written in `src/features/settings/sections/provider-usage.tsx`; this file has
// no React and no `t()`, so the wording stays in the locale files and the shape stays testable.

import { invoke } from "@tauri-apps/api/core"

/** `ok` is the only state whose figures are known to be live and complete. */
export type ProviderQuotaStatus = "ok" | "unsupported" | "console" | "unauthorized" | "unreachable" | "error"

/** `usd` is money; the rest are counters the vendor publishes in its own unit. */
export type ProviderQuotaUnit = "usd" | "credits" | "requests" | "tokens"

/** The counter units that are not money — the ones rendered as "remaining N <unit>". */
export type QuotaCountUnit = Exclude<ProviderQuotaUnit, "usd">

/**
 * One provider's quota window. Every optional field is genuinely optional: vendors differ in what
 * they publish, and the Rust command reports `null` rather than a placeholder.
 */
export type ProviderQuota = {
  providerId: string
  status: ProviderQuotaStatus
  /** Which endpoint answered (e.g. `credits`, `key`, `rate_limits`). Shown as the hover detail. */
  kind: string
  remaining: number | null
  limit: number | null
  used: number | null
  unit: ProviderQuotaUnit | null
  /** Unix timestamp of the window reset. Seconds or milliseconds — see `unixMillis`. */
  resetAt: number | null
  /** Unix timestamp this credential stops being valid. */
  expiresAt: number | null
  plan: string | null
  /** The vendor's own sentence, kept for the hover title only. */
  detail: string | null
  /**
   * Why no probe was attempted, set only when `status === "unsupported"`:
   * `noApi` (the vendor publishes no quota API — nothing to fix), `disabled` (the credential is
   * switched off), `noBaseUrl` (no usable address, so there is nowhere to ask).
   *
   * The last two are the reader's to fix, which is why they cannot share one sentence with the
   * first. Matched by exact equality — `detail` is prose and must never be parsed for this.
   */
  unsupportedReason: string | null
  /** Unix timestamp this reading was taken. */
  fetchedAt: number
}

/**
 * OpenRouter's `:free` picture for today. It carries **two independent counters** and they must
 * never be combined:
 *
 *   * `limit` / `remaining` / `resetAt` / `resetSource` — the vendor's own free-model allowance,
 *     read from its response headers. This is the number a reader cares about;
 *   * `calls` — how many `:free` calls *this machine* made today, tallied locally.
 *
 * `calls / limit` is therefore a false ratio (a second machine would move the vendor half and not
 * the local half). The row prints `remaining / limit` and shows `calls` as its own labelled figure.
 */
export type FreeUsage = {
  /** The local calendar day the `calls` tally belongs to, as `YYYY-MM-DD`. */
  date: string
  /** `:free` calls made by this machine today. Local tally — not the vendor's counter. */
  calls: number
  /** The vendor's free-model allowance for the current day, when it answered. */
  limit: number | null
  /** What the vendor says is left of that allowance. `null` means it did not say. */
  remaining: number | null
  /** Unix seconds (see `unixMillis`). */
  resetAt: number | null
  /**
   * Where `resetAt` came from. `"vendor"` is an instant the vendor sent with the allowance — a
   * fact it stated. `"utcDay"` is the 00:00 UTC rollover *we* compute, because the vendor's daily
   * counter resets then but ships no timestamp; that one is a rule about the vendor, not something
   * it told us, so it must not be phrased like the other case. Any other value (including `null`)
   * means no reset is known and no countdown may be drawn.
   */
  resetSource?: "utcDay" | "vendor" | null
  /**
   * `true` only when the vendor *enforced* a limit (a real 429), never merely because `remaining`
   * reached 0 — a policy reading of zero from the key endpoint does not block anything.
   */
  blocked: boolean
}

/** Cached readings, one per provider. Read on mount so the row is never empty on a slow network. */
export function cachedProviderQuotas(): Promise<ProviderQuota[]> {
  return invoke<ProviderQuota[]>("provider_quota_cached")
}

/** A live read for one provider. Rejects when the vendor cannot be reached. */
export function queryProviderQuota(providerId: string): Promise<ProviderQuota> {
  return invoke<ProviderQuota>("provider_quota_query", { providerId })
}

/** Today's `:free` picture: the vendor's allowance plus this machine's own tally. */
export function openrouterFreeUsage(): Promise<FreeUsage> {
  return invoke<FreeUsage>("openrouter_free_usage")
}

/**
 * Unix timestamps arrive at two precisions: the quota commands report seconds, while anything the
 * webview records itself (a cached reading it stamped on arrival) is milliseconds. Rather than
 * trusting one of them and printing a date in 1970 for the other, anything below 1e11 is read as
 * seconds — that threshold is 5138 AD in seconds and 1973 in milliseconds, so no real timestamp
 * lands in the wrong branch.
 */
export function unixMillis(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null
  return value < 1e11 ? value * 1000 : value
}

/** Seconds left in a window, clamped at zero — a countdown never renders a negative number. */
export function quotaCountdownSeconds(resetAt: number | null, now: number): number | null {
  const at = unixMillis(resetAt)
  if (at === null) return null
  return Math.max(0, Math.floor((at - now) / 1000))
}

/** `YYYY/MM/DD HH:mm` in the reader's own timezone. */
export function formatQuotaStamp(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ""
  const pad = (value: number): string => String(value).padStart(2, "0")
  const day = `${String(date.getFullYear())}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `HH:mm` — the "updated at" stamp, where the date would only add noise. */
export function formatQuotaClock(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ""
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

/** The figure the row prints, already reduced to the two shapes it can draw. */
export type QuotaFigure =
  | { kind: "usd"; remaining: number; limit: number | null }
  | { kind: "count"; remaining: number; unit: QuotaCountUnit }

/** Everything the row needs, in one object, with no wording attached. */
export type QuotaWindow = {
  status: ProviderQuotaStatus
  /** The figures came from the cache (or survived a failed refresh) and must be labelled as such. */
  stale: boolean
  figure: QuotaFigure | null
  /** The vendor states there is no ceiling. Carries no figure on purpose — "unlimited" is a fact
   *  about the absence of a number, not a number. */
  unlimited: boolean
  /** Normalised to milliseconds via `unixMillis`. */
  resetAt: number | null
  /** Normalised to milliseconds via `unixMillis`. */
  expiresAt: number | null
  /** Normalised to milliseconds via `unixMillis`. */
  fetchedAt: number | null
  plan: string | null
  detail: string | null
  /** Passed through untouched so the card can word an `unsupported` verdict correctly. */
  unsupportedReason: string | null
}

const COUNT_UNITS: readonly string[] = ["credits", "requests", "tokens"]

/**
 * The figure a quota describes, or `null` when the vendor did not publish enough to say one.
 *
 * `remaining` is the only accepted source. A `limit` with no `remaining` is still a real limit —
 * but the row must not print a remaining balance the vendor never stated, so it prints the limit
 * alone (see `quotaLimit` below) and no figure.
 */
function figureOf(quota: ProviderQuota): QuotaFigure | null {
  if (quota.remaining === null || !Number.isFinite(quota.remaining)) return null
  if (quota.unit === "usd") return { kind: "usd", remaining: quota.remaining, limit: quota.limit }
  if (quota.unit !== null && COUNT_UNITS.includes(quota.unit)) {
    return { kind: "count", remaining: quota.remaining, unit: quota.unit as QuotaCountUnit }
  }
  return null
}

/**
 * Turns one backend reading into the row's model.
 *
 * `unreachable` and `error` keep their figures — the last reading we hold is still the last thing
 * the vendor said, and a reader looking at a red row would rather see "12.40 left, cached" than
 * nothing. Every other non-`ok` status carries no figures at all, because those statuses mean the
 * vendor never published any.
 *
 * `detail` is a shared channel, so it is read by **exact match only** and never by substring. The
 * backend puts two machine tokens there — `stale` (a ≤24h snapshot replayed after a failed
 * refresh, numbers intact) and `unlimited` (the vendor states there is no ceiling) — and prose on
 * every other path (`HTTP 500`, `request: …`, `New API: …; billing: …`). A `includes()` check would
 * eventually paint 「不限量」 over a real failure.
 *
 * `options.fromCache` marks a reading that has not been refreshed yet (the cache-first paint), so
 * the row does not present a stale balance as the current one.
 */
export function formatQuotaWindow(
  quota: ProviderQuota | null,
  options: { fromCache?: boolean } = {}
): QuotaWindow | null {
  if (quota === null) return null
  const figure = figureOf(quota)
  const numeric = quota.status === "ok" || quota.status === "unreachable" || quota.status === "error"
  // A replayed snapshot is served with `status: "ok"` and every number intact — the only marker is
  // this token. Without reading it, a day-old balance would render as if it had just been fetched.
  const replayed = quota.detail === "stale"
  return {
    status: quota.status,
    stale: figure !== null && (quota.status !== "ok" || replayed || options.fromCache === true),
    figure: numeric ? figure : null,
    // A ceiling-less plan publishes no numbers at all (`limit: null`, `remaining: null`), so the
    // token is the only thing that distinguishes it from "nothing was reported".
    unlimited:
      quota.status === "ok" &&
      quota.detail === "unlimited" &&
      quota.limit === null &&
      quota.remaining === null,
    resetAt: unixMillis(quota.resetAt),
    expiresAt: unixMillis(quota.expiresAt),
    fetchedAt: unixMillis(quota.fetchedAt),
    plan: quota.plan,
    detail: quota.detail,
    unsupportedReason: quota.unsupportedReason
  }
}

/** The vendor's free-model allowance, reduced to the four shapes the row can draw. */
export type FreeAllowance =
  | { kind: "pair"; remaining: number; limit: number }
  | { kind: "remainingOnly"; remaining: number }
  | { kind: "limitOnly"; limit: number }
  | null

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * What the vendor says is left today, based on `remaining` and `limit` **only**.
 *
 * `calls` is deliberately absent: it is this machine's tally for a different question, and
 * `calls / limit` would divide one source by another. A half-known allowance keeps the half the
 * vendor did state — a published `limit` with an undisclosed `remaining` is a fact, `0` is not.
 */
export function freeAllowance(free: FreeUsage): FreeAllowance {
  const remaining = finiteOrNull(free.remaining)
  const limit = finiteOrNull(free.limit)
  if (remaining !== null && limit !== null) return { kind: "pair", remaining, limit }
  if (remaining !== null) return { kind: "remainingOnly", remaining }
  if (limit !== null) return { kind: "limitOnly", limit }
  return null
}

/** How — and whether — the free window's reset may be stated. */
export type FreeResetHint =
  | { kind: "vendor"; seconds: number | null }
  | { kind: "utcDay"; seconds: number | null }
  | null

/**
 * The reset of the free window, with its provenance attached.
 *
 * The two sources may not share wording: `"utcDay"` is a rule we derive (00:00 UTC), while
 * `"vendor"` is an instant the vendor sent. A missing or unreadable `resetSource` yields `null` —
 * drawing a countdown for a value nobody stated is exactly the kind of plausible-looking guess
 * this module exists to avoid.
 */
export function freeResetHint(free: FreeUsage, now: number): FreeResetHint {
  const source = free.resetSource ?? null
  const seconds = quotaCountdownSeconds(free.resetAt, now)
  const live = seconds !== null && seconds > 0 ? seconds : null
  if (source === "vendor") return live === null ? null : { kind: "vendor", seconds: live }
  if (source === "utcDay") return { kind: "utcDay", seconds: live }
  return null
}
