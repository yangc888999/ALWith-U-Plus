/**
 * Copy the freshly built macOS bundle into the delivery folder, with a `yyMMddHHmm` build stamp in
 * the dmg name. That keeps every build distinguishable without bumping the app version each time.
 *
 *   bun run deliver
 *
 * The stamp is the .app's mtime — the moment the bundler finished — so it reflects the build, not
 * the copy. Delivery folder defaults to ~/Documents/ALwith; override with ALWITH_DELIVERY_DIR.
 */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const bundle = join(root, "src-tauri", "target", "release", "bundle")
const dest = process.env.ALWITH_DELIVERY_DIR ?? "/Users/flyme/Documents/ALwith"
const product = "ALWith L"
const appPath = join(bundle, "macos", `${product}.app`)

const pkg = (await Bun.file(join(root, "package.json")).json()) as { version: string }

function two(value: number): string {
  return String(value).padStart(2, "0")
}

/** yymmddhhmm, matching the older hand-stamped dmg names (e.g. 2611032220). */
function buildStamp(date: Date): string {
  return `${two(date.getFullYear() % 100)}${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}`
}

const appStat = await stat(appPath).catch(() => null)
if (appStat === null) {
  console.error(`No build found at ${appPath} — run \`bun tauri build\` first.`)
  process.exit(1)
}
const stamp = buildStamp(new Date(appStat.mtimeMs))

await mkdir(dest, { recursive: true })

// Replace the app bundle rather than merging into the previous copy.
const appTarget = join(dest, `${product}.app`)
await rm(appTarget, { recursive: true, force: true })
await cp(appPath, appTarget, { recursive: true })
console.log(`app  -> ${appTarget}`)

// The copy people actually launch is the one in /Applications; refresh it too, or a rebuild
// never reaches them and the old UI keeps showing. Missing → nothing to update.
const installed = `/Applications/${product}.app`
const hasInstalled = await stat(installed)
  .then(() => true)
  .catch(() => false)
if (hasInstalled) {
  try {
    await rm(installed, { recursive: true, force: true })
    await cp(appPath, installed, { recursive: true })
    console.log(`app  -> ${installed} (installed copy)`)
  } catch (error) {
    console.warn(`Could not refresh ${installed}: ${error instanceof Error ? error.message : String(error)}`)
    console.warn("Quit the app and reinstall from the delivery folder.")
  }
}

const dmgDir = join(bundle, "dmg")
const dmgName = (await readdir(dmgDir).catch(() => [] as string[])).find((name) => name.endsWith(".dmg"))
if (dmgName === undefined) {
  console.warn(`No .dmg found under ${dmgDir}`)
} else {
  // "ALWith L_0.2.27_aarch64.dmg" -> "ALWith L_0.2.27_<stamp>_aarch64.dmg"
  const match = /^(.*?)_([^_]+)_([^_]+)\.dmg$/.exec(dmgName)
  const stamped =
    match === null ? `${product}_${pkg.version}_${stamp}.dmg` : `${match[1]}_${match[2]}_${stamp}_${match[3]}.dmg`
  await cp(join(dmgDir, dmgName), join(dest, stamped))
  console.log(`dmg  -> ${join(dest, stamped)}`)
}
console.log(`build stamp: ${stamp} (version ${pkg.version})`)
