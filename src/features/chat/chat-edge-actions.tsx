import { setComposerDraft } from "@alwith/module-chat/conversation"
import { BookOpenIcon, ShrinkIcon, EraserIcon } from "lucide-react"
import { type ReactNode, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { describeError } from "@/lib/error-text"
import { cn } from "@/lib/utils"

/** The one memory prompt implementation shared by the edge dock and the composer header. */
function useMemoryPrompt(
  sessionId: string,
  onSend?: (text: string) => void | Promise<unknown>
): () => void {
  const { t } = useTranslation()
  return useCallback(() => {
    const text = t("chat.memoryPrompt")
    if (onSend !== undefined) {
      void Promise.resolve()
        .then(() => onSend(text))
        .catch((error: unknown) => toast.error(describeError(error)))
      return
    }
    try {
      setComposerDraft(sessionId, text)
    } catch (error) {
      toast.error(describeError(error))
    }
  }, [onSend, sessionId, t])
}

/**
 * Compact memory action for the composer's top-right corner.
 *
 * A fresh Work draft has only one memory action. Docking it to the conversation column's edge left
 * a lone circle far from the project chip that gives it meaning. This version sits in the
 * composer header, aligned with that chip; the full edge dock remains for live conversations with
 * read/compress/clear.
 */
export function ChatMemoryButton({
  sessionId,
  onSend,
  className
}: {
  sessionId: string
  onSend?: (text: string) => void | Promise<unknown>
  className?: string
}): ReactNode {
  const { t } = useTranslation()
  const runMemoryPrompt = useMemoryPrompt(sessionId, onSend)
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className={cn(
        "h-8 shrink-0 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground",
        className
      )}
      aria-label={t("chat.readMemory")}
      title={t("chat.readMemory")}
      onClick={runMemoryPrompt}
    >
      <BookOpenIcon className="size-4" aria-hidden="true" />
      {t("chat.readMemory")}
    </Button>
  )
}

export function ChatEdgeActions({
  sessionId,
  onClearContext,
  onCompressMemory,
  onSend
}: {
  /** The active session id, or the draft owner id ("draft"). */
  sessionId: string
  onClearContext?: () => void
  /** Archives the project memory into `history.md` and asks the agent to compress `memory.md`. */
  onCompressMemory?: () => void
  /**
   * Sends the prompt straight away. The host owns the real send path: a live session can prompt
   * immediately, while a draft has to let its session materialise first — sending into a session
   * that was never opened is exactly what produced "The session's composer is not open".
   * Without this the text only lands in the composer for the user to press Enter.
   */
  onSend?: (text: string) => void | Promise<unknown>
}): ReactNode {
  const { t } = useTranslation()
  const runMemoryPrompt = useMemoryPrompt(sessionId, onSend)
  return (
    <div className="pointer-events-none absolute inset-y-0 end-0 z-20 flex flex-col items-end justify-center pe-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={t("chat.projectMemory")}
              title={t("chat.projectMemory")}
              className={cn(
                "group pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden",
                "rounded-full border border-border/70 bg-popover/95 text-foreground shadow-lg shadow-black/10 backdrop-blur-sm",
                "transition-[width,padding,color] duration-200 ease-out",
                "hover:w-44 hover:justify-start hover:gap-2 hover:px-3",
                "focus-visible:w-44 focus-visible:justify-start focus-visible:gap-2 focus-visible:px-3",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              )}
            />
          }
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            <BookOpenIcon className="size-4" />
          </span>
          <span className="max-w-0 overflow-hidden whitespace-nowrap text-xs opacity-0 transition-all duration-200 group-hover:max-w-[9rem] group-hover:opacity-100 group-focus-visible:max-w-[9rem] group-focus-visible:opacity-100">
            {t("chat.projectMemory")}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="left" align="end" className="w-48">
          <DropdownMenuItem onClick={runMemoryPrompt}>
            <BookOpenIcon />
            {t("chat.readMemory")}
          </DropdownMenuItem>
          {onCompressMemory !== undefined && (
            <DropdownMenuItem onClick={onCompressMemory}>
              <ShrinkIcon />
              {t("chat.compressMemory")}
            </DropdownMenuItem>
          )}
          {onClearContext !== undefined && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onClearContext}>
                <EraserIcon />
                {t("chat.clearContext")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
