import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { antigravityAgent, type AgentPermission } from "@/agent/antigravity-agent"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog"

/**
 * Approval surface for the native Gemini Agent.
 *
 * ACP asks for permission once per tool call, so several requests can queue up while the user is
 * deciding. They are kept in a queue: replacing the single visible request with the newest one left
 * the earlier requests unanswered forever, which stalled the whole turn (the agent waits on the
 * ACP request until it is answered).
 */
export function AntigravityPermissionDialog(): React.JSX.Element {
  const { t } = useTranslation()
  const [queue, setQueue] = useState<AgentPermission[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const listener = (event: Event) => {
      const permission = (event as CustomEvent<AgentPermission>).detail
      setQueue((current) =>
        current.some((entry) => entry.permissionId === permission.permissionId) ? current : [...current, permission]
      )
      setBusy(false)
    }
    window.addEventListener("antigravity:permission", listener)
    return () => window.removeEventListener("antigravity:permission", listener)
  }, [])

  const permission = queue[0] ?? null

  const answer = async (optionId: string | null) => {
    if (permission === null) return
    setBusy(true)
    try {
      await antigravityAgent.answer(permission.requestId, permission.permissionId, optionId)
      setQueue((current) => current.slice(1))
    } catch {
      // A failed answer must not strand the request: drop it so the next one can be shown.
      setQueue((current) => current.slice(1))
    } finally {
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