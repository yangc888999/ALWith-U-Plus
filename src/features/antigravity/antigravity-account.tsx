import { isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { format } from "date-fns"
import { RefreshCwIcon } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { commands } from "@/bindings"
import { GoogleMark } from "@/components/icons/google-mark"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { describeError } from "@/lib/error-text"

import { SettingGroup, SettingLabel } from "../settings/sections/shared"
import { UsageLimitRow } from "../settings/sections/usage-limit-row"
import type { AntigravityLimit, AntigravityUsage } from "./usage"

const TIER_KEY = "alwith:antigravity:tier"
const EVENT = "antigravity:event"

type AccountStatus = "checking" | "signedIn" | "signedOut" | "unavailable"
type QuotaSnapshot = { limits: AntigravityLimit[]; capturedAt: number }
type UsageRead = { id: string; timer: ReturnType<typeof setTimeout> }
type AccountEvent =
  | { type: "logged_in"; tier: unknown }
  | { type: "usage"; readId: string; tier?: unknown; usage: AntigravityUsage }
  | { type: "logged_out" | "exit" }
  | { type: "error"; message: string }

function tierName(value: unknown): string | null {
  if (value === null || typeof value !== "object" || !("name" in value)) return null
  return typeof value.name === "string" ? value.name.trim() || null : null
}

function savedTier(): string | null {
  try {
    return tierName(JSON.parse(localStorage.getItem(TIER_KEY) ?? "null"))
  } catch {
    return null
  }
}

function persistTier(name: string | null): void {
  try {
    if (name === null) localStorage.removeItem(TIER_KEY)
    else localStorage.setItem(TIER_KEY, JSON.stringify({ name }))
  } catch {
    return
  }
}

async function send(message: { type: string; methodId?: string; readId?: string }): Promise<void> {
  await commands.antigravitySend({ message: JSON.stringify(message) })
}

export function useAntigravityAccount(supported: boolean) {
  const [status, setStatus] = useState<AccountStatus>("checking")
  const [tier, setTier] = useState(savedTier)
  const [busy, setBusy] = useState(false)
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null)
  const [usageStatus, setUsageStatus] = useState<"idle" | "loading" | AntigravityUsage["status"]>("idle")
  const listener = useRef<Promise<() => void> | null>(null)
  const usageRead = useRef<UsageRead | null>(null)

  const clearRead = useCallback(() => {
    if (usageRead.current !== null) clearTimeout(usageRead.current.timer)
    usageRead.current = null
  }, [])

  const finishRead = useCallback(
    (id: string, usage: AntigravityUsage, name?: unknown) => {
      if (usageRead.current?.id !== id) return
      clearRead()
      const updatedTier = tierName(name)
      if (updatedTier !== null) {
        setTier(updatedTier)
        persistTier(updatedTier)
      }
      setUsageStatus(usage.status)
      if (usage.status === "ready") setQuota({ limits: usage.limits, capturedAt: Date.now() })
      else if (usage.status === "unavailable") setQuota(null)
    },
    [clearRead]
  )

  const refresh = useCallback(async () => {
    if (listener.current === null || usageRead.current !== null) return
    const id = crypto.randomUUID()
    usageRead.current = { id, timer: setTimeout(() => finishRead(id, { status: "error" }), 22_000) }
    setUsageStatus("loading")
    try {
      await listener.current
      await commands.antigravityStart()
      if (usageRead.current?.id === id) await send({ type: "usage", readId: id })
    } catch {
      finishRead(id, { status: "error" })
    }
  }, [finishRead])

  useEffect(() => {
    if (!supported || !isTauri()) {
      setStatus("unavailable")
      return
    }
    let disposed = false
    let sawAuthEvent = false
    const registered = listen<string>(EVENT, (event) => {
      if (disposed) return
      let message: AccountEvent | null
      try {
        message = JSON.parse(event.payload) as AccountEvent | null
      } catch {
        return
      }
      if (message?.type === "logged_in") {
        sawAuthEvent = true
        const name = tierName(message.tier)
        setTier(name)
        persistTier(name)
        setStatus("signedIn")
        setBusy(false)
        clearRead()
        setQuota(null)
        void refresh()
      } else if (message?.type === "logged_out") {
        sawAuthEvent = true
        clearRead()
        setQuota(null)
        setUsageStatus("idle")
        setTier(null)
        persistTier(null)
        setStatus("signedOut")
        setBusy(false)
      } else if (message?.type === "usage") {
        finishRead(message.readId, message.usage, message.tier)
      } else if (message?.type === "error") {
        setBusy(false)
        toast.error(message.message)
      } else if (message?.type === "exit") {
        setBusy(false)
        if (usageRead.current !== null) finishRead(usageRead.current.id, { status: "error" })
      }
    })
    listener.current = registered
    void registered.catch(() => {
      if (!disposed) setStatus("unavailable")
    })
    void registered
      .then(() => commands.antigravityStatus())
      .then((state) => {
        if (disposed || sawAuthEvent) return
        setStatus(state.signedIn ? "signedIn" : "signedOut")
        if (!state.signedIn) {
          setTier(null)
          persistTier(null)
        }
      })
      .catch(() => {
        if (!disposed && !sawAuthEvent) setStatus("unavailable")
      })
    return () => {
      disposed = true
      clearRead()
      listener.current = null
      void registered.then((stop) => stop()).catch(() => {})
    }
  }, [supported, clearRead, finishRead, refresh])

  const authenticate = async (type: "login" | "logout"): Promise<void> => {
    if (listener.current === null) return
    setBusy(true)
    try {
      await listener.current
      await commands.antigravityStart()
      await send(type === "login" ? { type, methodId: "oauth-personal" } : { type })
    } catch (error) {
      setBusy(false)
      toast.error(describeError(error))
    }
  }

  return { status, tier, busy, quota, usageStatus, refresh, authenticate }
}

export function AntigravityAccountSection({ account }: { account: ReturnType<typeof useAntigravityAccount> }) {
  const { t, i18n } = useTranslation()
  const { status, tier, busy, quota, usageStatus, refresh, authenticate } = account
  const groups = new Map<string | null, AntigravityLimit[]>()
  for (const limit of quota?.limits ?? []) {
    const existing = groups.get(limit.group)
    if (existing === undefined) groups.set(limit.group, [limit])
    else existing.push(limit)
  }
  const signedIn = status === "signedIn"
  const refreshing = usageStatus === "loading"
  return (
    <SettingGroup>
      <SettingLabel>{t("antigravity.settingsTitle")}</SettingLabel>
      <section
        aria-label={t("antigravity.settingsAccount")}
        aria-busy={status === "checking"}
        className="space-y-4 rounded-xl border p-4"
      >
        <div className="flex min-h-8 items-center justify-between gap-4">
          {status === "checking" ? (
            <Skeleton className="h-4 w-40 max-w-[65%] motion-reduce:animate-none" />
          ) : (
            <span className="flex min-w-0 items-center gap-2 text-sm">
              <GoogleMark className="size-4 shrink-0 text-[9px]" />
              <span className="min-w-0 wrap-break-word">
                {signedIn
                  ? [t("antigravity.settingsSignedIn"), tier].filter(Boolean).join(" · ")
                  : t(status === "unavailable" ? "usage.accountUnavailable" : "usage.notSignedIn")}
              </span>
            </span>
          )}
          {status === "checking" ? (
            <Skeleton className="h-8 w-16 shrink-0 motion-reduce:animate-none" />
          ) : (
            status !== "unavailable" && (
              <Button
                type="button"
                variant={signedIn ? "outline" : "default"}
                size="sm"
                className="shrink-0"
                disabled={busy}
                onClick={() => void authenticate(signedIn ? "logout" : "login")}
              >
                {busy && <Spinner data-icon="inline-start" />}
                {t(signedIn ? "connection.signOut" : busy ? "antigravity.waitingLogin" : "antigravity.connect")}
              </Button>
            )
          )}
        </div>
        {status === "signedOut" && (
          <p className="text-xs text-muted-foreground">{t("antigravity.settingsAccountHint")}</p>
        )}
        {signedIn && (
          <div className="space-y-3" aria-busy={refreshing}>
            <h3 className="text-sm font-medium">{t("usage.title")}</h3>
            {[...groups].map(([label, limits]) => (
              <div className="space-y-2" key={label ?? "quota"}>
                {label !== null && <h4 className="text-xs font-medium text-muted-foreground">{label}</h4>}
                {limits.map((limit, index) => (
                  <div key={`${limit.label}:${index}`}>
                    {"remainingPercent" in limit ? (
                      <UsageLimitRow label={limit.label} limit={limit} showUsed />
                    ) : (
                      <div className="space-y-1 text-sm">
                        <div className="flex justify-between gap-3">
                          <span>{limit.label}</span>
                          <span className="text-end text-xs text-muted-foreground tabular-nums">
                            {t("antigravity.usageRemainingUnits", {
                              amount: limit.remainingUnits.toLocaleString(i18n.language)
                            })}
                          </span>
                        </div>
                        {limit.resetsAt !== null && (
                          <p className="text-end text-xs text-muted-foreground">
                            {t("usage.resetsAt", { time: format(new Date(limit.resetsAt), "yyyy/MM/dd HH:mm") })}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {quota === null &&
              (refreshing ? (
                <UsageLimitRow />
              ) : (
                <p className="text-sm text-muted-foreground" role="status">
                  {t(
                    usageStatus === "error"
                      ? "antigravity.usageError"
                      : usageStatus === "unavailable"
                        ? "antigravity.usageUnavailable"
                        : "antigravity.usagePrompt"
                  )}
                </p>
              ))}
            <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
              {quota === null ? (
                <span />
              ) : (
                <p className="text-[11px] text-muted-foreground" role="status">
                  {t(usageStatus === "error" ? "usage.staleLimits" : "usage.lastUpdated", {
                    time: format(new Date(quota.capturedAt), "yyyy/MM/dd HH:mm")
                  })}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={refreshing || busy}
                onClick={() => void refresh()}
              >
                <RefreshCwIcon className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden="true" />
                {t("usageReport.resetCardRefresh")}
              </Button>
            </div>
          </div>
        )}
      </section>
    </SettingGroup>
  )
}
