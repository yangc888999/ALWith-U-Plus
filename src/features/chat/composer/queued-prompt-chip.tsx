import type { Session } from "@alwith/api"
import { TimerIcon } from "lucide-react"
import { type ReactNode, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  cancelQueuedPrompt,
  queuedPromptCount,
  queuedPromptText,
  subscribeQueuedPrompts
} from "@/lib/queued-prompt"

/**
 * "排队中…（点击取消）": the visible half of the queued send mode.
 *
 * A queued message is deliberately not put into the timeline until it is actually sent, so
 * without this chip the composer looked stuck for the whole running turn. Clicking it cancels
 * every message waiting on this session; the composer then restores the text into the input.
 */
export function QueuedPromptChip({ session, compact = false }: { session: Session; compact?: boolean }): ReactNode {
  const { t } = useTranslation()
  const count = useSyncExternalStore(
    subscribeQueuedPrompts,
    () => queuedPromptCount(session.id),
    () => 0
  )
  const text = useSyncExternalStore(
    subscribeQueuedPrompts,
    () => queuedPromptText(session.id),
    () => null
  )
  if (count === 0) return null
  return (
    <button
      type="button"
      className="border-border/60 bg-muted/40 text-muted-foreground hover:text-foreground inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
      title={text ?? t("chat.queuePendingHint")}
      onClick={() => {
        cancelQueuedPrompt(session.id)
        toast.info(t("chat.queueCancelled"))
      }}
    >
      <TimerIcon className="size-3 shrink-0" />
      <span className="shrink-0 font-medium">
        {count > 1 ? t("chat.queuePendingCount", { count }) : t("chat.queuePending")}
      </span>
      {!compact && text !== null && <span className="max-w-40 truncate opacity-70">{text}</span>}
      <span className="shrink-0 underline underline-offset-2">{t("chat.queueCancel")}</span>
    </button>
  )
}
