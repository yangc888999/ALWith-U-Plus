import { isTauri } from "@tauri-apps/api/core"
import { ExternalLinkIcon, LoaderCircleIcon, RefreshCwIcon } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { commands, type LarkAuthLogin } from "@/bindings"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { formatCountdown } from "@/lib/format-countdown"
import { openExternal } from "@/lib/open"

/** The one scope that lets lark-cli post a message as the signed-in person. */
const LARK_SEND_AS_USER_SCOPE = "im:message.send_as_user"

type Phase = "checking" | "waiting" | "failed" | "expired"

/**
 * Permission gate for the "use user identity" switch.
 *
 * Opening the switch checks the scopes already held by lark-cli. A missing scope starts the same
 * device-code flow the component settings page uses. Closing this dialog never grants anything and
 * leaves the task on the bot identity.
 */
export function LarkUserPermissionDialog({
  open,
  onOpenChange,
  onGranted,
  onOpenExtensions
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onGranted: () => void
  onOpenExtensions?: () => void
}) {
  const { t } = useTranslation()
  const grantedRef = useRef(onGranted)
  grantedRef.current = onGranted
  const closeRef = useRef(onOpenChange)
  closeRef.current = onOpenChange
  const [phase, setPhase] = useState<Phase>("checking")
  const [login, setLogin] = useState<LarkAuthLogin | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!open) return
    let alive = true
    setPhase("checking")
    setLogin(null)
    setError(null)
    setRemaining(null)
    void (async () => {
      try {
        if (!isTauri()) throw new Error(t("automation.larkUserPermissionDesktopOnly"))
        const status = await commands.larkCliAuthStatus()
        const user = status.identities.find(
          (identity) =>
            identity.kind === "user" &&
            identity.available &&
            identity.status === "ready" &&
            identity.scopes.includes(LARK_SEND_AS_USER_SCOPE)
        )
        if (!alive) return
        if (user !== undefined) {
          grantedRef.current()
          closeRef.current(false)
          return
        }
        const started = await commands.larkCliAuthLogin({ scopes: [LARK_SEND_AS_USER_SCOPE] })
        if (!alive) return
        setLogin(started)
        setRemaining(started.expiresIn ?? 600)
        setPhase("waiting")
        const result = await commands.larkCliAuthComplete({ deviceCode: started.deviceCode })
        if (!alive) return
        if (result.ok) {
          grantedRef.current()
          closeRef.current(false)
        } else {
          setError(result.message || t("automation.larkUserPermissionFailedShort"))
          setPhase("failed")
        }
      } catch (cause) {
        if (alive) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setPhase("failed")
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [open, attempt, t])

  useEffect(() => {
    if (phase !== "waiting") return
    const timer = window.setInterval(() => {
      setRemaining((value) => (value === null ? null : Math.max(0, value - 1)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [phase])

  useEffect(() => {
    if (phase === "waiting" && remaining === 0) {
      setLogin(null)
      setPhase("expired")
    }
  }, [phase, remaining])

  const retry = (): void => setAttempt((value) => value + 1)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" data-testid="lark-user-permission">
        <DialogHeader>
          <DialogTitle>{t("automation.larkUserPermissionTitle")}</DialogTitle>
          <DialogDescription>{t("automation.larkUserPermissionDesc")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          {phase === "checking" && (
            <div className="flex h-[208px] items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
              <Spinner />
              {t("automation.larkUserPermissionChecking")}
            </div>
          )}
          {phase === "waiting" && login !== null && (
            <>
              <p className="text-center text-xs leading-5 text-muted-foreground">
                {t("automation.larkUserPermissionWaiting")}
              </p>
              <div className="rounded-lg bg-white p-3">
                <QRCodeSVG value={login.verificationUrl} size={184} level="M" bgColor="#ffffff" fgColor="#000000" />
              </div>
              {login.userCode && (
                <div className="text-center text-xs text-muted-foreground">
                  {t("automation.larkUserPermissionUserCode")}：<span className="font-mono">{login.userCode}</span>
                </div>
              )}
              {remaining !== null && (
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {formatCountdown(remaining)}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => void openExternal(login.verificationUrl).catch(() => undefined)}
              >
                <ExternalLinkIcon className="size-3.5" />
                {t("automation.larkUserPermissionOpenLink")}
              </Button>
            </>
          )}
          {(phase === "failed" || phase === "expired") && (
            <div className="flex min-h-[208px] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-4 text-center">
              <LoaderCircleIcon className="size-6 text-muted-foreground" />
              <p className="text-xs leading-5 text-muted-foreground">
                {phase === "expired"
                  ? t("automation.larkUserPermissionExpired")
                  : t("automation.larkUserPermissionFailed", { message: error ?? "" })}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={retry}>
                  <RefreshCwIcon className="size-3.5" />
                  {t("automation.larkUserPermissionRefresh")}
                </Button>
                {onOpenExtensions !== undefined && (
                  <Button variant="outline" size="sm" onClick={onOpenExtensions}>
                    {t("automation.larkUserPermissionOpenSettings")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("automation.larkUserPermissionClose")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
