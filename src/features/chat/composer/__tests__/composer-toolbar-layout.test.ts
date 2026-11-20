/**
 * Two composer layout contracts, both reported from a narrow window (2026-11-20):
 *
 * 1. The strip above the input (quoted document · running state · 分工) must keep a visible
 *    rounded-top surface. The package paints it `bg-sidebar`; v1.0.13 folded the solid
 *    appearance's --sidebar into the same colour as --card/--background, so the strip lost its
 *    background without any markup change. The contrast is restored on the strip itself.
 *
 * 2. The send key must never sit on top of the model picker. The toolbar's right group used to
 *    overflow LEFT (justify-end + unshrinkable children) once it outgrew its grid track, so a
 *    click aimed at send landed on the picker. The trigger now shrinks and ellipsises, and the
 *    group wraps as a last resort — overlap is no longer a possible outcome.
 *
 * These are CSS contracts (jsdom does no layout), in the same style as glass-background.test.ts.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "vitest"

const styles = readFileSync(join(__dirname, "../../../../index.css"), "utf8")

function ruleOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{[^}]*\\}`).exec(styles)
  // Comments quote the OLD values to explain the fix; only declarations are the contract.
  return (match?.[0] ?? "").replace(/\/\*[\s\S]*?\*\//g, "")
}

test("the composer is painted as one surface, not a header slab stacked on a card", () => {
  const header = ruleOf("[data-chat-input-header]")
  // The package's tab geometry: narrower than the card, dropped, and tucked underneath it.
  expect(header).toContain("margin: 0")
  expect(header).toContain("top: 0")
  // The row owns no fill and no ring any more — the shared parent paints both halves.
  expect(header).toContain("background-color: transparent")
  expect(header).toContain("box-shadow: none")
  // ...and the surface gives up its own fill/ring for the same reason.
  const surface = ruleOf("[data-composer] .codex-composer-surface")
  expect(surface).toContain("background-color: transparent")
  expect(surface).toContain("box-shadow: none")
  // The single outline lives on the element that contains header AND input.
  const shell = /\[data-composer\] div:has\(> form > \.codex-composer-surface\)[^{]*\{([^}]*)\}/.exec(styles)
  expect(shell?.[1]).toContain("border-radius: 24px")
  expect(shell?.[1]).toContain("var(--chat-input-bg-color")
  // An empty row must not leave a bare strip above the input.
  expect(styles).toMatch(/\[data-chat-input-header\]:not\(:has\(button, span\)\)\s*\{\s*display: none;/)
  // `:has()` cannot be nested inside another `:has()` — the spec forbids it and the whole rule is
  // dropped — so no rule may wrap one in another.
  expect(styles).not.toMatch(/:has\([^)]*:has\(/)
})

test("the model trigger shrinks and ellipsises instead of overflowing the toolbar", () => {
  const trigger = ruleOf('.alwith-model-pill[data-testid="model-trigger"]')
  // The old no-shrink pair is exactly what pushed send onto the picker.
  expect(trigger).not.toContain("flex: 0 0 auto")
  expect(trigger).not.toContain("max-width: none")
  expect(trigger).toContain("flex: 0 1 auto")
  expect(trigger).toContain("min-width: 0")
  // The name line truncates; the full name stays available as a hover title (model-entry.tsx).
  const nameLine = ruleOf(".alwith-model-pill > span:not(.model-picker-icon) > span:first-child")
  expect(nameLine).toContain("text-overflow: ellipsis")
  expect(nameLine).toContain("overflow: hidden")
  expect(nameLine).not.toContain("overflow: visible")
})

test("the toolbar stays one line: the send key is pinned and the picker yields", () => {
  const group = ruleOf(".chat-composer-toolbar > div > div:last-child")
  expect(group).toContain("min-width: 0")
  // Stacking the group onto a second line was the previous fallback and was rejected on sight.
  expect(group).not.toContain("flex-wrap: wrap")
  expect(styles).toMatch(
    /\.chat-composer-toolbar button\[type="submit"\]\s*\{\s*flex: none;\s*\}/
  )
  // Degradation runs on the toolbar's own width, in three steps.
  expect(styles).toMatch(/@container input-footer \(max-width: 30rem\)/)
  expect(styles).toMatch(/@container input-footer \(max-width: 25rem\)/)
  expect(styles).toMatch(/@container input-footer \(max-width: 21rem\)/)
})
