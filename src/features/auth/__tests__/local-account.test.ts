import { beforeEach, expect, test, vi } from "vitest"

// The real store goes through Tauri IPC; the password derivation is what this file is about.
const { values } = vi.hoisted(() => ({ values: new Map<string, unknown>() }))

vi.mock("@/lib/store", () => ({
  openStore: () => ({
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => void values.set(key, value),
    has: async (key: string) => values.has(key),
    delete: async (key: string) => void values.delete(key)
  })
}))

const { clearLocalAccount, createLocalAccount, hasLocalAccount, readLocalCredential, verifyLocalPassword } =
  await import("../local-account")

beforeEach(() => values.clear())

test("a fresh install has no local account", async () => {
  expect(await hasLocalAccount()).toBe(false)
  expect(await verifyLocalPassword("anything")).toBe(false)
})

test("the password set on first run is the one that unlocks later", async () => {
  await createLocalAccount("测试同学", "correct horse")
  expect(await hasLocalAccount()).toBe(true)
  expect(await verifyLocalPassword("correct horse")).toBe(true)
  expect(await verifyLocalPassword("wrong horse")).toBe(false)
  expect(await verifyLocalPassword("")).toBe(false)
})

test("the stored record never contains the password", async () => {
  await createLocalAccount("", "correct horse")
  const credential = await readLocalCredential()
  expect(credential).not.toBeNull()
  expect(JSON.stringify(credential)).not.toContain("correct horse")
  expect(credential?.hash).not.toBe("")
  expect(credential?.salt).not.toBe("")
  // An unnamed account still gets a readable default rather than an empty label.
  expect(credential?.name).toBe("本地用户")
})

test("two accounts with the same password do not share a hash", async () => {
  await createLocalAccount("a", "same password")
  const first = await readLocalCredential()
  await clearLocalAccount()
  await createLocalAccount("b", "same password")
  const second = await readLocalCredential()
  // The salt is random per account, so an identical password must not produce an identical digest.
  expect(first?.salt).not.toBe(second?.salt)
  expect(first?.hash).not.toBe(second?.hash)
})

test("clearing the account returns the app to the first-run state", async () => {
  await createLocalAccount("", "correct horse")
  await clearLocalAccount()
  expect(await hasLocalAccount()).toBe(false)
})
