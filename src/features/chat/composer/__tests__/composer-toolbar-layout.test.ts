/**
 * Two composer layout contracts, both reported from a narrow window (2026-11-20):
 *
 * 1. The header, textarea and toolbar must share one integrated dock. The package owns the nested
 *    drop zone, so the dock geometry belongs to explicit host attributes rather than broad wrapper
 *    selectors.
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

test("composer keeps the WorkBuddy-style attachment affordance", () => {
  expect(styles).not.toMatch(/\[data-composer-mode="chat"\][^{]*\.chat-composer-toolbar[^}]*\{\s*display: none;/)
})

test("composer is a distinct card inside the chat column", () => {
  const dock = /\[data-composer\]\[data-composer-dock\]\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ""
  expect(dock).toContain("width: 100%")
  expect(dock).toContain("background: transparent")
  expect(dock).not.toContain("border-block-start: 1px solid")

  // The card is the one raised control at the bottom: a real border, radius and fill separate it
  // from the transcript instead of letting the input disappear into the page background.
  const shell = /\[data-composer\] > \[data-chat-drop-zone\] > \.relative:has\(> form > \.codex-composer-surface\)\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ""
  expect(shell).toContain("border: 1px solid")
  expect(shell).toContain("border-radius: 1.25rem")
  expect(shell).toContain("background: color-mix")
  expect(shell).toContain("box-shadow:")
  expect(shell).not.toContain("background: transparent")
  expect(shell).toContain("background-image: none")
  expect(styles).toMatch(/\[data-chat-drop-zone\] > \[data-composer\]:has\(form > \.codex-composer-surface\)/)
  // Both children are transparent: no second fill can disagree with the first by construction.
  const surface = /\[data-composer\] \.codex-composer-surface\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ""
  const header = /\[data-composer\] > \[data-chat-drop-zone\] \.relative > \[data-chat-input-header\]\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ""
  expect(styles).not.toMatch(/\[data-composer\] \[data-chat-input-header\]/)
  expect(surface).toContain("background: transparent")
  expect(surface).toContain("box-shadow: none")
  expect(header).toContain("background-color: transparent")
  // The header is context, not another painted surface.
  expect(header).toContain("box-shadow: none")
  // No gap and no side inset — either would carve the block into stripes of page colour.
  expect(header).toMatch(/margin: 0/)
  expect(header).not.toMatch(/margin: 0 12px/)
  expect(header).not.toMatch(/-18px/)
  // Once the preview and tree columns are closed, the input must use the same measure as the
  // transcript instead of stopping at its old 56rem cap.
  const dropZone = /\[data-composer\] > \[data-chat-drop-zone\]\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ""
  expect(dropZone).toContain("max-width: var(--chat-column-width)")
  expect(dropZone).not.toContain("max-width: 56rem")
  // An empty row must not leave a bare strip (and its divider) above the input.
  expect(styles).toMatch(/\[data-chat-input-header\]:not\(:has\(button, span\)\)\s*\{\s*display: none;/)
})

test("a populated composer status row has its own tint and hairline", () => {
  const status = /\[data-composer\] > \[data-chat-drop-zone\] > \.relative > \[data-chat-input-header\]:has\(button, span\)\s*\{([^}]*)\}/.exec(
    styles
  )?.[1] ?? ""
  expect(status).toContain("background-image: linear-gradient")
  expect(status).toContain("var(--foreground) 6%")
  expect(status).toContain("box-shadow: inset 0 -1px 0")
  expect(status).toContain("border-radius: calc(1.25rem - 1px)")
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
  const sendKey = ruleOf('.chat-composer-toolbar button[type="submit"]')
  expect(sendKey).toContain("flex: none")
  // Degradation runs on the toolbar's own width, never the window's. Only two steps remain: the
  // ladder no longer competes with the name for horizontal space, so there is nothing to drop at
  // 25rem — the name just gets its hard cap at the narrowest width.
  expect(styles).toMatch(/@container input-footer \(max-width: 30rem\)/)
  expect(styles).not.toMatch(/@container input-footer \(max-width: 25rem\)/)
  expect(styles).toMatch(/@container input-footer \(max-width: 21rem\)/)
})

test("the accent reaches the main window through the send key, not a global wash", () => {
  // "选了主题色，主界面几乎看不到" was not a weak accent — the main window had no consumer at
  // all: the send key used to be `bg-foreground` (achromatic). The send key is the one consumer
  // now: a focus ring on `.codex-composer-surface` drew a box inside the card (the fill lives on
  // the parent and that surface has square top corners), so it must not come back.
  const send = /\[data-composer\] \.chat-composer-toolbar button\[type="submit"\]\s*\{([^}]*)\}/.exec(styles)?.[1] ?? ""
  expect(send).toContain("background-color: var(--settings-accent)")
  expect(send).toContain("color: var(--accent-on)")
  expect(styles).not.toMatch(/\[data-composer\] \.codex-composer-surface:focus-within/)
  // The whole-window wash must stay a whisper: raising it again is what dyed the neutral
  // surfaces and fought the white documents.
  expect(styles).toMatch(/--accent-wash: 1\.2%/)
  // Every accent preset needs a readable foreground on its own fill.
  expect(styles).toMatch(/:root\[data-accent="lemon-green"\][^{]*\{[^}]*--accent-on:/)
  expect(styles).toMatch(/\.dark\s*\{\s*--accent-on:/)
})

test("the stop key uses a soft accent disc on the light theme", () => {
  const stop = ruleOf("[data-composer] .chat-composer-toolbar button.border-border")
  // A solid accent disc becomes a heavy grey blob in light mode with a neutral accent.
  expect(stop).toContain("background-color: color-mix")
  expect(stop).toContain("var(--card)")
  expect(stop).not.toContain("background-color: var(--settings-accent)")
  // Dark mode keeps the filled accent for a clear stop affordance.
  expect(styles).toMatch(
    /\.dark \[data-composer\] \.chat-composer-toolbar button\.border-border\s*\{[^}]*background-color: var\(--settings-accent\);/
  )
})

test("the resting send key matches WorkBuddy while active action glyphs invert", () => {
  const disabledSend = ruleOf('[data-composer] .chat-composer-toolbar button[type="submit"]:disabled')
  expect(disabledSend).toContain("background-color: color-mix(in oklab, var(--foreground) 10%, var(--muted))")
  expect(disabledSend).toContain("color: color-mix(in oklab, var(--foreground) 18%, #000)")
  expect(disabledSend).not.toContain("color-mix(in oklab, var(--accent-on)")

  const sendKey = ruleOf('.chat-composer-toolbar button[type="submit"]')
  expect(sendKey).toContain("width: 34px")
  expect(sendKey).toContain("height: 34px")
  const stopKey = ruleOf("[data-composer] .chat-composer-toolbar button.border-border")
  expect(stopKey).toContain("width: 34px")
  expect(stopKey).toContain("height: 34px")

  const darkStop = ruleOf(".dark [data-composer] .chat-composer-toolbar button.border-border")
  expect(darkStop).toContain("background-color: var(--settings-accent)")
  expect(darkStop).toContain("color: var(--accent-on)")

  // The default red/black discs are dark enough for a white glyph; only light discs switch to ink.
  expect(styles).toMatch(/:root\s*\{\s*--accent-on: oklch\(0\.99/)
  expect(styles).toMatch(/\.dark\s*\{\s*--accent-on: oklch\(0\.99/)
  expect(styles).toMatch(/\.dark\[data-accent="snow-white"\][^{]*\{[^}]*--accent-on: oklch\(0\.17/)
  expect(styles).toMatch(/\.dark\[data-accent="lemon-green"\][^{]*\{[^}]*--accent-on: oklch\(0\.17/)
})

test("the welcome composer keeps one fixed footprint across tabs", () => {
  expect(styles).toMatch(/min-height: var\(--composer-input-min, 3\.3rem\)/)
  expect(styles).toMatch(
    /\.welcome-hero-composer \[data-composer\] > \[data-chat-drop-zone\] > \.relative:has\(> form > \.codex-composer-surface\)\s*\{[^}]*min-height: 10\.5rem/
  )
  expect(styles).not.toMatch(/data-welcome-mode="chat"\] \.welcome-hero-composer \[data-composer\] \.alwith-composer-textarea/)
})
