import { expect, test, vi } from "vitest"

/**
 * The preference reads and writes the real settings store, which talks to Rust. This stands in for
 * it: `values` is the stored snapshot and `writes` records what each call asked to persist.
 */
const store = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  writes: [] as Record<string, unknown>[]
}))

vi.mock("@/lib/settings-store", () => ({
  settingsStore: {
    get: (key: string) => store.values[key],
    subscribe: () => () => {}
  },
  updateSettings: async (changes: Record<string, unknown>) => {
    store.writes.push(changes)
    Object.assign(store.values, changes)
  }
}))

const { fourColumnsDefault, setFourColumnsDefault } = await import("../four-columns-preference")

test("a project chat opens four columns wide unless the preference says otherwise", () => {
  // Nothing stored yet: the preview column is part of the workspace, so it is there on open.
  store.values = {}
  expect(fourColumnsDefault()).toBe(true)

  store.values = { "appearance.fourColumnsDefault": false }
  expect(fourColumnsDefault()).toBe(false)
})

test("turning it off stores one key and nothing else", async () => {
  store.values = {}
  store.writes = []

  await setFourColumnsDefault(false)

  expect(store.writes).toEqual([{ "appearance.fourColumnsDefault": false }])
  expect(fourColumnsDefault()).toBe(false)
})

test("a choice that matches the stored value is not written again", async () => {
  store.values = {}
  store.writes = []

  // On is already the default; flipping it on must not cost a settings round trip.
  await setFourColumnsDefault(true)

  expect(store.writes).toEqual([])
})
