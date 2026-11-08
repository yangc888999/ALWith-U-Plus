import {
  CommentSurface,
  type DriveContentHost,
  DriveContentProvider,
  driveContentTranslator
} from "@alwith/module-drive/content"
import { useDrive } from "@alwith/module-drive/react"
import { containsPath } from "@alwith/module-fs"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { describeError } from "@/lib/error-text"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

import { setCollaborationOwner } from "./collaboration-owners"
import { drive, driveTransport } from "./controller"

export function useDriveContentHost(saveDocument: (path: string) => Promise<void>): DriveContentHost {
  const { i18n } = useTranslation()
  const { connected, snapshot } = useDrive(drive)
  const [userName, setUserName] = useState("")
  useEffect(() => {
    let active = true
    if (!connected || !snapshot?.configured) {
      setUserName("")
      return
    }
    void drive
      .request({ type: "configuration" })
      .then((response) => {
        if (response.type !== "configuration") throw new Error("Invalid Drive configuration")
        if (active) setUserName(response.data.userName ?? "")
      })
      .catch((error: unknown) => {
        if (active) toast.error(describeError(error))
      })
    return () => {
      active = false
    }
  }, [connected, snapshot?.configured, snapshot?.generation])
  return useMemo(
    () => ({
      transport: driveTransport,
      generation: snapshot?.generation,
      collaborationOwner: setCollaborationOwner,
      saveDocument,
      userName,
      language: i18n.language,
      pushConnected: snapshot?.status?.pushConnected ?? false,
      translate: driveContentTranslator(i18n.language.startsWith("zh") ? "zh-CN" : "en"),
      onError: (error) => toast.error(describeError(error)),
      notify: toast,
      searchUsers: async (keyword) => {
        const response = await drive.request({ type: "searchUsers", query: keyword })
        if (response.type !== "users") throw new Error("Invalid Drive user search")
        return response.data
      },
      controls: {
        Button,
        Input,
        Textarea,
        Checkbox: ({ checked, onCheckedChange }) => (
          <Checkbox checked={checked} onCheckedChange={(value) => onCheckedChange(value)} />
        )
      }
    }),
    [userName, i18n.language, snapshot?.status?.pushConnected, snapshot?.generation, saveDocument]
  )
}
export function DriveDocumentSurface({
  host,
  path,
  children
}: {
  host: DriveContentHost
  path: string | null
  children: ReactNode
}): ReactNode {
  const { snapshot } = useDrive(drive)
  const managed =
    path !== null &&
    snapshot?.running &&
    snapshot.roots.some((root) => root.drivePath && containsPath(root.localPath, path))
  // The comment rail and drawer are positioned over the document by the Drive module, so they used
  // to cover the file being read. Measure the panel and reserve exactly its width next to the
  // content instead: 0 while it is absent, 2rem collapsed, 20rem when the drawer opens.
  const [commentWidth, setCommentWidth] = useState(0)
  const surface = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!managed) {
      setCommentWidth(0)
      return
    }
    // The panel is rendered next to this surface by the Drive module, inside the same pane. Look
    // beside the surface rather than at the document, so a second preview can never be measured.
    const host = surface.current?.parentElement ?? null
    if (host === null) return
    let frame = 0
    const measure = (): void => {
      frame = 0
      const panel = host.querySelector<HTMLElement>('[data-testid="comment-rail"], [data-testid="comment-drawer"]')
      const width = panel === null ? 0 : Math.round(panel.getBoundingClientRect().width)
      setCommentWidth((current) => (current === width ? current : width))
    }
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure)
    }
    measure()
    // The rail swaps to the drawer (and back) by re-rendering beside the content. Watch node
    // insertions only: watching class attributes across the whole editor would measure on every
    // hover and ProseMirror decoration, which is far more work than a width change needs.
    const observer = new MutationObserver(schedule)
    observer.observe(host, { childList: true, subtree: true })
    window.addEventListener("resize", schedule)
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener("resize", schedule)
    }
  }, [managed, path])
  return (
    <DriveContentProvider host={host}>
      {managed ? (
        <CommentSurface key={path} path={path}>
          <div ref={surface} className="h-full min-h-0" style={{ paddingInlineEnd: commentWidth }}>
            {children}
          </div>
        </CommentSurface>
      ) : (
        children
      )}
    </DriveContentProvider>
  )
}
