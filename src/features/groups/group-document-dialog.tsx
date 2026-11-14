import { invoke } from "@tauri-apps/api/core"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"

import type { GroupConfig } from "@/lib/groups"

/**
 * The group's own document: the background every member reads before it speaks.
 *
 * It is a plain markdown file in the group's directory, so it can be edited here or with any
 * other editor — the app only writes back what the user changed.
 */
export function GroupDocumentDialog({
  group,
  open,
  onClose
}: {
  group: GroupConfig | null
  open: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState("")
  const [loading, setLoading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)

  useEffect(() => {
    if (!open || group === null) return
    // A late read from the previous group must not overwrite the one being shown now.
    let cancelled = false
    setLoading(true)
    setReadError(null)
    void invoke<string>("group_document_read", { document: group.document })
      .then((value) => {
        if (cancelled) return
        setText(value)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setReadError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, group, retryToken])

  const save = (): void => {
    if (loading || readError) return
    if (group === null) return
    void invoke("group_document_write", { document: group.document, content: text })
      .then(() => {
        toast.success(t("groups.documentSaved"))
        onClose()
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
  }

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("groups.documentTitle", { name: group?.name ?? "" })}</DialogTitle>
          <DialogDescription title={group?.document}>{t("groups.documentHint")}</DialogDescription>
        </DialogHeader>
        {readError !== null ? (
          <p className="h-80 w-full rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {readError}
          </p>
        ) : (
          <textarea
            aria-label={t("groups.documentTitle", { name: group?.name ?? "" })}
            className="h-80 w-full resize-y rounded-md border border-border/70 bg-background p-3 text-sm leading-relaxed"
            value={loading ? "" : text}
            onChange={(event) => setText(event.target.value)}
            disabled={loading}
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("actions.cancel")}
          </Button>
          {readError !== null && (
            <Button variant="outline" onClick={() => setRetryToken((token) => token + 1)}>
              {t("actions.retry")}
            </Button>
          )}
          <Button onClick={save} disabled={loading || readError !== null}>
            {t("groups.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
