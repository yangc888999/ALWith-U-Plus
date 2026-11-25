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
  test("context actions are direct and independent of project memory", async () => {
    const compact = vi.fn()
    const compressMemory = vi.fn()
    const view = render(
      <ChatEdgeActions sessionId="session-1" onCompactContext={compact} onCompressMemory={compressMemory} onClearContext={vi.fn()} />
    )
    const trigger = view.getByRole("button", { name: "Project memory" })
    expect(trigger.className).toContain("w-9")
    expect(trigger.className).toContain("hover:w-44")
    expect(trigger.className).toContain("focus-visible:w-44")

    fireEvent.click(view.getByRole("button", { name: "Compact context" }))
    expect(compact).toHaveBeenCalledTimes(1)
    expect(compressMemory).not.toHaveBeenCalled()
    expect(view.getByRole("button", { name: "Clear context" })).toBeDefined()
    await openMenu(view)
    expect(view.getByRole("menuitem", { name: "Read project memory" })).toBeDefined()
    expect(view.getByRole("menuitem", { name: "Compress memory" })).toBeDefined()
    expect(view.queryByRole("menuitem", { name: "Clear context" })).toBeNull()
  })

  test("the memory item only stages a prompt and never sends it", async () => {
    draft.mockClear()
    const clear = vi.fn()
    const view = render(<ChatEdgeActions sessionId="draft" onCompactContext={vi.fn()} onClearContext={clear} />)
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
    const view = render(<ChatEdgeActions sessionId="session-1" onCompactContext={vi.fn()} onSend={send} />)
    await openMenu(view)

    await act(() => Promise.try(() => fireEvent.click(view.getByRole("menuitem", { name: "Read project memory" }))))
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))

    expect(String(send.mock.calls[0]?.[0])).toContain("memory.md")
    expect(draft).not.toHaveBeenCalled()
  })

  test("a fresh draft menu exposes read only", async () => {
    const view = render(<ChatEdgeActions sessionId="draft" onCompactContext={vi.fn()} contextEnabled={false} />)
    await openMenu(view)
    expect(view.getByRole("menuitem", { name: "Read project memory" })).toBeDefined()
    expect(view.queryByRole("menuitem", { name: "Compress memory" })).toBeNull()
    expect(view.queryByRole("menuitem", { name: "Clear context" })).toBeNull()
  })

  test("clear context only calls the host after confirmation", async () => {
    const clear = vi.fn()
    const view = render(<ChatEdgeActions sessionId="session-1" onCompactContext={vi.fn()} onClearContext={clear} />)
    const click = (name: string) => act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name }))))
    await click("Clear context")
    await click("Cancel")
    expect(clear).not.toHaveBeenCalled()
    await click("Clear context")
    await click("Confirm")
    expect(clear).toHaveBeenCalledTimes(1)
  })

  test("regular chats keep both context actions visible but inactive while busy", () => {
    const compact = vi.fn()
    const clear = vi.fn()
    const view = render(<ChatEdgeActions sessionId="chat" projectMemory={false} contextEnabled={false} onCompactContext={compact} onClearContext={clear} />)
    expect(view.queryByRole("button", { name: "Project memory" })).toBeNull()
    for (const name of ["Compact context", "Clear context"]) {
      const button = view.getByRole("button", { name }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      fireEvent.click(button)
    }
    expect(view.queryByRole("alertdialog")).toBeNull()
    expect(clear).not.toHaveBeenCalled()
    expect(compact).not.toHaveBeenCalled()
  })
})
