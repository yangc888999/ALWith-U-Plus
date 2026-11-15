// What the settings window needs from the main window's agent connection: the engine
// identity for About and the sign-out action. The settings window has no ACP client of
// its own (a second client would attach the sessions away from the main window), so the
// two windows talk over events, as ALwith Desktop's windows do.

import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { isTauri } from "@tauri-apps/api/core"
import { emitTo, listen } from "@tauri-apps/api/event"
import * as React from "react"
import { toast } from "sonner"

import type { PendingAction } from "@/agent/client"
import { reviveCatalogModels } from "@/lib/retired-models"
import type { AccountReadResponse, RateLimitSnapshot } from "@nyssance/codex-acp-v2/client"

export type SettingsEvents = { listen: typeof listen; emitTo: typeof emitTo }
// Built per call, not at import: a surface that only needs the types (or a test that stubs the
// event module partially) must not pay for — or fail on — the Tauri bindings at module load.
const tauriEvents = (): SettingsEvents => ({ listen, emitTo })

export type SettingsAgent = {
  name: string
  version: string
  authMethods: acp.AuthMethod[]
  actions: PendingAction[]
} | null
/** `null` while the agent is not connected or does not expose the account methods. */
export type SettingsAccount = {
  account: AccountReadResponse
  rateLimits: RateLimitSnapshot | null
  /** When the snapshot above was read from ChatGPT (ms). Older than "now" once it is a cache. */
  rateLimitsCapturedAt?: number | null
  /** True when the live read failed and these numbers are the last successful snapshot. */
  rateLimitsStale?: boolean
  /** True when the live read failed *and* there was nothing cached to fall back on. */
  rateLimitsError?: boolean
} | null

/** One model in the settings picker: its own effort ladder, when it publishes one. */
export interface SettingsModel {
  id: string
  label: string
  efforts: string[]
  defaultEffort: string | null
}
/** The integrated (native) model group, answered by the main window's live agent catalog. */
export interface SettingsNativeModels {
  id: string
  name: string
  /**
   * Which catalog this is.
   *
   * `session` — a live session's own picker, the only list that may be called authoritative.
   * `bundled` — the `codex_bundled_models` fallback used while no session is open. It is the
   * engine's built-in catalog, i.e. **partial**: a model missing from it has not been withdrawn,
   * which is why `model-config.ts` refuses to diff saved rows against anything not authoritative.
   */
  sourceKind?: "session" | "bundled"
  models: SettingsModel[]
}

const REQUEST_AGENT = "settings:request-agent"
const AGENT = "settings:agent"
const AUTH_REQUEST = "settings:auth-request"
const AUTH_RESULT = "settings:auth-result"
const REQUEST_ACCOUNT = "settings:request-account"
const ACCOUNT = "settings:account"
const REQUEST_NATIVE_MODELS = "settings:request-native-models"
const NATIVE_MODELS = "settings:native-models"

type AuthRequest = { id: string } & (
  | { action: "login"; methodId: string; extra: Record<string, unknown> }
  | { action: "logout" }
  | { action: "respond"; actionId: string; answer: acp.RequestPermissionResponse | acp.CreateElicitationResponse }
)
type AuthResult = { id: string; error: string | null }
const ACCOUNT_ERROR = "settings:account-error"

/** Main window: answers the settings window's requests. */
export function serveSettingsBridge(
  options: {
    agent: () => SettingsAgent
    subscribe: (listener: () => void) => () => void
    logout: () => Promise<void>
    login: (methodId: string, extra: Record<string, unknown>) => Promise<void>
    respond: (actionId: string, answer: acp.RequestPermissionResponse | acp.CreateElicitationResponse) => void
    /** Account + rate limits from the agent; `null` when unavailable. */
    account: () => Promise<SettingsAccount>
    /** Rolling rate-limit updates; the callback receives each snapshot. */
    onRateLimits: (listener: (limits: RateLimitSnapshot) => void) => () => void
    /** The integrated model group from any live session's picker; `null` before one exists. */
    nativeModels: () => SettingsNativeModels | null
  },
  events: SettingsEvents = tauriEvents()
): { stop: () => void; republish: () => void } {
  const { listen, emitTo } = events
  // Settings used to be a window labelled `settings`. It now renders inside the main window as an
  // overlay, so an emit addressed only to that label reaches nobody — the model list and the
  // account card would stay empty. Send to both: whichever surface exists answers, and a build
  // that still opens a standalone settings window keeps working unchanged.
  const toSettings = (event: string, payload: unknown): Promise<void> => {
    void emitTo("settings", event, payload)
    return emitTo("main", event, payload)
  }
  let lastAgent = options.agent()
  let lastNativeSignature = ""
  const nativeSignature = (models: SettingsNativeModels | null): string =>
    models === null
      ? ""
      : // `sourceKind` is part of the signature: the same rows arriving from a live session instead
        // of the bundled fallback change what the settings window may say about them (已下架).
        `${models.id}|${models.sourceKind ?? "session"}|${models.name}|${models.models.map((m) => `${m.id}:${m.efforts.join(",")}:${m.defaultEffort ?? ""}`).join(";")}`
  const publish = () => {
    const agent = options.agent()
    void toSettings(AGENT, agent)
    if ((lastAgent === null) !== (agent === null)) void publishAccount()
    // The native model list appears with the first session; republish it whenever it changes so
    // a settings window opened before that still receives it.
    const nativeModels = options.nativeModels()
    const signature = nativeSignature(nativeModels)
    if (signature !== lastNativeSignature) {
      lastNativeSignature = signature
      // The engine's catalog is the only source of truth for what can run. A catalog change is
      // proof that a provider which withdrew an id may have put it back, so believe it over any
      // tombstone written during the outage. Done here — where the catalog originates — so it
      // also happens when no settings window is open.
      if (nativeModels !== null) reviveCatalogModels(nativeModels.models.map((model) => model.id))
      void toSettings(NATIVE_MODELS, nativeModels)
    }
    lastAgent = agent
  }
  let lastAccount: SettingsAccount = null
  let revision = 0
  let disposed = false
  const publishAccount = async () => {
    const current = ++revision
    try {
      const account = await options.account()
      if (disposed || current !== revision) return
      lastAccount = account
      await toSettings(ACCOUNT, lastAccount)
    } catch (error) {
      if (disposed || current !== revision) return
      await toSettings(ACCOUNT_ERROR, error instanceof Error ? error.message : String(error))
    }
  }
  const unsubscribe = options.subscribe(publish)
  const stopLimits = options.onRateLimits((limits) => {
    if (lastAccount === null) return
    lastAccount = { ...lastAccount, rateLimits: limits, rateLimitsCapturedAt: Date.now(), rateLimitsStale: false }
    void toSettings(ACCOUNT, lastAccount)
  })
  const publishNativeModels = () => {
    void toSettings(NATIVE_MODELS, options.nativeModels())
  }
  const stops = Promise.all([
    listen(REQUEST_AGENT, publish),
    listen(REQUEST_ACCOUNT, () => void publishAccount()),
    listen(REQUEST_NATIVE_MODELS, publishNativeModels),
    listen<AuthRequest>(
      AUTH_REQUEST,
      ({ payload: request }) =>
        void (async () => {
          try {
            switch (request.action) {
              case "login":
                await options.login(request.methodId, request.extra)
                await publishAccount()
                break
              case "logout":
                await options.logout()
                await publishAccount()
                break
              case "respond":
                options.respond(request.actionId, request.answer)
                break
            }
            await toSettings(AUTH_RESULT, { id: request.id, error: null } satisfies AuthResult)
          } catch (error) {
            await toSettings(AUTH_RESULT, {
              id: request.id,
              error: error instanceof Error ? error.message : String(error)
            } satisfies AuthResult)
          }
        })()
    )
  ])
  return {
    stop: () => {
      disposed = true
      revision++
      unsubscribe()
      stopLimits()
      void stops.then((fns) => {
        for (const stop of fns) stop()
      })
    },
    /** Re-pushes the current snapshot: the bundled-catalog fallback arrives after boot. */
    republish: publish
  }
}

/** Settings window: the main window's account + rate limits, `undefined` until the first answer. */
export function useSettingsAccount(): SettingsAccount | undefined {
  const [account, setAccount] = React.useState<SettingsAccount | undefined>(undefined)
  const retry = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryDelay = React.useRef(8_000)
  React.useEffect(() => {
    let disposed = false
    const ask = () => {
      if (disposed) return
      void emitTo("main", REQUEST_ACCOUNT)
    }
    // A failed limit read is usually a network blip, so ask again by itself rather than leaving the
    // panel on "暂无用量数据" until the user happens to reopen settings. The delay doubles up to a
    // minute: an offline machine must not hammer an endpoint it cannot reach.
    const scheduleRetry = (payload: SettingsAccount) => {
      if (payload?.rateLimitsError !== true) {
        retryDelay.current = 8_000
        if (retry.current !== null) clearTimeout(retry.current)
        retry.current = null
        return
      }
      if (retry.current !== null) return
      const delay = retryDelay.current
      retryDelay.current = Math.min(60_000, delay * 2)
      retry.current = setTimeout(() => {
        retry.current = null
        ask()
      }, delay)
    }
    const stops = Promise.all([
      listen<SettingsAccount>(ACCOUNT, (event) => {
        if (disposed) return
        setAccount(event.payload)
        scheduleRetry(event.payload)
      }),
      listen<string>(ACCOUNT_ERROR, (event) => {
        if (disposed) return
        setAccount(null)
        toast.error(event.payload)
      })
    ])
    void stops.then(() => {
      if (!disposed) return emitTo("main", REQUEST_ACCOUNT)
    })
    return () => {
      disposed = true
      if (retry.current !== null) clearTimeout(retry.current)
      retry.current = null
      void stops.then((fns) => {
        for (const stop of fns) stop()
      })
    }
  }, [])
  return account
}

/** Settings window: the main window's agent, `undefined` until the first answer arrives. */
export function useSettingsAgent(): SettingsAgent | undefined {
  const [agent, setAgent] = React.useState<SettingsAgent | undefined>(undefined)
  React.useEffect(() => {
    let disposed = false
    const stop = listen<SettingsAgent>(AGENT, (event) => {
      if (!disposed) setAgent(event.payload)
    })
    void stop.then(() => {
      if (!disposed) return emitTo("main", REQUEST_AGENT)
    })
    return () => {
      disposed = true
      void stop.then((fn) => fn())
    }
  }, [])
  return agent
}

/** Settings window: the integrated model group from the main window, `undefined` until answered. */
export function useSettingsNativeModels(): SettingsNativeModels | null | undefined {
  const [models, setModels] = React.useState<SettingsNativeModels | null | undefined>(undefined)
  React.useEffect(() => {
    // Without the Tauri bridge `listen` throws while registering its callback, which surfaced as an
    // unhandled rejection in every test (and in the Storybook/preview builds) that mounts this
    // section. Nothing can answer the request there either, so stay unresolved instead.
    if (!isTauri()) return
    let disposed = false
    const stop = listen<SettingsNativeModels | null>(NATIVE_MODELS, (event) => {
      if (!disposed) setModels(event.payload)
    })
    void stop.then(() => {
      if (!disposed) return emitTo("main", REQUEST_NATIVE_MODELS)
    })
    return () => {
      disposed = true
      void stop.then((fn) => fn())
    }
  }, [])
  return models
}

/** Settings window: asks the main window to sign out of Codex. */
async function requestAuth(request: AuthRequest, { listen, emitTo }: SettingsEvents): Promise<void> {
  let resolve!: (result: AuthResult) => void
  const promise = new Promise<AuthResult>((done) => {
    resolve = done
  })
  const stop = await listen<AuthResult>(AUTH_RESULT, (event) => {
    if (event.payload.id === request.id) resolve(event.payload)
  })
  try {
    await emitTo("main", AUTH_REQUEST, request)
    const { error } = await promise
    if (error !== null) throw new Error(error)
  } finally {
    stop()
  }
}

export function createSettingsAuthClient(events: SettingsEvents) {
  return {
    requestSignOut: () => requestAuth({ id: crypto.randomUUID(), action: "logout" }, events),
    requestSignIn: (methodId: string, extra: Record<string, unknown>) =>
      requestAuth({ id: crypto.randomUUID(), action: "login", methodId, extra }, events),
    requestActionResponse: (actionId: string, answer: acp.RequestPermissionResponse | acp.CreateElicitationResponse) =>
      requestAuth({ id: crypto.randomUUID(), action: "respond", actionId, answer }, events)
  }
}

export function requestSignOut(): Promise<void> {
  return requestAuth({ id: crypto.randomUUID(), action: "logout" }, tauriEvents())
}

export function requestSignIn(methodId: string, extra: Record<string, unknown>): Promise<void> {
  return requestAuth({ id: crypto.randomUUID(), action: "login", methodId, extra }, tauriEvents())
}

/**
 * Settings window: asks the main window to re-read `account/read` + `account/rateLimits/read`.
 *
 * The answer does not come back through this promise — it arrives on the `settings:account`
 * channel and reaches every `useSettingsAccount` subscriber, which is what lets one click refresh
 * both the usage page and the rate-limit reset card. Kept separate from `requestSignOut` because
 * it carries no action and needs no correlation id.
 */
export function requestAccountRefresh(events: SettingsEvents = tauriEvents()): Promise<void> {
  return events.emitTo("main", REQUEST_ACCOUNT)
}

export function requestActionResponse(
  actionId: string,
  answer: acp.RequestPermissionResponse | acp.CreateElicitationResponse
): Promise<void> {
  return requestAuth({ id: crypto.randomUUID(), action: "respond", actionId, answer }, tauriEvents())
}
