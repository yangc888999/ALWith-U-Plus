/**
 * Stages the local bridge (`~/.codex/bridge`) into `src-tauri/resources/alwith-bridge`, so the app
 * bundle carries the runtime that `bridge_payload.rs` releases on launch.
 *
 * The bridge itself is not part of this repository: it is a Python proxy that lives in the user's
 * home directory and is edited there. Staging copies whatever that directory holds *now*, which is
 * the only way a rebuild can ship the same scripts the developer is running. `ALWITH_BRIDGE_DIR`
 * overrides the source, matching what `release.sh` and `bridge_payload.rs` honour at runtime.
 *
 * When the source directory is absent (a clean clone, CI), the resource directory is still created
 * and left empty: the app then reports that this build ships no payload instead of failing to
 * build. A missing payload is a supported state — Settings simply finds nothing to release.
 */
import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/** Everything `bridge_payload.rs` releases. `bridge-config.json` is user state and never staged. */
export const BRIDGE_FILES = [
  "alwith-proxy.py",
  "alwith-model.py",
  "release.sh",
  "sync.sh",
  "embed.sh",
  "install.sh",
  "README.md"
] as const

/** Template the app copies into place when the user has no allow-list yet. */
export const BRIDGE_CONFIG_TEMPLATE = "bridge-config.default.json"

export function bridgeSource(): string {
  return process.env.ALWITH_BRIDGE_DIR ?? join(homedir(), ".codex/bridge")
}

export type StagedBridge = {
  /** `false` when the source had no proxy to copy — the bundle then carries no payload. */
  staged: boolean
  destination: string
  files: string[]
  version: string | null
}

/**
 * Copies the payload and writes the `manifest.json` the app compares against its installed copy.
 *
 * The version is `<app version>+<content hash>`: the same scheme `embed.sh` uses, so a release that
 * changes nothing but the app version is still distinguishable from no release at all.
 */
export async function stageBridge(root: string, appVersion: string): Promise<StagedBridge> {
  const source = bridgeSource()
  const destination = join(root, "src-tauri/resources/alwith-bridge")
  await mkdir(destination, { recursive: true })

  const files: string[] = []
  for (const name of [...BRIDGE_FILES, BRIDGE_CONFIG_TEMPLATE]) {
    const from = join(source, name)
    const bytes = await readFile(from).catch(() => null)
    if (bytes === null) continue
    await writeFile(join(destination, name), bytes)
    if (name.endsWith(".sh")) await chmod(join(destination, name), 0o755)
    files.push(name)
  }

  if (!files.includes("alwith-proxy.py")) {
    return { staged: false, destination, files, version: null }
  }

  // Content hash over the shipped files, each by name so a rename changes the revision too.
  const digest = createHash("sha256")
  for (const name of [...files].sort()) {
    digest.update(name)
    digest.update(await readFile(join(destination, name)))
  }
  const revision = digest.digest("hex").slice(0, 8)
  const version = `${appVersion}+${revision}`
  const hashes: Record<string, string> = {}
  for (const name of [...files].sort()) {
    hashes[name] = createHash("sha256").update(await readFile(join(destination, name))).digest("hex").slice(0, 16)
  }
  await writeFile(
    join(destination, "manifest.json"),
    `${JSON.stringify(
      {
        version,
        app_version: appVersion,
        bridge_rev: revision,
        staged_at: new Date().toISOString(),
        files: hashes
      },
      null,
      2
    )}\n`
  )
  return { staged: true, destination, files, version }
}
