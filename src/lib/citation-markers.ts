/**
 * ChatGPT's internal citation marker: U+E200 "cite" U+E202 <ref> U+E201.
 *
 * The reference ids (`turn0search0`, …) only mean something to the web-search UI that produced
 * them. A plain transcript has no source table to resolve them against, so the marker used to
 * leak into the answer as "cite turn0search0 turn0search2".
 */
const COMPLETE_MARKER = /\uE200cite[\s\S]*?\uE201/gi
/** A marker that is still streaming in: hide it until its closing byte arrives. */
const OPEN_MARKER = /\uE200cite[\s\S]*$/gi
const MARKER_PREFIX = "\uE200cite"

/** Removes internal citation markers from text that is shown to the reader. */
export function withoutCitationMarkers(text: string): string {
  // Restrict cleanup to the citation marker, not every private-use sequence: other markers can
  // be meaningful to a renderer and must not disappear because they share the same envelope.
  return text.replace(COMPLETE_MARKER, "").replace(OPEN_MARKER, "")
}

/**
 * Stateful variant for ACP `*_chunk` updates. The adapter may split a citation marker across
 * streamed chunks, so a stateless replace would leave the tail (`turn0search0…`) in the stored
 * transcript. This keeps only the ambiguous suffix between pushes.
 */
export class CitationStreamFilter {
  private pending = ""

  push(text: string): string {
    if (this.pending === "" && !text.includes("\uE200")) return text
    const input = this.pending + text
    this.pending = ""
    let output = ""
    let cursor = 0
    while (cursor < input.length) {
      const start = input.indexOf("\uE200", cursor)
      if (start === -1) {
        output += input.slice(cursor)
        break
      }
      output += input.slice(cursor, start)
      const candidate = input.slice(start, start + MARKER_PREFIX.length)
      if (candidate !== MARKER_PREFIX.slice(0, candidate.length)) {
        // Another private-use marker (for example visualize) shares the opener; preserve it.
        output += "\uE200"
        cursor = start + 1
        continue
      }
      if (candidate.length < MARKER_PREFIX.length) {
        // Not enough bytes to know whether this is a citation marker yet.
        this.pending = input.slice(start)
        break
      }
      const close = input.indexOf("\uE201", start + MARKER_PREFIX.length)
      if (close === -1) {
        // A citation marker that is still streaming; hide it and wait for the close byte.
        this.pending = input.slice(start)
        break
      }
      cursor = close + 1
    }
    return output
  }

  /** Drops an unterminated marker when the message/stream ends. */
  flush(): void {
    this.pending = ""
  }
}
