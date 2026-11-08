import { setComposerDraft } from "@alwith/module-chat/conversation"
import { BookOpenIcon, ShrinkIcon, EraserIcon } from "lucide-react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { describeError } from "@/lib/error-text"
import { cn } from "@/lib/utils"

/**
 * Two independent actions docked to the chat column's trailing edge.
 *
 * Collapsed, each one is a 36px circle sitting flush against the edge so it never covers the
 * conversation. Hovering (or focusing) only that circle stretches it into a pill and reveals
 * its label — the two never move together, so pointing at one never disturbs the other.
 * They live outside the conversation header so a fresh draft, which has no session and
 * therefore no actions menu, still offers both.
 */
function EdgeAction({
  icon,
  label,
  onClick,
  destructive
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  destructive?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "group pointer-events-auto flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden",
        "rounded-full border border-border/70 bg-popover/95 text-foreground shadow-lg shadow-black/10 backdrop-blur-sm",
        "transition-[width,padding,color] duration-200 ease-out",
        "hover:w-44 hover:justify-start hover:gap-2 hover:px-3",
        "focus-visible:w-44 focus-visible:justify-start focus-visible:gap-2 focus-visible:px-3",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        destructive && "hover:text-destructive focus-visible:text-destructive"
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="max-w-0 overflow-hidden whitespace-nowrap text-xs opacity-0 transition-all duration-200 group-hover:max-w-[9rem] group-hover:opacity-100 group-focus-visible:max-w-[9rem] group-focus-visible:opacity-100">
        {label}
      </span>
    </button>
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
  const runMemoryPrompt = (): void => {
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
  }
  return (
    <div className="pointer-events-none absolute inset-y-0 end-0 z-20 flex flex-col items-end justify-center gap-2 pe-1.5">
      <EdgeAction icon={<BookOpenIcon className="size-4" />} label={t("chat.readMemory")} onClick={runMemoryPrompt} />
      {onCompressMemory !== undefined && (
        <EdgeAction
          icon={<ShrinkIcon className="size-4" />}
          label={t("chat.compressMemory")}
          onClick={onCompressMemory}
        />
      )}
      {onClearContext !== undefined && (
        <EdgeAction
          icon={<EraserIcon className="size-4" />}
          label={t("chat.clearContext")}
          onClick={onClearContext}
          destructive
        />
      )}
    </div>
  )
}
