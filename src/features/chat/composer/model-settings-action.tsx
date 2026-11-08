import { ChevronRight } from "lucide-react"
import type { ReactElement } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { describeError } from "@/lib/error-text"
import { openSettingsWindow } from "@/lib/window-manager"

/**
 * The footer of the model picker: leave the picker and configure the model list itself.
 *
 * The label used to read "更多模型" while the row opened 设置 → 自定义模型配置, so the promise on
 * screen (show me more models) and the action (take me to a settings form) disagreed — and the
 * external-link icon implied a browser tab on top of that. Both now say the same thing, and the
 * chevron reads as "goes elsewhere in this window", which is what happens.
 */
export function ModelSettingsAction(): ReactElement {
  const { t } = useTranslation()
  const label = t("chat.model.configureModels")
  return (
    <DropdownMenuItem
      className="h-9 gap-2 rounded-md px-2 text-sm font-normal"
      title={label}
      onClick={() => {
        void openSettingsWindow("provider").catch((error: unknown) => {
          toast.error(describeError(error))
        })
      }}
    >
      {label}
      <ChevronRight className="ml-auto size-4" aria-hidden="true" />
    </DropdownMenuItem>
  )
}
