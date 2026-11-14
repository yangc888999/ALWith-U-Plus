import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

import { settingsFixture } from "@/lib/__tests__/settings-fixture"

import { setYupDriveEnabled, useYupDriveEnabled } from "../yup-drive-preference"

// `setYupDriveEnabled(false)` now also stops the drive client; keep the unit test off the native IPC.
vi.mock("../controller", () => ({ drive: { request: vi.fn().mockResolvedValue(undefined) } }))

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
