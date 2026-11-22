export type GreetingPeriod = "morning" | "afternoon" | "evening" | "lateEvening" | "lateNight"

/**
 * The greeting follows the reader's own clock. Late night is its own period because the
 * sentence changes: it says good night instead of asking what to start.
 */
export function greetingPeriod(date: Date): GreetingPeriod {
  const hour = date.getHours()
  if (hour >= 5 && hour < 12) return "morning"
  if (hour >= 12 && hour < 18) return "afternoon"
  if (hour >= 22) return "lateEvening"
  if (hour >= 18) return "evening"
  return "lateNight"
}

/** The account name, or the email's local part when the account has no nickname. */
export function welcomeName(
  displayName: string | null | undefined,
  email: string | null | undefined
): string | null {
  const name = displayName?.trim()
  if (name) {
    const local = name.includes("@") ? name.split("@")[0] : name
    if (local?.trim()) return local.trim()
  }
  const address = email?.trim()
  const local = address?.includes("@") ? address.split("@")[0] : address
  return local?.trim() || null
}

export function greetingKey(period: GreetingPeriod, hasName: boolean): string {
  const suffix = hasName ? "" : "Anon"
  switch (period) {
    case "morning":
      return `welcome.morning${suffix}`
    case "afternoon":
      return `welcome.afternoon${suffix}`
    case "evening":
      return `welcome.evening${suffix}`
    case "lateEvening":
      return `welcome.lateEvening${suffix}`
    case "lateNight":
      return `welcome.lateNight${suffix}`
  }
}

/** The second welcome line follows the same clock but changes the reminder, not the greeting. */
export function welcomeSubtitleKey(period: GreetingPeriod): string {
  if (period === "lateNight") return "welcome.lateNightSubtitle"
  if (period === "lateEvening") return "welcome.lateEveningSubtitle"
  return "welcome.subtitle"
}

