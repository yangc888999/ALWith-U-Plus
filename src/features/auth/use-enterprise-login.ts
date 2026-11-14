import { listen } from "@tauri-apps/api/event"
import { useCallback, useEffect, useRef, useState } from "react"

import { commands } from "@/bindings"

import {
  enterpriseLoginAvailable,
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
  /** Server authorization AND a healthy local renewal: the models are usable right now. */
  authorized: boolean
  /** The local renewal alone is healthy. The cached provider is NOT proof of sign-in: it survives
   *  offline and outlives an expired token, so this — not the provider list — is the sign-in signal. */
  renewalAvailable: boolean
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
      // Server confirmation is best-effort: being off the company network must not look like a
      // sign-out while the local renewal is still healthy.
      let status: EnterpriseStatus | null = null
      let error = false
      try {
        const server = await platformApiRequest<EnterpriseStatus>("/api/v1/me/enterprise/finture", "GET")
        if (typeof server.enabled !== "boolean" || typeof server.authorization_status !== "string")
          throw new Error("Invalid enterprise status")
        status = server
      } catch {
        error = true
      }
      if (accountRef.current !== account || usePlatformAuth.getState().user !== identity) return
      setState({
        checking: false,
        authorized: status !== null && enterpriseLoginAvailable(status, renewal),
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

  const recheck = useCallback(() => checkRef.current(), [])
  return { ...state, recheck }
}