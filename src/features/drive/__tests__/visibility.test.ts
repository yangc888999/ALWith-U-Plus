import { expect, test } from "vitest"

import { isDriveVisible } from "../visibility"

test.each([
  [false, "user@finture.id", false],
  [true, "user@finture.id", true],
  [true, "USER@FINTURE.ID", true],
  [true, "user@finture.id.example.com", false],
  [true, "user@sub.finture.id", false],
  [true, null, false]
])("Drive visibility follows the authenticated email", (authenticated, email, expected) => {
  expect(isDriveVisible(authenticated, email)).toBe(expected)
})

test("a synced drive counts as access without a company-domain login email", () => {
  expect(isDriveVisible(true, null, true)).toBe(true)
  expect(isDriveVisible(true, "user@example.com", true)).toBe(true)
})

test("a synced drive does not grant access while signed out", () => {
  expect(isDriveVisible(false, "user@finture.id", true)).toBe(false)
  expect(isDriveVisible(false, null, true)).toBe(false)
})
