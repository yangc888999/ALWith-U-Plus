import type { TextEditorProps } from "@alwith/module-editor"
import { ownsItsContextMenu } from "../file-workspace"
import { type FsAdapter, normalizePath, type WriteOptions } from "@alwith/module-fs"
import type { NativeRequest } from "@alwith/module-fs/tauri"
import { createMemoryAdapter } from "@alwith/module-fs/testing"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { toast } from "sonner"
import { StrictMode, useState } from "react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { WindowsWorkspaceControlsContext } from "@/components/alwith-ui/windows-main-window-shell"
import { ChatHeader } from "@/features/chat/chat-header"
import { openGuideWindow } from "@/features/guide/guide-window"
import { CanvasContext } from "@/features/layout/lib/canvas-context"
import { initI18n } from "@/lib/i18n"
import { settingsStore } from "@/lib/settings-store"

import { WorkspaceHeaderContext } from "../context"
import { FileWorkspace } from "../file-workspace"
import { DRAFT_DIRECTORY_KEY, projectDirectoryAttempt, type ProjectDirectoryReason } from "../project-directory"

vi.mock("@/features/guide/guide-window", () => ({ openGuideWindow: vi.fn() }))

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn((_event: string, _handler: () => void) => Promise.resolve((): void => {})),
  nativeMode: false,
  close: null as ((event: { preventDefault(): void }) => void) | null
}))
let clipboardText: string
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (text: string): Promise<void> => {
    clipboardText = text
    return Promise.resolve()
  }
}))
vi.mock("@/components/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => native.nativeMode }))
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    listen: native.listen,
    onDragDropEvent: () => Promise.resolve((): void => {}),
    onCloseRequested: (callback: (event: { preventDefault(): void }) => void) => {
      native.close = callback
      return Promise.resolve((): void => {
        native.close = null
      })
    }
  })
}))
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen, emit: vi.fn(), emitTo: vi.fn() }))
vi.mock("@/features/chat/codex/markdown-renderer", () => ({
  CodexMarkdownRenderer: ({ text }: { text: string }) => <article>{text}</article>
}))
vi.mock("../monaco-editor", () => ({
  default: (props: TextEditorProps) => (
    <textarea aria-label="Code" value={props.document.text} onChange={(event) => props.onChange(event.target.value)} />
  ),
  releaseMonaco: vi.fn()
}))
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing native request field")
  return value
}
let adapter: FsAdapter
let authorize: ((path: string) => Promise<string>) | null
// Task #5 / ④: the native group folder picker used by the invalid empty state.
let pickedGroupDirectory: string | null = null
beforeEach(async () => {
  localStorage.clear()
  vi.clearAllMocks()
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(280)
  // @tanstack/react-virtual 3.14.21 measures the scroll element with clientHeight / clientWidth.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("file-workspace-layout") ? 1000 : 280
  })
  native.nativeMode = false
  native.close = null
  await initI18n("en")
  authorize = null
  pickedGroupDirectory = null
  adapter = createMemoryAdapter({ "/a/one.txt": "first", "/b/two.txt": "second" })
  native.invoke.mockImplementation(
    async (command: string, args: { cwd?: string; path?: string; request?: NativeRequest }): Promise<unknown> => {
      if (command === "draft_directory") return args.cwd
      if (command === "pick_group_directory") return pickedGroupDirectory
      if (command === "workspace_open") return authorize === null ? args.path : authorize(required(args.path))
      if (command === "workspace_watch" || command === "workspace_dirty" || command === "workspace_exit") return null
      if (command !== "workspace_file" || !args.request) throw new Error(`Unexpected native command: ${command}`)
      const r = args.request
      switch (r.operation) {
        case "stat":
          return adapter.stat(r.path)
        case "readDirectory":
          return adapter.readDirectory(r.path, {
            showHidden: required(r.showHidden),
            showIgnored: required(r.showIgnored)
          })
        case "readFile":
          return [...(await adapter.readFile(r.path))]
        case "writeFile":
          return adapter.writeFile(r.path, new Uint8Array(required(r.data)), {
            mode: r.mode as WriteOptions["mode"],
            expectedVersion: r.expectedVersion
          })
        case "move":
          return adapter.move(r.path, required(r.to))
        case "createDirectory":
          return adapter.createDirectory(r.path)
        case "remove":
          return adapter.remove(r.path)
        default:
          throw new Error(`Unexpected operation: ${r.operation}`)
      }
    }
  )
})

test("remount restores pinned files, active file and expanded folders without draft persistence", async () => {
  const view = render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  const row = await screen.findByRole("treeitem", { name: /one.txt/ })
  fireEvent.doubleClick(row)
  await screen.findByRole("textbox", { name: "Code" })
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), { target: { value: "unsaved body" } })
  await waitFor(() => expect(localStorage.getItem("workspace:/a")).toContain('"pinned":true'))
  expect(localStorage.getItem("workspace:/a")).not.toContain("unsaved body")
  view.unmount()
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  expect(await screen.findByRole("textbox", { name: "Code" })).toHaveValue("first")
  expect(screen.getByRole("tab", { name: "one.txt" }).closest("[data-transient]")).toHaveAttribute(
    "data-transient",
    "false"
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
test("Windows moves only the workspace toggle into the title bar and preserves its action", async () => {
  const target = document.createElement("div")
  document.body.append(target)
  try {
    const view = render(
      <WindowsWorkspaceControlsContext.Provider value={target}>
        <Surface cwd="/a" />
      </WindowsWorkspaceControlsContext.Provider>
    )
    fireEvent.click(within(target).getByRole("button", { name: "Open preview area" }))
    await screen.findByRole("treeitem", { name: /one.txt/ })
    expect(within(target).getByRole("button", { name: "Close workspace" })).toHaveAttribute("aria-expanded", "true")
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }))
    expect(document.querySelector(".file-workspace-layout")).toHaveAttribute("data-view-mode", "true")
    fireEvent.click(screen.getByRole("button", { name: "Restore" }))
    expect(document.querySelector(".file-workspace-layout")).toHaveAttribute("data-view-mode", "false")
    fireEvent.click(within(target).getByRole("button", { name: "Close workspace" }))
    expect(within(target).getByRole("button", { name: "Open preview area" })).toHaveAttribute("aria-expanded", "false")
    view.unmount()
    expect(target).toBeEmptyDOMElement()
  } finally {
    target.remove()
  }
})
function Surface({
  cwd,
  chatRevealRequest = 0,
  defaultOpen = false,
  columnsRequest = 0,
  reason = "project",
  guidance = null,
  invalidDirectory = null,
  directoryKey = undefined,
  sessionId = null
}: {
  cwd: string | null
  chatRevealRequest?: number
  defaultOpen?: boolean
  columnsRequest?: number
  reason?: ProjectDirectoryReason
  guidance?: string | null
  invalidDirectory?: string | null
  directoryKey?: string
  sessionId?: string | null
}) {
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null)
  return (
    <WorkspaceHeaderContext.Provider value={toolbar}>
      <div ref={setToolbar} data-testid="window-titlebar" />
      <FileWorkspace
        cwd={cwd}
        sessionId={sessionId}
        directoryKey={directoryKey}
        chatRevealRequest={chatRevealRequest}
        defaultOpen={defaultOpen}
        columnsRequest={columnsRequest}
        reason={reason}
        guidance={guidance}
        invalidDirectory={invalidDirectory}
      >
        <ChatHeader title="Conversation" project={<span>Project</span>}>
          {null}
        </ChatHeader>
        <div>Chat {cwd}</div>
      </FileWorkspace>
    </WorkspaceHeaderContext.Provider>
  )
}

test.each(["tree", "tab"])("copies the %s file path without browser clipboard access", async (surface) => {
  clipboardText = ""
  const browserWrite = vi.fn((): Promise<void> => {
    return Promise.try(() => {
      throw new DOMException("Clipboard access denied", "NotAllowedError")
    })
  })
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: browserWrite } })
  try {
    render(<Surface cwd="/a" />)
    fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
    const file = await screen.findByRole("treeitem", { name: "one.txt" })
    if (surface === "tab") {
      fireEvent.doubleClick(file)
      await screen.findByRole("textbox", { name: "Code" })
    }
    fireEvent.contextMenu(surface === "tree" ? file : screen.getByRole("tab", { name: "one.txt" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy path" }))
    await waitFor(() => expect(clipboardText).toBe("/a/one.txt"))
    expect(browserWrite).not.toHaveBeenCalled()
  } finally {
    if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard)
    else Reflect.deleteProperty(navigator, "clipboard")
  }
})

test.each([String.raw`\\?\C:\projects\alwith-u`, String.raw`\\?\UNC\server\share\alwith-u`])(
  "Windows breadcrumbs use relative paths and reveal the real folder for %s",
  async (root) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32")
    const normalizedRoot = normalizePath(root)
    adapter = createMemoryAdapter({ [`${normalizedRoot}/folder/bunfig.toml`]: "content" })
    authorize = () => Promise.resolve(root)
    render(<Surface cwd={root} />)
    fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
    const project = await screen.findByRole("treeitem", { name: /alwith-u/ })
    fireEvent.click(project)
    fireEvent.keyDown(project, { key: "ArrowRight" })
    const folder = await screen.findByRole("treeitem", { name: /folder/ })
    fireEvent.click(folder)
    fireEvent.keyDown(folder, { key: "ArrowRight" })
    fireEvent.click(await screen.findByRole("treeitem", { name: /bunfig.toml/ }))
    await screen.findByRole("textbox", { name: "Code" })
    const breadcrumbs = screen.getByRole("navigation", { name: "File path" })
    expect(
      within(breadcrumbs)
        .getAllByRole("button")
        .map((button) => button.textContent)
    ).toEqual(["folder", "bunfig.toml"])
    expect(breadcrumbs).toHaveAttribute("title", `${normalizedRoot}/folder/bunfig.toml`)
    native.invoke.mockClear()
    fireEvent.click(within(breadcrumbs).getByRole("button", { name: "folder" }))
    await waitFor(() =>
      expect(native.invoke).toHaveBeenCalledWith("workspace_file", {
        request: expect.objectContaining({ operation: "readDirectory", root, path: normalizedRoot }) as unknown
      })
    )
    await waitFor(() =>
      expect(screen.getByRole("treeitem", { name: /folder/ })).toHaveAttribute("aria-selected", "true")
    )
  }
)

test("right workspace edits, renames and saves through installed packages", async () => {
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.click(await screen.findByRole("treeitem", { name: /one.txt/ }))
  expect(document.querySelector(".file-workspace-panel > header")).toBeNull()
  expect(screen.getByTestId("tree-toggle")).toHaveAttribute("aria-expanded", "true")
  const code = await screen.findByRole("textbox", { name: "Code" })
  fireEvent.change(code, { target: { value: "edited" } })
  fireEvent.contextMenu(screen.getByRole("treeitem", { name: "one.txt" }))
  fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }))
  const name = await screen.findByRole("textbox", { name: "Rename" })
  fireEvent.change(name, { target: { value: "renamed.txt" } })
  fireEvent.keyDown(name, { key: "Enter" })
  await waitFor(() => expect(document.body).toContainOneByRole("tab", { name: "renamed.txt •" }))
  fireEvent.click(
    within(required(document.querySelector<HTMLElement>(".alwith-editor-toolbar"))).getByRole("button", {
      name: "More actions"
    })
  )
  fireEvent.click(await screen.findByRole("menuitem", { name: "Save" }))
  await waitFor(() => expect(document.body).toContainOneByRole("tab", { name: "renamed.txt" }))
  expect(new TextDecoder().decode(await adapter.readFile("/a/renamed.txt"))).toBe("edited")
  expect(await adapter.stat("/a/one.txt")).toBeNull()
  expect(document.body).toContainOneByText("Chat /a")
})

test("an old authorization response cannot open another chat's workspace", async () => {
  let finish!: (value: string) => void
  authorize = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const view = render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("workspace_open", { path: "/a" }))
  view.rerender(<Surface cwd="/b" />)
  await act(() => {
    return Promise.try(() => {
      finish("/a")
    })
  })
  expect(screen.queryByRole("tree")).toBeNull()
  authorize = null
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  await screen.findByRole("treeitem", { name: /two.txt/ })
  expect(screen.queryByRole("treeitem", { name: /one.txt/ })).toBeNull()
})

test("switching projects retains unsaved documents and cancelling close retains edits", async () => {
  const view = render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.click(await screen.findByRole("treeitem", { name: /one.txt/ }))
  fireEvent.change(await screen.findByRole("textbox", { name: "Code" }), { target: { value: "draft" } })
  view.rerender(<Surface cwd="/b" />)
  await screen.findByRole("treeitem", { name: /two.txt/ })
  view.rerender(<Surface cwd="/a" />)
  await waitFor(() => expect(document.body).toContainOneByDisplayValue("draft"))
  fireEvent.click(required(screen.getByRole("tab", { name: "one.txt •" }).querySelector(".alwith-workspace-tab-close")))
  await screen.findByRole("dialog")
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(document.body).toContainOneByDisplayValue("draft")
  expect(new TextDecoder().decode(await adapter.readFile("/a/one.txt"))).toBe("first")
})

test("native dirty state follows the aggregate across workspace switches", async () => {
  const view = render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.click(await screen.findByRole("treeitem", { name: /one.txt/ }))
  fireEvent.change(await screen.findByRole("textbox", { name: "Code" }), { target: { value: "changed a" } })
  view.rerender(<Surface cwd="/b" />)
  fireEvent.click(await screen.findByRole("treeitem", { name: /two.txt/ }))
  await screen.findByRole("textbox", { name: "Code" })
  view.rerender(<Surface cwd="/a" />)
  await waitFor(() => expect(document.body).toContainOneByDisplayValue("changed a"))
  fireEvent.click(
    within(required(document.querySelector<HTMLElement>(".alwith-editor-toolbar"))).getByRole("button", {
      name: "More actions"
    })
  )
  fireEvent.click(await screen.findByRole("menuitem", { name: "Save" }))
  await waitFor(() => expect(document.body).toContainOneByRole("tab", { name: "one.txt" }))
  view.rerender(<Surface cwd="/b" />)
  await waitFor(() => expect(document.body).toContainOneByDisplayValue("second"))
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), { target: { value: "changed b" } })
  const notifications = native.invoke.mock.calls.filter(([command]) => command === "workspace_dirty")
  expect(notifications.at(-1)).toEqual(["workspace_dirty", { dirty: true }])
})

function requestExit(): void {
  required(native.listen.mock.calls.find(([name]) => name === "workspace:shutdown")?.[1])()
}

test("main-window close is left to the resident host without prompting or approving exit", async () => {
  native.nativeMode = true
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.doubleClick(await screen.findByRole("treeitem", { name: "one.txt" }))
  fireEvent.change(await screen.findByRole("textbox", { name: "Code" }), { target: { value: "kept in memory" } })
  expect(native.close).toBeNull()
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(native.invoke).not.toHaveBeenCalledWith("workspace_exit")
  expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue("kept in memory")
})

test("discarding on explicit quit takes the approved native exit path", async () => {
  native.nativeMode = true
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.click(await screen.findByRole("treeitem", { name: /one.txt/ }))
  fireEvent.change(await screen.findByRole("textbox", { name: "Code" }), { target: { value: "draft" } })
  expect(native.close).toBeNull()
  await act(() => Promise.try(() => requestExit()))
  fireEvent.click(await screen.findByRole("button", { name: "Discard" }))
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("workspace_exit"))
  expect(new TextDecoder().decode(await adapter.readFile("/a/one.txt"))).toBe("first")
})

test("preview controls switch view mode and retain edits across hiding", async () => {
  render(<Surface cwd="/a" />)
  expect(screen.queryByRole("button", { name: "Maximize" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.click(await screen.findByRole("treeitem", { name: /one.txt/ }))
  fireEvent.change(await screen.findByRole("textbox", { name: "Code" }), { target: { value: "retained draft" } })
  expect(screen.getByRole("button", { name: "Maximize" }).querySelector(".lucide-maximize-2")).not.toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Maximize" }))
  const chat = required(document.querySelector(".file-workspace-chat"))
  expect(chat.querySelector("header")).toHaveTextContent("Conversation")
  expect(chat.closest(".file-workspace-slide")).toHaveAttribute("aria-hidden", "true")
  expect(chat.closest(".file-workspace-slide")).toHaveAttribute("inert")
  expect(document.querySelector(".alwith-workspace-tabbar")).toContainOneByRole("button", {
    name: "Restore"
  })
  const titlebar = within(screen.getByTestId("window-titlebar"))
  expect(titlebar.getByRole("button", { name: "Open preview area" })).toHaveAttribute("aria-expanded", "true")
  const layout = document.querySelector(".file-workspace-layout")
  expect(layout).toHaveAttribute("data-view-mode", "true")
  fireEvent.click(titlebar.getByRole("button", { name: "Open preview area" }))
  expect(layout).toHaveAttribute("data-view-mode", "false")
  expect(chat.closest(".file-workspace-slide")).toHaveAttribute("aria-hidden", "false")
  expect(chat.closest(".file-workspace-slide")).not.toHaveAttribute("inert")
  const tree = screen.getByRole("tree")
  const editor = screen.getByRole("textbox", { name: "Code" })
  expect(editor.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  fireEvent.click(screen.getByRole("button", { name: "Maximize" }))
  fireEvent.click(screen.getByRole("button", { name: "Restore" }))
  expect(layout).toHaveAttribute("data-view-mode", "false")
  fireEvent.click(screen.getByRole("button", { name: "Maximize" }))
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }))
  expect(screen.queryByRole("button", { name: "Maximize" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  await waitFor(() => expect(document.body).toContainOneByDisplayValue("retained draft"))
  expect(layout).toHaveAttribute("data-view-mode", "false")
})

test("chat reveal requests restore the chat pane without closing the preview or losing edits", async () => {
  const view = render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.click(await screen.findByRole("treeitem", { name: "one.txt" }))
  fireEvent.change(await screen.findByRole("textbox", { name: "Code" }), { target: { value: "retained draft" } })
  fireEvent.click(screen.getByRole("button", { name: "Maximize" }))
  const layout = required(document.querySelector(".file-workspace-layout"))
  expect(layout).toHaveAttribute("data-view-mode", "true")
  view.rerender(<Surface cwd="/a" />)
  expect(layout).toHaveAttribute("data-view-mode", "true")
  view.rerender(<Surface cwd="/a" chatRevealRequest={1} />)
  await waitFor(() => expect(layout).toHaveAttribute("data-view-mode", "false"))
  expect(screen.getByText("Chat /a")).toBeVisible()
  expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue("retained draft")
  expect(screen.getByRole("button", { name: "Close workspace" })).toHaveAttribute("aria-expanded", "true")
})

test("Desktop-style context menu, inline rename cancellation, and search keyboard controls", async () => {
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  const row = await screen.findByRole("treeitem", { name: /one.txt/ })
  fireEvent.contextMenu(row)
  const rename = await screen.findByRole("menuitem", { name: "Rename" })
  fireEvent.click(rename)
  const input = await screen.findByRole("textbox", { name: "Rename" })
  fireEvent.change(input, { target: { value: "cancelled.txt" } })
  fireEvent.keyDown(input, { key: "Escape" })
  expect(await adapter.stat("/a/one.txt")).not.toBeNull()
  expect(await adapter.stat("/a/cancelled.txt")).toBeNull()
  fireEvent.keyDown(screen.getByRole("tree"), { key: "f", metaKey: true })
  const search = await screen.findByRole("textbox", { name: "Filter loaded files" })
  fireEvent.change(search, { target: { value: "missing" } })
  expect(screen.queryByRole("treeitem", { name: /one.txt/ })).toBeNull()
  fireEvent.keyDown(search, { key: "Escape" })
  expect(document.body).toContainOneByRole("treeitem", { name: /one.txt/ })
})

test("reopening the preview reuses the authorized workspace", async () => {
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  await screen.findByRole("treeitem", { name: /one.txt/ })
  fireEvent.click(screen.getByRole("button", { name: "Close workspace" }))
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  await screen.findByRole("treeitem", { name: /one.txt/ })
  expect(native.invoke.mock.calls.filter(([command]) => command === "workspace_open")).toHaveLength(1)
})

test("rapid preview clicks share one pending authorization", async () => {
  let finish!: (value: string) => void
  authorize = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  render(<Surface cwd="/a" />)
  const open = screen.getByRole("button", { name: "Open preview area" })
  fireEvent.click(open)
  fireEvent.click(open)
  await waitFor(() =>
    expect(native.invoke.mock.calls.filter(([command]) => command === "workspace_open")).toHaveLength(1)
  )
  await act(() => {
    return Promise.try(() => {
      finish("/a")
    })
  })
  await screen.findByRole("treeitem", { name: /one.txt/ })
  expect(native.invoke.mock.calls.filter(([command]) => command === "workspace_open")).toHaveLength(1)
})

// A drag suppresses its trailing click, but must not swallow the next root click.
test("root remains clickable after cancelling a pointer drag outside the tree", async () => {
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  const file = await screen.findByRole("treeitem", { name: "one.txt" })
  fireEvent(file, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }))
  fireEvent(document, new MouseEvent("pointermove", { bubbles: true, clientX: 30, clientY: 30 }))
  fireEvent(document, new MouseEvent("pointerup", { bubbles: true }))
  const root = screen.getByRole("treeitem", { name: "a" })
  fireEvent(root, new MouseEvent("pointerdown", { bubbles: true, button: 0 }))
  fireEvent.click(root)
  await waitFor(() => expect(root).toHaveAttribute("aria-expanded", "false"))
  expect(screen.queryByRole("treeitem", { name: "one.txt" })).toBeNull()
})

test("explorer icon toggles the tree while preserving the open document and selection", async () => {
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.click(await screen.findByRole("treeitem", { name: "one.txt" }))
  await screen.findByRole("textbox", { name: "Code" })
  fireEvent.click(screen.getByTestId("tree-toggle"))
  expect(document.querySelector(".file-workspace-tree")).toHaveAttribute("data-collapsed", "true")
  expect(document.body).toContainOneByRole("tab", { name: "one.txt" })
  fireEvent.click(screen.getByTestId("tree-toggle"))
  expect(screen.getByRole("treeitem", { name: "one.txt" })).toHaveAttribute("aria-selected", "true")
  expect(screen.getByRole("navigation", { name: "File path" })).toHaveAttribute("title", "/a/one.txt")
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
})

test("more than twelve pinned files retain every tab and reload deferred content", async () => {
  adapter = createMemoryAdapter(
    Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`/a/file${index}.txt`, `body ${index}`]))
  )
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  for (let index = 0; index < 14; index++) {
    fireEvent.doubleClick(await screen.findByRole("treeitem", { name: `file${index}.txt` }))
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue(`body ${index}`))
  }
  expect(screen.getAllByRole("tab")).toHaveLength(14)
  fireEvent.click(screen.getByRole("tab", { name: "file0.txt" }))
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue("body 0"))
  expect(screen.getAllByRole("tab")).toHaveLength(14)
}, 20000)

test("cancelled close-others keeps the dirty document and remaining tabs", async () => {
  await adapter.writeFile("/a/two.txt", new TextEncoder().encode("second"), { mode: "create" })
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.doubleClick(await screen.findByRole("treeitem", { name: "one.txt" }))
  await screen.findByRole("textbox", { name: "Code" })
  fireEvent.doubleClick(screen.getByRole("treeitem", { name: "two.txt" }))
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue("second"))
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), { target: { value: "unsaved" } })
  fireEvent.contextMenu(screen.getByRole("tab", { name: "one.txt" }))
  fireEvent.click(await screen.findByRole("menuitem", { name: "Close others" }))
  await screen.findByRole("dialog")
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(screen.getAllByRole("tab")).toHaveLength(2)
  expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue("unsaved")
})

test("tab strip accepts horizontal trackpad and vertical wheel scrolling", async () => {
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.click(await screen.findByRole("treeitem", { name: "one.txt" }))
  const tabs = required(document.querySelector<HTMLElement>(".alwith-workspace-tab-scroll"))
  Object.defineProperties(tabs, { scrollWidth: { value: 800 }, clientWidth: { value: 200 } })
  fireEvent.wheel(tabs, { deltaX: 60, deltaY: 0 })
  expect(tabs.scrollLeft).toBe(60)
  fireEvent.wheel(tabs, { deltaX: 0, deltaY: 40 })
  expect(tabs.scrollLeft).toBe(100)
  fireEvent.wheel(tabs, { deltaY: 40, ctrlKey: true })
  expect(tabs.scrollLeft).toBe(100)
})

test("Desktop keyboard navigation accumulates shift selection and Home only changes focus", async () => {
  adapter = createMemoryAdapter({ "/a/alpha.txt": "a", "/a/beta.txt": "b", "/a/gamma.txt": "c" })
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.click(await screen.findByRole("treeitem", { name: "alpha.txt" }))
  await screen.findByRole("tab", { name: "alpha.txt" })
  const tree = screen.getByRole("tree")
  fireEvent.keyDown(tree, { key: "ArrowDown", shiftKey: true })
  fireEvent.keyDown(tree, { key: "ArrowDown", shiftKey: true })
  fireEvent.keyDown(tree, { key: "ArrowUp", shiftKey: true })
  for (const name of ["alpha.txt", "beta.txt", "gamma.txt"]) {
    expect(screen.getByRole("treeitem", { name })).toHaveAttribute("aria-selected", "true")
  }
  fireEvent.keyDown(tree, { key: "Home" })
  expect(screen.getByRole("treeitem", { name: "a" })).toHaveAttribute("aria-selected", "false")
  expect(tree.getAttribute("aria-activedescendant")).toBe(screen.getByRole("treeitem", { name: "a" }).id)
})

test("the file tree keeps its own right-click menu", () => {
  // A row inside the tree answers true; anything else in the editor surface stays with the text menu.
  const tree = document.createElement("section")
  tree.className = "alwith-file-tree"
  const row = document.createElement("div")
  row.setAttribute("data-file-path", "/a/one.txt")
  const name = document.createElement("span")
  row.append(name)
  tree.append(row)

  expect(ownsItsContextMenu(name)).toBe(true)
  expect(ownsItsContextMenu(row)).toBe(true)
  expect(ownsItsContextMenu(tree)).toBe(true)
  expect(ownsItsContextMenu(document.createElement("p"))).toBe(false)
})

test("starting a chat in a project reopens the columns that were closed on a previous visit", async () => {
  // A project opens its columns once per run; the reader then closes them and starts another chat
  // in the same project. The instance stays mounted (that is how the real workspace behaves), so
  // only the explicit signal can bring the columns back.
  const view = render(<Surface cwd="/a" defaultOpen />)
  expect(await screen.findByRole("treeitem", { name: /one.txt/ })).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "Close workspace" }))
  await waitFor(() => expect(screen.queryByRole("treeitem", { name: /one.txt/ })).toBeNull())

  view.rerender(<Surface cwd="/a" defaultOpen columnsRequest={1} />)
  expect(await screen.findByRole("treeitem", { name: /one.txt/ })).toBeInTheDocument()
})

test("Desktop root context menu omits rename, copy and delete", async () => {
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.contextMenu(await screen.findByRole("treeitem", { name: "a" }))
  await screen.findByRole("menu")
  for (const name of ["Rename", "Copy", "Delete"]) expect(screen.queryByRole("menuitem", { name })).toBeNull()
})

test("single-click replaces a clean preview, double-click pins it, and editing pins it", async () => {
  adapter = createMemoryAdapter({ "/a/alpha.txt": "a", "/a/beta.txt": "b", "/a/gamma.txt": "c" })
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.click(await screen.findByRole("treeitem", { name: "alpha.txt" }))
  await screen.findByRole("tab", { name: "alpha.txt" })
  fireEvent.click(screen.getByRole("treeitem", { name: "beta.txt" }))
  await screen.findByRole("tab", { name: "beta.txt" })
  await waitFor(() => expect(screen.queryByRole("tab", { name: "alpha.txt" })).toBeNull())
  fireEvent.doubleClick(screen.getByRole("treeitem", { name: "beta.txt" }))
  fireEvent.click(screen.getByRole("treeitem", { name: "alpha.txt" }))
  fireEvent.change(await screen.findByDisplayValue("a"), { target: { value: "edited" } })
  fireEvent.click(screen.getByRole("treeitem", { name: "gamma.txt" }))
  await screen.findByRole("tab", { name: "gamma.txt" })
  expect(document.body).toContainOneByRole("tab", { name: "beta.txt" })
  expect(document.body).toContainOneByRole("tab", { name: "alpha.txt •" })
})

test("workspace switch opens and closes the preview while retaining the chat", async () => {
  render(<Surface cwd="/a" />)
  const closed = screen.getByRole("button", { name: "Open preview area" })
  expect(closed).toHaveAttribute("aria-expanded", "false")
  expect(closed).toHaveAttribute("aria-controls", "file-workspace-panel")
  fireEvent.click(closed)
  await screen.findByRole("treeitem", { name: "one.txt" })
  const opened = screen.getByRole("button", { name: "Close workspace" })
  expect(opened).toHaveAttribute("aria-expanded", "true")
  fireEvent.click(opened)
  expect(screen.queryByRole("tree")).toBeNull()
  expect(screen.getByRole("button", { name: "Open preview area" })).toHaveAttribute("aria-expanded", "false")
  expect(screen.getByText("Chat /a")).toBeVisible()
})

test("a chat keeps only the conversation while a project opens all four columns on its own", async () => {
  const view = render(<Surface cwd="/a" />)
  // A chat has no files next to it: the preview stays shut until the user asks for it.
  expect(screen.getByRole("button", { name: "Open preview area" })).toHaveAttribute("aria-expanded", "false")
  expect(native.invoke.mock.calls.filter(([command]) => command === "workspace_open")).toHaveLength(0)

  // Choosing a project folder opens the tree, the editor and the preview without another click.
  view.rerender(<Surface cwd="/a" defaultOpen />)
  expect(await screen.findByRole("treeitem", { name: /one.txt/ })).toBeVisible()
  expect(screen.getByRole("button", { name: "Close workspace" })).toHaveAttribute("aria-expanded", "true")
  expect(document.querySelector(".file-workspace-layout")).toHaveAttribute("data-view-mode", "false")

  // Closing the preview inside the project keeps it closed: a chat never reopens it, and coming
  // back to the project must not either.
  fireEvent.click(screen.getByRole("button", { name: "Close workspace" }))
  view.rerender(<Surface cwd="/a" />)
  view.rerender(<Surface cwd="/a" defaultOpen />)
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Open preview area" })).toHaveAttribute("aria-expanded", "false")
  )
})

test("row drag prevents native text selection without blocking inline rename input", async () => {
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  const file = await screen.findByRole("treeitem", { name: "one.txt" })
  const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 })
  fireEvent(file, down)
  expect(down.defaultPrevented).toBe(true)
  fireEvent(document, new MouseEvent("pointerup", { bubbles: true }))
  fireEvent.contextMenu(file)
  fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }))
  const input = await screen.findByRole("textbox", { name: "Rename" })
  const renameDown = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 })
  fireEvent(input, renameDown)
  expect(renameDown.defaultPrevented).toBe(false)
})

test("unmount releases a watch that finishes after workspace creation is cancelled", async () => {
  let completeWatch: (() => void) | null = null
  const pendingWatch = new Promise<void>((resolve) => {
    completeWatch = resolve
  })
  const originalInvoke = required(native.invoke.getMockImplementation())
  native.invoke.mockImplementation(async (command: string, args: { enabled?: boolean }) => {
    if (command === "workspace_watch" && args.enabled) {
      await pendingWatch
      return null
    }
    return originalInvoke(command, args) as unknown
  })
  const view = render(
    <StrictMode>
      <Surface cwd="/a" />
    </StrictMode>
  )
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("workspace_watch", { path: "/a", enabled: true }))
  view.unmount()
  await act(async () => {
    required(completeWatch)()
    await pendingWatch
  })
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("workspace_watch", { path: "/a", enabled: false }))
  expect(localStorage.getItem("workspace:/a")).toBeNull()
  expect(native.invoke.mock.calls.filter(([command]) => command === "workspace_dirty")).toHaveLength(0)

  // StrictMode's cleanup must not leave subsequent mounts with an aborted lifetime.
  render(
    <StrictMode>
      <Surface cwd="/a" />
    </StrictMode>
  )
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  expect(await screen.findByRole("treeitem", { name: "one.txt" })).toBeInTheDocument()
})

test("cancelling application exit keeps the dirty document editable and allows a later exit", async () => {
  native.nativeMode = true
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.doubleClick(await screen.findByRole("treeitem", { name: "one.txt" }))
  fireEvent.change(await screen.findByRole("textbox", { name: "Code" }), { target: { value: "unsaved" } })
  await act(() => Promise.try(() => requestExit()))
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(native.invoke.mock.calls.filter(([command]) => command === "workspace_exit")).toHaveLength(0)
  expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue("unsaved")
  fireEvent.change(screen.getByRole("textbox", { name: "Code" }), { target: { value: "continued editing" } })
  await act(() => Promise.try(() => requestExit()))
  fireEvent.click(await screen.findByRole("button", { name: "Save" }))
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("workspace_exit"))
  expect(new TextDecoder().decode(await adapter.readFile("/a/one.txt"))).toBe("continued editing")
})

test("saving on exit succeeds when the saved background document is deferred", async () => {
  native.nativeMode = true
  adapter = createMemoryAdapter(
    Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`/a/file${index}.txt`, `body ${index}`]))
  )
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.doubleClick(await screen.findByRole("treeitem", { name: "file0.txt" }))
  fireEvent.change(await screen.findByRole("textbox", { name: "Code" }), { target: { value: "saved on exit" } })
  for (let index = 1; index < 14; index++) {
    fireEvent.doubleClick(screen.getByRole("treeitem", { name: `file${index}.txt` }))
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue(`body ${index}`))
  }
  await act(() => {
    return Promise.try(() => {
      requestExit()
    })
  })
  fireEvent.click(await screen.findByRole("button", { name: "Save" }))
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("workspace_exit"))
  expect(new TextDecoder().decode(await adapter.readFile("/a/file0.txt"))).toBe("saved on exit")
}, 20000)

test("edits to an approved project while another exit prompt is open prevent exit", async () => {
  native.nativeMode = true
  const view = render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.doubleClick(await screen.findByRole("treeitem", { name: "one.txt" }))
  fireEvent.change(await screen.findByRole("textbox", { name: "Code" }), { target: { value: "first draft" } })
  view.rerender(<Surface cwd="/b" />)
  fireEvent.doubleClick(await screen.findByRole("treeitem", { name: "two.txt" }))
  fireEvent.change(await screen.findByRole("textbox", { name: "Code" }), { target: { value: "second draft" } })
  await act(() => {
    return Promise.try(() => {
      requestExit()
    })
  })
  fireEvent.click(await screen.findByRole("button", { name: "Discard" }))
  await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("/b/two.txt"))
  view.rerender(<Surface cwd="/a" />)
  await waitFor(() =>
    expect(required(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Code"]'))).toHaveValue(
      "first draft"
    )
  )
  fireEvent.change(required(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Code"]')), {
    target: { value: "changed after approval" }
  })
  fireEvent.click(screen.getByRole("button", { name: "Discard" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  expect(native.invoke.mock.calls.filter(([command]) => command === "workspace_exit")).toHaveLength(0)
  expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue("changed after approval")
})

test("project tree shortcut opens the preview and reopens a collapsed tree without toggling it closed", async () => {
  render(<Surface cwd="/a" />)
  fireEvent.keyDown(window, { key: "E", ctrlKey: true, shiftKey: true })
  expect(await screen.findByRole("treeitem", { name: /one.txt/ })).toBeVisible()
  fireEvent.click(screen.getByTestId("tree-toggle"))
  expect(screen.getByTestId("tree-toggle")).toHaveAttribute("aria-expanded", "false")
  fireEvent.keyDown(window, { key: "e", metaKey: true, shiftKey: true })
  await waitFor(() =>
    expect(screen.getByTestId("tree-toggle")).toHaveAttribute("aria-expanded", "true")
  )
  fireEvent.keyDown(window, { key: "E", ctrlKey: true, shiftKey: true })
  await waitFor(() =>
    expect(screen.getByTestId("tree-toggle")).toHaveAttribute("aria-expanded", "true")
  )
})

test("native project tree menu opens the current workspace", async () => {
  native.nativeMode = true
  render(<Surface cwd="/a" />)
  const calls = native.listen.mock.calls as unknown as [string, () => void][]
  const callback = calls.find(([name]) => name === "menu:project-tree")?.[1]
  expect(callback).toBeDefined()
  act(() => required(callback)())
  expect(await screen.findByRole("treeitem", { name: /one.txt/ })).toBeVisible()
})

test("a temporary chat that lands in a project opens the four-column layout", async () => {
  // 新建任务 drops the reader into a two-column chat; the moment that chat is given a project,
  // the preview and the file column have to come with it instead of waiting for a menu click.
  const view = render(<Surface cwd="/quick" />)
  expect(screen.queryByRole("tree")).toBeNull()
  view.rerender(<Surface cwd="/a" defaultOpen />)
  expect(await screen.findByRole("treeitem", { name: /one.txt/ })).toBeVisible()
})

test("a column the reader closed stays closed when the next project opens", async () => {
  // The preference outlives the workspace: opening a project must not undo the reader's choice.
  vi.spyOn(settingsStore, "get").mockImplementation(<T,>(key: string): T | undefined =>
    key === "workspace.treeVisible" ? (false as T) : undefined
  )
  render(<Surface cwd="/a" defaultOpen />)
  expect(await screen.findByTestId("tree-toggle")).toHaveAttribute(
    "aria-expanded",
    "false"
  )
  expect(screen.queryByRole("treeitem", { name: /one.txt/ })).toBeNull()
})

test("project tree shortcut ignores a response belonging to a previous project", async () => {
  let finish!: (value: string) => void
  authorize = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const view = render(<Surface cwd="/a" />)
  fireEvent.keyDown(window, { key: "E", ctrlKey: true, shiftKey: true })
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("workspace_open", { path: "/a" }))
  view.rerender(<Surface cwd="/b" />)
  await act(() => Promise.try(() => finish("/a")))
  expect(screen.queryByRole("tree")).toBeNull()
  authorize = null
  fireEvent.keyDown(window, { key: "E", ctrlKey: true, shiftKey: true })
  expect(await screen.findByRole("treeitem", { name: /two.txt/ })).toBeVisible()
  expect(screen.queryByRole("treeitem", { name: /one.txt/ })).toBeNull()
})

test("new tabs keep the existing preview, support middle close and restore their selection", async () => {
  await adapter.writeFile("/a/two.txt", new TextEncoder().encode("second"), { mode: "create" })
  const view = render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  expect(await screen.findByRole("tab", { name: "New tab" })).toHaveAttribute("aria-selected", "true")
  expect(screen.getByRole("button", { name: "Discover ALWith U⁺ ALWith U⁺ Guide" })).toBeVisible()
  fireEvent.click(screen.getByRole("treeitem", { name: "one.txt" }))
  await screen.findByRole("tab", { name: "one.txt" })
  fireEvent.click(screen.getByRole("button", { name: "New tab" }))
  fireEvent.click(screen.getByRole("treeitem", { name: "two.txt" }))
  await screen.findByRole("tab", { name: "two.txt" })
  expect(screen.getByRole("tab", { name: "one.txt" })).toBeVisible()
  expect(screen.queryByRole("tab", { name: "New tab" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "New tab" }))
  await waitFor(() =>
    expect(
      (JSON.parse(required(localStorage.getItem("workspace:/a"))) as { tabLayout: { activeIndex: number } }).tabLayout
        .activeIndex
    ).toBe(2)
  )
  view.unmount()
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  expect(await screen.findByRole("tab", { name: "New tab" })).toHaveAttribute("aria-selected", "true")
  fireEvent(screen.getByRole("tab", { name: "New tab" }), new MouseEvent("auxclick", { bubbles: true, button: 1 }))
  await waitFor(() => expect(screen.queryByRole("tab", { name: "New tab" })).toBeNull())
  expect(screen.getByRole("tab", { name: "two.txt" })).toHaveAttribute("aria-selected", "true")
})

test("the new-tab card opens the ALWith U⁺ guide", async () => {
  vi.mocked(openGuideWindow).mockResolvedValueOnce()
  render(<Surface cwd="/a" />)
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.click(await screen.findByRole("button", { name: "Discover ALWith U⁺ ALWith U⁺ Guide" }))
  await waitFor(() => expect(openGuideWindow).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole("dialog")).toBeNull()
})

test("workspace keyboard shortcuts open, close and reopen a file without losing its contents", async () => {
  render(<Surface cwd="/a" />)
  fireEvent.keyDown(window, { key: "t", metaKey: true })
  expect(await screen.findByRole("tab", { name: "New tab" })).toHaveAttribute("aria-selected", "true")
  fireEvent.click(await screen.findByRole("treeitem", { name: "one.txt" }))
  await screen.findByRole("tab", { name: "one.txt" })
  fireEvent.keyDown(window, { key: "w", metaKey: true })
  await waitFor(() => expect(screen.queryByRole("tab", { name: "one.txt" })).toBeNull())
  fireEvent.keyDown(window, { key: "t", metaKey: true, shiftKey: true })
  expect(await screen.findByRole("textbox", { name: "Code" })).toHaveValue("first")
  expect(screen.getByRole("tab", { name: "one.txt" }).closest("[data-transient]")).toHaveAttribute(
    "data-transient",
    "false"
  )
})

test("native new-tab menu opens the workspace and close-tab preserves the chat", async () => {
  native.nativeMode = true
  render(<Surface cwd="/a" />)
  const handler = (): (() => void) => required(native.listen.mock.calls.find(([name]) => name === "menu:new-tab")?.[1])
  act(() => handler()())
  await screen.findByRole("tab", { name: "New tab" })
  const close = native.listen.mock.calls.findLast(([name]) => name === "menu:close-tab")?.[1]
  act(() => required(close)())
  await waitFor(() => expect(screen.queryByRole("tab")).toBeNull())
  expect(screen.getByText("Chat /a")).toBeInTheDocument()
  expect(native.invoke.mock.calls.some(([command]) => command === "workspace_exit")).toBe(false)
})

test("chat reveal navigates the unified canvas back from a split preview", async () => {
  const navigate = vi.fn()
  const context = {
    viewportWidth: 1000,
    budget: 744,
    selected: 1,
    split: true,
    moving: false,
    setWorkspace: vi.fn(),
    navigate,
    setDividerDragging: vi.fn()
  }
  const surface = (request: number) => (
    <CanvasContext.Provider value={context}>
      <Surface cwd="/a" chatRevealRequest={request} />
    </CanvasContext.Provider>
  )
  const view = render(surface(0))
  expect(navigate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  await waitFor(() => expect(navigate).toHaveBeenLastCalledWith("preview"))
  context.selected = 2
  view.rerender(surface(0))
  fireEvent.click(await screen.findByRole("button", { name: "Maximize" }))
  view.rerender(surface(1))
  await waitFor(() => expect(navigate).toHaveBeenLastCalledWith("chat"))
})

test("the titlebar restores an expanded workspace before closing it on the next click", async () => {
  const setWorkspace = vi.fn()
  const navigate = vi.fn()
  render(
    <CanvasContext.Provider
      value={{
        viewportWidth: 1256,
        budget: 1000,
        selected: 1,
        split: false,
        moving: false,
        setWorkspace,
        navigate,
        setDividerDragging: vi.fn()
      }}
    >
      <Surface cwd="/a" />
    </CanvasContext.Provider>
  )
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  fireEvent.click(await screen.findByRole("treeitem", { name: "one.txt" }))
  fireEvent.change(await screen.findByRole("textbox", { name: "Code" }), { target: { value: "retained edit" } })
  // Expanded (view mode) exercises the same restore branch as a preview paged onto a third screen.
  fireEvent.click(screen.getByRole("button", { name: "Maximize" }))
  expect(setWorkspace).toHaveBeenLastCalledWith({ chat: 0, preview: 1000, visible: true, maximized: true })
  // In view mode the toolbar toggle is labelled "Open preview area"; its first click restores.
  fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
  expect(setWorkspace).toHaveBeenLastCalledWith({ chat: 320, preview: 680, visible: true, maximized: false })
  expect(navigate).toHaveBeenLastCalledWith("chat")
  expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue("retained edit")
  expect(screen.getByRole("button", { name: "Close workspace" })).toHaveAttribute("aria-expanded", "true")
  fireEvent.click(screen.getByRole("button", { name: "Close workspace" }))
  expect(setWorkspace).toHaveBeenLastCalledWith({ chat: 1000, preview: 0, visible: false, maximized: false })
  expect(screen.getByRole("button", { name: "Open preview area" })).toHaveAttribute("aria-expanded", "false")
})

test("Windows workspace controls follow the actual canvas screen without resetting workspace state", async () => {
  const target = document.createElement("div")
  document.body.append(target)
  const context = {
    viewportWidth: 1256,
    budget: 1000,
    split: true,
    moving: false,
    setWorkspace: vi.fn(),
    navigate: vi.fn(),
    setDividerDragging: vi.fn()
  }
  const layout = (selected: number) => (
    <CanvasContext.Provider value={{ ...context, selected }}>
      <WindowsWorkspaceControlsContext.Provider value={target}>
        <Surface cwd="/a" />
      </WindowsWorkspaceControlsContext.Provider>
    </CanvasContext.Provider>
  )
  try {
    const view = render(layout(1))
    fireEvent.click(within(target).getByRole("button", { name: "Open preview area" }))
    fireEvent.click(await screen.findByRole("treeitem", { name: "one.txt" }))
    fireEvent.change(await screen.findByRole("textbox", { name: "Code" }), {
      target: { value: "retained across screens" }
    })
    for (const selected of [0, 2, 1, 0, 1]) {
      view.rerender(layout(selected))
      if (selected === 1)
        expect(within(target).getByRole("button", { name: "Close workspace" })).toHaveAttribute("aria-expanded", "true")
      else expect(target).toBeEmptyDOMElement()
    }
    expect(screen.getByRole("textbox", { name: "Code" })).toHaveValue("retained across screens")
    view.unmount()
  } finally {
    target.remove()
  }
})

// Regression for the reported "click 文件栏 and nothing happens". QA: this used to render with
// `defaultOpen` true, but `app.tsx:507-508` *excludes* `reason === "missing"` from
// `defaultFourColumns`, so that combination never occurs in the real app. Test the real one:
// missing ⇒ defaultOpen=false ⇒ visible=false ⇒ the column is shut on the first frame.
test("a directory-less (missing) surface starts with the file column closed and hidden", async () => {
  const info = vi.spyOn(toast, "info")
  try {
    render(<Surface cwd={null} reason="missing" guidance="Pick a folder" />)
    const layout = () => document.querySelector(".file-workspace-layout")
    const slab = () => document.querySelector(".file-workspace-preview-slide .file-workspace-slab")
    const slide = () => document.querySelector(".file-workspace-preview-slide")
    // The empty-state node exists in the DOM (WorkspacePanels renders `preview` unconditionally),
    // but it is zero-width, inert and aria-hidden: the reader perceives and can operate nothing.
    expect(layout()).toHaveAttribute("data-open", "false")
    expect(slide()).toHaveAttribute("style", expect.stringContaining("width: 0px"))
    expect(slab()).toHaveAttribute("aria-hidden", "true")
    expect(slab()?.hasAttribute("inert")).toBe(true)
    expect(screen.getByTestId("workspace-empty-state")).toHaveAttribute("data-workspace-empty-reason", "missing")
    // The header toggle and 四方格 must not claim the four columns are open.
    expect(screen.getByTestId("header-tree-toggle")).toHaveAttribute("aria-expanded", "false")
    expect(screen.getByRole("button", { name: "Open preview area" })).toHaveAttribute("aria-expanded", "false")
    expect(info).not.toHaveBeenCalled()

    // P0-5 minimum: a click is never a dead end — toast + an opened, actionable empty state.
    await act(async () => {
      fireEvent.click(screen.getByTestId("header-tree-toggle"))
    })
    expect(layout()).toHaveAttribute("data-open", "true")
    expect(slab()).toHaveAttribute("aria-hidden", "false")
    expect(slab()?.hasAttribute("inert")).toBe(false)
    expect(info).toHaveBeenCalled()
    expect(screen.getByText("Pick a folder")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Choose a folder" })).toBeTruthy()
  } finally {
    info.mockRestore()
  }
})

// `invalid` is NOT excluded from `defaultFourColumns` (`app.tsx:507-508`): the repair hint must
// be on screen without any click. Construct the real combination, including the rejected path.
test("an invalid Groups-root directory opens the column and offers the one-click repair without a click", async () => {
  render(
    <Surface
      cwd={null}
      reason="invalid"
      defaultOpen
      invalidDirectory="/Users/me/Documents/ALWith/groups"
    />
  )
  expect(document.querySelector(".file-workspace-layout")).toHaveAttribute("data-open", "true")
  const slab = document.querySelector(".file-workspace-preview-slide .file-workspace-slab")
  expect(slab).toHaveAttribute("aria-hidden", "false")
  expect(slab?.hasAttribute("inert")).toBe(false)
  expect(await screen.findByTestId("workspace-empty-state")).toHaveAttribute(
    "data-workspace-empty-reason",
    "invalid"
  )
  expect(screen.getByText("Use the one-click repair below to point the directory back at this meeting's own folder.")).toBeTruthy()
  expect(screen.getByRole("button", { name: "Repair now" })).toBeTruthy()
  // Task #5 / ③: a failed heal must not be a dead end — the manual picker is always available.
  expect(screen.getByRole("button", { name: "Choose a folder" })).toBeTruthy()
  expect(screen.getByRole("button", { name: "Reopen file column" })).toBeTruthy()
})

// QA regression: the reported symptom was a *dead* 文件栏 click on the default two-column surface.
// Prove the second entrance (四方格) also produces an opened, actionable empty state in that exact
// configuration, so all 文件栏 entries behave alike.
test("四方格 on the default two-column, directory-less surface opens the actionable empty state", async () => {
  const info = vi.spyOn(toast, "info")
  try {
    render(<Surface cwd={null} reason="missing" guidance="Pick a folder" />)
    expect(document.querySelector(".file-workspace-layout")).toHaveAttribute("data-open", "false")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open preview area" }))
    })
    expect(document.querySelector(".file-workspace-layout")).toHaveAttribute("data-open", "true")
    const empty = await screen.findByTestId("workspace-empty-state")
    expect(empty).toHaveAttribute("data-workspace-empty-reason", "missing")
    expect(screen.getByText("Pick a folder")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Choose a folder" })).toBeTruthy()
    expect(info).toHaveBeenCalled()
  } finally {
    info.mockRestore()
  }
})

// Task #5 / ④: `selectedId` can already be set in the frame before `session` is published, so a
// repair/folder pick must be written under the app's `directoryKey` (selectedId ?? __draft__),
// never under `__draft__`. Previously FileWorkspace derived the key from `sessionId` alone and the
// selected conversation stayed unresolved after a repair. This drives the real native picker path.
test("an invalid empty state writes a folder pick under the app's directoryKey, not __draft__", async () => {
  const chosen = "/Users/me/Documents/ALWith/groups/定价会"
  pickedGroupDirectory = chosen
  const draftBefore = projectDirectoryAttempt(DRAFT_DIRECTORY_KEY)
  render(
    <Surface
      cwd={null}
      sessionId={null}
      directoryKey="qa-selected-session"
      reason="invalid"
      defaultOpen
      invalidDirectory="/Users/me/Documents/ALWith/groups"
    />
  )
  expect(await screen.findByTestId("workspace-empty-state")).toHaveAttribute(
    "data-workspace-empty-reason",
    "invalid"
  )
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Choose a folder" }))
  })
  await waitFor(() => expect(projectDirectoryAttempt("qa-selected-session")?.directory).toBe(chosen))
  expect(projectDirectoryAttempt("qa-selected-session")?.invalid).toBeUndefined()
  // The whole point of ④: the draft key is untouched in the "selected but not published" frame.
  expect(projectDirectoryAttempt(DRAFT_DIRECTORY_KEY)).toBe(draftBefore)
  expect(native.invoke).toHaveBeenCalledWith("pick_group_directory")
})
