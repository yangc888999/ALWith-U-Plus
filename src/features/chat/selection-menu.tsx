// Floating menu over a text selection inside the transcript: 复制 / 添加到对话.
//
// The chat surface had no selection affordance at all: selecting text only produced WebKit's
// native menu, and there was no way to quote a passage into the composer. This mirrors the
// WorkBuddy gesture — select, then either copy or drop the passage into the input as a quote.
//
// Failure modes this deliberately handles (each caused a reported bug in earlier attempts):
// - The menu's own mousedown must not clear the selection (preventDefault on mousedown).
// - Selections inside the composer belong to the input, not to this menu.
// - Right-click opens the context menu instead; the floating menu hides.
// - Scrolling, an empty selection, Escape and outside clicks all dismiss it.
// - A selection spanning several blocks has no sensible single rect: the last visual line is
//   used, which is where the eye (and the pointer) ends up.
import { CopyIcon, MessageSquareIcon, MessageSquarePlusIcon } from "lucide-react"
import {
  type RefObject,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { drafts, importDraft } from "@alwith/module-chat/conversation"

import { copyText } from "./chat-context-menu"

interface Placement {
  left: number
  top: number
  text: string
}

/** module-drive's own floating comment trigger for a text selection. */
const COMMENT_BUTTON = '[data-testid="comment-selection-button"]'

const MENU_WIDTH = 260
const MENU_HEIGHT = 34

/** The quote form dropped into the composer: every selected line becomes a blockquote line. */
export function quoteForComposer(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n")
}

/** The new draft text: the quote on top, whatever the composer already held below it. */
export function composeQuoteText(current: string, text: string): string {
  const quoted = `${quoteForComposer(text)}\n\n`
  return current.trim() === "" ? quoted : `${quoted}${current}`
}

/**
 * Prepends the quote to whatever the composer already holds — as many times as the reader likes.
 *
 * `setComposerDraft` is the wrong tool here: it refuses a session whose composer is not mounted
 * ("open the session first") AND one that already holds a draft ("send or clear it first"). Both
 * refusals are exactly what quoting must not do — a quote is additive, and the preview can quote
 * into a conversation that has not been opened yet. So this writes through the two doors the
 * package leaves open:
 *
 * - Composer mounted: drive the real textarea through React's controlled-input path (native value
 *   setter + `input` event). The package's `onChange` runs `textInput.setInput`, which bumps the
 *   revision and syncs the draft map — the same path typing takes, so attachments, mentions and
 *   the model pick all survive, and a second quote simply merges into the first.
 * - Composer not mounted: seed the draft map with `importDraft` (no guards). The composer reads
 *   that map when it mounts, so the quote is waiting in the input the first time the session opens.
 *
 * Returns false only when there is genuinely nowhere to write (no textarea and no draft slot).
 */
export function appendQuote(sessionId: string, text: string): boolean {
  const merged = composeQuoteText(drafts.get(sessionId)?.text ?? "", text)
  const field = document.querySelector<HTMLTextAreaElement>("[data-composer] textarea")
  if (field !== null) {
    // React tracks the value it last rendered; assigning through the native setter and firing
    // `input` is what makes the controlled onChange see the change instead of ignoring it.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
    if (setter !== undefined) {
      setter.call(field, merged)
      field.dispatchEvent(new Event("input", { bubbles: true }))
      // The package's onChange runs synchronously inside the dispatch and syncs the draft map.
      // If it did not take (a composer that is not accepting input right now), the map still has
      // to carry the quote — otherwise the next read would merge against stale text and lose it.
      if (drafts.get(sessionId)?.text !== merged) seedDraft(sessionId, merged)
      return true
    }
  }
  // No live textarea (session not open, or the composer is still preparing): park the merged text
  // in the draft map. The composer reads that map when it mounts, so the quote is waiting in the
  // input the first time the session opens.
  seedDraft(sessionId, merged)
  return true
}

/** Writes the merged text into the draft map, keeping attachments/mentions/model intact. */
function seedDraft(sessionId: string, text: string): void {
  const existing = drafts.get(sessionId)
  importDraft(sessionId, {
    text,
    attachments: existing?.attachments ?? [],
    mentions: existing?.mentions ?? [],
    modelId: existing?.modelId ?? null
  })
}

/** Focuses the composer input after a quote lands, so typing can continue immediately. */
export function focusComposer(): void {
  const field = document.querySelector<HTMLElement>(
    "[data-composer] textarea, [data-composer] [contenteditable='true'], [data-composer] [contenteditable='']"
  )
  field?.focus()
}

export function SelectionMenu({
  containerRef,
  sessionId,
  external = null,
  allowAdd = true,
  allowComment = false,
  onComment,
  onDismiss
}: {
  /** The transcript root: selections outside it (sidebar, header) never open the menu. */
  containerRef: RefObject<HTMLElement | null>
  sessionId: string
  /**
   * Placement supplied by the host (the HTML preview's iframe bridge forwards its selection,
   * because a frame's own selection never reaches this document). Wins over the internal one.
   */
  external?: { left: number; top: number; text: string } | null
  /** Only for hosts with no composer at all; previews quote into the conversation by default. */
  allowAdd?: boolean
  /** Preview hosts with the Drive comment bridge keep comment as a unified selection action. */
  allowComment?: boolean
  /**
   * A host that owns the comment composer itself, such as the HTML preview bridge. When set,
   * 点评 calls this instead of looking for module-drive's hidden trigger in the document.
   */
  onComment?: () => void
  /** Clears an `external` placement held by the host, which `hide` cannot reach. */
  onDismiss?: () => void
}): ReactNode {
  const { t } = useTranslation()
  const [placement, setPlacement] = useState<Placement | null>(null)
  // The document viewer (module-drive) draws its own floating "评论" button above the selection.
  // Two pills stacked on one selection read as a glitch, so the action moves into this bar and
  // that button is hidden while the bar is up (see `html[data-selection-menu]` in index.css).
  const [commentTarget, setCommentTarget] = useState<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // Comments are not owned by the host selection bar. module-drive renders its own trigger
  // through a React portal in the host document; the bar must delegate to that trigger, while
  // Copy/Add remain local actions implemented below.
  const commentOwner = document
  const commentDocuments = useCallback((): Document[] => {
    const documents = [commentOwner]
    for (const frame of commentOwner.querySelectorAll<HTMLIFrameElement>("iframe")) {
      try {
        const frameDocument = frame.contentDocument
        if (frameDocument !== null && !documents.includes(frameDocument)) documents.push(frameDocument)
      } catch {
        // Cross-origin frames cannot expose their document; the host button remains discoverable.
      }
    }
    return documents
  }, [commentOwner])
  const findCommentButtons = useCallback(
    (): HTMLButtonElement[] =>
      commentDocuments().flatMap((owner) => [...owner.querySelectorAll<HTMLButtonElement>(COMMENT_BUTTON)]),
    [commentDocuments]
  )
  const findCommentButton = useCallback((): HTMLButtonElement | null => findCommentButtons()[0] ?? null, [findCommentButtons])

  const hide = useCallback((): void => setPlacement(null), [])
  // The preview module also renders a native 评论 trigger. While the unified white action bar is
  // visible, that trigger is hidden (not removed) so the bar owns the only visible entry point;
  // clicking 评论 below still delegates to the module's original composer.
  useEffect(() => {
    const shown = external ?? placement
    if (shown === null) return
    document.documentElement.dataset.selectionMenu = ""
    return () => {
      delete document.documentElement.dataset.selectionMenu
    }
  }, [external, placement])
  // module-drive inserts its trigger after its own selection state commits. A single query during
  // measure() races that commit, which is why the screenshot could still show a standalone button
  // while the white bar had only Copy/Add. Observe the portal until the trigger appears, hide it
  // imperatively as a belt-and-suspenders fallback to the CSS rule, and keep the DOM node so the
  // unified bar can delegate the original comment flow.
  useEffect(() => {
    const shown = external ?? placement
    if (shown === null) {
      setCommentTarget(null)
      return
    }
    const sync = (): void => {
      const buttons = findCommentButtons()
      setCommentTarget(buttons[0] ?? null)
      for (const button of buttons) {
        button.style.setProperty("opacity", "0", "important")
        button.style.setProperty("pointer-events", "none", "important")
      }
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(commentOwner.body, { childList: true, subtree: true })
    let frameCount = 0
    let frameId = 0
    const schedule = (): void => {
      frameId = requestAnimationFrame(() => {
        sync()
        frameCount += 1
        if (frameCount < 16) schedule()
      })
    }
    schedule()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frameId)
      for (const button of findCommentButtons()) {
        button.style.removeProperty("opacity")
        button.style.removeProperty("pointer-events")
      }
      setCommentTarget(null)
    }
  }, [commentOwner, external, findCommentButtons, placement])
  // `hide` only clears this component's own placement. An `external` placement (an iframe
  // selection forwarded by the preview host) lives in the host's state, so explicit dismissal
  // has to tell the host to drop it too — otherwise the pill stays on screen after copy/add.
  // `selectionchange` with an empty in-document selection must NOT dismiss it: the main document
  // usually has no selection at all while the frame does, and that would hide the pill instantly.
  const dismiss = useCallback((): void => {
    setPlacement(null)
    onDismiss?.()
  }, [onDismiss])

  const measure = useCallback((): void => {
    // The container is only a positioning hint now: a missing ref must not swallow the pill.
    const selection = window.getSelection()
    if (selection === null || selection.rangeCount === 0) return hide()
    const text = selection.toString().trim()
    if (text === "") return hide()
    const range = selection.getRangeAt(0)
    const node = range.commonAncestorContainer
    const element = node instanceof Element ? node : node.parentElement
    // The container check used to be strict; when the transcript root's ref pointed at a
    // different node than the selection, the pill never appeared. Anything in this document is
    // fine — except functional chrome with its own selection semantics (the file tree selects
    // rows, the sidebar selects chats, tabs switch documents): a copy pill there would steal
    // their right-click menu and read as a bug.
    if (element === null || !document.body.contains(element)) return hide()
    // 2026-11-21: the pill lives in exactly two places — the transcript (对话框) and the preview
    // pane (预览栏). Everywhere else keeps the native gesture: the sidebar, the file tree, the
    // tab strip, the title/status bars, the settings surface and the composer each own their
    // selection, and a copy pill on top of them reads as a bug.
    //
    // Now that the container ref is only a hint, a denylist was the wrong shape: any surface
    // nobody remembered to list (a new panel, an extension view) silently got the pill. So the
    // rule is an allow-list, and editing surfaces are excluded inside it — a .md/.html document
    // in edit mode is a text editor (native cut/copy/paste), not a preview.
    const inTranscript =
      element.closest("[data-chat-content]") !== null ||
      (containerRef.current?.contains(element) ?? false)
    const inPreview = element.closest(".file-workspace-editor") !== null
    const editing =
      element.closest(
        '.monaco-editor, .cm-editor, [data-editor], [contenteditable="true"], [contenteditable=""], [data-alwith-markdown-editing="true"], [data-alwith-html-editing="true"], textarea, input, [data-chat-input-header]'
      ) !== null
    const chrome =
      element.closest(
        '[data-composer], [role="tab"], [role="tablist"], .main-window-titlebar, .main-window-statusbar, .main-sidebar-panel, .main-sidebar-shell, .file-workspace-tree, .alwith-file-tree'
      ) !== null
    if (editing || chrome) return hide()
    if (!inTranscript && !inPreview) return hide()
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 || rect.height > 0)
    // WebKit reports no client rects for some inline-spanning selections; the bounding rect is
    // still valid and keeps the pill anchored to the selection.
    const last = rects.at(-1) ?? range.getBoundingClientRect()
    const left = Math.max(8, Math.min(last.left + last.width / 2 - MENU_WIDTH / 2, window.innerWidth - MENU_WIDTH - 8))
    // Below the selection when there is room, above it otherwise.
    const top = last.bottom + MENU_HEIGHT + 8 < window.innerHeight ? last.bottom + 8 : Math.max(8, last.top - MENU_HEIGHT - 8)
    setPlacement({ left, top, text: text.slice(0, 20_000) })
    // The comment trigger is synchronized by the owner-document observers above; no single-document
    // query here can win the iframe/portal race reliably.
  }, [containerRef, hide])

  useEffect(() => {
    const onPointerUp = (event: PointerEvent): void => {
      // Right-click (context menu) and clicks inside this menu never re-measure.
      if (event.button !== 0) return
      if (menuRef.current?.contains(event.target as Node)) return
      // Measure immediately (the selection is final on pointerup) and again on the next frame:
      // WebKit can throttle rAF callbacks, which left the pill waiting indefinitely.
      measure()
      requestAnimationFrame(measure)
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      // Any press dismisses the floating menu — including a right press, whose own context
      // menu would otherwise sit on top of a leftover selection pill.
      dismiss()
    }
    const onScroll = (): void => dismiss()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") dismiss()
    }
    // A collapsed selection (click elsewhere, Cmd+A then collapse) dismisses the menu.
    // Any non-empty one opens it: on macOS WebKit a drag-select does not always deliver a
    // pointerup that a document capture listener sees (the transcript's text interaction path
    // consumes it), which left selections with no pill at all. `selectionchange` always fires,
    // so it drives the pill and the pointer handlers only refine its position.
    let settle: ReturnType<typeof setTimeout> | undefined
    const onSelectionChange = (): void => {
      if (settle !== undefined) clearTimeout(settle)
      settle = setTimeout(() => {
        settle = undefined
        if (window.getSelection()?.toString().trim() === "") return hide()
        measure()
      }, 120)
    }
    window.addEventListener("pointerup", onPointerUp, true)
    window.addEventListener("pointerdown", onPointerDown, true)
    window.addEventListener("scroll", onScroll, true)
    window.addEventListener("keydown", onKeyDown, true)
    document.addEventListener("selectionchange", onSelectionChange)
    return () => {
      if (settle !== undefined) clearTimeout(settle)
      window.removeEventListener("pointerup", onPointerUp, true)
      window.removeEventListener("pointerdown", onPointerDown, true)
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("keydown", onKeyDown, true)
      document.removeEventListener("selectionchange", onSelectionChange)
    }
  }, [hide, measure, dismiss])

  const shown = external ?? placement
  // The pill's real width depends on the labels, so the estimate under the selection can still
  // hang past the window edge. Measure it, re-center on the selection centre and pull it back
  // inside before paint.
  const [box, setBox] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const node = menuRef.current
    if (shown === null || node === null) {
      setBox(null)
      return
    }
    const rect = node.getBoundingClientRect()
    // `shown.left` was centred on MENU_WIDTH, so the selection centre is recoverable from it.
    const centre = shown.left + MENU_WIDTH / 2
    const left = Math.max(8, Math.min(centre - rect.width / 2, window.innerWidth - rect.width - 8))
    const top = Math.max(8, Math.min(shown.top, window.innerHeight - rect.height - 8))
    setBox((current) => (current !== null && current.left === left && current.top === top ? current : { left, top }))
  }, [shown])
  if (shown === null) return null

  const copy = (): void => {
    void copyText(shown.text)
      .then(() => toast.success(t("chat.selectionCopied")))
      .catch(() => toast.error(t("chat.contextCopyFailed")))
    dismiss()
  }
  const comment = (): void => {
    dismiss()
    if (onComment !== undefined) {
      onComment()
      return
    }
    // The viewer owns the comment composer: click its trigger instead of reimplementing the flow.
    // It stays in the DOM (hidden by CSS), so a programmatic click still opens it.
    const button = commentTarget ?? findCommentButton()
    button?.click()
  }
  const addToChat = (): void => {
    if (!appendQuote(sessionId, shown.text)) {
      toast.error(t("chat.selectionAddFailed"))
      dismiss()
      return
    }
    focusComposer()
    toast.success(t("chat.selectionAdded"))
    dismiss()
  }

  // Rendered at the document root: inside the transcript the pill inherits whatever containing
  // block an ancestor establishes (filter, backdrop-filter, contain) and lands off-screen.
  return createPortal(
    <div
      ref={menuRef}
      data-selection-menu
      role="menu"
      // Width follows the labels instead of a fixed 196px: a fixed width made "添加到对话" wrap
      // onto two lines in narrow windows. The clamp below still measures the real box.
      className="bg-popover text-popover-foreground fixed z-[70] flex w-max items-center gap-0.5 rounded-full border px-1 py-1 text-xs whitespace-nowrap shadow-lg"
      style={{
        left: box?.left ?? shown.left,
        top: box?.top ?? shown.top
      }}
      // Keeping the selection is what makes "copy" and "add" act on the right text.
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        className="hover:bg-muted flex flex-1 items-center justify-center gap-1.5 rounded-full px-2 py-1 whitespace-nowrap"
        onClick={copy}
      >
        <CopyIcon className="size-3.5" />
        {t("chat.selectionCopy")}
      </button>
      {allowAdd && (
        <>
          <span className="bg-border h-4 w-px" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            className="hover:bg-muted flex flex-1 items-center justify-center gap-1.5 rounded-full px-2 py-1 whitespace-nowrap"
            onClick={addToChat}
          >
            <MessageSquarePlusIcon className="size-3.5" />
            {t("chat.selectionAdd")}
          </button>
        </>
      )}
      {/* 评论 belongs to HTML previews only. A Markdown viewer may still expose module-drive's
          native comment trigger in the document; discovering it must not add 评论 to a host that
          never enabled comments (md preview, transcript). */}
      {(onComment !== undefined || (allowComment && (commentTarget !== null || external !== null))) && (
        <>
          <span className="bg-border h-4 w-px" aria-hidden="true" />
          <button
            type="button"
            role="menuitem"
            className="hover:bg-muted flex flex-1 items-center justify-center gap-1.5 rounded-full px-2 py-1 whitespace-nowrap"
            onClick={comment}
          >
            <MessageSquareIcon className="size-3.5" />
            {t("chat.selectionComment")}
          </button>
        </>
      )}
    </div>,
    document.body
  )
}
