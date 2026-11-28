import { readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, test } from "vitest"

const styles = readFileSync(join(process.cwd(), "src", "index.css"), "utf8")

test("user messages keep text before attachments and actions after both", () => {
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(styles)
    if (match === null) throw new Error(`missing ${selector}`)
    return match[1] ?? ""
  }
  expect(rule(".codex-user-message-group > .codex-user-bubble")).toContain("order: 1")
  expect(rule(".codex-user-message-group > .codex-user-images")).toContain("order: 2")
  expect(rule(".codex-user-message-group > .codex-user-actions")).toContain("order: 3")
})
