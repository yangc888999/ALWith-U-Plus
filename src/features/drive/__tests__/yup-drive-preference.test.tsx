import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"

import { settingsFixture } from "@/lib/__tests__/settings-fixture"

import { setYupDriveEnabled, useYupDriveEnabled } from "../yup-drive-preference"

afterEach(cleanup)

test("the YUP Drive switch defaults on and follows changes from another window", async () => {
  const fixture = settingsFixture()
  const { result } = renderHook(() => useYupDriveEnabled())
  expect(result.current).toBe(true)
  await setYupDriveEnabled(false)
  expect(result.current).toBe(false)
  expect(fixture.values.get("drive.yupEnabled")).toBe(false)
  act(() => fixture.changed({ "drive.yupEnabled": true }))
  expect(result.current).toBe(true)
})
