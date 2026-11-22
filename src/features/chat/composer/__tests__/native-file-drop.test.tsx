import { PromptInput } from "@alwith/module-chat/composer"
import { PromptInputProvider, usePromptInputAttachments } from "@alwith/module-chat/composer-context"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest"

import type { ChatDroppedFile } from "@/bindings"
import { initI18n } from "@/lib/i18n"
import { basename } from "@/lib/path"
import { mockOf } from "@/test/mock-of"

import { nativeAttachmentPolicy, NativeFileDrop } from "../native-file-drop"

type Drop = { payload: { type: "drop"; paths: string[]; position: { x: number; y: number } } }
const host = vi.hoisted(() => ({
  listeners: [] as ((event: Drop) => void)[],
  listen: vi.fn(),
  read: vi.fn(),
  stop: vi.fn(),
  error: vi.fn()
}))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: host.read }))
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: host.listen }) }))
vi.mock("sonner", () => ({ toast: { error: host.error } }))

function Probe() {
  const attachments = usePromptInputAttachments()
  return (
    <div>
      {attachments.files.map((file) => (
        <button type="button" key={file.id} onClick={() => attachments.remove(file.id)}>
          {file.filename}
        </button>
      ))}
    </div>
  )
}
function Harness({ sessionId = "main-session", enabled = true }: { sessionId?: string; enabled?: boolean }) {
  const [mentions, setMentions] = useState<string[]>([])
  const [images, setImages] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  return (
    <div data-chat-drop-zone>
      <PromptInputProvider attachmentPolicy={nativeAttachmentPolicy}>
        <PromptInput accept="image/png" onError={host.error} onSubmit={() => {}} onSubmitError={host.error}>
          <NativeFileDrop
            sessionId={sessionId}
            enabled={enabled}
            onBusyChange={setBusy}
            onMention={(path) => setMentions((previous) => [...new Set([...previous, path])])}
            onImage={(file) => setImages((previous) => [...previous, file.name])}
            materialsDirectory={null}
          />
          <Probe />
        </PromptInput>
      </PromptInputProvider>
      <output data-testid="mentions">{mentions.join("|")}</output>
      <output data-testid="images">{images.join("|")}</output>
      <output data-testid="busy">{String(busy)}</output>
    </div>
  )
}
function drop(paths: string[], index = host.listeners.length - 1) {
  const listener = host.listeners[index]
  if (!listener) throw new Error("Native drop listener not registered")
  act(() => listener({ payload: { type: "drop", paths, position: { x: 20, y: 40 } } }))
}
function image(path = "/tmp/qa.png", data = "AQ=="): ChatDroppedFile {
  return { path, name: basename(path), image: { data, mimeType: "image/png" } }
}
beforeAll(() => initI18n("en"))
beforeEach(() => {
  host.listeners = []
  host.read.mockReset()
  host.stop.mockReset()
  host.error.mockReset()
  host.listen.mockReset().mockImplementation((listener: (event: Drop) => void) => {
    return Promise.try(() => {
      host.listeners.push(listener)
      return host.stop
    })
  })
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 })
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() => document.querySelector<HTMLElement>("[data-chat-drop-zone]"))
  })
})
afterEach(() => cleanup())

test.each(["main-session", "floating-session"])(
  "%s receives inline images and Unicode file references through the native bridge",
  async (sessionId) => {
    host.read
      .mockResolvedValueOnce(image())
      .mockResolvedValueOnce({ path: "/tmp/中文 space #1.txt", name: "中文 space #1.txt", image: null })
    const view = render(<Harness sessionId={sessionId} />)
    drop(["/tmp/qa.png", "/tmp/中文 space #1.txt"])
    // The image goes to the inline handler, not the attachment tray.
    await waitFor(() => expect(view.getByTestId("images").textContent).toBe("qa.png"))
    await waitFor(() => expect(view.getByTestId("busy").textContent).toBe("false"))
    expect(view.getByTestId("mentions").textContent).toBe("/tmp/中文 space #1.txt")
    expect(view.queryByRole("button", { name: "qa.png" })).toBeNull()
    expect(mockOf(document, "elementFromPoint")).toHaveBeenCalledWith(10, 20)
    expect(host.read).toHaveBeenCalledWith("chat_read_dropped_file", { path: "/tmp/qa.png" })
    expect(host.listen).toHaveBeenCalledTimes(1)
    expect(view.getByTestId("busy").textContent).toBe("false")
  }
)

test("rapid duplicate drops are serialized and a duplicate image is dropped", async () => {
  host.read.mockResolvedValue(image())
  const view = render(<Harness />)
  drop(["/tmp/qa.png", "/tmp/qa.png"])
  drop(["/tmp/qa.png"])
  await waitFor(() => expect(view.getByTestId("busy").textContent).toBe("false"))
  expect(view.getByTestId("images").textContent).toBe("qa.png")
  expect(host.listen).toHaveBeenCalledTimes(1)
})

test("the attachment policy drops a browser copy of an image already added natively", () => {
  const file = new File(["png"], "qa.png", { type: "image/png" })
  const existing = [
    {
      id: "native",
      type: "file" as const,
      url: "blob:qa",
      filename: "qa.png",
      size: file.size,
      lastModified: file.lastModified,
      mediaType: "image/png"
    }
  ]
  expect(nativeAttachmentPolicy.uniqueFiles([file], existing)).toEqual([])
  const other = new File(["other"], "other.png", { type: "image/png" })
  expect(nativeAttachmentPolicy.uniqueFiles([other], existing)).toEqual([other])
})

test("workspace drops are left to its importer and unavailable composers reject with feedback", () => {
  return Promise.try(() => {
    const view = render(<Harness enabled={false} />)
    const tree = document.createElement("div")
    tree.className = "file-workspace-tree"
    mockOf(document, "elementFromPoint").mockReturnValueOnce(tree)
    drop(["/tmp/qa.png"])
    expect(host.read).not.toHaveBeenCalled()
    expect(host.error).not.toHaveBeenCalled()
    drop(["/tmp/qa.png"])
    expect(host.error).toHaveBeenCalledWith("This chat cannot accept files right now.")
    expect(host.read).not.toHaveBeenCalled()
    expect(view.getByTestId("busy").textContent).toBe("false")
  })
})

test("a delayed file read never lands in a different session", async () => {
  let finish!: (file: ChatDroppedFile) => void
  host.read.mockImplementation(
    () =>
      new Promise<ChatDroppedFile>((resolve) => {
        finish = resolve
      })
  )
  const view = render(<Harness sessionId="old" />)
  drop(["/tmp/qa.png"])
  await waitFor(() => expect(host.read).toHaveBeenCalledTimes(1))
  view.rerender(<Harness sessionId="new" />)
  await act(() => Promise.try(() => finish(image())))
  expect(view.queryByRole("button", { name: "qa.png" })).toBeNull()
  expect(view.getByTestId("busy").textContent).toBe("false")
  expect(host.stop).toHaveBeenCalledTimes(1)
})

test("failed reads report the file and continue with other files", async () => {
  host.read.mockRejectedValueOnce("Permission denied").mockResolvedValueOnce(image())
  const view = render(<Harness />)
  drop(["/private/secret.txt", "/tmp/qa.png"])
  await waitFor(() => expect(view.getByTestId("images").textContent).toBe("qa.png"))
  expect(host.error).toHaveBeenCalledWith("Could not attach secret.txt", { description: "Permission denied" })
})

test("inline images keep their own aggregate size limit across separate drops", async () => {
  const data = "AAAA".repeat(1_000_000)
  host.read.mockResolvedValueOnce(image("/tmp/first.png", data)).mockResolvedValueOnce(image("/tmp/second.png", data))
  const view = render(<Harness />)
  drop(["/tmp/first.png"])
  await waitFor(() => expect(view.getByTestId("images").textContent).toBe("first.png"))
  drop(["/tmp/second.png"])
  await waitFor(() => expect(view.getByTestId("busy").textContent).toBe("false"))
  expect(view.getByTestId("images").textContent).toBe("first.png")
  expect(host.error).toHaveBeenCalledWith("Images exceed 8 MB in total; remove some before adding more")
})

test("late native listener registration is cleaned up after unmount", async () => {
  let finish!: (stop: () => void) => void
  host.listen.mockImplementation(
    () =>
      new Promise<() => void>((resolve) => {
        finish = resolve
      })
  )
  const view = render(<Harness />)
  view.unmount()
  await act(() => Promise.try(() => finish(host.stop)))
  expect(host.stop).toHaveBeenCalledTimes(1)
})
