import type { Session } from "@alwith/api"
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

import { client } from "@/lib/client"
import { initI18n } from "@/lib/i18n"
import {
  beginQueuedPrompt,
  cancelQueuedPrompt,
  pauseQueuedPrompts,
  queuedPromptCount,
  setQueuedPromptDispatching,
  type QueuedPrompt
} from "@/lib/queued-prompt"

import { QueuedPromptList } from "../queued-prompt-list"

await initI18n("en")
afterEach(() => {
  cleanup()
  cancelQueuedPrompt("list-session")
  cancelQueuedPrompt("list-attachments")
  cancelQueuedPrompt("list-paused")
  cancelQueuedPrompt("list-jumping")
  cancelQueuedPrompt("list-dispatching")
  vi.restoreAllMocks()
})

const session = { id: "list-session" } as unknown as Session

test("waiting messages render as individual rows with inline edit, jump and delete", async () => {
  const view = render(<QueuedPromptList session={session} />)
  expect(view.queryByRole("list")).toBeNull()

  let first: QueuedPrompt | undefined
  let second: QueuedPrompt | undefined
  let jumps = 0
  act(() => {
    first = beginQueuedPrompt("list-session", "帮我跑一下测试", {
      body: "帮我跑一下测试\n第二行",
      image: "data:image/png;base64,image",
      imageCount: 2,
      jump: async () => {
        jumps += 1
        return "sent"
      }
    })
    second = beginQueuedPrompt("list-session", "再把结果整理出来")
  })
  expect(view.getAllByRole("listitem")).toHaveLength(2)
  expect(view.container.querySelector('[data-queued-prompt-image] img')).not.toBeNull()

  fireEvent.click(view.getAllByRole("button", { name: "Edit queued message" })[0]!)
  const field = view.getByRole("textbox", { name: "Edit queued message" })
  expect(field).toHaveValue("帮我跑一下测试\n第二行")
  fireEvent.change(field, { target: { value: "帮我跑一下测试（已改）\n第二行" } })
  fireEvent.click(view.getByRole("button", { name: "Save" }))
  expect(first?.cancelled).toBe(false)
  expect(first?.body).toBe("帮我跑一下测试（已改）\n第二行")
  expect(queuedPromptCount("list-session")).toBe(2)
  expect(view.queryByText("帮我跑一下测试（已改）")).not.toBeNull()

  fireEvent.click(view.getAllByRole("button", { name: "Jump to the current turn" })[0]!)
  await waitFor(() => expect(jumps).toBe(1))
  expect(queuedPromptCount("list-session")).toBe(1)

  fireEvent.click(view.getByRole("button", { name: "Delete queued message" }))
  expect(second?.removed).toBe(true)
  expect(queuedPromptCount("list-session")).toBe(0)
  expect(view.queryByRole("list")).toBeNull()
})

test("attachment-only waiting messages still have a readable row", async () => {
  const attachmentSession = { id: "list-attachments" } as unknown as Session
  const view = render(<QueuedPromptList session={attachmentSession} />)
  act(() => {
    beginQueuedPrompt("list-attachments", null)
  })
  expect(view.getByText("Attachment message")).toBeDefined()
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
})

test("the drag handle is exposed for keyboard and pointer reordering", async () => {
  const view = render(<QueuedPromptList session={session} />)
  act(() => {
    beginQueuedPrompt("list-session", "one")
  })
  const handle = view.getByRole("button", { name: "Drag to reorder the queue" })
  expect(handle.getAttribute("aria-roledescription")).not.toBeNull()
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
})

test("a paused queue exposes resume and a two-step clear while disabling jump", async () => {
  const pausedSession = { id: "list-paused", cwd: "/tmp/project" } as unknown as Session
  const resume = vi.spyOn(client, "resumeQueuedPromptQueue").mockResolvedValue()
  const view = render(<QueuedPromptList session={pausedSession} />)
  act(() => {
    beginQueuedPrompt("list-paused", "keep me")
    pauseQueuedPrompts("list-paused", "stop")
  })

  expect(view.getByText("Queue paused")).toBeDefined()
  expect(view.getByText("This turn was stopped and the queued messages were kept. Resume to reopen the conversation.")).toBeDefined()
  expect(view.getByRole("button", { name: "Jump to the current turn" })).toBeDisabled()

  fireEvent.click(view.getByRole("button", { name: "Resume sending" }))
  await waitFor(() => expect(resume).toHaveBeenCalledWith("list-paused", "/tmp/project"))

  fireEvent.click(view.getByRole("button", { name: "Clear queue" }))
  expect(view.getByRole("button", { name: "Confirm clear" })).toBeDefined()
  fireEvent.click(view.getByRole("button", { name: "Confirm clear" }))
  expect(queuedPromptCount("list-paused")).toBe(0)
})

test("editing, deleting and dragging are disabled while a row is jumping", async () => {
  const jumpingSession = { id: "list-jumping", cwd: "/tmp/project" } as unknown as Session
  let finish: ((result: "queued") => void) | undefined
  const view = render(<QueuedPromptList session={jumpingSession} />)
  act(() => {
    beginQueuedPrompt("list-jumping", "jump", {
      jump: () => new Promise((resolve) => { finish = resolve })
    })
  })

  fireEvent.click(view.getByRole("button", { name: "Jump to the current turn" }))
  await waitFor(() => expect(view.getByRole("button", { name: "Edit queued message" })).toBeDisabled())
  expect(view.getByRole("button", { name: "Delete queued message" })).toBeDisabled()
  expect(view.getByRole("button", { name: "Drag to reorder the queue" })).toBeDisabled()

  await act(async () => finish?.("queued"))
  await waitFor(() => expect(view.getByRole("button", { name: "Edit queued message" })).toBeEnabled())
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
})

test("a row waiting for acceptance stays visible and locks its controls", async () => {
  const dispatchSession = { id: "list-dispatching", cwd: "/tmp/project" } as unknown as Session
  const view = render(<QueuedPromptList session={dispatchSession} />)
  let firstId = ""
  act(() => {
    firstId = beginQueuedPrompt("list-dispatching", "first").id
    beginQueuedPrompt("list-dispatching", "second")
    setQueuedPromptDispatching("list-dispatching", firstId, true)
  })

  expect(view.getAllByRole("listitem")).toHaveLength(2)
  expect(view.getAllByRole("button", { name: "Edit queued message" })[0]).toBeDisabled()
  expect(view.getAllByRole("button", { name: "Delete queued message" })[0]).toBeDisabled()
  expect(view.getAllByRole("button", { name: "Drag to reorder the queue" })[0]).toBeDisabled()
  for (const button of view.getAllByRole("button", { name: "Jump to the current turn" }))
    expect(button).toBeDisabled()

  act(() => setQueuedPromptDispatching("list-dispatching", firstId, false))
  expect(view.getAllByRole("button", { name: "Edit queued message" })[0]).toBeEnabled()
})
