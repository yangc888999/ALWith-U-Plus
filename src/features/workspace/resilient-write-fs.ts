// Editor saves go through the shared controller, which writes with the version captured when a
// document was opened. Drive can rotate that version without changing the body, and an autosave
// then reports a false conflict. This adapter keeps the filesystem contract intact while resolving
// that one case: identical bytes are adopted, a still-unchanged base is retried against the fresh
// version, and a genuinely different body is left untouched and surfaced as a conflict.

import type { FileStat, FileSystem, FsTransaction, WriteOptions } from "@alwith/module-fs/core"

const STABLE_READ_DELAYS = [40, 80, 120, 180, 240, 320, 420, 540] as const
const FILE_STILL_UPDATING = "File is still being updated; retry the save"
const READ_CACHE_LIMIT = 128

interface StableRead {
  bytes: Uint8Array
  version: string
}

export interface WriteConflict {
  path: string
  localBytes: Uint8Array
  currentBytes: Uint8Array
  currentVersion: string
}

export interface ResilientWriteOptions {
  /** Called before a genuine external edit is surfaced. The save still refuses to overwrite. */
  onConflict?: (conflict: WriteConflict) => void | Promise<void>
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds))

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false
  return true
}

function isVersionConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /changed on disk|expectedVersion|version conflict/i.test(message)
}

async function readStable(fs: FsTransaction, path: string): Promise<StableRead> {
  for (let attempt = 0; attempt < STABLE_READ_DELAYS.length; attempt += 1) {
    const before = await fs.stat(path)
    if (before === null) throw new Error("File is no longer available")
    const bytes = await fs.readFile(path)
    const after = await fs.stat(path)
    if (after !== null && after.version === before.version) return { bytes, version: after.version }
    if (attempt + 1 < STABLE_READ_DELAYS.length) await delay(STABLE_READ_DELAYS[attempt] ?? 540)
  }
  throw new Error(FILE_STILL_UPDATING)
}

/**
 * Wrap a filesystem used by the editor controller and preview providers.
 *
 * Only conditional writes are extended; reads, watches, transactions and every other operation
 * remain the underlying implementation's responsibility. The read cache is deliberately small and
 * scoped to the most recent editor reads, because it is a conflict baseline, not a document cache.
 */
export function createResilientWriteFileSystem(fs: FileSystem, hooks: ResilientWriteOptions = {}): FileSystem {
  const baseRead = fs.readFile.bind(fs)
  const baseStat = fs.stat.bind(fs)
  const readCache = new Map<string, Uint8Array>()

  const rememberRead = (path: string, bytes: Uint8Array): void => {
    readCache.delete(path)
    readCache.set(path, bytes.slice())
    while (readCache.size > READ_CACHE_LIMIT) {
      const oldest = readCache.keys().next().value
      if (oldest === undefined) break
      readCache.delete(oldest)
    }
  }

  const writeResilient = async (
    target: FsTransaction,
    path: string,
    bytes: Uint8Array,
    options: WriteOptions | undefined
  ): Promise<void> => {
    const expectedVersion = options?.expectedVersion
    if (options === undefined || expectedVersion === undefined) {
      await target.writeFile(path, bytes, options)
      rememberRead(path, bytes)
      return
    }
    const baseBytes = readCache.get(path)
    try {
      await target.writeFile(path, bytes, options)
      rememberRead(path, bytes)
      return
    } catch (error) {
      if (!isVersionConflict(error)) throw error
      const current = await readStable(target, path)
      // Another writer landed exactly this draft: adopt its version without rewriting the body.
      if (sameBytes(current.bytes, bytes)) {
        rememberRead(path, bytes)
        return
      }
      // The version moved but the base body did not: retry the same conditional write against the
      // fresh marker. A different base body is a real concurrent edit and must stay untouched.
      if (baseBytes === undefined || !sameBytes(current.bytes, baseBytes)) {
        await hooks.onConflict?.({
          path,
          localBytes: bytes.slice(),
          currentBytes: current.bytes.slice(),
          currentVersion: current.version
        })
        throw error
      }
      try {
        await target.writeFile(path, bytes, { ...options, expectedVersion: current.version })
        rememberRead(path, bytes)
      } catch (retryError) {
        if (isVersionConflict(retryError)) throw new Error("File changed on disk; retry the save")
        throw retryError
      }
    }
  }

  const wrapTransaction = (transaction: FsTransaction): FsTransaction => ({
    stat: (path) => transaction.stat(path),
    readFile: async (path) => {
      const bytes = await transaction.readFile(path)
      rememberRead(path, bytes)
      return bytes
    },
    writeFile: (path, bytes, options) => writeResilient(transaction, path, bytes, options)
  })

  return {
    ...fs,
    stat: (path): Promise<FileStat | null> => baseStat(path),
    readFile: async (path) => {
      const bytes = await baseRead(path)
      rememberRead(path, bytes)
      return bytes
    },
    writeFile: (path, bytes, options) => writeResilient(fs, path, bytes, options),
    transaction: (work) => fs.transaction((transaction) => work(wrapTransaction(transaction)))
  }
}
