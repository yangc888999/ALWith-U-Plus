import { PanelsTopLeft } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { useWorkspace } from "./context"
export function WorkspaceButton() {
  const workspace = useWorkspace()
  const { t } = useTranslation()
  if (workspace === null) return null
  // `visible` alone used to claim the four columns were open while `workspace`/`cwd` were still
  // null — the button looked selected over a two-column layout. Optional for the test contexts that
  // build `WorkspaceActions` by hand; those surfaces always have a ready directory.
  const ready = workspace.directoryReady ?? true
  // View mode (maximised preview) is a restore action, not a close action, so its label stays the
  // "open" one; only the selected state follows the real columns.
  const bothVisible = workspace.visible && ready && !workspace.viewMode
  const expanded = workspace.visible && ready
  const label = t(bothVisible ? "workspace.closeWorkspace" : "workspace.openWorkspace")
  const onClick = (): void => {
    if (!ready && workspace.showProjectTree !== undefined) {
      workspace.showProjectTree()
      return
    }
    workspace.toggle()
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="workspace-sidebar-toggle"
            aria-label={label}
            aria-expanded={expanded}
            aria-controls="file-workspace-panel"
            onClick={onClick}
          >
            <PanelsTopLeft className="size-4 text-sky-600 dark:text-sky-400" />
          </Button>
        }
      />
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
