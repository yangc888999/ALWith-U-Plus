/**
 * `mm:ss` for a *relative* number of seconds.
 *
 * Two callers share this: the Lark device-code QR countdown (relative `expires_in`, always a few
 * minutes) and the usage page's rate-limit reset card (an absolute Unix `resetsAt` converted to
 * seconds by the caller). Minutes are not folded into hours on purpose — the QR code's window is
 * short, and folding would have changed the string every existing test and screenshot pins.
 */
export function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
}

/**
 * `HH:mm:ss`, or `Xd HH:mm:ss` once the remainder no longer fits in a day.
 *
 * A rate-limit window can be five hours or seven days, so `mm:ss` would have printed `7000:00` for
 * the weekly one. Days are spelled out and the clock restarts at `00:00:00` after them, which is how
 * a reader says "six days, twenty-three hours". Anything below a day keeps the plain clock that
 * `formatCountdown` already produces for the QR code — the two formats never disagree below 24h.
 *
 * Negative and fractional inputs are clamped: a countdown never renders "-00:00:01".
 */
export function formatRemaining(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const rest = total % 60
  const clock = [hours, minutes, rest].map((part) => String(part).padStart(2, "0")).join(":")
  return days > 0 ? `${String(days)}d ${clock}` : clock
}
