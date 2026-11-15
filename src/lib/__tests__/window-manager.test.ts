import { afterEach, expect, test } from "vitest"

import { openSettingsWindow, toggleSettingsWindow } from "../window-manager"
import { closeSettingsOverlay, getSettingsOverlayState } from "../settings-overlay"

afterEach(() => {
  closeSettingsOverlay()
})

test("openSettingsWindow opens the in-main-window overlay on the requested section", () => {
  void openSettingsWindow("general")
  expect(getSettingsOverlayState()).toMatchObject({ open: true, section: "general" })
})

test("a provider target is carried into the overlay state", () => {
  void openSettingsWindow("provider", { providerId: "openrouter" })
  expect(getSettingsOverlayState()).toMatchObject({ open: true, section: "provider", providerId: "openrouter" })
})

test("toggleSettingsWindow opens when closed and closes when already open", () => {
  closeSettingsOverlay()
  void toggleSettingsWindow("account")
  expect(getSettingsOverlayState().open).toBe(true)
  expect(getSettingsOverlayState().section).toBe("account")
  void toggleSettingsWindow("account")
  expect(getSettingsOverlayState().open).toBe(false)
})

test("reopening re-targets the section without closing the overlay", () => {
  void openSettingsWindow("general")
  void openSettingsWindow("appearance")
  expect(getSettingsOverlayState()).toMatchObject({ open: true, section: "appearance" })
})
