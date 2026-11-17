import { listen } from "@tauri-apps/api/event"
import { info } from "@tauri-apps/plugin-log"
import { useCallback, useEffect, useRef, useState } from "react"

import { commands } from "@/bindings"

import { logEnterpriseError } from "./enterprise-diagnostics"
import {
  enterpriseSignedIn,
  nativeEnterpriseStatus,
  parseEnterpriseRenewal,
  type EnterpriseRenewal,
  type EnterpriseStatus
} from "./enterprise-status"
import { usePlatformAuth } from "./store"

export interface EnterpriseLogin {
  /** True only while the very first check is in flight. */
  checking: boolean
  /** The native layer's verdict: automatic renewal is healthy and the gateway session it owns is
   *  authorized. The account service is not consulted — see `enterpriseSignedIn`. */
  authorized: boolean
  /** The local renewal alone is healthy. The cached provider is NOT proof of sign-in: it survives
   *  offline and outlives an expired token, so this — not the provider list — is the sign-in signal. */
  renewalAvailable: boolean
  /** The signed-in address, read from the native status so it survives without a server answer. */
  email: string | null
  status: EnterpriseStatus | null
  renewal: EnterpriseRenewal | null
  /** The native status could not be read at all (engine not ready, or the call failed). */
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

/**
 * The single source of truth for "is the enterprise channel signed in".
 *
 * Both the account section and the company provider card read this, so they can never disagree.
 * Detection is event-driven: the native renewal loop emits `enterprise:event` when the token is
 * renewed, expires or needs a fresh login, and model publication / revocation emit their own
 * events. Each one triggers a single fresh read — there is no interval polling and no steady-state
 * focus refresh, so an open settings page neither hammers the account service nor goes stale when
 * the token expires underneath it.
 *
 * The read itself is local: `enterprise_status` answers from the gateway session the native layer
 * holds, and caches its own healthy answer for a short while. Nothing here goes over the network,
 * which is also why there is no cross-mount cache to invalidate.
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
  /** The last failure we logged, so a five-minute keep-alive cannot repeat it. */
  const lastFailureRef = useRef<string | null>(null)

  const check = useCallback(async () => {
    const account = accountRef.current
    const identity = userRef.current
    if (!account || busyRef.current) return
    busyRef.current = true
    try {
      const native = await commands.enterpriseStatus()
      const renewal = parseEnterpriseRenewal(native)
      const status = nativeEnterpriseStatus(native)
      const renewalAvailable = renewal.automatic_renewal && !renewal.requires_login
      void info(
        `[enterprise] native status authorization=${status.authorization_status ?? "none"} enabled=${
          status.enabled === null ? "unset" : status.enabled
        } renewal=${renewal.automatic_renewal} requires_login=${renewal.requires_login}`
      )
      lastFailureRef.current = null
      if (accountRef.current !== account || usePlatformAuth.getState().user !== identity) return
      setState({
        checking: false,
        authorized: enterpriseSignedIn({ native: status, renewal }),
        renewalAvailable,
        email: status.email,
        status,
        renewal,
        error: false
      })
    } catch (reason) {
      // A failed *read* is not a sign-out: keep the last known answer instead of flashing 未登录
      // every time the engine is briefly unavailable, and leave one trace per distinct failure.
      const failure = reason instanceof Error ? reason.message : String(reason)
      if (lastFailureRef.current !== failure) {
        lastFailureRef.current = failure
        logEnterpriseError("settings-status", reason)
      }
      if (accountRef.current === account && usePlatformAuth.getState().user === identity)
        setState((previous) => ({ ...previous, checking: false, error: true }))
    } finally {
      busyRef.current = false
    }
  }, [])
  checkRef.current = () => void check()

  // A different account starts from a clean slate and checks once.
  useEffect(() => {
    setState(INITIAL)
    void check()
  }, [account, check])

  // One fresh read per relevant event. No timers: expiry, renewal, login completion, model
  // publication and revocation all announce themselves.
  useEffect(() => {
    if (!account) return
    let active = true
    const recheck = () => {
      if (active) checkRef.current()
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

  // The explicit "ask again" path (the retry button, and the step after a sign-out).
  const recheck = useCallback(() => {
    checkRef.current()
  }, [])
  // Silent keep-alive. The company gateway rotates its token on its own schedule, and a settings
  // window left open for hours otherwise only learns about it from an event. Re-ask every five
  // minutes while the window is visible — no spinner, no toast. This is what keeps the enterprise
  // model list alive instead of letting it read as unavailable after a quiet spell.
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
