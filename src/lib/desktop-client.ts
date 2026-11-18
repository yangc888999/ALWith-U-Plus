import { CodexClient } from "@/agent/client"
import { commands } from "@/bindings"
import type { FuzzyFileSearchParams, FuzzyFileSearchResponse } from "@nyssance/codex-acp-v2/client"
import { info } from "@tauri-apps/plugin-log"

import { CODEX_AGENT_ID, runtimeClient } from "./runtime"
import { initialFileResults } from "./initial-file-results"

/** How long a reconnect may take before the Runtime itself is rebuilt. */
const CONNECT_DEADLINE_MS = 10_000
/** How long the Runtime gets to forget an agent that already exited. */
const SETTLE_DEADLINE_MS = 4_000

/** Main owns native filesystem access; floating clients forward this method to it. */
export class DesktopCodexClient extends CodexClient {
  private settling: Promise<boolean> | null = null
  /** When the current connection became ready, and how many died right after becoming ready. */
  private readyAt = 0
  private shortLived = 0

  protected override onConnected(agent: never): void {
    this.readyAt = Date.now()
    super.onConnected(agent)
  }

  protected override onDisconnected(): void {
    // An engine that dies within seconds of a successful handshake is not crashing on its own:
    // something in the Runtime keeps ending it, and reconnecting into that state just repeats the
    // cycle. Count those, so `connect()` can rebuild the Runtime instead of feeding the loop.
    if (this.readyAt > 0 && Date.now() - this.readyAt < 3_000) this.shortLived += 1
    else if (this.readyAt > 0) this.shortLived = 0
    super.onDisconnected()
  }

  /**
   * `connect()` is only safe when the Runtime does not hold an agent this client cannot adopt.
   *
   * The SDK's `hold()` adopts an existing `codex` entry; that adoption re-runs `initialize`, fails
   * against a process that is already going away, and its fallback then *stops* the process and
   * waits for an `Exit` event. When the exit already happened, that wait never resolves — the
   * promise stays pending forever, so the reader's 「重新连接」 did nothing at all (2026-11-18).
   *
   * So: wait for the Runtime to report no agent, and if the entry is still there afterwards (a
   * phantom), rebuild the Runtime instead of adopting it. The whole attempt is bounded; a timeout
   * surfaces as a real error rather than an inert button.
   */
  override async connect(): Promise<void> {
    if (this.state.connection === "ready") return super.connect()
    const phantom = (await this.settleAgentGone()) || this.shortLived >= 2
    if (phantom) {
      void info("[connect] Runtime still lists codex after its exit; rebuilding the Runtime")
      await this.rebuildRuntime()
    }
    await this.connectWithin(CONNECT_DEADLINE_MS)
  }

  /** Closes the Runtime and waits until the webview holds a fresh port for it. */
  private async rebuildRuntime(): Promise<void> {
    const before = await runtimeClient().catch(() => null)
    await commands.restartRuntimeEngine().catch(() => undefined)
    // The port is replaced when Rust reports `runtime:exit`; connecting through the old one would
    // answer every request with the closed-connection error.
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = await runtimeClient().catch(() => null)
      if (current !== null && current !== before) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  private async connectWithin(deadlineMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`连接超时（${deadlineMs / 1000}s）`)), deadlineMs)
    })
    try {
      await Promise.race([super.connect(), deadline])
    } catch (error) {
      // A wedged handshake keeps `connecting` set inside the client, which is why every later
      // attempt answered with the same pending promise. Rebuilding the Runtime fails that
      // handshake for real, so the next attempt starts from a clean state.
      void info(`[connect] failed: ${error instanceof Error ? error.message : String(error)}`)
      await this.rebuildRuntime()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /** Resolves to true when the Runtime still lists `codex` after the settle window. */
  private settleAgentGone(): Promise<boolean> {
    this.settling ??= (async () => {
      const port = await runtimeClient()
      const until = Date.now() + SETTLE_DEADLINE_MS
      for (;;) {
        const agents = await port.agents().catch(() => [])
        if (!agents.some((agent) => agent.agentId === CODEX_AGENT_ID)) return false
        if (Date.now() >= until) return true
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    })().finally(() => {
      this.settling = null
    })
    return this.settling
  }

  override async fuzzyFileSearch(params: FuzzyFileSearchParams): Promise<FuzzyFileSearchResponse> {
    return {
      files: (await Promise.all(params.roots.map((root) => initialFileResults(root, params.query)))).flat().slice(0, 50)
    }
  }
}
