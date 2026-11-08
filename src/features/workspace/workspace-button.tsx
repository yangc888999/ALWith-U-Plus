import { PanelsTopLeft } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { useWorkspace } from "./context"
export function WorkspaceButton() {
  const workspace = useWorkspace()
  const { t } = useTranslation()
  if (workspace === null) return null
  const bothVisible = workspace.visible && !workspace.viewMode
  const label = t(bothVisible ? "workspace.closeWorkspace" : "workspace.openWorkspace")
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="workspace-sidebar-toggle"
            aria-label={label}
            aria-expanded={workspace.visible}
            aria-controls="file-workspace-panel"
            onClick={workspace.toggle}
          >
            <PanelsTopLeft className="size-4 text-sky-600 dark:text-sky-400" />
          </Button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
