import {
  type AuthActions,
  type AuthState,
  type AuthStateEvent,
  authStoreName,
  createAuthClient,
  createAuthState,
  createTokenStorage,
  type LoginResponse
} from "@alwith/module-auth"
import { emit, emitTo, listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { fetch } from "@tauri-apps/plugin-http"
import { arch, platform } from "@tauri-apps/plugin-os"
import { toast } from "sonner"
import { create } from "zustand"

import { commands } from "@/bindings"
import i18n from "@/lib/i18n"
import { openStore } from "@/lib/store"

import { bumpAuthGeneration, createAuthTransport, readAuthGeneration } from "./http"
import { assertActiveLogin } from "./login-response"
import { createEnterpriseEventHandler } from "./enterprise-events"
import { createAccountTransition, createManagedProviders } from "./managed-providers"

export const API_BASE_URL = import.meta.env.DEV ? "https://api-dev.alwith.ai/service" : "https://api.alwith.ai/service"
const STATE_EVENT = "alwith-auth-state"
const LOGOUT_EVENT = "alwith-auth-logout-request"
const LOGIN_EVENT = "alwith-auth-login-request"
const PROVIDERS_REFRESH_EVENT = "alwith-providers-refresh-request"
const isMain = () => getCurrentWindow().label === "main"
// 同一个 `appDataDir/<name>.json`,原 tauri-plugin-store 写下的登录态原样读回;每次 set 即原子落盘。
const store = openStore(authStoreName(API_BASE_URL))
const storage = createTokenStorage({
  get: (key) => store.get(key),
  set: (key, value) => store.set(key, value),
  delete: (key) => store.delete(key)
})
const expiredListeners = new Set<() => void>()
const stateListeners = new Set<(event: AuthStateEvent) => void>()
const transport = createAuthTransport({
  baseUrl: API_BASE_URL,
  fetch,
  storage,
  refresh: (refreshToken) => commands.refreshTokens({ apiBaseUrl: API_BASE_URL, refreshToken }),
  expired: async (generation) => {
    // A newer login/logout already superseded this refresh's account; dropping the expiry keeps a
    // stale refresh from kicking the new login out. The event still carries the epoch so the main
    // window can make the same check if the two webviews race.
    if (generation !== readAuthGeneration()) return
    if (!isMain()) {
      await emitTo("main", LOGOUT_EVENT, { generation })
      return
    }
    bumpAuthGeneration()
    await clearAccountProviders()
    for (const listener of expiredListeners) listener()
    await storage.clearAllAuth()
    await emit(STATE_EVENT, { action: "logout" } satisfies AuthStateEvent)
  }
})
type EnterpriseAccount = { apiBaseUrl: string; userUuid: string }
const enterpriseBindings = new Map<number, { account: EnterpriseAccount; generation: number }>()
async function enterpriseBind(account: EnterpriseAccount): Promise<number> {
  return commands.enterpriseBind({ account })
}
async function enterpriseRefresh(generation: number, accessToken: string): Promise<void> {
  const binding = enterpriseBindings.get(generation)
  if (!binding) throw new Error("Enterprise account binding is missing")
  await commands.enterpriseRefresh({ ...binding, accessToken })
}
async function enterpriseClear(): Promise<void> {
  enterpriseBindings.clear()
  await commands.enterpriseClear()
}
const managedProviders = createManagedProviders({
  validate: async (userUuid) => {
    const profile = await transport.request<{ uuid: string }>("/api/v1/me/profile", "GET")
    if (profile?.uuid !== userUuid || usePlatformAuth.getState().user?.user_uuid !== userUuid)
      throw new Error("ALwith account changed during profile validation")
  },
  bind: async (userUuid) => {
    const account = { apiBaseUrl: API_BASE_URL, userUuid }
    // Both catalogs belong to the same validated account, with independent gateways.
    const generation = await commands.providersAccountBind({ account })
    enterpriseBindings.set(generation, { account, generation: await enterpriseBind(account) })
    return generation
  },
  refresh: async (generation) => {
    await transport.authenticated(async (accessToken) => {
      await commands.providersRefreshManaged({ generation, accessToken })
      await enterpriseRefresh(generation, accessToken)
    })
  },
  clear: async () => {
    const results = await Promise.allSettled([enterpriseClear(), commands.providersClearManaged()])
    for (const result of results) if (result.status === "rejected") throw result.reason
  }
})
let validatedAccount: string | null = null
async function clearAccountProviders(): Promise<void> {
  validatedAccount = null
  try {
    await managedProviders.clear()
  } catch (error) {
    toast.error(`ALwith model cleanup failed: ${String(error)}`)
  }
}
async function loadAccountProviders(): Promise<void> {
  if (!isMain()) throw new Error("ALwith model refresh belongs to the main window")
  const user = usePlatformAuth.getState().user
  if (!user) throw new Error("Sign in to refresh ALwith models")
  await managedProviders.refresh(user.user_uuid)
}
function refreshAccountProviders(): void {
  if (!isMain()) return
  const user = usePlatformAuth.getState().user
  if (!user || user.user_uuid !== validatedAccount) return
  void managedProviders.refresh(user.user_uuid).catch((error: unknown) => {
    // A failed refresh means the account service is unreachable from this network, or the token
    // could not be renewed — both are conditions the reader resolves in 设置 → 账号, and both are
    // normal outside the company network. A red toast on every launch sent the reader chasing a
    // failure they could not act on, and it vanished in a second (2026-11-08). Log it instead.
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : String(error)
    console.warn("[auth] managed provider refresh failed:", message)
  })
}
export function requestAccountProviderRefresh(): Promise<void> {
  return emitTo("main", PROVIDERS_REFRESH_EVENT)
}
export const platformApiRequest = transport.request
export const authClient = createAuthClient({
  publicPost: (path, body) => transport.request(path, "POST", body, false),
  apiPost: (path, body) => transport.request(path, "POST", body),
  platform,
  arch,
  getDeviceId: storage.tokenStorage.getDeviceId,
  onLogoutError: () => console.warn("[auth] remote logout failed; clearing local login"),
  logInfo: () => {}
})
export const usePlatformAuth = create<AuthState & AuthActions>(
  createAuthState({
    storage,
    getProfile: () => transport.request("/api/v1/me/profile", "GET"),
    logoutApi: authClient.logoutApi,
    onInit: () => {},
    validateProfile: isMain,
    handleUnauthenticated: async () => {
      if (!isMain()) await getCurrentWindow().hide()
      return false
    },
    // Account providers are coordinated by the main window; Codex history and login remain engine-owned.
    loadProviders: () => {},
    clearProviders: () => {},
    onProfileRestored: () => {
      const user = usePlatformAuth.getState().user
      if (!user) throw new Error("ALwith profile restored without an account")
      validatedAccount = user.user_uuid
      managedProviders.confirm(user.user_uuid)
      refreshAccountProviders()
    },
    clearAccountConversation: async () => {},
    onSignedIn: (user, source) => {
      if (source === "login") {
        validatedAccount = user.user_uuid
        managedProviders.confirm(user.user_uuid)
        refreshAccountProviders()
      }
    },
    subscribeExpired: (listener) => expiredListeners.add(listener),
    subscribeState: (listener) => stateListeners.add(listener),
    broadcast: (event) => emit(STATE_EVENT, event)
  })
)

const transitionAccount = createAccountTransition()
export function logoutPlatform(): Promise<void> {
  if (!isMain()) return emitTo("main", LOGOUT_EVENT, { generation: readAuthGeneration() })
  return transitionAccount(async () => {
    bumpAuthGeneration()
    await clearAccountProviders()
    await transport.invalidate()
    await usePlatformAuth.getState().logout()
  })
}

export function loginPlatform(response: LoginResponse): Promise<void> {
  // Signed-in state, the provider table it unlocks and the refresh timer all live in the main
  // window, so a settings-window sign-in has to be carried out there. Logout already worked this
  // way; login refused instead, which is why 设置 → 账户 could never sign in (2026-11-09).
  if (!isMain()) return emitTo("main", LOGIN_EVENT, response)
  assertActiveLogin(response)
  return transitionAccount(async () => {
    bumpAuthGeneration()
    await clearAccountProviders()
    await transport.invalidate()
    await usePlatformAuth.getState().login(response)
  })
}

/** Register listeners before restoring credentials; called once by each window bootstrap. */
export async function initPlatformAuth(): Promise<void> {
  if (isMain()) {
    const handleEnterpriseEvent = createEnterpriseEventHandler({
      account: () => usePlatformAuth.getState().user?.user_uuid ?? null,
      status: () => commands.enterpriseStatus(),
      renewAccount: async (generation, requestId) => {
        await transport.request("/api/v1/me/profile", "GET")
        await transport.authenticated((accessToken) =>
          commands.enterpriseUpdateAccount({ generation, requestId, accessToken })
        )
      },
      refreshModels: loadAccountProviders,
      failed: () => toast.error(i18n.t("enterprise.error"))
    })
    await listen<unknown>("enterprise:event", ({ payload }) => {
      void handleEnterpriseEvent(payload)
    })
  }
  await listen<AuthStateEvent>(STATE_EVENT, (event) => {
    // A login/logout in any webview invalidates this window's in-flight account requests. It is
    // fire-and-forget: invalidate never emits a state event or writes the epoch, so it cannot loop.
    if (event.payload.action === "login" || event.payload.action === "logout") void transport.invalidate()
    for (const listener of stateListeners) listener(event.payload)
  })
  if (isMain()) await listen(PROVIDERS_REFRESH_EVENT, refreshAccountProviders)
  if (isMain())
    await listen<{ generation?: number }>(LOGOUT_EVENT, (event) => {
      const generation = event.payload?.generation
      // A delayed expiry from an old account must not log out a newer login.
      if (generation !== undefined && generation !== readAuthGeneration()) return
      void logoutPlatform().catch(() => console.error("[auth] local logout failed"))
    })
  if (isMain())
    await listen<LoginResponse>(LOGIN_EVENT, (event) => {
      void loginPlatform(event.payload).catch((error: unknown) =>
        console.error("[auth] forwarded login failed", error)
      )
    })
  usePlatformAuth.getState().init()
}
