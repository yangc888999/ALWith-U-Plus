// The Runtime connection for this app: Rust spawns alwith-runtime over stdio; the webview
// talks frames through Tauri events and commands (`@alwith/api/tauri`).

import { TauriRuntimeClient } from "@alwith/api/tauri"

import { events, type RuntimeExit } from "@/bindings"

/** Emitted by Rust when the alwith-runtime process ends. */
export type { RuntimeExit } from "@/bindings"

/** What the Runtime's launcher accepts for `start` (see alwith-runtime `apps/runtime`). */
export type CodexProvider = {
  engine: "codex"
  cwd?: string
  env?: Record<string, string>
  provider?: string
  model?: string
}

export const CODEX_AGENT_ID = "codex"

let port: TauriRuntimeClient<CodexProvider> | null = null

/**
 * The port to the running Runtime. Rust starts the process on first use; after an exit the
 * next call hands out a fresh port, which makes Rust spawn a fresh Runtime.
 */
export function runtimeClient(): Promise<TauriRuntimeClient<CodexProvider>> {
  port ??= retryProviderRestart(new TauriRuntimeClient<CodexProvider>())
  return Promise.resolve(port)
}

/**
 * The Codex app-server restarts itself whenever the provider table changes — which is exactly what
 * a launch does — and any request in flight at that moment is refused with an error the adapter
 * marks `restartable`. Waiting briefly and asking once more turns a red flash into a pause.
 *
 * Wrapping `acpRequest` closes the hole that `client.ts` already handles for `replay`: that retry
 * only covers reopening a conversation, while the refusal the reader actually saw came from an
 * ordinary request racing the restart (2026-11-08).
 */
function retryProviderRestart(client: TauriRuntimeClient<CodexProvider>): TauriRuntimeClient<CodexProvider> {
  const original = client.acpRequest.bind(client)
  client.acpRequest = async (...args: Parameters<TauriRuntimeClient<CodexProvider>["acpRequest"]>) => {
    try {
      return await original(...args)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (!/restarted for a provider change while this request ran/i.test(text)) throw error
      await new Promise((resolve) => setTimeout(resolve, 500))
      return original(...args)
    }
  }
  return client
}

/** Forgets the current port and closes it; the next `runtimeClient()` starts over. */
function resetHubPort(): void {
  const stale = port
  port = null
  stale?.close()
}

/** alwith-runtime ended (crash or kill): the port is dead and every subscription with it. */
export function onHubExit(handler: (exit: RuntimeExit) => void): Promise<() => void> {
  return events["runtime:exit"].listen((event) => {
    port?.markExited()
    resetHubPort()
    handler(event.payload)
  })
}
