// The ChatGPT usage panel asks chatgpt.com for its rate-limit windows. That host sits behind the
// same network the chat itself needs, so an offline moment, a dropped VPN or a transient 5xx turns
// the panel into "暂无用量数据" even though the numbers were known a minute ago. Keep the last
// successful snapshot on disk: across restarts the panel can then show it and say how old it is
// instead of pretending there is no usage at all.

import type { RateLimitSnapshot } from "@nyssance/codex-acp-v2/client"

const KEY = "alwith.rate-limits"

export interface CachedRateLimits {
  snapshot: RateLimitSnapshot
  /** When this snapshot was read from ChatGPT, in epoch milliseconds. */
  capturedAt: number
}

export function readCachedRateLimits(): CachedRateLimits | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (raw === null || raw === undefined) return null
    const parsed = JSON.parse(raw) as Partial<CachedRateLimits> | null
    if (parsed?.snapshot === null || parsed?.snapshot === undefined) return null
    if (typeof parsed.capturedAt !== "number" || !Number.isFinite(parsed.capturedAt)) return null
    return { snapshot: parsed.snapshot, capturedAt: parsed.capturedAt }
  } catch {
    // A quota error or a payload written by an older build: a missing cache is not an error.
    return null
  }
}

export function writeCachedRateLimits(value: CachedRateLimits): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(value))
  } catch {
    // Storage full or disabled: the in-memory copy still serves this session.
  }
}

/**
 * A 200 response with both windows null is not usage data: chatgpt.com does this while a sign-in
 * token is being replaced. Treating it as a successful read used to overwrite the last good
 * snapshot, after which the panel could only say "暂无用量数据" — with nothing left to fall back
 * to. Only real windows are worth caching or showing.
 */
export function hasRateLimitWindows(snapshot: RateLimitSnapshot | null): boolean {
  return snapshot !== null && (snapshot.primary != null || snapshot.secondary != null)
}
