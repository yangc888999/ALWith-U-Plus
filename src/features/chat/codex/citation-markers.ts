/**
 * ChatGPT's internal citation marker: U+E200 "cite" U+E202 <ref> U+E201.
 *
 * The reference ids (`turn0search0`, …) only mean something to the web-search UI that produced
 * them. A plain transcript has no source table to resolve them against, so the marker used to
 * leak into the answer as "cite turn0search0 turn0search2".
 */
const COMPLETE_MARKER = /\uE200[\s\S]*?\uE201/g
/** A marker that is still streaming in: hide it until its closing byte arrives. */
const OPEN_MARKER = /\uE200[\s\S]*$/g
/** Orphaned marker bytes (for example when a model dropped only the opener). */
const STRAY_BYTES = /[\uE200-\uE202]/g

/** Removes internal citation markers from text that is shown to the reader. */
export function withoutCitationMarkers(text: string): string {
  return text.replace(COMPLETE_MARKER, "").replace(OPEN_MARKER, "").replace(STRAY_BYTES, "")
}
