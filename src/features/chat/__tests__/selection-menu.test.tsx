import { drafts, importDraft } from "@alwith/module-chat/conversation"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

import { SelectionMenu, appendQuote, composeQuoteText, quoteForComposer } from "../selection-menu"

await initI18n("en")

afterEach(() => {
  cleanup()
  for (const id of [...drafts.keys()]) importDraft(id, null)
})

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

describe("appendQuote", () => {
  test("seeds the draft map when the session's composer is not open yet", () => {
    expect(appendQuote("closed-session", "第一段引用")).toBe(true)
    expect(drafts.get("closed-session")?.text).toBe("> 第一段引用\n\n")
  })

  test("a second quote into a closed session merges instead of being refused", () => {
    appendQuote("closed-session", "第一段")
    expect(appendQuote("closed-session", "第二段")).toBe(true)
    expect(drafts.get("closed-session")?.text).toBe("> 第二段\n\n> 第一段\n\n")
  })

  test("keeps attachments, mentions and the model pick when seeding a closed session", () => {
    importDraft("closed-session", {
      text: "已有草稿",
      attachments: [],
      mentions: ["/tmp/a.ts"],
      modelId: "qwen/qwen4-max-preview"
    })
    appendQuote("closed-session", "引用")
    const draft = drafts.get("closed-session")
    expect(draft?.text).toBe("> 引用\n\n已有草稿")
    expect(draft?.mentions).toEqual(["/tmp/a.ts"])
    expect(draft?.modelId).toBe("qwen/qwen4-max-preview")
  })

  test("writes through a mounted composer's controlled textarea, repeatedly", () => {
    // A controlled textarea whose onChange mirrors what the package does: setInput → draft map.
    const onChange = vi.fn((event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.currentTarget.value
      importDraft("open-session", { text: value, attachments: [], mentions: [], modelId: null })
    })
    render(
      <div data-composer>
        <textarea defaultValue="" onChange={onChange} />
      </div>
    )
    expect(appendQuote("open-session", "第一次")).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(drafts.get("open-session")?.text).toBe("> 第一次\n\n")
    // The second quote must merge with what the first one left, not be refused.
    expect(appendQuote("open-session", "第二次")).toBe(true)
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(drafts.get("open-session")?.text).toBe("> 第二次\n\n> 第一次\n\n")
  })

  test("falls back to the draft map when the mounted textarea does not take the write", () => {
    // A textarea with no onChange (composer not accepting input): the dispatch lands nowhere,
    // so the quote must still survive in the draft map instead of being silently dropped.
    render(
      <div data-composer>
        <textarea defaultValue="" />
      </div>
    )
    expect(appendQuote("open-session", "引用")).toBe(true)
    expect(drafts.get("open-session")?.text).toBe("> 引用\n\n")
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
