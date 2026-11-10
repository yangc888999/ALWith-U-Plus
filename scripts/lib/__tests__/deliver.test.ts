import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildStamp, deliver, replaceInstalledApp, selectDmg, verifyVersionStrings, type DmgEntry } from "../../deliver"

const directories: string[] = []

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "alwith-u-deliver-test-"))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

test("buildStamp formats the .app mtime as yymmddhhmm", () => {
  expect(buildStamp(new Date(2026, 10, 3, 22, 20))).toBe("2611032220")
})

test("selects the dmg whose version matches the package version", () => {
  const entries: DmgEntry[] = [
    { name: "ALWith L_0.3.3_aarch64.dmg", mtimeMs: 100 },
    { name: "ALWith L_0.3.4_aarch64.dmg", mtimeMs: 200 }
  ]
  expect(selectDmg(entries, "0.3.4")).toBe("ALWith L_0.3.4_aarch64.dmg")
})

test("ignores already-stamped dmgs and picks the newest matching build", () => {
  const entries: DmgEntry[] = [
    { name: "ALWith L_0.3.3_2611032220_aarch64.dmg", mtimeMs: 900 },
    { name: "ALWith L_0.3.4_aarch64.dmg", mtimeMs: 100 },
    { name: "ALWith L_0.3.4_x64.dmg", mtimeMs: 300 }
  ]
  expect(selectDmg(entries, "0.3.4")).toBe("ALWith L_0.3.4_x64.dmg")
})

test("fails when no dmg matches the package version", () => {
  expect(() => selectDmg([{ name: "ALWith L_0.3.3_aarch64.dmg", mtimeMs: 100 }], "0.3.4")).toThrow(
    "No .dmg matching version 0.3.4"
  )
})

test("rejects dmg and app version strings that disagree with the package", () => {
  expect(() => verifyVersionStrings("0.3.4", "ALWith L_0.3.3_aarch64.dmg", "0.3.4")).toThrow("Dmg version")
  expect(() => verifyVersionStrings("0.3.4", "ALWith L_0.3.4_aarch64.dmg", "0.3.3")).toThrow("App version")
  expect(() => verifyVersionStrings("0.3.4", "ALWith L_0.3.4_aarch64.dmg", "0.3.4")).not.toThrow()
})

test("deliver refuses a stale dmg before writing any destination", async () => {
  const directory = fixture()
  const appPath = join(directory, "bundle", "macos", "ALWith L.app")
  mkdirSync(join(appPath, "Contents", "MacOS"), { recursive: true })
  writeFileSync(join(appPath, "Contents", "Info.plist"), "<plist/>")
  const dmgDir = join(directory, "bundle", "dmg")
  mkdirSync(dmgDir, { recursive: true })
  writeFileSync(join(dmgDir, "ALWith L_0.3.3_aarch64.dmg"), "old build")
  const dest = join(directory, "delivery")

  await expect(
    deliver({
      version: "0.3.4",
      appPath,
      dmgDir,
      dest,
      product: "ALWith L",
      readAppVersion: () => "0.3.4",
      log: () => {}
    })
  ).rejects.toThrow("No .dmg matching version 0.3.4")
  expect(() => readdirSync(dest)).toThrow()
})

test("keeps the installed app intact when the staged copy fails verification", async () => {
  const directory = fixture()
  const source = join(directory, "source.app")
  const installed = join(directory, "ALWith L.app")
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, "new"), "new-version")
  mkdirSync(installed, { recursive: true })
  writeFileSync(join(installed, "marker"), "old-version")

  await expect(
    replaceInstalledApp(source, installed, () => {
      throw new Error("staged copy is invalid")
    })
  ).rejects.toThrow("staged copy is invalid")

  expect(readFileSync(join(installed, "marker"), "utf8")).toBe("old-version")
  expect(readdirSync(directory).filter((name) => name.startsWith(".ALWith L.app-"))).toEqual([])
})

test("swaps in the new app only after the staged copy verifies", async () => {
  const directory = fixture()
  const source = join(directory, "source.app")
  const installed = join(directory, "ALWith L.app")
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, "new"), "new-version")
  mkdirSync(installed, { recursive: true })
  writeFileSync(join(installed, "old"), "old-version")

  await replaceInstalledApp(source, installed, (staged) => {
    expect(readFileSync(join(staged, "new"), "utf8")).toBe("new-version")
  })

  expect(readFileSync(join(installed, "new"), "utf8")).toBe("new-version")
  expect(() => readFileSync(join(installed, "old"), "utf8")).toThrow()
  expect(readdirSync(directory).filter((name) => name.startsWith(".ALWith L.app-"))).toEqual([])
})
