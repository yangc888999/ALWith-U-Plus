import { type ReactNode, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
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
  const options: Array<{ value: QueueSendMode; label: string; hint: string; selectedColor: string }> = [
    {
      value: "immediate",
      label: t("chat.sendModeInterject"),
      hint: t("chat.sendModeInterjectHint"),
      selectedColor: "bg-send-interject hover:bg-send-interject"
    },
    {
      value: "queued",
      label: t("chat.sendModeQueue"),
      hint: t("chat.sendModeQueueHint"),
      selectedColor: "bg-send-queue hover:bg-send-queue"
    }
  ]
  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 bg-muted p-0.5"
      role="group"
      aria-label={t("chat.sendModeGroup")}
      data-send-mode-switch=""
    >
      {options.map((option) => {
        const active = mode === option.value
        return (
          <Button
            key={option.value}
            type="button"
            size="xs"
            variant={active ? "default" : "ghost"}
            aria-pressed={active}
            title={option.hint}
            onClick={() => setQueueSendMode(option.value)}
            className={cn(
              "min-w-6 rounded px-1.5 transition-none focus-visible:z-10",
              active ? "underline underline-offset-2" : "hover:bg-foreground/8 dark:hover:bg-foreground/8",
              active && option.selectedColor
            )}
          >
            {option.label}
          </Button>
        )
      })}
    </div>
  )
}
