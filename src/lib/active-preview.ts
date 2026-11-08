/**
 * The document currently shown in the preview pane.
 *
 * The chat needs to tell the agent which file the user is talking about when the preview is open,
 * but the preview lives in a React tree that the agent client cannot see. This tiny external store
 * bridges the two: `FileWorkspace` publishes the active document, the composer subscribes for its
 * "referring to …" chip, and `CodexClient.prompt` attaches the same context to the model request
 * (via `PromptOptions.display`, so the user's own bubble stays clean).
 */
export interface ActivePreviewDocument {
  /** Absolute path of the document open in the preview pane. */
  path: string
  /** File name shown to the user (and used in the composer chip). */
  title: string
  /** Project root the preview belongs to; context is only attached to sessions in that project. */
  root: string
}

let current: ActivePreviewDocument | null = null
const listeners = new Set<() => void>()

/** Publishes the active document; `null` clears it (preview closed or no document). */
export function setActivePreview(next: ActivePreviewDocument | null): void {
  if (
    current === next ||
    (current !== null &&
      next !== null &&
      current.path === next.path &&
      current.title === next.title &&
      current.root === next.root)
  )
    return
  current = next
  for (const listener of listeners) listener()
}

/** Snapshot for non-React consumers (the agent client). */
export function getActivePreview(): ActivePreviewDocument | null {
  return current
}

/** Subscription for `useSyncExternalStore`. */
export function subscribeActivePreview(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
