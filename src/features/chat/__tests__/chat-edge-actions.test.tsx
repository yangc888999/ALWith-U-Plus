import { fireEvent, render } from "@testing-library/react"
import { beforeAll, describe, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

const draft = vi.hoisted(() => vi.fn())
vi.mock("@alwith/module-chat/conversation", () => ({ setComposerDraft: draft }))

const { ChatEdgeActions } = await import("../chat-edge-actions")

beforeAll(async () => {
  await initI18n("en")
})

describe("chat edge actions", () => {
  test("renders two independent buttons, each collapsed until it is hovered", () => {
    const view = render(<ChatEdgeActions sessionId="session-1" onClearContext={() => {}} />)
    const memory = view.getByRole("button", { name: "Read project memory" })
    const clear = view.getByRole("button", { name: "Clear context" })

    expect(memory).not.toBe(clear)
    for (const button of [memory, clear]) {
      // Collapsed by default and expanded by that button's own hover/focus, never by a
      // shared parent group — pointing at one must not move the other.
      expect(button.className).toContain("w-9")
      expect(button.className).toContain("hover:w-44")
      expect(button.className).toContain("focus-visible:w-44")
      expect(button.parentElement?.className ?? "").not.toContain("group")
    }
  })

  test("the memory button only stages a prompt and never sends it", () => {
    draft.mockClear()
    const clear = vi.fn()
    const view = render(<ChatEdgeActions sessionId="draft" onClearContext={clear} />)

    fireEvent.click(view.getByRole("button", { name: "Read project memory" }))

    expect(draft).toHaveBeenCalledTimes(1)
    expect(draft.mock.calls[0]?.[0]).toBe("draft")
    expect(String(draft.mock.calls[0]?.[1])).toContain("memory.md")
    expect(clear).not.toHaveBeenCalled()
  })

  test("the memory button sends straight away when the host provides a send path", async () => {
    draft.mockClear()
    const send = vi.fn(async (_text: string) => undefined)
    const view = render(<ChatEdgeActions sessionId="session-1" onSend={send} />)

    fireEvent.click(view.getByRole("button", { name: "Read project memory" }))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

    expect(String(send.mock.calls[0]?.[0])).toContain("memory.md")
    // A real send must not also stage the text, or the user would dispatch it twice.
    expect(draft).not.toHaveBeenCalled()
  })

  test("clear context stays hidden for a fresh draft with no callback", () => {
    const view = render(<ChatEdgeActions sessionId="draft" />)
    expect(view.queryByRole("button", { name: "Read project memory" })).not.toBeNull()
    expect(view.queryByRole("button", { name: "Clear context" })).toBeNull()
  })

  test("clear context calls back into the host", () => {
    const clear = vi.fn()
    const view = render(<ChatEdgeActions sessionId="session-1" onClearContext={clear} />)
    fireEvent.click(view.getByRole("button", { name: "Clear context" }))
    expect(clear).toHaveBeenCalledTimes(1)
  })
})
