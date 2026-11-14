import { describe, expect, test } from "vitest"

import { acceptFrameMessage, hostMessage, mintNonce, postToFrame } from "../html-edit-protocol"
import { HTML_EDIT_FRAME_SOURCE, HTML_EDIT_HOST_SOURCE } from "../wysiwyg-types"

function frameWith(source: Window | null): HTMLIFrameElement {
  return { contentWindow: source } as unknown as HTMLIFrameElement
}

function event(source: Window | null, data: unknown): MessageEvent {
  return { source, data } as unknown as MessageEvent
}

describe("acceptFrameMessage", () => {
  const nonce = "nonce-1"
  const otherWindow = {} as Window
  const frameWindow = {} as Window

  test("accepts a ready message from the frame without a nonce", () => {
    const message = acceptFrameMessage(
      event(frameWindow, { source: HTML_EDIT_FRAME_SOURCE, type: "ready", editable: true }),
      frameWith(frameWindow),
      null
    )
    expect(message?.type).toBe("ready")
  })

  test("rejects a message from a different window", () => {
    const message = acceptFrameMessage(
      event(otherWindow, { source: HTML_EDIT_FRAME_SOURCE, type: "state", nonce, state: {} }),
      frameWith(frameWindow),
      nonce
    )
    expect(message).toBeNull()
  })

  test("rejects a wrong source constant", () => {
    const message = acceptFrameMessage(
      event(frameWindow, { source: "alwith-preview", type: "state", nonce }),
      frameWith(frameWindow),
      nonce
    )
    expect(message).toBeNull()
  })

  test("rejects a wrong nonce", () => {
    const message = acceptFrameMessage(
      event(frameWindow, { source: HTML_EDIT_FRAME_SOURCE, type: "dirty", nonce: "stale", html: "<p>x</p>" }),
      frameWith(frameWindow),
      nonce
    )
    expect(message).toBeNull()
  })

  test("rejects non-ready messages before a nonce exists", () => {
    const message = acceptFrameMessage(
      event(frameWindow, { source: HTML_EDIT_FRAME_SOURCE, type: "dirty", nonce, html: "x" }),
      frameWith(frameWindow),
      null
    )
    expect(message).toBeNull()
  })

  test("accepts a matching nonce", () => {
    const message = acceptFrameMessage(
      event(frameWindow, { source: HTML_EDIT_FRAME_SOURCE, type: "dirty", nonce, html: "<p>x</p>" }),
      frameWith(frameWindow),
      nonce
    )
    expect(message?.type).toBe("dirty")
  })

  test("rejects when the frame is null", () => {
    const message = acceptFrameMessage(
      event(frameWindow, { source: HTML_EDIT_FRAME_SOURCE, type: "ready", editable: true }),
      null,
      null
    )
    expect(message).toBeNull()
  })

  test("rejects malformed payloads", () => {
    expect(acceptFrameMessage(event(frameWindow, null), frameWith(frameWindow), null)).toBeNull()
    expect(acceptFrameMessage(event(frameWindow, "text"), frameWith(frameWindow), null)).toBeNull()
    expect(acceptFrameMessage(event(frameWindow, { source: HTML_EDIT_FRAME_SOURCE, type: "bogus" }), frameWith(frameWindow), nonce)).toBeNull()
  })
})

describe("hostMessage / postToFrame", () => {
  test("hostMessage stamps the host source constant", () => {
    const message = hostMessage({ type: "set-mode", nonce: "n", editing: true })
    expect(message.source).toBe(HTML_EDIT_HOST_SOURCE)
    expect(message.type).toBe("set-mode")
  })

  test("postToFrame posts to the frame contentWindow with wildcard origin", () => {
    const post = vi.fn()
    const frame = { contentWindow: { postMessage: post } } as unknown as HTMLIFrameElement
    const message = hostMessage({ type: "flush", nonce: "n" })
    postToFrame(frame, message)
    expect(post).toHaveBeenCalledWith(message, "*")
  })

  test("postToFrame is a no-op without a frame", () => {
    expect(() => postToFrame(null, hostMessage({ type: "flush", nonce: "n" }))).not.toThrow()
  })

  test("mintNonce produces unique values", () => {
    expect(mintNonce()).not.toBe(mintNonce())
  })
})