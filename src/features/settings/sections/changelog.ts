/**
 * Release history for the About dialog.
 *
 * The repository's `CHANGELOG.md` is the only source: every release already edits it, and the
 * dialog used to read a second copy out of the locale files, which only ever held the newest
 * version — so the history readers asked for was never there. Parsing the file keeps one list in
 * one place, and the `## 0.3.8` headings natural to that file are exactly the grouping the dialog
 * renders.
 */
export type ChangeLogGroup = { version: string; items: string[] }

export function parseChangeLog(markdown: string): ChangeLogGroup[] {
  const groups: ChangeLogGroup[] = []
  let current: ChangeLogGroup | null = null
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading !== null) {
      // A heading that is not a bare version (e.g. upstream's "0.1.0 (unreleased)") ends the
      // previous group instead of inheriting its bullets.
      const version = /^v?(\d+(?:\.\d+)*)$/.exec(heading[1].trim())
      current = version === null ? null : { version: version[1], items: [] }
      if (current !== null) groups.push(current)
      continue
    }
    if (current === null) continue
    const bullet = /^[*\-]\s+(.+)$/.exec(line.trim())
    if (bullet === null) continue
    const item = bullet[1].replace(/[；;]\s*$/, "").trim()
    if (item !== "") current.items.push(item)
  }
  return groups.filter((group) => group.items.length > 0)
}
