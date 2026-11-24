import type { Session } from "@alwith/api"
// The app-wide CodexClient instance and the React bindings to its store.
import { isTauri } from "@tauri-apps/api/core"
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow"
import { info } from "@tauri-apps/plugin-log"
import { useStore } from "zustand"

import type { AppState } from "@/agent/client"
import { macProjectPaths } from "@/agent/project-path"
import { commands } from "@/bindings"
import { computerRuntimeEnv } from "@/features/computer/runtime-config"
import { computerContextRevision, hostSessionContext, prepareComputerTools } from "@/features/computer/session-context"
import { RemoteChatClient } from "@/lib/chat-window-client"
import { DesktopCodexClient } from "@/lib/desktop-client"
import { isMac } from "@/lib/platform"
import { applyProvidersWhenIdle, defaultModelFallback, getProviderSnapshot, isAccountModel, loadProviders, resolveSessionModel } from "@/lib/providers"
import { CODEX_AGENT_ID, runtimeClient } from "@/lib/runtime"

export const client =
  isTauri() && getCurrentWebviewWindow().label === "chat"
    ? new RemoteChatClient()
    : new DesktopCodexClient(runtimeClient, {
        logInfo: (message) => { void info(message).catch(() => {}) },
        agentId: CODEX_AGENT_ID,
        launch: { engine: "codex", env: computerRuntimeEnv },
        projectPaths: isMac() ? macProjectPaths : undefined,
        resolveModel: async (model, purpose) => {
          // Read the last applied catalog from the cache (fast path), warmed by useProviders and
          // loadProviders, instead of a write round-trip (providersApply) on every session. A
          // pending catalog means a saved change has not reached the adapter yet: apply it now (if
          // idle) rather than resolving against a stale snapshot, preserving the previous contract.
          let providers = getProviderSnapshot() ?? (await loadProviders())
          if (providers.status === "pending") providers = await applyProvidersWhenIdle()
          // Account (enterprise) models stay usable on a pending catalog: prompt admission retries
          // the saved provider revision after active turns have finished.
          return providers.status === "pending" && !isAccountModel(model)
            ? null
            : resolveSessionModel(model, providers, purpose)
        },
        defaultModel: () => {
          // Drafts used to fall back to the previous session's model even when the user had
          // configured a default in settings; the option was defined but never supplied here.
          const snapshot = getProviderSnapshot()
          return snapshot === null ? null : defaultModelFallback(snapshot)
        },
        sessionContext: hostSessionContext,
        sessionContextRevision: computerContextRevision,
        prepareSessionTools: prepareComputerTools,
        revokeSessionAccess: async (sessionId) => {
          await commands.computerStopSession({ sessionId })
        }
      })

/** Mirrors the Runtime's run states into the client store for the lifetime of the app. */
export async function watchRunStates(): Promise<() => void> {
  const port = await runtimeClient()
  let revision = 0
  const stop = await port.onRunStates((sessions) => {
    revision++
    client.applyRunStates(sessions)
  })
  const baseline = revision
  const snapshot = await port.runStates()
  if (revision === baseline) client.applyRunStates(snapshot, "snapshot")
  return stop
}

/** `done` clears only through the Runtime: a session someone looked at is read everywhere. The
 *  confirmation names the version on screen: a session that finished again since keeps its new `done`. */
export async function markRead(sessionId: string): Promise<void> {
  const port = await runtimeClient()
  await port.markRead(sessionId, client.state.runStates[sessionId]?.version ?? null)
}

/** Close only this session; Runtime.stopSession would kill the shared Codex agent. */
export async function stopSession(sessionId: string): Promise<void> {
  await client.stopSession(sessionId)
}

export function useApp<T>(selector: (state: AppState) => T): T {
  return useStore(client.store, selector)
}

export function useSession(id: string | null): Session | null {
  return useStore(client.store, (state) => (id === null ? null : (state.sessions[id] ?? null)))
}
