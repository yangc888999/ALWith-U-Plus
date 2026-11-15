/**
 * Build-time only. Stages the native Drive library that `@alwith/module-drive` ships in its own
 * `native/<platform>/` directory.
 *
 * `@alwith/module-drive` 0.6 dropped the separate `@alwith/native-drive` + platform-package pair:
 * the dylib/dll now travels inside the module package next to an `artifact.json` descriptor. The
 * descriptor is the contract the host relies on, so every field is verified before the bytes are
 * copied — a mismatched library fails the build instead of failing at runtime behind a closed
 * native ABI.
 */
import { createHash } from "node:crypto"
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

/** Rust target triple -> the platform directory used inside `@alwith/module-drive/native/`. */
const PLATFORMS: Record<string, string> = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-pc-windows-msvc": "win32-x64"
}

/** The native Drive ABI this host links against. */
const ABI = 1
/** The Drive command/event contract this host speaks; 2 added `setExcluded` and `resolveConflict`. */
const CONTRACT = 2

/** Recorded in `artifact.json` by the module's release pipeline. */
type DriveArtifact = {
  module: string
  contract: number
  abi: number
  target: string
  binary: string
  sha256: string
}

const root = resolve(import.meta.dirname, "..", "..")

/** The module package's native directory for `platform`. */
function artifactDirectory(platform: string): string {
  return join(root, "node_modules/@alwith/module-drive/native", platform)
}

function readArtifact(directory: string, target: string, platform: string): DriveArtifact {
  const file = join(directory, "artifact.json")
  if (!existsSync(file)) {
    throw new Error(`Missing Drive native descriptor ${file}. Install @alwith/module-drive for ${target}.`)
  }
  const artifact = JSON.parse(readFileSync(file, "utf8")) as Partial<DriveArtifact>
  if (artifact.module !== "drive") throw new Error(`Drive native descriptor is for module ${artifact.module}`)
  if (artifact.abi !== ABI) throw new Error(`Drive native ABI ${artifact.abi} does not match the host ABI ${ABI}`)
  if (artifact.contract !== CONTRACT) {
    throw new Error(`Drive native contract ${artifact.contract} does not match the host contract ${CONTRACT}`)
  }
  if (artifact.target !== target) {
    throw new Error(`Drive native descriptor targets ${artifact.target}, not the requested ${target}`)
  }
  if (typeof artifact.binary !== "string" || !artifact.binary) {
    throw new Error(`Drive native descriptor for ${platform} names no binary`)
  }
  if (typeof artifact.sha256 !== "string" || !artifact.sha256) {
    throw new Error(`Drive native descriptor for ${platform} pins no checksum`)
  }
  return artifact as DriveArtifact
}

/**
 * Copies the pinned, checksum-verified Drive library and its licence notices.
 * @param target the Rust target triple being staged
 * @param destination the host's native library directory (`src-tauri/resources/native`)
 * @param licenses the host's licence notice directory (`src-tauri/resources/licenses`)
 * @returns the staged library path
 */
export function stageDriveNative(target: string, destination: string, licenses: string): string {
  const platform = PLATFORMS[target]
  if (!platform) {
    // Upstream publishes darwin-arm64 and win32-x64 only; fail loudly instead of shipping an app
    // whose Drive panel silently cannot load its library.
    throw new Error(
      `Drive publishes native libraries only for darwin-arm64 and win32-x64; ${target} has no artifact`
    )
  }
  const directory = artifactDirectory(platform)
  if (!existsSync(directory)) {
    throw new Error(`Missing Drive native package directory ${directory}. Install @alwith/module-drive for ${target}.`)
  }
  const artifact = readArtifact(directory, target, platform)
  const binary = join(directory, artifact.binary)
  if (!existsSync(binary) || !statSync(binary).isFile()) {
    throw new Error(`Drive native descriptor names ${artifact.binary}, which is missing from ${directory}`)
  }
  const bytes = readFileSync(binary)
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
    throw new Error(`Drive native binary ${artifact.binary} does not match its pinned checksum`)
  }
  mkdirSync(destination, { recursive: true })
  const staged = join(destination, artifact.binary)
  copyFileSync(binary, staged)
  // Licence notices live beside the binary upstream; keep them in their own directory so another
  // module's notices can never be overwritten.
  const legal = join(licenses, "alwith-native-drive")
  mkdirSync(legal, { recursive: true })
  const notices = join(directory, "THIRD_PARTY_NOTICES.md")
  if (!existsSync(notices)) throw new Error(`Missing Drive native licence notices ${notices}`)
  copyFileSync(notices, join(legal, "THIRD_PARTY_NOTICES.md"))
  const thirdParty = join(directory, "licenses")
  if (!existsSync(thirdParty)) throw new Error(`Missing Drive native licence texts ${thirdParty}`)
  cpSync(thirdParty, join(legal, "licenses"), { recursive: true })
  // The module's own licence covers the wrapper crate and ships at the package root.
  const license = join(root, "node_modules/@alwith/module-drive/LICENSE")
  if (existsSync(license)) copyFileSync(license, join(legal, "LICENSE"))
  return staged
}
