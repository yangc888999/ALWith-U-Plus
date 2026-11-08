import { openStore } from "@/lib/store"

/**
 * Local sign-in: a gate for this machine, not a security boundary.
 *
 * The data behind it already lives in plain files under the reader's own account, and anyone
 * holding the disk can reach it without passing through here. What it is for: the company account
 * service only answers inside the company network, so the app needs a way in that does not depend
 * on it.
 */
const STORE_NAME = "alwith-local-account"
const KEY = "credential"
/** Deliberately modest: this runs on every unlock and is not protecting a secret. */
const ITERATIONS = 120_000

export interface LocalCredential {
  name: string
  salt: string
  hash: string
  /** 0 means the fallback digest below was used because Web Crypto was unavailable. */
  iterations: number
  createdAt: string
}

const store = openStore(STORE_NAME)

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ""
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * FNV-1a. Only reached when `crypto.subtle` is missing — some webview origins are not treated as
 * secure contexts for Web Crypto. It is weak on purpose and says so, because a false sense of
 * strength here would be worse than an honest speed bump.
 */
function fallbackDigest(password: string, salt: Uint8Array<ArrayBuffer>): string {
  let hash = 0x811c9dc5
  for (const byte of salt) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  for (const char of password) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0
  return toBase64(new Uint8Array(new Uint32Array([hash]).buffer))
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<string> {
  if (iterations === 0 || !globalThis.crypto?.subtle) return fallbackDigest(password, salt)
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits"
  ])
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, 256)
  return toBase64(bits)
}

export async function readLocalCredential(): Promise<LocalCredential | null> {
  return (await store.get<LocalCredential>(KEY)) ?? null
}

export async function hasLocalAccount(): Promise<boolean> {
  try {
    return await store.has(KEY)
  } catch {
    return false
  }
}

export async function createLocalAccount(name: string, password: string): Promise<LocalCredential> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iterations = globalThis.crypto?.subtle ? ITERATIONS : 0
  const credential: LocalCredential = {
    name: name.trim() || "本地用户",
    salt: toBase64(salt),
    hash: await derive(password, salt, iterations),
    iterations,
    createdAt: new Date().toISOString()
  }
  await store.set(KEY, credential)
  return credential
}

export async function verifyLocalPassword(password: string): Promise<boolean> {
  const credential = await readLocalCredential()
  if (credential === null) return false
  return (await derive(password, fromBase64(credential.salt), credential.iterations)) === credential.hash
}

/** Resetting the local password is legitimate: it opens this machine, it does not hold data. */
export async function clearLocalAccount(): Promise<void> {
  await store.delete(KEY)
}
