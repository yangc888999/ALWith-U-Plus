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
  const newest = new Map<string, { row: SessionRow; index: number }>()
  rows.forEach((row, index) => {
    const cwd = row.cwd.trim()
    if (!cwd) return
    const previous = newest.get(cwd)
    if (!previous || (row.updatedAt ?? "").localeCompare(previous.row.updatedAt ?? "") > 0)
      newest.set(cwd, { row, index })
  })
  return [...newest]
    .filter(([cwd]) => !isExcluded(cwd))
    .sort(([, left], [, right]) =>
      (right.row.updatedAt ?? "").localeCompare(left.row.updatedAt ?? "") || left.index - right.index
    )
    .slice(0, Math.max(0, limit))
    .map(([cwd, { row }]) => ({
      sessionId: row.sessionId ?? null,
      cwd,
      name: projectNameFromPath(cwd),
      title: row.title?.trim() || null,
      updatedAt: row.updatedAt
    }))
}
