import { useCallback, useEffect, useRef, useState } from "react"

import { client, useApp } from "@/lib/client"
import { isTemporaryChatDir } from "@/lib/quick-chat"

/** A local sidebar row that exists before the native session is ready. It keeps one stable key
 *  from click through preparation so the row can be clicked, retried and then replaced in place. */
export interface PendingChatRow {
  key: string
  directory: string | null
  status: "draft" | "connecting" | "retryable"
  sessionId?: string
}

export function pendingChatGroup(directory: string | null): string | null {
  return directory === null || isTemporaryChatDir(directory) ? null : client.projectPath(directory)
}

export function usePendingChat(selectedId: string | null) {
  const [pendingChat, setPendingChat] = useState<PendingChatRow | null>(null)
  const requestedKey = useRef<string | null>(null)
  const begin = useCallback((directory: string | null) => {
    const key = globalThis.crypto?.randomUUID?.() ?? `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`
    requestedKey.current = key
    setPendingChat({ key, directory: pendingChatGroup(directory), status: "draft" })
    return key
  }, [])
  const cancel = useCallback(() => {
    requestedKey.current = null
    setPendingChat(null)
  }, [])
  const key = pendingChat?.key
  const id = pendingChat?.sessionId
  const visible = useApp((state) =>
    id !== undefined && id === selectedId && state.sessionListLoaded && state.sessionList.some((row) => row.sessionId === id)
  )
  useEffect(() => {
    if (visible) setPendingChat((current) => current !== null && current.key === key && current.sessionId === id ? null : current)
  }, [visible, key, id])
  const onListed = key === undefined ? undefined : (sessionId: string, directory: string) =>
    setPendingChat((current) =>
      current?.key === key ? { ...current, sessionId, directory: pendingChatGroup(directory), status: "connecting" } : current
    )
  return { pendingChat, setPendingChat, begin, cancel, requestedKey, onListed }
}
