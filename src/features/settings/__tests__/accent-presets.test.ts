import { describe, expect, test } from "vitest"

import { ACCENT_PRESETS, normalizeAccentId } from "../accent-store"

describe("accent presets", () => {
  test("the picker uses the seven ordered work presets", () => {
    expect(ACCENT_PRESETS.map((preset) => preset.id)).toEqual([
      "elegant-black",
      "snow-white",
      "yup-red",
      "girly-pink",
      "lemon-green",
      "sky-blue",
      "emerald"
    ])
  })

  test("removed presets migrate to the default brand colour", () => {
    expect(normalizeAccentId("linen-gray")).toBe("yup-red")
    expect(normalizeAccentId("warm-brown")).toBe("yup-red")
    expect(normalizeAccentId("invalid")).toBe("yup-red")
    expect(normalizeAccentId("emerald")).toBe("emerald")
  })
})
