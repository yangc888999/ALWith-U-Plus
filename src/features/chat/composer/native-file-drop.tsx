import { type AttachmentPolicy, usePromptInputAttachments } from "@alwith/module-chat/composer-context"
import { isTauri } from "@tauri-apps/api/core"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { useEffect, useLayoutEffect, useRef } from "react"
import { flushSync } from "react-dom"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { commands } from "@/bindings"
import { basename } from "@/lib/path"

const sourcePaths = new WeakMap<File, string>()
/** Native drops bypass the package's browser drop handler, so we enforce the same 5 MB total image
 *  budget here. The figure is mirrored to the attachment tray (see the reconciling effect) so a
 *  removed image frees its allowance. */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024
export const nativeAttachmentPolicy: AttachmentPolicy = {
  sourcePath: (file) => sourcePaths.get(file),
  uniqueFiles(incoming, existing) {
    const paths = new Set(existing.map((file) => file.sourcePath))
    return incoming.filter((file) => {
      const path = sourcePaths.get(file)
      if (path === undefined) return true
      if (paths.has(path)) return false
      paths.add(path)
      return true
    })
  }
}

/** Adapt native OS drops to the shared composer; never subscribe on attachment updates. */
export function NativeFileDrop({
  sessionId,
  enabled,
  onMention,
  onImage,
  materialsDirectory,
  onBusyChange
}: {
  sessionId: string
  enabled: boolean
  onMention: (path: string) => void
  /** Images land in the ordinary attachment tray (the package turns them into image blocks). */
  onImage: (file: File) => void
  /** When the conversation is a 群聊 project: dropped files are copied into its 资料/ folder. */
  materialsDirectory: string | null
  onBusyChange: (busy: boolean) => void
}) {
  const attachments = usePromptInputAttachments()
  const { t } = useTranslation()
  // Synchronous dedup + budget for the drop handler. The refs bridge the gap *between* drops within
  // a single flush (where React hasn't committed the just-added attachment yet); the effect below
  // re-derives them from the tray whenever it changes, so removing an image frees its allowance
  // and re-dropping a removed file works again.
  const inlineBytes = useRef(0)
  const seenImages = useRef(new Set<string>())
  useEffect(() => {
    const images = attachments.files.filter((item) => (item.mediaType ?? "").toLowerCase().startsWith("image/"))
    inlineBytes.current = images.reduce((sum, item) => sum + (item.size ?? 0), 0)
    seenImages.current = new Set(images.map((item) => item.sourcePath).filter((path): path is string => path !== undefined))
  }, [attachments.files])
  const current = useRef({ sessionId, attachments, enabled, onMention, onImage, materialsDirectory, onBusyChange, t })
  useLayoutEffect(() => {
    current.current = { sessionId, attachments, enabled, onMention, onImage, materialsDirectory, onBusyChange, t }
  })
  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let stop: (() => void) | undefined
    let queue = Promise.resolve()
    let pending = 0
    const writable = () => !disposed && current.current.sessionId === sessionId && current.current.enabled
    current.current.onBusyChange(false)
    const listener = getCurrentWebview().onDragDropEvent((event) => {
      if (disposed || event.payload.type !== "drop") return
      const { paths, position } = event.payload
      const target = document.elementFromPoint(
        position.x / window.devicePixelRatio,
        position.y / window.devicePixelRatio
      )
      // Only the conversation owns these drops. The file tree retains its import behavior.
      if (!target?.closest("[data-chat-drop-zone]") || target.closest('[role="dialog"]')) return
      if (!writable()) {
        toast.error(current.current.t("chat.input.dropUnavailable"))
        return
      }
      pending++
      flushSync(() => current.current.onBusyChange(true))
      queue = queue
        .then(async () => {
          try {
            const imagePaths = new Set(current.current.attachments.files.map((file) => file.sourcePath))
            for (const path of new Set(paths)) {
              if (!writable()) return
              try {
                const file = await commands.chatReadDroppedFile({ path })
                if (!writable()) return
                if (file.image === null) {
                  flushSync(() => current.current.onMention(file.path))
                } else if (!imagePaths.has(file.path) && !seenImages.current.has(file.path)) {
                  const bytes = Uint8Array.from(atob(file.image.data), (char) => char.charCodeAt(0))
                  if (inlineBytes.current + bytes.length > MAX_INLINE_IMAGE_BYTES) {
                    toast.error(current.current.t("chat.input.imageTooLargeInline"))
                    continue
                  }
                  inlineBytes.current += bytes.length
                  seenImages.current.add(file.path)
                  const image = new File([bytes], file.name, { type: file.image.mimeType })
                  sourcePaths.set(image, file.path)
                  imagePaths.add(file.path)
                  // Land in the ordinary attachment tray; the package turns them into image blocks.
                  current.current.onImage(image)
                }
              } catch (error) {
                if (!disposed)
                  toast.error(current.current.t("chat.input.dropFailed", { name: basename(path) }), {
                    description: error instanceof Error ? error.message : String(error)
                  })
              }
            }
            // A 群聊's 资料/ is where the discussion works from: files dropped into the chat are
            // copied there as well, so every member reads the same material.
            const materials = current.current.materialsDirectory
            if (materials !== null) {
              try {
                const saved = await commands.groupCopyMaterials({ paths: [...new Set(paths)], groupDirectory: materials })
                if (saved.length > 0 && !disposed)
                  toast.success(current.current.t("chat.input.movedToMaterials", { count: saved.length }))
              } catch (error) {
                if (!disposed)
                  toast.error(current.current.t("chat.input.materialsFailed"), {
                    description: error instanceof Error ? error.message : String(error)
                  })
              }
            }
          } finally {
            pending--
            if (!disposed) flushSync(() => current.current.onBusyChange(pending > 0))
          }
        })
        .catch((error) => {
          if (!disposed) toast.error(error instanceof Error ? error.message : String(error))
        })
    })
    void listener
      .then((unlisten) => {
        if (disposed) unlisten()
        else stop = unlisten
      })
      .catch((error) => {
        if (!disposed) toast.error(error instanceof Error ? error.message : String(error))
      })
    return () => {
      disposed = true
      stop?.()
    }
  }, [sessionId])
  return null
}
