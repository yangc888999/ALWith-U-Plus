import { type ReactNode, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"

import {
  getQueueSendMode,
  type QueueSendMode,
  setQueueSendMode,
  subscribeChatDisplayPreferences
} from "@/lib/chat-display-preferences"
import { cn } from "@/lib/utils"

/**
 * The compact 插话 / 排队 switch in the conversation header.
 *
 * The full description stays in Settings → General. Here the two short labels are enough: the
 * control sits beside the title so it stays visible in the four-column layout without taking a
 * row from the composer.
 */
export function SendModeSwitch(): ReactNode {
  const { t } = useTranslation()
  const mode = useSyncExternalStore(subscribeChatDisplayPreferences, getQueueSendMode, getQueueSendMode)
  const options: Array<{ value: QueueSendMode; label: string; hint: string }> = [
    {
      value: "immediate",
      label: t("chat.sendModeInterject"),
      hint: t("chat.sendModeInterjectHint")
    },
    {
      value: "queued",
      label: t("chat.sendModeQueue"),
      hint: t("chat.sendModeQueueHint")
    }
  ]
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 bg-muted/35 p-0.5"
      role="group"
      aria-label={t("chat.sendModeGroup")}
      data-send-mode-switch=""
    >
      {options.map((option) => {
        const active = mode === option.value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            title={option.hint}
            onClick={() => setQueueSendMode(option.value)}
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] leading-4 transition-colors",
              active
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
