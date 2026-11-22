/**
 * Markdown image previews used to open as a second full-screen surface. The dialog is now a
 * centred floating card capped at roughly half the window, with its actions owned by the card
 * instead of the viewport. jsdom has no layout engine, so this pins the CSS contract directly.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "vitest"

const styles = readFileSync(join(__dirname, "../styles.css"), "utf8")

function ruleOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{[^}]*\\}`).exec(styles)
  return (match?.[0] ?? "").replace(/\/\*[\s\S]*?\*\//g, "")
}

test("markdown image previews float within half the window instead of taking it over", () => {
  const dialog = ruleOf(".codex-markdown-image-dialog")
  expect(dialog).toContain("position: fixed")
  expect(dialog).toContain("width: min(50vw, 56rem)")
  expect(dialog).toContain("height: min(50vh, 40rem)")
  expect(dialog).toContain("margin: auto")
  expect(dialog).toContain("border-radius: 12px")
  expect(dialog).not.toMatch(/width:\s*100vw/)
  expect(dialog).not.toMatch(/height:\s*100vh/)

  const backdrop = ruleOf(".codex-markdown-image-dialog::backdrop")
  expect(backdrop).toContain("background: rgb(0 0 0 / 42%)")
  expect(backdrop).toContain("blur(4px)")

  const actions = ruleOf(".codex-markdown-image-preview-actions")
  expect(actions).toContain("position: absolute")
  expect(actions).not.toContain("position: fixed")
})
