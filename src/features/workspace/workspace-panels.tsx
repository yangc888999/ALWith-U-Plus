import { ChevronLeft, ChevronRight } from "lucide-react"
import {
  type ReactNode,
  type Ref,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState
} from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { CanvasContext } from "@/features/layout/lib/canvas-context"

import { contentShares, requestedPreviewWidth, saveWorkspaceLayout, workspaceLayoutDefaults } from "./layout-preferences"
import { type PanelControls, PanelControlsContext } from "./panel-controls-context"
import { PanelDivider } from "./panel-divider"
import { useWorkspaceLayout } from "./use-workspace-layout"
import "./workspace.css"

const MIN_BLOCK_WIDTH = 320
/** Inlined from Atlas' resolveSplitWidths — the only sizing rule this panel ever used. */
function resolvePanelWidths(
  viewportWidth: number,
  previewVisible: boolean,
  previewWidth: number,
  fullViewportWidth = viewportWidth,
  manuallySeparated = false
): { chat: number; preview: number } {
  const screen = Math.max(0, viewportWidth)
  const full = Math.max(MIN_BLOCK_WIDTH, screen)
  if (!previewVisible) return { chat: full, preview: 0 }
  const requested = Math.max(400, previewWidth || Math.floor(screen / 2))
  const pushedToNextScreen = previewWidth > 0 && previewWidth < 400
  if (!manuallySeparated && !pushedToNextScreen && screen - requested >= MIN_BLOCK_WIDTH)
    return { chat: screen - requested, preview: requested }
  return { chat: full, preview: Math.max(MIN_BLOCK_WIDTH, fullViewportWidth) }
}

// Two mounted panes, chat then preview. The detached window pans between them with a local
// `pane` index; inside the main canvas the parent owns the screen and both panes size by share.
export function WorkspacePanels({
  chat,
  preview,
  visible,
  maximized,
  onMaximizedChange,
  controlsRef
}: {
  controlsRef?: Ref<PanelControls>
  chat: ReactNode
  preview: ReactNode
  visible: boolean
  maximized: boolean
  onVisibleChange: (visible: boolean) => void
  onMaximizedChange: (maximized: boolean) => void
}): ReactNode {
  const { t, i18n } = useTranslation()
  const canvas = useContext(CanvasContext)
  const unified = canvas !== null
  const root = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)
  const dragStart = useRef(0)
  const previousVisible = useRef(visible)
  const previousMaximized = useRef(maximized)
  const [draggingPreview, setDraggingPreview] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(0)
  // While dragging, the pointer owns the width; the persisted store wins once the drag ends.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragWidthRef = useRef(0)
  const layout = useWorkspaceLayout()
  const [manuallySeparated, setManuallySeparated] = useState(false)
  const [edgeZone, setEdgeZone] = useState<"start" | "end" | null>(null)
  // Detached-window pane index: 0 = chat, 1 = preview. Replaces Atlas' snap engine here.
  const [pane, setPane] = useState(0)
  const budget = canvas?.budget ?? viewportWidth
  const fullViewportWidth = canvas?.viewportWidth ?? viewportWidth
  // The drag owns a pixel-precise width only while it is happening; once released the share is
  // what we persist (see onEnd), so there is nothing pixel-based left in storage.
  const previewWidth = dragWidth ?? 0
  // A dragged pixel width wins; otherwise the Settings share decides the chat/preview split.
  const shares = contentShares(layout)
  // The split-view's "preview" region contains the file tree as well, so its share is tree +
  // preview. Passing only the preview share made the region too narrow: the tree was squeezed
  // inside it and chat stole the difference, so the Settings percentages never matched the screen.
  const previewRegionShare = shares.tree + shares.preview
  const requestedPreview = requestedPreviewWidth(budget, previewRegionShare, previewWidth)
  const widths = resolvePanelWidths(budget, visible, requestedPreview, fullViewportWidth, manuallySeparated)
  const chatWidth = maximized ? 0 : widths.chat
  const fileWidth = maximized ? budget : widths.preview
  const expanded = maximized || (visible && budget > 0 && widths.chat + widths.preview > budget)
  const toggleExpanded = (): void => {
    if (expanded) {
      setDragWidth(null)
      // Restore means "back to the default split", not "reuse the last dragged share".
      saveWorkspaceLayout({
        chatRatio: workspaceLayoutDefaults.chatRatio,
        treeRatio: workspaceLayoutDefaults.treeRatio,
        previewRatio: workspaceLayoutDefaults.previewRatio
      })
      setManuallySeparated(false)
      onMaximizedChange(false)
      canvas?.navigate("chat")
    } else {
      onMaximizedChange(true)
    }
  }
  useImperativeHandle(controlsRef, () => ({ expanded, toggleExpanded }))
  const reportWorkspace = canvas?.setWorkspace
  const navigate = canvas?.navigate
  useLayoutEffect(() => {
    reportWorkspace?.({ chat: chatWidth, preview: fileWidth, visible, maximized })
  }, [reportWorkspace, chatWidth, fileWidth, visible, maximized])
  useEffect(() => {
    if (!navigate) return
    if (visible && (!previousVisible.current || (maximized && !previousMaximized.current))) navigate("preview")
    previousVisible.current = visible
    previousMaximized.current = maximized
  }, [navigate, visible, maximized])

  useLayoutEffect(() => {
    const node = root.current
    if (!node || unified) return
    const measure = (): void => setViewportWidth(node.clientWidth)
    measure()
    // Avoid flushSync: React batches the width update to the next frame, so divider dragging
    // no longer forces a synchronous render that blocks the main thread.
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [unified])

  useEffect(() => {
    // Closing the preview or switching sessions must not discard a manually adjusted split;
    // only the "panes no longer fit" marker follows visibility.
    if (!visible || maximized) setManuallySeparated(false)
  }, [visible, maximized])

  // Pane navigation is only meaningful in the detached window; the unified canvas shows both.
  // Opening the preview reveals the next-pane affordance, closing it returns to chat.
  useEffect(() => {
    if (unified) return
    if (!visible) setPane(0)
  }, [unified, visible])
  const edges = { previous: !unified && pane > 0, next: !unified && visible && pane === 0 }

  return (
    <PanelControlsContext.Provider value={{ expanded, toggleExpanded }}>
      <div
        ref={root}
        className="file-workspace-layout"
        data-unified-canvas={canvas !== null}
        data-split={!maximized && visible && widths.chat + widths.preview > budget}
        data-open={visible}
        data-view-mode={maximized}
        data-edge={edgeZone}
        onMouseMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          const x = i18n.dir() === "rtl" ? bounds.right - event.clientX : event.clientX - bounds.left
          setEdgeZone(x < 56 ? "start" : x > bounds.width - 56 ? "end" : null)
        }}
        onMouseLeave={() => setEdgeZone(null)}
      >
        <div className="file-workspace-viewport">
          <div
            className="file-workspace-track"
            data-pane={unified ? undefined : pane}
            style={unified ? undefined : { transform: `translateX(${pane === 0 ? 0 : -chatWidth}px)` }}
          >
            <div
              className="file-workspace-slide"
              // With the preview shut, the conversation fills the live content column in CSS.
              // Its measured budget is intentionally settled later during a window resize, so a
              // numeric width here would leave a blank strip until that measurement lands.
              style={{ width: !visible && !maximized ? "100%" : chatWidth }}
              inert={maximized || (canvas?.split && canvas.selected === 2)}
              aria-hidden={maximized}
            >
              <div className="file-workspace-slab">
                <div className="file-workspace-chat">{chat}</div>
              </div>
            </div>
            <div
              className="file-workspace-slide file-workspace-preview-slide"
              style={{ width: fileWidth }}
            >
              <div
                className="file-workspace-slab"
                inert={!visible || (canvas?.split && canvas.selected !== 2)}
                aria-hidden={!visible}
              >
                <aside id="file-workspace-panel" className="file-workspace-panel" aria-label={t("workspace.files")}>
                  {preview}
                </aside>
              </div>
              {(draggingPreview || (visible && !maximized)) && (
                <PanelDivider
                  label={t("workspace.resize")}
                  width={fileWidth}
                  direction={i18n.dir()}
                  onStart={() => {
                    if (maximized) onMaximizedChange(false)
                    // Keep the requested width when splitting substitutes a full-screen display width.
                    dragStart.current = previewWidth || fileWidth
                    dragWidthRef.current = dragStart.current
                    dragging.current = true
                    setDraggingPreview(true)
                    canvas?.setDividerDragging(true)
                  }}
                  onDrag={(dx) => {
                    // Zero means automatic sizing; retain a positive request across the split threshold.
                    const requested = Math.max(1, Math.round(dragStart.current + dx))
                    // Growing preview collapses chat at its minimum; shrinking preview still moves it to the next screen.
                    const hideChat = dx > 0 && budget - requested <= 320
                    onMaximizedChange(hideChat)
                    const next = resolvePanelWidths(budget, true, requested, fullViewportWidth)
                    dragWidthRef.current = requested
                    setDragWidth(requested)
                    // A manual split survives navigation and window resizing until another divider adjustment.
                    setManuallySeparated(next.chat + next.preview > budget)
                  }}
                  onEnd={() => {
                    // Persist only the new share, never a pixel width: the split is derived from
                    // the live window width at render time, so a width dragged on one monitor can
                    // never starve the chat column on another.
                    const settled = dragWidthRef.current
                    const next = resolvePanelWidths(budget, true, settled, fullViewportWidth)
                    if (budget > 0) {
                      // Inside the workspace the three content shares add up to `1 - navigation`,
                      // so scale them back onto the window-wide 100% budget.
                      const scale = 1 - layout.navigationRatio
                      const withinPreview = shares.tree + shares.preview
                      const treeOfPreview = withinPreview > 0 ? shares.tree / withinPreview : 0.2
                      const previewShare = next.preview / budget
                      saveWorkspaceLayout({
                        chatRatio: (next.chat / budget) * scale,
                        treeRatio: previewShare * treeOfPreview * scale,
                        previewRatio: previewShare * (1 - treeOfPreview) * scale
                      })
                    }
                    // The store now owns the width; drop the pointer-owned preview value.
                    setDragWidth(null)
                    // A manual resize on main overrides preview intent retained from an earlier merged layout.
                    if (canvas?.selected === 1 && !maximized) canvas.navigate("chat")
                    dragging.current = false
                    setDraggingPreview(false)
                    canvas?.setDividerDragging(false)
                  }}
                />
              )}
            </div>
          </div>
        </div>
        {edges.previous && (
          <Button
            className="workspace-page-arrow workspace-page-previous"
            variant="outline"
            size="icon-sm"
            aria-label={t("workspace.previousPane")}
            onClick={() => setPane(0)}
          >
            <ChevronLeft />
          </Button>
        )}
        {edges.next && (
          <Button
            className="workspace-page-arrow workspace-page-next"
            variant="outline"
            size="icon-sm"
            aria-label={t("workspace.nextPane")}
            onClick={() => setPane(1)}
          >
            <ChevronRight />
          </Button>
        )}
      </div>
    </PanelControlsContext.Provider>
  )
}
