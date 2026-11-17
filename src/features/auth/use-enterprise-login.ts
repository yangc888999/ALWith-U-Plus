import { listen } from "@tauri-apps/api/event"
import { info } from "@tauri-apps/plugin-log"
import { useCallback, useEffect, useRef, useState } from "react"

import { commands } from "@/bindings"

import {
  enterpriseSignedIn,
  nativeAuthorizationStatus,
  parseEnterpriseRenewal,
  type EnterpriseRenewal,
  type EnterpriseStatus
} from "./enterprise-status"
import { platformApiRequest, usePlatformAuth } from "./store"

function enterpriseEmail(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("email" in value)) return null
  const email = (value as { email?: unknown }).email
  return typeof email === "string" && email.trim() !== "" ? email.trim() : null
}

export interface EnterpriseLogin {
  /** True only while the very first check is in flight. */
  checking: boolean
  /** A healthy local renewal, and — when the account service was asked at all — an answer that did
   *  not revoke it. The server can only take authorization away, never grant it. */
  authorized: boolean
  /** The local renewal alone is healthy. The cached provider is NOT proof of sign-in: it survives
   *  offline and outlives an expired token, so this — not the provider list — is the sign-in signal. */
  renewalAvailable: boolean
  /** The signed-in address, read from the native status so it survives without a server answer. */
  email: string | null
  status: EnterpriseStatus | null
  renewal: EnterpriseRenewal | null
  /** The account service could not be reached (e.g. off the company network). */
  error: boolean
}

const INITIAL: EnterpriseLogin = {
  checking: true,
  authorized: false,
  renewalAvailable: false,
  email: null,
  status: null,
  renewal: null,
  error: false
}

/** How long a server answer is reused. Long enough that moving between settings sections costs one
 *  request instead of one per mount, short enough that a revocation performed elsewhere is still
 *  noticed without a restart. */
const STATUS_TTL = 60_000
interface CachedStatus {
  account: string
  at: number
  status: EnterpriseStatus
}
/**
 * The account service is the only authority on `enabled` / `authorization_status`, so it cannot be
 * skipped outright while the renewal is healthy: a server-side revocation has to take effect, and
 * "off the company network" has to read as offline rather than signed out. What it must not do is
 * run on every mount. The answer is reused for `STATUS_TTL`, and every native event (renewal, login
 * completion, model publication, revocation) drops it — an event is always answered with a fresh
 * request, while ten ordinary visits to the account page cost one.
 */
let cachedStatus: CachedStatus | null = null

/** Clears the shared answer. The hook drops it on every native event; tests call it per case. */
export function resetEnterpriseStatusCache(): void {
  cachedStatus = null
}

/**
 * The single source of truth for "is the enterprise channel signed in".
 *
 * Both the account section and the company provider card read this, so they can never disagree.
 * Detection is event-driven: the native renewal loop emits `enterprise:event` when the token is
 * renewed, expires or needs a fresh login, and model publication / revocation emit their own
 * events. Each one triggers a single fresh read — there is no interval polling and no steady-state
 * focus refresh, so an open settings page neither hammers the account service nor goes stale when
 * the token expires underneath it.
 */
export function useEnterpriseLogin(): EnterpriseLogin & { recheck: () => void } {
  const user = usePlatformAuth((state) => state.user)
  const account = user?.user_uuid ?? null
  const [state, setState] = useState<EnterpriseLogin>(INITIAL)
  const userRef = useRef(user)
  userRef.current = user
  const accountRef = useRef(account)
  accountRef.current = account
  const busyRef = useRef(false)
  const checkRef = useRef<() => void>(() => {})

  const check = useCallback(async () => {
    const account = accountRef.current
    const identity = userRef.current
    if (!account || busyRef.current) return
    busyRef.current = true
    try {
      const native = await commands.enterpriseStatus()
      const renewal = parseEnterpriseRenewal(native)
      const renewalAvailable = renewal.automatic_renewal && !renewal.requires_login
      const email = enterpriseEmail(native)
      // The native layer owns the gateway session since 0.6.5: it is the one that renews the token
      // every few minutes, so its own answer about authorization is the live one. The account
      // service keeps a *record* of the enterprise link, and that record is not written back by a
      // gateway login — after one it still read `enterprise_session_expired` while the gateway
      // session was seconds old, which is how a signed-in account showed 未登录 (2026-11-17).
      const nativeAuthorization = nativeAuthorizationStatus(native)
      void info(
        `[enterprise] native status authorization=${nativeAuthorization ?? "none"} renewal=${renewal.automatic_renewal} requires_login=${renewal.requires_login}`
      )
      // Server confirmation is reused, not re-asked, on a plain mount: a healthy renewal *is* the
      // sign-in signal, and the previous answer is still the account service's word. Anything the
      // account service might have changed arrives as a native event first, and that clears the
      // cache below.
      const reusable = cachedStatus?.account === account && Date.now() - cachedStatus.at < STATUS_TTL
      let status: EnterpriseStatus | null = reusable && cachedStatus ? cachedStatus.status : null
      let error = false
      if (status === null) {
        try {
          const server = await platformApiRequest<EnterpriseStatus>("/api/v1/me/enterprise/finture", "GET")
          if (typeof server.enabled !== "boolean" || typeof server.authorization_status !== "string")
            throw new Error("Invalid enterprise status")
          status = server
          cachedStatus = { account, at: Date.now(), status: server }
        } catch {
          error = true
        }
      }
      if (accountRef.current !== account || usePlatformAuth.getState().user !== identity) return
      setState({
        checking: false,
        // Three things can vouch for the account, in order of freshness:
        //   1. the native layer's own `authorization_status`, which reflects the gateway session it
        //      renews itself — a successful gateway login is proof even while the account service's
        //      record still says the old session expired;
        //   2. the account service answering "authorized";
        //   3. no server answer at all (off the company network is not a sign-out).
        // A stale server record must not revoke a session the native layer is actively renewing;
        // a revocation announced by the service arrives as an event and clears this immediately.
        authorized: enterpriseSignedIn({ nativeAuthorization, renewal, status }),
        renewalAvailable,
        email,
        status,
        renewal,
        error
      })
    } catch {
      if (accountRef.current === account && usePlatformAuth.getState().user === identity)
        setState({ ...INITIAL, checking: false, error: true })
    } finally {
      busyRef.current = false
    }
  }, [])
  checkRef.current = () => void check()

  // A different account starts from a clean slate and checks once. The cache is keyed by account,
  // so a new one misses it naturally — resetting here instead would empty it on every mount and
  // put the request back on every visit to the page.
  useEffect(() => {
    setState(INITIAL)
    void check()
  }, [account, check])

  // One fresh read per relevant event. No timers: expiry, renewal, login completion, model
  // publication and revocation all announce themselves, and each one is itself the reason to ask
  // the account service again instead of reusing the previous answer.
  useEffect(() => {
    if (!account) return
    let active = true
    const recheck = () => {
      if (!active) return
      resetEnterpriseStatusCache()
      checkRef.current()
    }
    // The event bridge may be unavailable (e.g. a webview without the Tauri runtime). A failed
    // subscription degrades to "no live updates" rather than an unhandled rejection; the mount
    // check and explicit recheck still work.
    const noop = () => {}
    const subscribe = (name: string, handler: (event: { payload: unknown }) => void) =>
      listen(name, handler as (event: { payload: Record<string, unknown> }) => void).catch(() => noop)
    const stops = [
      subscribe("enterprise:event", ({ payload }) => {
        const record = payload as Record<string, unknown> | null
        if (record && record.accountId === accountRef.current) recheck()
      }),
      subscribe("enterprise:models-changed", recheck),
      subscribe("providers:managed-revoked", recheck)
    ]
    return () => {
      active = false
      for (const stop of stops) void stop.then((unlisten) => unlisten()).catch(() => {})
    }
  }, [account])

  // The explicit "ask again" path (the retry button, and the step after a sign-out): it must not
  // hand back the answer the reader is retrying away from.
  const recheck = useCallback(() => {
    resetEnterpriseStatusCache()
    checkRef.current()
  }, [])
  // Silent keep-alive. The company gateway rotates its token on its own schedule, and a settings
  // window left open for hours otherwise only learns about it from an event. Re-ask every five
  // minutes while the window is visible — no spinner, no toast, and the 60s answer cache still
  // absorbs anything in between. This is what keeps the enterprise model list alive instead of
  // letting it read as unavailable after a quiet spell.
  useEffect(() => {
    if (!account) return
    const quietCheck = (): void => {
      if (typeof document === "undefined" || document.visibilityState === "visible") checkRef.current()
    }
    const timer = window.setInterval(quietCheck, 5 * 60_000)
    const onVisible = (): void => {
      if (document.visibilityState === "visible") checkRef.current()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [account])

  return { ...state, recheck }
}