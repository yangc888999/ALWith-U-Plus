import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { openExternal } from "@/lib/open"

/**
 * Chinese replacement for the native WebKit context menu.
 *
 * macOS hands every view a built-in English menu (Look Up / Translate / Spelling / Font /
 * Services…). Only the actions people actually use are offered here.
 */
export interface ContextMenuTarget {
  x: number
  y: number
  text: string
  /** True when the pointer was over an editable region — cut and paste only apply there. */
  editable: boolean
}

const WIDTH = 148

/** The text a context menu opened at `node` should act on: the selection, or the whole element. */
export function contextMenuText(node: EventTarget | null): string {
  const selection = window.getSelection()?.toString().trim() ?? ""
  if (selection !== "") return selection
  if (!(node instanceof HTMLElement)) return ""
  return (node.textContent ?? "").trim()
}

/** True when the event came from an editable region, where cut and paste apply. */
export function isEditableTarget(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false
  return node.closest("input, textarea, [contenteditable='true'], [contenteditable='']") !== null
}

/** Copies text through the native clipboard, which the webview trusts even without a selection. */
export async function copyText(text: string): Promise<void> {
  if (text === "") return
  await writeText(text)
}

/**
 * Pastes into whatever had focus when the menu opened.
 *
 * The webview's asynchronous clipboard rejects `execCommand('paste')`, so the text is spliced into
 * the focused field and reported through an `input` event — the same path a keystroke takes.
 */
export async function pasteInto(target: HTMLElement | null): Promise<void> {
  const { readText } = await import("@tauri-apps/plugin-clipboard-manager")
  const clip = await readText()
  if (clip === "") return
  const active = target ?? document.activeElement
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    const start = active.selectionStart ?? active.value.length
    const end = active.selectionEnd ?? start
    active.value = active.value.slice(0, start) + clip + active.value.slice(end)
    active.selectionStart = active.selectionEnd = start + clip.length
    active.dispatchEvent(new Event("input", { bubbles: true }))
    return
  }
  if (active instanceof HTMLElement && active.isContentEditable) document.execCommand("insertText", false, clip)
}

/** Selects the whole document when nothing is focused, otherwise the focused field's contents. */
export function selectAllText(): void {
  const active = document.activeElement
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    active.focus()
    active.select()
    return
  }
  const selection = window.getSelection()
  const body = document.body
  if (selection === null || body === null) return
  const range = document.createRange()
  range.selectNodeContents(body)
  selection.removeAllRanges()
  selection.addRange(range)
}

export function ChatContextMenu({
  target,
  onClose,
  onAddToChat
}: {
  target: ContextMenuTarget | null
  onClose: () => void
  /** When set, a non-empty selection also offers "添加到对话" (quote into the composer). */
  onAddToChat?: (text: string) => void
}): ReactNode {
  const { t } = useTranslation()
  const root = useRef<HTMLDivElement | null>(null)
  // The menu's height depends on how many actions apply, so an estimated clamp ran past the
  // bottom edge on a long menu (the last rows became unreachable). Measure the real box before
  // the first paint and keep it inside the window.
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const node = root.current
    if (target === null || node === null) {
      setPosition(null)
      return
    }
    const rect = node.getBoundingClientRect()
    const left = Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8))
    const top = Math.max(8, Math.min(target.y, window.innerHeight - rect.height - 8))
    setPosition((current) =>
      current !== null && current.left === left && current.top === top ? current : { left, top }
    )
  }, [target])

  useEffect(() => {
    if (target === null) return
    const dismiss = (event: Event): void => {
      // A right-button press is the open gesture: the view's mousedown listener re-opens the
      // menu at the new spot in the same event, so closing here would only flicker.
      if (event instanceof PointerEvent && event.button === 2) return
      if (!root.current?.contains(event.target as Node)) onClose()
    }
    // Captured: a menu opened by a right-click must survive the very pointerdown that opened it.
    window.addEventListener("pointerdown", dismiss, true)
    window.addEventListener("keydown", dismiss, true)
    return () => {
      window.removeEventListener("pointerdown", dismiss, true)
      window.removeEventListener("keydown", dismiss, true)
    }
  }, [target, onClose])

  if (target === null) return null
  const text = target.text
  const editable = target.editable

  const copy = (): void => {
    void copyText(text).catch(() => toast.error(t("chat.contextCopyFailed")))
    onClose()
  }
  const paste = (): void => {
    void pasteInto(null).catch(() => {})
    onClose()
  }
  const selectAll = (): void => {
    selectAllText()
    onClose()
  }
  const translate = (): void => {
    void openExternal(`https://fanyi.baidu.com/#auto/zh/${encodeURIComponent(text)}`).catch(() => {})
    onClose()
  }
  const share = (): void => {
    void copyText(text).catch(() => {})
    onClose()
  }
  const find = (): void => {
    // window.find is the only in-page search a webview exposes; it is non-standard but present.
    const finder = (window as { find?: (needle: string) => boolean }).find
    if (finder === undefined) toast(t("chat.contextFindUnsupported"))
    else finder(text)
    onClose()
  }

  const addToChat = (): void => {
    onAddToChat?.(text)
    onClose()
  }

  const items = [
    { label: t("chat.contextCopy"), run: copy, disabled: text === "" },
    ...(onAddToChat !== undefined && text !== ""
      ? [{ label: t("chat.selectionAdd"), run: addToChat, disabled: false }]
      : []),
    { label: t("chat.contextPaste"), run: paste, disabled: !editable },
    { label: t("chat.contextSelectAll"), run: selectAll, disabled: false },
    { label: t("chat.contextTranslate"), run: translate, disabled: text === "" },
    { label: t("chat.contextShare"), run: share, disabled: text === "" },
    { label: t("chat.contextFind"), run: find, disabled: text === "" }
  ]

  return createPortal(
    <div
      ref={root}
      data-chat-context-menu
      role="menu"
      className="fixed z-[60] overflow-hidden rounded-md border bg-popover py-1 text-xs text-popover-foreground shadow-md"
      style={{
        left: position?.left ?? Math.max(8, Math.min(target.x, window.innerWidth - WIDTH - 8)),
        top: position?.top ?? Math.max(8, Math.min(target.y, window.innerHeight - 12 * items.length - 24)),
        // Hidden for the single frame before the measurement lands, never painted off-window.
        visibility: position === null ? "hidden" : "visible",
        width: WIDTH
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          className="block w-full px-3 py-1.5 text-left hover:bg-muted disabled:opacity-50"
          onClick={item.run}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  )
}
