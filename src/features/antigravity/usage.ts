export type AntigravityLimit = {
  group: string | null
  label: string
  resetsAt: number | null
} & ({ remainingPercent: number } | { remainingUnits: number })

export type AntigravityUsage = { status: "ready"; limits: AntigravityLimit[] } | { status: "error" | "unavailable" }

export function parseAntigravityUsage(report: string): AntigravityUsage {
  const [, section] = report.split(/^### Quota Limits\s*$/m, 2)
  if (section === undefined) return { status: "unavailable" }
  const [quota] = section.split(/^### /m, 1)
  if (/^\s*- Unable to retrieve quota status\b/m.test(quota ?? "")) return { status: "error" }

  const limits: AntigravityLimit[] = []
  let group: string | null = null
  for (const line of (quota ?? "").split(/\r?\n/)) {
    const heading = /^- \*\*(.+?)\*\*\s*$/.exec(line)
    if (heading) group = heading[1] ?? null
    const bucket = /^\s+- \*\*(.+?):\*\* (\d[\d,]*)(%| units) remaining(?: \(resets (.+)\))?\s*$/.exec(line)
    if (bucket === null) continue
    const [, label, value, unit, reset] = bucket
    if (!label || !value) continue
    const remaining = Number(value.replaceAll(",", ""))
    if (!Number.isSafeInteger(remaining) || (unit === "%" && (remaining > 100 || value.includes(",")))) continue
    const date = reset === undefined ? NaN : Date.parse(reset)
    const data = { group, label, resetsAt: Number.isFinite(date) ? date : null }
    limits.push(unit === "%" ? { ...data, remainingPercent: remaining } : { ...data, remainingUnits: remaining })
  }
  return limits.length === 0 ? { status: "unavailable" } : { status: "ready", limits }
}
