export type RecentProject = {
  sessionId: string | null
  cwd: string
  name: string
  title: string | null
  updatedAt: string | null
}

type SessionRow = {
  sessionId?: string
  cwd: string
  title: string | null
  updatedAt: string | null
}

export function projectNameFromPath(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "")
  return trimmed.split(/[\\/]/).pop() || trimmed
}

/**
 * Newest projects first, one row per folder. Quick chats are temporary folders, so the caller
 * excludes them; they are not projects the reader can return to.
 */
export function recentProjectsFrom(
  rows: readonly SessionRow[],
  limit = 4,
  isExcluded: (cwd: string) => boolean = () => false
): RecentProject[] {
  const seen = new Set<string>()
  const projects: RecentProject[] = []
  for (const row of [...rows].sort((left, right) =>
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
  )) {
    const cwd = row.cwd.trim()
    if (cwd === "" || seen.has(cwd) || isExcluded(cwd)) continue
    seen.add(cwd)
    projects.push({
      sessionId: row.sessionId ?? null,
      cwd,
      name: projectNameFromPath(cwd),
      title: row.title?.trim() || null,
      updatedAt: row.updatedAt
    })
    if (projects.length >= limit) break
  }
  return projects
}
