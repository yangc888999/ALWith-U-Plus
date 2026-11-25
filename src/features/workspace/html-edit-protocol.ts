/**
 * Host-side guards and helpers for the HTML edit bridge protocol.
 *
 * The previewed document lives in an opaque-origin iframe (`preview-html://localhost`), so
 * `event.origin` is useless; trust comes from three checks: the message really came from this
 * frame's contentWindow, carries our `source` constant, and echoes the nonce minted for the
 * current handshake. `targetOrigin` is "*" because the frame's origin is opaque — the nonce and
 * source checks are the actual security boundary.
 */
import {
  HTML_EDIT_HOST_SOURCE,
  isHtmlEditMessage,
  type HtmlEditMessage,
  type HtmlHostCommandMessage,
  type HtmlHostFlushMessage,
  type HtmlHostInitMessage,
  type HtmlHostMessage,
  type HtmlHostSetModeMessage,
  type HtmlHostUndoMessage
} from "./wysiwyg-types"

/** Mint a fresh handshake nonce. Each (re)load of the frame gets a new one; stale frames are mute. */
export function mintNonce(): string {
  return crypto.randomUUID()
}

/**
 * Validate an incoming window message against the frame we expect. Returns the parsed message or
 * null. `ready` is the only message allowed before a nonce exists (it starts the handshake).
 */
export function acceptFrameMessage(
  event: MessageEvent,
  frame: HTMLIFrameElement | null,
  nonce: string | null
): HtmlEditMessage | null {
  if (frame === null || event.source !== frame.contentWindow) return null
  if (!isHtmlEditMessage(event.data)) return null
  const message = event.data
  if (message.type === "ready") return message
  if (nonce === null || !("nonce" in message) || message.nonce !== nonce) return null
  return message
}

/** The host→frame message shapes without the (auto-stamped) source constant. */
export type HtmlHostMessageBody =
  | Omit<HtmlHostInitMessage, "source">
  | Omit<HtmlHostSetModeMessage, "source">
  | Omit<HtmlHostCommandMessage, "source">
  | Omit<HtmlHostFlushMessage, "source">
  | Omit<HtmlHostUndoMessage, "source">

/** Build a host→frame message with the shared source constant. */
export function hostMessage(message: HtmlHostMessageBody): HtmlHostMessage {
  return { ...message, source: HTML_EDIT_HOST_SOURCE } as HtmlHostMessage
}

/** Post a host message into the frame. No-op when the frame is gone. */
export function postToFrame(frame: HTMLIFrameElement | null, message: HtmlHostMessage): void {
  frame?.contentWindow?.postMessage(message, "*")
}
