import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

export function isMarkdownDocumentPath(path: string): boolean {
  return /\.(md|markdown|mdown|mdx)$/i.test(path)
}

/** One fixed, hidden draft per document; repeated conflicts overwrite it instead of piling versions. */
export function markdownDraftPath(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  const directory = slash >= 0 ? path.slice(0, slash + 1) : ""
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf(".")
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ".md"
  return `${directory}.${stem}.conflict-draft${extension}`
}

export interface MarkdownConflictState {
  path: string
  local: string
  current: string
  version: string
  /** One fixed draft path per document; it is overwritten by the next conflict. */
  draftPath: string
  draftError: string | null
}

export function MarkdownConflictDialog({
  conflict,
  busy,
  error,
  onUseDisk,
  onOverwrite,
  onKeep
}: {
  conflict: MarkdownConflictState | null
  busy: boolean
  error: string | null
  onUseDisk: () => void
  onOverwrite: () => void
  onKeep: () => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={conflict !== null} onOpenChange={(open) => !open && !busy && onKeep()}>
      <DialogContent className="max-w-4xl" data-testid="markdown-save-conflict">
        <DialogHeader>
          <DialogTitle>{t("workspace.markdownSaveConflict")}</DialogTitle>
          <DialogDescription>{t("workspace.markdownSaveConflictDescription")}</DialogDescription>
        </DialogHeader>
        <div className="grid max-h-[55vh] min-h-0 grid-cols-2 gap-3">
          <section className="flex min-h-0 flex-col gap-1.5">
            <h3 className="text-sm font-medium">{t("workspace.markdownLocalDraft")}</h3>
            <pre className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
              {conflict?.local ?? ""}
            </pre>
          </section>
          <section className="flex min-h-0 flex-col gap-1.5">
            <h3 className="text-sm font-medium">{t("workspace.markdownDiskVersion")}</h3>
            <pre className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap">
              {conflict?.current ?? ""}
            </pre>
          </section>
        </div>
        {conflict && (
          <p className="min-h-4 text-xs text-muted-foreground" role="status">
            {conflict.draftError === null
              ? `${t("workspace.markdownDraftCopySaved")}: ${conflict.draftPath}`
              : `${t("workspace.markdownDraftCopyFailed")}: ${conflict.draftError}`}
          </p>
        )}
        <DialogFooter className="flex-wrap">
          <div className="me-auto min-h-4 text-xs text-destructive" role="status">
            {error}
          </div>
          <Button type="button" variant="outline" disabled={busy} onClick={onUseDisk}>
            {t("workspace.markdownUseDiskVersion")}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onOverwrite}>
            {t("workspace.markdownOverwriteDraft")}
          </Button>
          <Button type="button" disabled={busy} onClick={onKeep}>
            {t("workspace.markdownKeepDraft")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
