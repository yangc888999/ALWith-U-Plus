import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"

import { settingsFixture } from "@/lib/__tests__/settings-fixture"

import { useFixedFour } from "../fixed-four-preference"

afterEach(cleanup)

test("the fixed four-column layout is on by default and follows settings changes", async () => {
  const fixture = settingsFixture()
  const { result } = renderHook(() => useFixedFour())
  expect(result.current).toBe(true)
  act(() => fixture.changed({ "appearance.fixedFour": false }))
  expect(result.current).toBe(false)
  expect(fixture.values.get("appearance.fixedFour")).toBe(false)
})
