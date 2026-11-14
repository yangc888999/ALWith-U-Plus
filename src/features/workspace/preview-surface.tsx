import { Allotment, type AllotmentHandle, LayoutPriority } from "allotment"
import { FolderTree, Maximize2, Minimize2, X } from "lucide-react"
import { type ReactNode, useContext, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import "allotment/dist/style.css"
import { resolveRatioToPixels, saveWorkspaceLayout } from "./layout-preferences"
import { PanelControlsContext } from "./panel-controls-context"
import { useWorkspaceLayout } from "./use-workspace-layout"

// Desktop's PreviewSurface preserves the tree's pixel width and gives the editor spare space.
export function PreviewSurface({
  tree,
  editor,
  treeVisible,
  onTreeVisibleChange,
  onShowProjectTree,
  maximized,
  onMaximize,
  onClose
}: {
  tree: ReactNode
  editor: (controls: { leading: ReactNode; trailing: ReactNode }) => ReactNode
  treeVisible: boolean
  onTreeVisibleChange: (visible: boolean) => void
  /**
   * The collapsed-state FolderTree must run the same `showProjectTree()` action as 四方格 and the
   * header toggle: it has to ensure/open the workspace, not just flip a flag no column is rendering.
   * Optional so the standalone layout test can still drive the tree pane directly.
   */
  onShowProjectTree?: () => void
  maximized: boolean
  onMaximize: () => void
  onClose: () => void
}): ReactNode {
  const { t } = useTranslation()
  const controls = useContext(PanelControlsContext)
  const expanded = controls?.expanded ?? maximized
  const { treeRatio, previewRatio } = useWorkspaceLayout()
  const root = useRef<HTMLDivElement | null>(null)
  const allotment = useRef<AllotmentHandle | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const appliedTreePx = useRef(0)
  // The tree and the preview content split this container, so resolve the tree's share of the
  // pair against the live preview width and keep it proportional when the window resizes.
  const withinPreview = treeRatio + previewRatio
  const treeOfPreview = withinPreview > 0 ? treeRatio / withinPreview : 0.2
  // No pixel clamp: the Settings percentage must describe the actual tree width. The old 150px
  // floor turned 14% into 18% on a narrow preview and made the numbers disagree with the screen.
  const treePx = resolveRatioToPixels(treeOfPreview, containerWidth, 0, containerWidth)
  useEffect(() => {
    const node = root.current
    if (!node) return
    const measure = (): void => setContainerWidth(node.clientWidth)
    measure()
    const observer = new ResizeObserver(() => measure())
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  // Settings edits (and resizes) must reach the already-mounted split view; `preferredSize` is
  // mount-only. Only resize when the resolved pixel width actually changed.
  useEffect(() => {
    if (appliedTreePx.current === treePx || containerWidth <= 0) return
    appliedTreePx.current = treePx
    allotment.current?.resize([containerWidth - treePx, treePx])
  }, [treePx, containerWidth])
  return (
    <div ref={root} className="h-full min-h-0 w-full">
    <Allotment
      ref={allotment}
      proportionalLayout={false}
      onDragEnd={(sizes) => {
        const width = sizes[1]
        const total = sizes[0] + sizes[1]
        // Persist the file tree share the user settled on; `0` means the pane is collapsed.
        if (typeof width === "number" && width > 0 && total > 0) {
          const nextTreeOfPreview = width / total
          // Convert "share of the preview container" back to "share of the workspace width".
          // The region is `tree + preview`: using only `previewRatio` made the whole region shrink
          // by the tree's share on every drag, which is the "widths jump after resizing" bug.
          const region = treeRatio + previewRatio
          if (region > 0) {
            saveWorkspaceLayout({
              treeRatio: region * nextTreeOfPreview,
              previewRatio: region * (1 - nextTreeOfPreview)
            })
          }
        }
      }}
      onVisibleChange={(index, visible) => {
        if (index === 1) onTreeVisibleChange(visible)
      }}
    >
      <Allotment.Pane minSize={0} priority={LayoutPriority.High}>
        <div className="file-workspace-editor" data-tree-hidden={!treeVisible}>
          {editor({
            leading: !treeVisible && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-expanded={false}
                aria-label={t("workspace.showTree")}
                title={t("workspace.showTree")}
                onClick={() => {
                  if (onShowProjectTree !== undefined) onShowProjectTree()
                  else onTreeVisibleChange(true)
                }}
              >
                <FolderTree />
              </Button>
            ),
            trailing: (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-pressed={expanded}
                  aria-label={t(expanded ? "workspace.exitViewMode" : "workspace.enterViewMode")}
                  title={t(expanded ? "workspace.exitViewMode" : "workspace.enterViewMode")}
                  onClick={controls?.toggleExpanded ?? onMaximize}
                >
                  {expanded ? <Minimize2 /> : <Maximize2 />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("workspace.closePreview")}
                  title={t("workspace.closePreview")}
                  onClick={onClose}
                >
                  <X />
                </Button>
              </>
            )
          })}
        </div>
      </Allotment.Pane>
      <Allotment.Pane minSize={0} preferredSize={treePx} snap visible={treeVisible}>
        <div
          className="file-workspace-tree"
          data-collapsed={!treeVisible}
          inert={!treeVisible}
          aria-hidden={!treeVisible}
        >
          {tree}
        </div>
      </Allotment.Pane>
    </Allotment>
    </div>
  )
}
