import { act, fireEvent, render } from "@testing-library/react"
import { beforeAll, describe, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

const draft = vi.hoisted(() => vi.fn())
vi.mock("@alwith/module-chat/conversation", () => ({ setComposerDraft: draft }))

const { ChatEdgeActions } = await import("../chat-edge-actions")

beforeAll(async () => {
  await initI18n("en")
})

async function openMenu(view: ReturnType<typeof render>): Promise<void> {
  await act(() =>
    Promise.try(() => {
      fireEvent.click(view.getByRole("button", { name: "Project memory" }))
    })
  )
}

describe("chat edge actions", () => {
  test("one collapsed project-memory trigger opens the three live actions", async () => {
    const view = render(
      <ChatEdgeActions sessionId="session-1" onCompressMemory={() => {}} onClearContext={() => {}} />
    )
    const trigger = view.getByRole("button", { name: "Project memory" })
    expect(trigger.className).toContain("w-9")
    expect(trigger.className).toContain("hover:w-44")
    expect(trigger.className).toContain("focus-visible:w-44")

    await openMenu(view)
    expect(view.getByRole("menuitem", { name: "Read project memory" })).toBeDefined()
    expect(view.getByRole("menuitem", { name: "Compress memory" })).toBeDefined()
    expect(view.getByRole("menuitem", { name: "Clear context" })).toBeDefined()
  })

  test("the memory item only stages a prompt and never sends it", async () => {
    draft.mockClear()
    const clear = vi.fn()
    const view = render(<ChatEdgeActions sessionId="draft" onClearContext={clear} />)
    await openMenu(view)

    await act(() => Promise.try(() => fireEvent.click(view.getByRole("menuitem", { name: "Read project memory" }))))

    expect(draft).toHaveBeenCalledTimes(1)
    expect(draft.mock.calls[0]?.[0]).toBe("draft")
    expect(String(draft.mock.calls[0]?.[1])).toContain("memory.md")
    expect(clear).not.toHaveBeenCalled()
  })

  test("the memory item sends straight away when the host provides a send path", async () => {
    draft.mockClear()
    const send = vi.fn(async (_text: string) => undefined)
    const view = render(<ChatEdgeActions sessionId="session-1" onSend={send} />)
    await openMenu(view)

    await act(() => Promise.try(() => fireEvent.click(view.getByRole("menuitem", { name: "Read project memory" }))))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

    expect(String(send.mock.calls[0]?.[0])).toContain("memory.md")
    expect(draft).not.toHaveBeenCalled()
  })

  test("a fresh draft menu exposes read only", async () => {
    const view = render(<ChatEdgeActions sessionId="draft" />)
    await openMenu(view)
    expect(view.getByRole("menuitem", { name: "Read project memory" })).toBeDefined()
    expect(view.queryByRole("menuitem", { name: "Compress memory" })).toBeNull()
    expect(view.queryByRole("menuitem", { name: "Clear context" })).toBeNull()
  })

  test("clear context calls back into the host", async () => {
    const clear = vi.fn()
    const view = render(<ChatEdgeActions sessionId="session-1" onClearContext={clear} />)
    await openMenu(view)
    await act(() => Promise.try(() => fireEvent.click(view.getByRole("menuitem", { name: "Clear context" }))))
    expect(clear).toHaveBeenCalledTimes(1)
  })
})
