import type { Session } from "@alwith/api"
import { hasRename } from "@nyssance/codex-acp-v2/client"
import { PencilIcon, SearchIcon } from "lucide-react"
import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { ShortcutKey } from "@/components/alwith-ui/shortcut-hint"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { client, useApp } from "@/lib/client"
import { describeError } from "@/lib/error-text"

import { openChatSearch } from "./dialogs/chat-search"

/** Main chat header keeps only the two high-frequency actions. The other session actions stay
 *  reachable from the sidebar row, project popover and title bar; the floating surface keeps its
 *  full overflow menu. */
export function ChatHeaderActions({ session }: { session: Session }) {
  const { t } = useTranslation()
  const canRename = useApp((state) => hasRename(state.agent))
  const connected = useApp((state) => state.connection === "ready")
  const [renameOpen, setRenameOpen] = useState(false)
  const [name, setName] = useState("")
  const [pending, setPending] = useState(false)
  const submitting = useRef(false)
  const renameTrigger = useRef<HTMLButtonElement>(null)
  const canMutate = connected && !session.restoring
  const canSearch = session.items.length > 0

  const submitRename = async (): Promise<void> => {
    if (submitting.current || !name.trim()) return
    submitting.current = true
    setPending(true)
    try {
      await client.renameSession(session.id, name.trim())
      setRenameOpen(false)
    } catch (error) {
      toast.error(describeError(error))
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  return (
    <>
      <TooltipProvider delay={150}>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                ref={renameTrigger}
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("sidebar.rename")}
                title={t("sidebar.rename")}
                disabled={!canRename || !canMutate}
                onClick={() => {
                  setName(session.title ?? "")
                  setRenameOpen(true)
                }}
              />
            }
          >
            <PencilIcon />
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("sidebar.rename")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("chat.search.label")}
                title={t("chat.search.label")}
                disabled={!canSearch}
                onClick={() => openChatSearch(session.id)}
              />
            }
          >
            <SearchIcon />
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <span>{t("chat.search.label")}</span>
            <ShortcutKey shortcut="CmdOrCtrl+F" />
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          if (!open && !submitting.current) setRenameOpen(false)
        }}
      >
        <DialogContent finalFocus={renameTrigger}>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void submitRename()
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("sidebar.rename")}</DialogTitle>
            </DialogHeader>
            <Input
              aria-label={t("sidebar.rename")}
              value={name}
              disabled={pending}
              onChange={(event) => setName(event.target.value)}
              onFocus={(event) => event.target.select()}
            />
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setRenameOpen(false)}>
                {t("actions.cancel")}
              </Button>
              <Button type="submit" disabled={pending || !name.trim()}>
                {t("sidebar.rename")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
