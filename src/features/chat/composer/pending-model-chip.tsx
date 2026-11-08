import type { Session } from "@alwith/api"
import { ZapIcon } from "lucide-react"
import { useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"

import { isGroupedSelect, isSelectOption } from "@alwith/api"

import { client } from "@/lib/client"

/**
 * Shows a model chosen while the turn was still running.
 *
 * The agent keeps the previous provider until the turn settles, so the picker still displays the
 * old model; without this chip the choice would look ignored. Clicking it applies the choice at
 * once — that ends the running answer, which is the trade the user is making when they pick a
 * different model in the middle of one.
 */
export function PendingModelChip({ session }: { session: Session }): React.ReactNode {
  const { t } = useTranslation()
  const pending = useSyncExternalStore(
    client.onPendingModelChange.bind(client),
    () => client.pendingModelFor(session.id),
    () => client.pendingModelFor(session.id)
  )
  if (pending === null) return null
  const option = session.configOptions.find((entry) => entry.category === "model" && entry.type === "select")
  const choices =
    option !== undefined && isSelectOption(option)
      ? isGroupedSelect(option.options)
        ? option.options.flatMap((group) => group.options)
        : option.options
      : []
  const label = choices.find((choice) => choice.value === pending)?.name ?? pending
  return (
    <button
      type="button"
      className="bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors"
      role="status"
      title={t("chat.pendingModelHint")}
      aria-label={`${t("chat.pendingModel", { model: label })} — ${t("chat.pendingModelApplyNow")}`}
      onClick={() => void client.applyPendingModelNow(session.id)}
    >
      <ZapIcon className="size-3 shrink-0" aria-hidden="true" />
      <span>{label}</span>
      <span className="rounded bg-primary/15 px-1 text-[10px] font-semibold leading-tight text-primary">
        {t("chat.pendingModelBadge")}
      </span>
    </button>
  )
}
