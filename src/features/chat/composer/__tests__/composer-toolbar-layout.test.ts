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

test("the input-header strip paints its own surface in both themes", () => {
  const light = ruleOf("[data-chat-input-header]")
  expect(light).toContain("background-color: var(--muted)")
  const dark = ruleOf(".dark [data-chat-input-header]")
  expect(dark).toContain("background-color: color-mix(in oklab, var(--foreground) 3%, transparent)")
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

test("the toolbar's right group can shrink and wraps rather than overlap", () => {
  const group = ruleOf(".chat-composer-toolbar > div > div:last-child")
  expect(group).toContain("min-width: 0")
  expect(group).toContain("flex-wrap: wrap")
})
