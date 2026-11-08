import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

import { SelectionMenu, composeQuoteText, quoteForComposer } from "../selection-menu"

await initI18n("en")

afterEach(() => cleanup())

describe("selection menu quote", () => {
  test("prefixes every selected line, including blank ones", () => {
    expect(quoteForComposer("第一行\n\n第三行")).toBe("> 第一行\n>\n> 第三行")
  })

  test("keeps a single-line selection on one quote line", () => {
    expect(quoteForComposer("只有一行")).toBe("> 只有一行")
  })

  test("prepends the quote to an existing draft and keeps the draft below", () => {
    expect(composeQuoteText("原有草稿", "引用内容")).toBe("> 引用内容\n\n原有草稿")
  })

  test("an empty draft becomes just the quote", () => {
    expect(composeQuoteText("   ", "引用内容")).toBe("> 引用内容\n\n")
  })
})

describe("selection menu placement", () => {
  test("a file-tree selection never opens the copy pill", async () => {
    render(
      <div>
        <div className="file-workspace-tree">
          <span data-testid="tree-row">notes.md</span>
        </div>
        <SelectionMenu containerRef={{ current: null }} sessionId="" />
      </div>
    )
    const row = screen.getByTestId("tree-row")
    const range = document.createRange()
    range.selectNodeContents(row)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    act(() => {
      document.dispatchEvent(new Event("selectionchange"))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    expect(screen.queryByRole("menu")).toBeNull()
  })
})

describe("preview selection", () => {
  const placement = { left: 40, top: 40, text: "预览里选中的文字" }

  test("a forwarded iframe selection can be quoted into the conversation", () => {
    render(
      <SelectionMenu containerRef={{ current: null }} sessionId="session-1" external={placement} />
    )
    // Copy + add-to-chat. An empty session id used to make the second action unreachable.
    expect(screen.getAllByRole("menuitem")).toHaveLength(2)
  })

  test("explicit dismissal clears the placement held by the preview host", () => {
    const onDismiss = vi.fn()
    render(
      <SelectionMenu
        containerRef={{ current: null }}
        sessionId="session-1"
        external={placement}
        onDismiss={onDismiss}
      />
    )
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    })
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  test("a host with no composer can still restrict the pill to copy", () => {
    render(
      <SelectionMenu
        containerRef={{ current: null }}
        sessionId=""
        external={placement}
        allowAdd={false}
      />
    )
    expect(screen.getAllByRole("menuitem")).toHaveLength(1)
  })
})
