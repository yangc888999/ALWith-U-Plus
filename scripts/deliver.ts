/**
 * Copy the freshly built macOS bundle into the delivery folder, with a `yyMMddHHmm` build stamp in
 * the dmg name. That keeps every build distinguishable without bumping the app version each time.
 *
 *   bun run deliver
 *
 * The stamp is the .app's mtime — the moment the bundler finished — so it reflects the build, not
 * the copy. Delivery folder defaults to ~/Documents/ALwith; override with ALWITH_DELIVERY_DIR.
 *
 * The bundle's version must match package.json: a stale dmg or .app from an older release is a hard
 * failure rather than a silently mislabeled delivery. The installed /Applications copy is only
 * replaced after a staged copy verifies, and the previous app stays usable if anything fails.
 */
import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readdir, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

const root = join(import.meta.dir, "..")
const bundle = join(root, "src-tauri", "target", "release", "bundle")
const dest = process.env.ALWITH_DELIVERY_DIR ?? "/Users/flyme/Documents/ALwith"
const product = "ALWith L"

const dmgPattern = /^(.*?)_([^_]+)_([^_]+)\.dmg$/

function two(value: number): string {
  return String(value).padStart(2, "0")
}

/** yymmddhhmm, matching the older hand-stamped dmg names (e.g. 2611032220). */
export function buildStamp(date: Date): string {
  return `${two(date.getFullYear() % 100)}${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}`
}

export type DmgEntry = { name: string; mtimeMs: number }

/**
 * Pick the dmg whose embedded version equals the package version. Dmgs from other releases — and
 * already-stamped copies whose second field is a timestamp — are ignored; when several match, the
 * newest build wins. Never fall back to "the first .dmg", which wraps an old version with a new stamp.
 */
export function selectDmg(entries: DmgEntry[], version: string): string {
  const matches = entries
    .filter((entry) => entry.name.endsWith(".dmg"))
    .map((entry) => ({ entry, match: dmgPattern.exec(entry.name) }))
    .filter(({ match }) => match !== null && match[2] === version)
    .sort((a, b) => b.entry.mtimeMs - a.entry.mtimeMs)
  if (matches.length === 0) {
    throw new Error(`No .dmg matching version ${version} found in the bundle directory`)
  }
  return matches[0].entry.name
}

/** Fail delivery unless the dmg name and the built app's version both report the package version. */
export function verifyVersionStrings(version: string, dmgName: string, appVersion: string): void {
  const dmgVersion = dmgPattern.exec(dmgName)?.[2]
  if (dmgVersion !== version) {
    throw new Error(`Dmg version does not match package version ${version}: ${dmgName}`)
  }
  if (appVersion !== version) {
    throw new Error(`App version does not match package version ${version}: ${appVersion}`)
  }
}

/** Read CFBundleShortVersionString from a built .app (plutil handles both XML and binary plists). */
export function readAppVersion(appPath: string): string {
  const plist = join(appPath, "Contents", "Info.plist")
  const result = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist], {
    encoding: "utf8",
    timeout: 15_000
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Cannot read CFBundleShortVersionString from ${plist}: ${result.stderr}`)
  const version = result.stdout.trim()
  if (!version) throw new Error(`Empty CFBundleShortVersionString in ${plist}`)
  return version
}

/**
 * Refresh an installed .app only after a staged copy verifies. The old bundle is renamed aside —
 * never deleted first — and restored if the final swap fails, so a failure leaves it usable.
 */
export async function replaceInstalledApp(
  sourceApp: string,
  installed: string,
  verifyStaged: (staged: string) => Promise<void> | void
): Promise<void> {
  const parent = dirname(installed)
  const temp = await mkdtemp(join(parent, `.${basename(installed)}-`))
  let cleanup = true
  try {
    const staged = join(temp, "staged")
    const backup = join(temp, "previous")
    await cp(sourceApp, staged, { recursive: true })
    await verifyStaged(staged)
    await rename(installed, backup)
    try {
      await rename(staged, installed)
    } catch (error) {
      try {
        await rename(backup, installed)
      } catch {
        // Keep the backup for manual recovery instead of deleting the previous app with the temp dir.
        cleanup = false
        throw new Error(`Could not restore the previous installed app; it is preserved at ${backup}`)
      }
      throw error
    }
    await rm(backup, { recursive: true, force: true })
  } finally {
    if (cleanup) await rm(temp, { recursive: true, force: true })
  }
}

export type DeliverOptions = {
  version: string
  appPath: string
  dmgDir: string
  dest: string
  installed?: string
  product: string
  readAppVersion: (appPath: string) => string
  log?: (message: string) => void
}

export async function deliver(options: DeliverOptions): Promise<void> {
  const { version, appPath, dmgDir, dest: deliveryDir, installed, product: name, readAppVersion: readVersion } = options
  const log = options.log ?? console.log

  const appStat = await stat(appPath).catch(() => null)
  if (appStat === null) {
    throw new Error(`No build found at ${appPath} — run \`bun tauri build\` first.`)
  }
  const stamp = buildStamp(new Date(appStat.mtimeMs))

  // Validate the artifact set before writing anything: a mismatched app or dmg must abort delivery.
  const appVersion = readVersion(appPath)
  const entries: DmgEntry[] = []
  for (const dmgName of await readdir(dmgDir).catch(() => [] as string[])) {
    if (!dmgName.endsWith(".dmg")) continue
    const info = await stat(join(dmgDir, dmgName))
    entries.push({ name: dmgName, mtimeMs: info.mtimeMs })
  }
  const dmgName = selectDmg(entries, version)
  verifyVersionStrings(version, dmgName, appVersion)

  await mkdir(deliveryDir, { recursive: true })

  // Replace the delivery copy rather than merging into the previous one. A failure here throws.
  const appTarget = join(deliveryDir, `${name}.app`)
  await rm(appTarget, { recursive: true, force: true })
  await cp(appPath, appTarget, { recursive: true })
  log(`app  -> ${appTarget}`)

  // The copy people actually launch lives in /Applications; refresh it too, or a rebuild never
  // reaches them and the old UI keeps showing. Missing → nothing to update.
  if (installed !== undefined) {
    const hasInstalled = await stat(installed)
      .then(() => true)
      .catch(() => false)
    if (hasInstalled) {
      await replaceInstalledApp(appPath, installed, (staged) =>
        verifyVersionStrings(version, dmgName, readVersion(staged))
      )
      log(`app  -> ${installed} (installed copy)`)
    }
  }

  const match = dmgPattern.exec(dmgName)!
  const stamped = `${match[1]}_${match[2]}_${stamp}_${match[3]}.dmg`
  await cp(join(dmgDir, dmgName), join(deliveryDir, stamped))
  log(`dmg  -> ${join(deliveryDir, stamped)}`)
  log(`build stamp: ${stamp} (version ${version})`)
}

if (import.meta.main) {
  const pkg = (await Bun.file(join(root, "package.json")).json()) as { version: string }
  await deliver({
    version: pkg.version,
    appPath: join(bundle, "macos", `${product}.app`),
    dmgDir: join(bundle, "dmg"),
    dest,
    installed: `/Applications/${product}.app`,
    product,
    readAppVersion
  }).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
