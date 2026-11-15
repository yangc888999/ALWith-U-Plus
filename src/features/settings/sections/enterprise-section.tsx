import { listen } from "@tauri-apps/api/event"
import { Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { commands } from "@/bindings"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { useEnterpriseLogin } from "@/features/auth/use-enterprise-login"
import { requestAccountProviderRefresh, usePlatformAuth } from "@/features/auth/store"
import { openExternal } from "@/lib/open"

import { SettingGroup, SettingRow } from "./shared"

function enterpriseGeneration(value: unknown): number {
  if (typeof value !== "object" || value === null || !("generation" in value) || typeof value.generation !== "number")
    throw new Error("Enterprise account is not ready")
  return value.generation
}
export function EnterpriseSection() {
  const { t } = useTranslation()
  const user = usePlatformAuth((state) => state.user)
  const account = user?.user_uuid
  // Sign-in detection is shared with the company provider card: one event-driven source of truth,
  // so the two can never disagree and an expired token is noticed without any interval polling.
  const login = useEnterpriseLogin()
  const { status, renewal, error, authorized, email, recheck } = login
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [pending, setPending] = useState<{ state: string; generation: number } | null>(null)

  // A different account starts from clean controls: an in-flight login for the old account must
  // not keep the new account's buttons disabled (its `finally` no longer matches the identity).
  useEffect(() => {
    setBusy(false)
    setConfirm(false)
    setPending(null)
  }, [account])

  // A completed authorization (success or failure) releases the pending login. The shared hook
  // re-reads the status on the same event; this only clears the local "waiting for the browser"
  // state so the controls unlock either way.
  useEffect(() => {
    if (!pending || !account) return
    let active = true
    const stop = listen<Record<string, unknown>>("enterprise:event", ({ payload }) => {
      if (
        !active ||
        payload.type !== "enterpriseLoginCompleted" ||
        payload.accountId !== account ||
        payload.generation !== pending.generation
      )
        return
      setPending(null)
    })
    void stop.catch(() => {})
    return () => {
      active = false
      void stop.then((unlisten) => unlisten()).catch(() => {})
    }
  }, [account, pending])

  // Once the channel is authorized there is nothing left to wait for.
  useEffect(() => {
    if (authorized) setPending(null)
  }, [authorized])

  async function run(action: "login" | "logout" | "cancel") {
    const identity = usePlatformAuth.getState().user
    const current = () => usePlatformAuth.getState().user === identity
    setBusy(true)
    try {
      if (action === "login") {
        await requestAccountProviderRefresh()
        if (!current()) return
        const fresh = await commands.enterpriseStatus()
        if (!current()) return
        const generation = enterpriseGeneration(fresh)
        const result = await commands.enterpriseBegin({ generation })
        if (
          typeof result !== "object" ||
          result === null ||
          Array.isArray(result) ||
          typeof result.authorization_url !== "string" ||
          typeof result.state !== "string"
        )
          throw new Error("Invalid enterprise login response")
        if (!current()) return
        setPending({ state: result.state, generation })
        await openExternal(result.authorization_url)
      } else if (action === "cancel") {
        if (!current()) return
        if (pending !== null) await commands.enterpriseCancel({ generation: pending.generation, state: pending.state })
        setPending(null)
      } else {
        const fresh = await commands.enterpriseStatus()
        if (!current()) return
        await commands.enterpriseLogout({ generation: enterpriseGeneration(fresh) })
        if (!current()) return
        setConfirm(false)
        recheck()
      }
    } catch {
      // The shared hook surfaces status errors; a failed action just stops the spinner.
    } finally {
      if (current()) setBusy(false)
    }
  }
  // A healthy renewal is a known state even when the account service cannot be reached, so it is
  // answered first: "unknown" belongs to the case where nothing can vouch for the account.
  const label = authorized
    ? // The service is not asked on every visit, so the signed-in address comes from the native
      // status when there is no server answer to read it from.
      (status?.email ?? email ?? t("enterprise.authorized"))
    : error
      ? t("enterprise.unknown")
      : pending !== null
        ? t("enterprise.pending")
        : login.checking || status === null
          ? t("enterprise.checking")
          : !status.enabled
            ? t("enterprise.disabled")
            : t("enterprise.signedOut")
  return (
    <SettingGroup>
      <SettingRow title={t("enterprise.title")} desc={label}>
        <div className="flex gap-2">
          {pending !== null ? (
            <Button variant="outline" disabled={busy} onClick={() => void run("cancel")}>
              {t("enterprise.cancel")}
            </Button>
          ) : (
            <Button
              variant="outline"
              // 授权检查还没拿到结果时先别让点：那一刻 generation 可能尚未绑定，点了也只会失败。
              disabled={busy || !account || login.checking || status?.enabled === false}
              onClick={() => (authorized ? setConfirm(true) : void run("login"))}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t(authorized ? "enterprise.logout" : "enterprise.login")}
            </Button>
          )}
          {error && (
            <Button variant="outline" disabled={busy} onClick={() => recheck()}>
              {t("actions.retry")}
            </Button>
          )}
        </div>
      </SettingRow>
      {authorized && <p className="mt-2 mb-3 min-w-0 max-w-full break-words px-1 text-xs leading-5 text-muted-foreground">{t("enterprise.accountHint")}</p>}
      {(error || renewal?.error) && (
        <p role="alert" className="mb-3 min-w-0 max-w-full break-words px-1 pt-1.5 text-sm leading-5 text-destructive">
          {t("enterprise.error")}
        </p>
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("enterprise.logout")}</DialogTitle>
            <DialogDescription>{t("enterprise.logoutHint")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>
              {t("enterprise.cancel")}
            </Button>
            <Button disabled={busy} onClick={() => void run("logout")}>
              {t("enterprise.logout")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingGroup>
  )
}