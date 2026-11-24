import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { antigravityAgent, type AgentPermission } from "@/agent/antigravity-agent"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"

/**
 * Approval surface for the native Gemini Agent. Antigravity's ACP permission requests arrive on a
 * DOM event from the client and are answered through the bridge; denying is always available and
 * no option is auto-approved.
 */
export function AntigravityPermissionDialog(): React.JSX.Element {
  const { t } = useTranslation()
  const [permission, setPermission] = useState<AgentPermission | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const listener = (event: Event) => {
      setPermission((event as CustomEvent<AgentPermission>).detail)
      setBusy(false)
    }
    window.addEventListener("antigravity:permission", listener)
    return () => window.removeEventListener("antigravity:permission", listener)
  }, [])

  const answer = async (optionId: string | null) => {
    if (permission === null) return
    setBusy(true)
    try {
      await antigravityAgent.answer(permission.requestId, optionId)
      setPermission(null)
    } catch {
      setBusy(false)
    }
  }

  const deny = permission?.options.find((option) => option.kind === "reject" || /deny|reject/i.test(option.name))
  const allow = permission?.options.find((option) => option.kind !== "reject" && !/deny|reject/i.test(option.name))

  return (
    <Dialog open={permission !== null} onOpenChange={(open) => !open && !busy && void answer(deny?.optionId ?? null)}>
      <DialogContent>
        <DialogTitle>{t("antigravity.permissionTitle", { defaultValue: "Gemini 请求执行操作" })}</DialogTitle>
        <DialogDescription>
          {permission?.title ?? t("antigravity.permissionHint", { defaultValue: "是否允许此操作？" })}
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void answer(deny?.optionId ?? null)}>
            {t("common.cancel", { defaultValue: "拒绝" })}
          </Button>
          {allow !== undefined && (
            <Button disabled={busy} onClick={() => void answer(allow.optionId)}>
              {allow.name}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
