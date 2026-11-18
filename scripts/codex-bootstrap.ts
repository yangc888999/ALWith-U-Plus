// U owns startup caching. The ACP adapter is imported unchanged from its published package.
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"

import { prepareModelCatalog } from "./lib/model-catalog"

/**
 * Where the agent records why it refused to boot.
 *
 * A throw in this file happens before the ACP handshake, so the reader only ever sees
 * "agent codex exited" — the same sentence for a quarantined binary, a half-downloaded engine
 * update and an unreadable config. The app log cannot capture a child's stderr, so the reason is
 * appended here instead, where a user on any macOS account can find it.
 */
function bootLogPath(): string {
  return process.platform === "darwin"
    ? join(homedir(), "Library/Logs/ai.alwith.u/adapter-codex.log")
    : join(homedir(), ".alwith-u/adapter-codex.log")
}

function recordBootFailure(error: unknown): void {
  const line = `[${new Date().toISOString()}] agent boot failed: ${
    error instanceof Error ? (error.stack ?? error.message) : String(error)
  }\n`
  try {
    mkdirSync(dirname(bootLogPath()), { recursive: true })
    appendFileSync(bootLogPath(), line)
  } catch {
    // Logging must never mask the failure it is describing.
  }
  process.stderr.write(`[alwith-u] ${line}`)
}

function describeProbe(probe: ReturnType<typeof spawnSync>): string {
  if (probe.error) return probe.error.message
  const stderr = typeof probe.stderr === "string" ? probe.stderr.trim() : ""
  return stderr === "" ? `exit ${String(probe.status)}` : `exit ${String(probe.status)}: ${stderr.slice(0, 400)}`
}

/**
 * Resolve the engine to run, preferring the configured path but never dying on it.
 *
 * `ALWITH_U_CODEX_PATH` may name a per-user engine update (`codex-override/codex`). That file is
 * outside the app bundle: a half-finished download, a quarantine flag or a broken arch leaves a
 * binary that cannot execute, and the agent used to exit before it could answer `initialize`.
 * The bundled engine always sits next to this Bun process, so a failing override degrades the
 * version instead of taking the whole app down.
 */
function resolveCodex(configured: string): { command: string; version: string } {
  const first = spawnSync(configured, ["--version"], { encoding: "utf8", timeout: 10_000 })
  if (!first.error && first.status === 0) return { command: configured, version: (first.stdout ?? "").trim() }

  const bundled = join(dirname(process.execPath), process.platform === "win32" ? "codex.exe" : "codex")
  if (bundled !== configured && existsSync(bundled)) {
    const retry = spawnSync(bundled, ["--version"], { encoding: "utf8", timeout: 10_000 })
    if (!retry.error && retry.status === 0) {
      process.stderr.write(
        `[alwith-u] configured Codex failed (${describeProbe(first)}); using bundled ${bundled}\n`
      )
      return { command: bundled, version: (retry.stdout ?? "").trim() }
    }
  }
  throw new Error(`Codex version probe failed for ${configured} (${describeProbe(first)})`)
}

/**
 * The agent process only lives as long as its stdin: the Runtime closes that pipe when it stops
 * the agent. Recording the exit code and the pipe's end separates "the Runtime stopped me" from
 * "I died on my own", which is the difference between a reconnect loop and a crash (2026-11-18).
 */
function recordLifecycle(line: string): void {
  try {
    mkdirSync(dirname(bootLogPath()), { recursive: true })
    appendFileSync(bootLogPath(), `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

async function start(): Promise<void> {
  const startedAt = Date.now()
  recordLifecycle(`agent boot pid=${process.pid} codex=${process.env["ALWITH_U_CODEX_PATH"] ?? "?"}`)
  process.once("exit", (code) => recordLifecycle(`agent exit code=${code} aliveMs=${Date.now() - startedAt}`))
  process.once("SIGTERM", () => recordLifecycle("agent SIGTERM"))
  process.once("SIGINT", () => recordLifecycle("agent SIGINT"))
  process.stdin.once("end", () => recordLifecycle("agent stdin end"))
  const configured = process.env.ALWITH_U_CODEX_PATH
  if (!configured || !isAbsolute(configured))
    throw new Error("ALWITH_U_CODEX_PATH must name the bundled Codex executable")
  const { command, version } = resolveCodex(configured)

  // The catalog is an enhancement, not a prerequisite. `codex debug models` fails on older
  // engines and on an unreadable ~/.codex/config.toml; letting that throw would kill the agent
  // before it could start a conversation.
  let catalog: ReturnType<typeof prepareModelCatalog> | null = null
  try {
    catalog = prepareModelCatalog({ command, prefixArgs: [], shell: false }, process.env, version)
  } catch (error) {
    process.stderr.write(`[alwith-u] model catalog unavailable, starting without it: ${String(error)}\n`)
  }
  if (catalog === null || catalog.path === null) delete process.env.ALWITH_U_CODEX_CATALOG
  else process.env.ALWITH_U_CODEX_CATALOG = catalog.path
  const dispose = (): void => catalog?.dispose()
  process.once("exit", dispose)
  process.stdin.once("end", dispose)
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143]
  ] as const) {
    process.once(signal, () => {
      dispose()
      process.exit(code)
    })
  }
  try {
    // A runtime URL keeps the unmodified adapter out of this bundle.
    const adapter = new URL("./codex-acp-v2.mjs", import.meta.url).href
    await import(adapter)
  } catch (error) {
    dispose()
    throw error
  }
}

try {
  await start()
} catch (error) {
  recordBootFailure(error)
  process.exit(1)
}
