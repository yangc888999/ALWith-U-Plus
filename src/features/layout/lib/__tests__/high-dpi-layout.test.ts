/**
 * High-density displays report a much wider CSS viewport than a laptop. The root font-size used
 * to stay at 16px, so every rem-based control stayed physically small and the draft/conversation
 * column stopped at a hard-coded 1120px. These contracts keep the scale and the column coupled.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "vitest"

const root = join(__dirname, "../../../..")
const styles = readFileSync(join(root, "index.css"), "utf8")
const draft = readFileSync(join(root, "features/chat/draft-chat.tsx"), "utf8")
const chat = readFileSync(join(root, "features/chat/chat-view.tsx"), "utf8")

test("the root scales with wide high-density viewports", () => {
  expect(styles).toMatch(/html\s*\{\s*font-size:\s*clamp\(16px,\s*calc\(0\.5vw \+ 7px\),\s*22px\);\s*\}/)
  expect(styles).toMatch(/--chat-column-width:\s*70rem/)
  expect(styles).toMatch(/--chat-rail-gutter:\s*2rem/)
  expect(styles).toMatch(/--chat-content-width:\s*min\(var\(--chat-column-width\),\s*calc\(100% - var\(--chat-rail-gutter\)\)\)/)
  expect(styles).toMatch(
    /@media \(min-width: 1600px\)\s*\{[\s\S]*?\.welcome-hero-composer,[\s\S]*?\.welcome-hero-recent\s*\{[^}]*max-width:\s*56rem/
  )
})

test("the floating conversation actions stay out of the reading column", () => {
  expect(styles).toMatch(/\[data-chat-edge-actions\]\s*\{\s*transition:/)
  expect(styles).toMatch(
    /@media \(hover: hover\) and \(pointer: fine\)[\s\S]*?\[data-conversation-detail\]:not\(:hover\):not\(:focus-within\) \[data-chat-edge-actions\][\s\S]*?pointer-events: none;/
  )
})

test("the round badge yields to quiet-state controls and narrow progress rows", () => {
  expect(styles).toMatch(
    /\[data-turn-progress\]:has\(\[data-turn-quiet\], \[data-turn-help\], \[data-turn-nudge\]\) \[data-turn-round\]\s*\{\s*display: none;/
  )
  expect(styles).toMatch(/@container \(max-width: 24rem\)[\s\S]*?\[data-turn-round\]\s*\{\s*display: none;/)
})

test("draft and conversation columns use the shared, scalable column width", () => {
  for (const source of [draft, chat]) {
    expect(source).toContain("max-w-[var(--chat-column-width)]")
    expect(source).not.toContain("max-w-[1120px]")
  }
})
