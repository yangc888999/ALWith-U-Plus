import { createFileSystem, type FileSystem } from "@alwith/module-fs"
import { createMemoryAdapter } from "@alwith/module-fs/testing"
import { expect, test, vi } from "vitest"

import menuBridge from "../../../../src-tauri/src/html_preview_menu.js?raw"
import { createHtmlPreviewHost } from "../html-preview"

function filesystem(): FileSystem {
  return createFileSystem({
    adapter: createMemoryAdapter({
      "/repo/report/index.html": "<p>Hello</p>",
      "/repo/report/style.css": "body{}",
      "/repo/other.txt": "other"
    }),
    reportError: (error) => {
      throw error
    }
  })
}

test("opens an isolated native URL and revokes its capability on disposal", async () => {
  const invoke = vi.fn((command: string): Promise<unknown> =>
    Promise.resolve(command === "html_preview_open" ? { token: "token-1", path: "report/index.html" } : undefined)
  )
  const host = createHtmlPreviewHost("/repo", filesystem(), invoke, false)
  const preview = await host.open("/repo/report/index.html", "<p>Transformed</p>")
  expect(preview.url).toBe("preview-html://localhost/token-1/report/index.html")
  expect(invoke).toHaveBeenCalledWith("html_preview_open", {
    root: "/repo",
    path: "/repo/report/index.html",
    source: "<p>Transformed</p>"
  })
  await preview.dispose()
  expect(invoke).toHaveBeenLastCalledWith("html_preview_close", { token: "token-1" })
})

test("encodes URL segments on Windows without flattening relative resolution", async () => {
  const invoke = (): Promise<unknown> => Promise.resolve({ token: "token-2", path: "reports/a #1.html" })
  const preview = await createHtmlPreviewHost("/repo", filesystem(), invoke, true).open("/repo/reports/a #1.html", "x")
  expect(preview.url).toBe("http://preview-html.localhost/token-2/reports/a%20%231.html")
  expect(new URL("../data.json", preview.url).pathname).toBe("/token-2/data.json")
})

test("rebuilds only on the previewed file itself and unsubscribes on close", async () => {
  const fs = filesystem()
  const refresh = vi.fn()
  const host = createHtmlPreviewHost("/repo", fs, () => Promise.resolve(undefined), false)
  const off = await host.subscribe("/repo/report/index.html", refresh, (error) => {
    throw error
  })
  // Sibling and directory-sibling writes must NOT rebuild — previously the subscription was
  // directory-level and any change under /repo tore down the whole iframe (T01).
  await fs.writeFile("/repo/report/style.css", new TextEncoder().encode("body { color: red }"))
  expect(refresh).not.toHaveBeenCalled()
  await fs.writeFile("/repo/other.txt", new TextEncoder().encode("other change"))
  expect(refresh).not.toHaveBeenCalled()
  // Only the previewed file itself triggers a rebuild.
  await fs.writeFile("/repo/report/index.html", new TextEncoder().encode("<p>Changed</p>"))
  expect(refresh).toHaveBeenCalledTimes(1)
  off()
  // Unsubscribed: further changes are ignored.
  await fs.writeFile("/repo/report/index.html", new TextEncoder().encode("<p>Again</p>"))
  expect(refresh).toHaveBeenCalledTimes(1)
})

test("a self-write to the exact path does not rebuild within the suppression window", async () => {
  const fs = filesystem()
  const refresh = vi.fn()
  const host = createHtmlPreviewHost("/repo", fs, () => Promise.resolve(undefined), false)
  const off = await host.subscribe("/repo/report/index.html", refresh, (error) => {
    throw error
  })
  host.markSelfWrite("/repo/report/index.html")
  // Our own save of the previewed file: the echo is suppressed.
  await fs.writeFile("/repo/report/index.html", new TextEncoder().encode("<p>Edited</p>"))
  expect(refresh).not.toHaveBeenCalled()
  // A sibling change is unrelated directory noise and must not rebuild (T01).
  await fs.writeFile("/repo/report/style.css", new TextEncoder().encode("body{}"))
  expect(refresh).not.toHaveBeenCalled()
  // Age the self-write past SELF_WRITE_WINDOW (1200ms); an external write to the exact path now
  // rebuilds.
  const realNow = Date.now
  const start = realNow()
  vi.spyOn(Date, "now").mockReturnValue(start + 1_500)
  try {
    await fs.writeFile("/repo/report/index.html", new TextEncoder().encode("<p>External</p>"))
    expect(refresh).toHaveBeenCalledTimes(1)
  } finally {
    vi.restoreAllMocks()
  }
  off()
})

test("a self-write echo older than the window refreshes again", async () => {
  const fs = filesystem()
  const refresh = vi.fn()
  const host = createHtmlPreviewHost("/repo", fs, () => Promise.resolve(undefined), false)
  const off = await host.subscribe("/repo/report/index.html", refresh, (error) => {
    throw error
  })
  host.markSelfWrite("/repo/report/index.html")
  // Age the self-write past SELF_WRITE_WINDOW (1200ms).
  const realNow = Date.now
  const start = realNow()
  vi.spyOn(Date, "now").mockReturnValue(start + 1_500)
  try {
    await fs.writeFile("/repo/report/index.html", new TextEncoder().encode("<p>Later</p>"))
    expect(refresh).toHaveBeenCalledTimes(1)
  } finally {
    vi.restoreAllMocks()
  }
  off()
})

test("editing suspends rebuilds and replays the held change when editing ends", async () => {
  const fs = filesystem()
  const refresh = vi.fn()
  const host = createHtmlPreviewHost("/repo", fs, () => Promise.resolve(undefined), false)
  const off = await host.subscribe("/repo/report/index.html", refresh, (error) => {
    throw error
  })
  host.setEditing("/repo/report/index.html", true)
  // Sibling writes are unrelated directory noise and are ignored entirely (T01), not even held.
  await fs.writeFile("/repo/report/style.css", new TextEncoder().encode("body{color:blue}"))
  expect(refresh).not.toHaveBeenCalled()
  // A write to the previewed file itself is held while editing.
  await fs.writeFile("/repo/report/index.html", new TextEncoder().encode("<p>External</p>"))
  expect(refresh).not.toHaveBeenCalled()
  host.setEditing("/repo/report/index.html", false)
  // The held change replays exactly once on exit.
  expect(refresh).toHaveBeenCalledTimes(1)
  // Further sibling changes are still ignored...
  await fs.writeFile("/repo/report/style.css", new TextEncoder().encode("body{}"))
  expect(refresh).toHaveBeenCalledTimes(1)
  // ...but a later write to the exact path rebuilds normally.
  await fs.writeFile("/repo/report/index.html", new TextEncoder().encode("<p>Again</p>"))
  expect(refresh).toHaveBeenCalledTimes(2)
  off()
})

test("ending editing without a held change does not refresh", async () => {
  const fs = filesystem()
  const refresh = vi.fn()
  const host = createHtmlPreviewHost("/repo", fs, () => Promise.resolve(undefined), false)
  const off = await host.subscribe("/repo/report/index.html", refresh, (error) => {
    throw error
  })
  host.setEditing("/repo/report/index.html", true)
  host.setEditing("/repo/report/index.html", false)
  expect(refresh).not.toHaveBeenCalled()
  off()
})
test("a selection without mouseup survives scrolling while visible and hides outside the frame", async () => {
  const frame = document.createElement("iframe")
  document.body.append(frame)
  try {
    const doc = frame.contentDocument!
    const view = frame.contentWindow!
    doc.body.textContent = "Report passage"
    const script = doc.createElement("script")
    script.textContent = menuBridge
    doc.head.append(script)
    const post = vi.spyOn(view.parent, "postMessage").mockImplementation(() => {})
    const range = doc.createRange()
    range.selectNodeContents(doc.body)
    let top = 40
    range.getBoundingClientRect = () => new DOMRect(10, top, 100, 20)
    view.getSelection()!.addRange(range)
    doc.dispatchEvent(new Event("selectionchange"))
    const sent = (payload: object) => expect(post).toHaveBeenLastCalledWith(expect.objectContaining(payload), "*")
    await vi.waitFor(() => sent({ text: "Report passage", rect: expect.objectContaining({ top: 40 }) }))
    top = 28
    doc.dispatchEvent(new Event("scroll"))
    await vi.waitFor(() => sent({ text: "Report passage", rect: expect.objectContaining({ top: 28 }), repositionOnly: true }))
    top = -200
    doc.dispatchEvent(new Event("scroll"))
    await vi.waitFor(() => sent({ text: "", rect: null }))
    expect(view.getSelection()?.toString()).toBe("Report passage")
  } finally {
    vi.restoreAllMocks()
    frame.remove()
  }
})

test("the shipped HTML bridge forwards the selection and opens the report's own annotator", async () => {
  const frame = document.createElement("iframe")
  document.body.append(frame)
  try {
    const doc = frame.contentDocument!
    const view = frame.contentWindow!
    doc.body.innerHTML =
      '<p>First quote</p><p>Second quote</p><button id="annoFab" class="anno-fab">Notes</button><button class="anno-bubble">Comment</button>'
    const script = doc.createElement("script")
    script.textContent = menuBridge
    doc.head.append(script)
    const post = vi.spyOn(view.parent, "postMessage").mockImplementation(() => {})
    const bubble = doc.querySelector<HTMLButtonElement>(".anno-bubble")!
    const open = vi.fn(() => view.getSelection()?.toString())
    bubble.onclick = open
    expect(view.getComputedStyle(doc.querySelector("#annoFab")!).display).not.toBe("none")
    expect(view.getComputedStyle(bubble).display).toBe("none")
    const select = (index: number) => {
      const range = doc.createRange()
      range.selectNodeContents(doc.querySelectorAll("p")[index])
      range.getBoundingClientRect = () => new DOMRect(10, 10, 100, 20)
      view.getSelection()?.removeAllRanges()
      view.getSelection()?.addRange(range)
      doc.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
    }
    select(0)
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ type: "selection", text: "First quote", canComment: true }),
        "*"
      )
    )
    view.dispatchEvent(
      new MessageEvent("message", { source: view.parent, data: { source: "alwith-preview-host", type: "comment" } })
    )
    expect(open).toHaveReturnedWith("First quote")
    doc.querySelector("#annoFab")!.remove()
    select(1)
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ text: "Second quote", canComment: false }), "*")
    )
  } finally {
    vi.restoreAllMocks()
    frame.remove()
  }
})
