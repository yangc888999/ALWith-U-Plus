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

test("the controls row is a transparent holder, never a box around boxes", () => {
  const header = ruleOf("[data-chat-input-header]")
  // The package's tab geometry: dropped, and pulled back UP under the card by a negative margin.
  expect(header).toContain("top: 0")
  expect(header).not.toMatch(/margin:[^;]*-18px/)
  expect(header).not.toMatch(/margin:[^;]*13px/)
  // A grey slab with its own ring read as a lid on the card; the chips already carry pill borders,
  // so the container must add no chrome of its own.
  expect(header).toContain("background-color: transparent")
  expect(header).toContain("box-shadow: none")
  expect(header).not.toContain("color-mix")
  // Separation comes from spacing + a horizontal inset that lines the chips up with the input text.
  expect(header).toMatch(/padding:\s*2px\s+10px\s+8px/)
  // The card below keeps all four corners and its own fill: it is a box, not a half-box.
  const surface = ruleOf("[data-composer] .codex-composer-surface")
  expect(surface).toContain("border-radius: 24px")
  expect(surface).toContain("var(--chat-input-bg-color")
  expect(surface).not.toContain("border-radius: 0 0 24px 24px")
  // No rule may lift the fill to the shared parent — that made one continuous surface.
  expect(styles).not.toMatch(/\[data-composer\] div:has\(/)
  // An empty row must not leave a bare strip above the input.
  expect(styles).toMatch(/\[data-chat-input-header\]:not\(:has\(button, span\)\)\s*\{\s*display: none;/)
})

test("the effort ladder is never dropped by a width breakpoint", () => {
  // It sat on the name's line once, so it was the first thing dropped in narrow windows. Stacked
  // under the name it costs no horizontal space — hiding it only deletes information.
  expect(styles).not.toMatch(/\.alwith-model-pill[^{]*> span:nth-child\(2\)\s*\{\s*display: none/)
  const label = ruleOf(".alwith-model-pill > span:not(.model-picker-icon)")
  expect(label).toContain("flex-direction: column")
  expect(label).toContain("align-items: flex-start")
  expect(label).not.toContain("flex-direction: row")
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
  // Degradation runs on the toolbar's own width, never the window's. Only two steps remain: the
  // ladder no longer competes with the name for horizontal space, so there is nothing to drop at
  // 25rem — the name just gets its hard cap at the narrowest width.
  expect(styles).toMatch(/@container input-footer \(max-width: 30rem\)/)
  expect(styles).not.toMatch(/@container input-footer \(max-width: 25rem\)/)
  expect(styles).toMatch(/@container input-footer \(max-width: 21rem\)/)
})
