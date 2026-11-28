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
  expect(styles).toMatch(/--chat-rail-gutter:\s*6rem/)
  expect(styles).toMatch(/--chat-content-width:\s*min\(var\(--chat-column-width\),\s*calc\(100% - var\(--chat-rail-gutter\)\)\)/)
  expect(styles).toMatch(
    /@media \(min-width: 1600px\)\s*\{[\s\S]*?\.welcome-hero-composer,[\s\S]*?\.welcome-hero-recent\s*\{[^}]*max-width:\s*56rem/
  )
})

test("draft and conversation columns use the shared, scalable column width", () => {
  for (const source of [draft, chat]) {
    expect(source).toContain("max-w-[var(--chat-column-width)]")
    expect(source).not.toContain("max-w-[1120px]")
  }
})
