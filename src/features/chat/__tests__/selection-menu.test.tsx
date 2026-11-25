import { drafts, importDraft } from "@alwith/module-chat/conversation"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

import { appendQuote, composeQuoteText, quoteForComposer, SelectionMenu } from "../selection-menu"

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }))

await initI18n("en")

// jsdom has no layout: the pill's placement reads Range geometry. Empty rects are enough — the
// assertions are about visibility, not coordinates.
beforeEach(() => {
  const empty = (): DOMRect => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON: () => ({})
  })
  Range.prototype.getClientRects = function getClientRects(): DOMRectList {
    return Object.assign([empty()], {
      item: (index: number) => (index === 0 ? empty() : null)
    }) as unknown as DOMRectList
  }
  Range.prototype.getBoundingClientRect = empty
})

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

  test("a selection inside a Markdown editor in edit mode never opens the copy pill", async () => {
    render(
      <div>
        <div className="ProseMirror" data-alwith-markdown-editing="true">
          <span data-testid="editor-text">正在编辑的正文</span>
        </div>
        <SelectionMenu containerRef={{ current: null }} sessionId="" />
      </div>
    )
    const text = screen.getByTestId("editor-text")
    const range = document.createRange()
    range.selectNodeContents(text)
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

  test("the same selection still offers the pill while the Markdown preview is read-only", async () => {
    render(
      <div>
        <div className="file-workspace-editor">
          <div className="ProseMirror" data-alwith-markdown-editing="false">
            <span data-testid="preview-text">预览里的正文</span>
          </div>
        </div>
        <SelectionMenu containerRef={{ current: null }} sessionId="" />
      </div>
    )
    const text = screen.getByTestId("preview-text")
    const range = document.createRange()
    range.selectNodeContents(text)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    act(() => {
      document.dispatchEvent(new Event("selectionchange"))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    expect(screen.queryByRole("menu")).not.toBeNull()
  })

  // 2026-11-21: the pill is allowed in exactly two surfaces. Everything else keeps the native
  // gesture, including new panels nobody remembered to add to the old denylist.
  const selectAndWait = async (testId: string): Promise<void> => {
    const node = screen.getByTestId(testId)
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    act(() => {
      document.dispatchEvent(new Event("selectionchange"))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
  }

  test("the transcript opens the pill", async () => {
    render(
      <div>
        <div data-chat-content>
          <span data-testid="message-text">对话正文</span>
        </div>
        <SelectionMenu containerRef={{ current: null }} sessionId="s" />
      </div>
    )
    await selectAndWait("message-text")
    expect(screen.queryByRole("menu")).not.toBeNull()
  })

  test("a sidebar selection never opens the pill", async () => {
    render(
      <div>
        <div className="main-sidebar-panel">
          <span data-testid="sidebar-text">会话标题</span>
        </div>
        <SelectionMenu containerRef={{ current: null }} sessionId="s" />
      </div>
    )
    await selectAndWait("sidebar-text")
    expect(screen.queryByRole("menu")).toBeNull()
  })

  test("a source editor showing .md or .html never opens the pill", async () => {
    render(
      <div>
        <div className="file-workspace-editor">
          <div className="monaco-editor">
            <span data-testid="code-text"># 标题</span>
          </div>
        </div>
        <SelectionMenu containerRef={{ current: null }} sessionId="s" />
      </div>
    )
    await selectAndWait("code-text")
    expect(screen.queryByRole("menu")).toBeNull()
  })
})

describe("comment integration", () => {
  // The document viewer draws its own floating 评论 button; the bar absorbs it instead of
  // stacking two pills on one selection (2026-11-21).
  test("a Markdown viewer's native trigger must not add 评论 to a host that never enabled it", async () => {
    const viewerClick = vi.fn()
    const trigger = document.createElement("button")
    trigger.dataset.testid = "comment-selection-button"
    trigger.addEventListener("click", viewerClick)
    document.body.append(trigger)
    try {
      render(
        <div>
          <div className="file-workspace-editor">
            <div className="ProseMirror" data-alwith-markdown-editing="false">
              <span data-testid="doc-text">文档正文</span>
            </div>
          </div>
          <SelectionMenu containerRef={{ current: null }} sessionId="s" />
        </div>
      )
      const node = screen.getByTestId("doc-text")
      const range = document.createRange()
      range.selectNodeContents(node)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      act(() => {
        document.dispatchEvent(new Event("selectionchange"))
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250))
      })
      // 评论 is an HTML-preview capability; discovering the viewer's trigger is not enough.
      expect(screen.queryByRole("menuitem", { name: /评论|Comment/ })).toBeNull()
      expect(viewerClick).not.toHaveBeenCalled()
    } finally {
      trigger.remove()
    }
  })
})

describe("preview selection", () => {
  const placement = { left: 40, top: 40, text: "预览里选中的文字" }

  test("a forwarded iframe selection can be copied and quoted without success notices", async () => {
    const notice = vi.spyOn(toast, "success")
    try {
      render(<SelectionMenu containerRef={{ current: null }} sessionId="session-1" external={placement} />)
      expect(screen.getAllByRole("menuitem")).toHaveLength(2)
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: /copy/i }))
      })
      expect(writeText).toHaveBeenCalledWith(placement.text)
      fireEvent.click(screen.getByRole("menuitem", { name: /add/i }))
      expect(drafts.get("session-1")?.text).toContain(placement.text)
      expect(notice).not.toHaveBeenCalled()
    } finally {
      notice.mockRestore()
    }
  })

  test("a constrained preview menu stays above the iframe and its actions remain clickable", async () => {
    const panel = document.createElement("div")
    panel.className = "file-workspace-editor"
    panel.getBoundingClientRect = () => new DOMRect(20, 30, 600, 500)
    document.body.append(panel)
    vi.mocked(writeText).mockClear()
    try {
      render(
        <SelectionMenu
          containerRef={{ current: null }}
          sessionId="portal-session"
          external={{ left: 40, top: 40, text: "固定浮层里的文字" }}
          portalTarget={panel}
        />
      )
      const menu = screen.getByRole("menu")
      // The iframe native layer must not be able to cover the actions.
      expect(menu.parentElement).toBe(document.body)
      expect(menu).toHaveClass("fixed")
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: /copy/i }))
      })
      expect(writeText).toHaveBeenCalledWith("固定浮层里的文字")
      fireEvent.click(screen.getByRole("menuitem", { name: /add/i }))
      expect(drafts.get("portal-session")?.text).toContain("固定浮层里的文字")
    } finally {
      panel.remove()
    }
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
    render(<SelectionMenu containerRef={{ current: null }} sessionId="" external={placement} allowAdd={false} />)
    expect(screen.getAllByRole("menuitem")).toHaveLength(1)
  })
})

describe("comment scope", () => {
  const selectAndWait = async (testId: string): Promise<void> => {
    const node = screen.getByTestId(testId)
    const range = document.createRange()
    range.selectNodeContents(node)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    act(() => {
      document.dispatchEvent(new Event("selectionchange"))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
  }

  test("the preview-scoped bar never answers a transcript selection, from a document host", async () => {
    render(
      <div>
        <div data-chat-content>
          <span data-testid="scope-transcript-text">对话正文</span>
        </div>
        <SelectionMenu containerRef={{ current: null }} sessionId="s" scope="preview" />
      </div>
    )
    await selectAndWait("scope-transcript-text")
    expect(screen.queryByRole("menu")).toBeNull()
  })

  test("the transcript-scoped bar never offers 评论 even when a viewer trigger exists", async () => {
    const trigger = document.createElement("button")
    trigger.dataset.testid = "comment-selection-button"
    document.body.append(trigger)
    try {
      render(
        <div>
          <div data-chat-content>
            <span data-testid="scope-transcript-comment">对话正文</span>
          </div>
          <SelectionMenu containerRef={{ current: null }} sessionId="s" scope="transcript" />
        </div>
      )
      await selectAndWait("scope-transcript-comment")
      expect(screen.queryByRole("menu")).not.toBeNull()
      expect(screen.queryByRole("menuitem", { name: /评论|Comment/ })).toBeNull()
    } finally {
      trigger.remove()
    }
  })

  test("the preview-scoped bar never offers 评论 inside the preview", async () => {
    const trigger = document.createElement("button")
    trigger.dataset.testid = "comment-selection-button"
    document.body.append(trigger)
    try {
      render(
        <div>
          <div className="file-workspace-editor">
            <span data-testid="scope-preview-text">预览正文</span>
          </div>
          <SelectionMenu containerRef={{ current: null }} sessionId="s" scope="preview" />
        </div>
      )
      await selectAndWait("scope-preview-text")
      expect(screen.queryByRole("menuitem", { name: /评论|Comment/ })).toBeNull()
    } finally {
      trigger.remove()
    }
  })
})
