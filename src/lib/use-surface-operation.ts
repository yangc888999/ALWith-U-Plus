import { useRef, useState, useSyncExternalStore } from "react"

import { createSurfaceOperation } from "./surface-operation"

// Only window/draft handoffs set this. It lives in a module store so every composer in the webview
// reads the same value without threading a prop through ChatView, DraftChat and the package Composer.
const listeners = new Set<() => void>()
let handoffBusy = false
function publishHandoff(value: boolean): void {
  if (handoffBusy === value) return
  handoffBusy = value
  for (const listener of listeners) listener()
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
/** True only while a handoff that will replace the draft is running. Sending never sets it. */
export function useHandoffBusy(): boolean {
  return useSyncExternalStore(subscribe, () => handoffBusy, () => false)
}

/** `onStall` runs if a handoff wedges past the watchdog and the interface is recovered. */
export function useSurfaceOperation(onStall?: () => void) {
  const [busy, setBusy] = useState(false)
  // Kept in a ref so a changing callback never rebuilds the operation (and its lock) mid-request.
  const stall = useRef(onStall)
  stall.current = onStall
  const [operation] = useState(() =>
    createSurfaceOperation(
      (value) => {
        // Announce the handoff without freezing the window. A plain setState is enough; the
        // one-frame delay is imperceptible and avoids a forced sync render.
        setBusy(value)
      },
      () => stall.current?.(),
      publishHandoff
    )
  )
  return { busy, operation }
}
