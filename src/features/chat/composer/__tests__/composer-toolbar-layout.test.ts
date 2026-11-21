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

test("composer is ONE painted surface; the chip row is divided by a line, not a gap", () => {
  // Five shapes were tried. What finally ruled out the "narrower strip with a gap" variant is
  // measurable: both boxes were the SAME colour (233,240,251) and the 6px gap between them showed
  // the blue page — the block read as blue/white/blue/white. A gap is not a divider, it exposes
  // the backdrop. So the fill lives on the parent that contains BOTH halves.
  const shell = /\[data-composer\] div:has\(> form > \.codex-composer-surface\)\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ""
  expect(shell).toContain("var(--chat-input-bg-color")
  expect(shell).toContain("border-radius: 24px")
  // Both children are transparent: no second fill can disagree with the first by construction.
  const surface = /\[data-composer\] \.codex-composer-surface\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ""
  const header = /\[data-composer\] \[data-chat-input-header\]\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ""
  expect(surface).toContain("background-color: transparent")
  expect(surface).toContain("box-shadow: none")
  expect(header).toContain("background-color: transparent")
  // A hairline is the divider: an intentional element, not a shade that reads as a rendering fault.
  expect(header).toMatch(/box-shadow: inset 0 -1px 0 0 color-mix/)
  // No gap and no side inset — either would carve the block into stripes of page colour.
  expect(header).toMatch(/margin: 0/)
  expect(header).not.toMatch(/margin: 0 12px/)
  expect(header).not.toMatch(/-18px/)
  // An empty row must not leave a bare strip (and its divider) above the input.
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

test("the accent reaches the main window through controls, not a global wash", () => {
  // "选了主题色，主界面几乎看不到" was not a weak accent — the main window had no consumer at
  // all: the send key is `bg-foreground` (achromatic) and the composer gave no focus feedback.
  const send = /\[data-composer\] \.chat-composer-toolbar button\[type="submit"\]\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ""
  expect(send).toContain("background-color: var(--settings-accent)")
  expect(send).toContain("color: var(--accent-on)")
  expect(styles).toMatch(/\[data-composer\] \.codex-composer-surface:focus-within\s*\{[^}]*var\(--settings-accent\)/)
  // The whole-window wash must stay a whisper: raising it again is what dyed the neutral
  // surfaces and fought the white documents.
  expect(styles).toMatch(/--accent-wash: 1\.2%/)
  // Every accent preset needs a readable foreground on its own fill.
  expect(styles).toMatch(/:root\[data-accent="lemon-green"\][^{]*\{[^}]*--accent-on:/)
  expect(styles).toMatch(/\.dark\s*\{\s*--accent-on:/)
})
