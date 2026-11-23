import type { Session } from "@alwith/api"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"

import { initI18n } from "@/lib/i18n"
import { beginQueuedPrompt, cancelQueuedPrompt, queuedPromptCount } from "@/lib/queued-prompt"

import { QueuedPromptChip } from "../queued-prompt-chip"

await initI18n("en")
afterEach(() => {
  cancelQueuedPrompt("chip-session")
  cleanup()
})

const session = { id: "chip-session" } as unknown as Session

test("the chip appears only while a message is waiting, and cancelling clears it", () => {
  const view = render(<QueuedPromptChip session={session} />)
  expect(view.queryByRole("button")).toBeNull()

  act(() => {
    beginQueuedPrompt("chip-session", "帮我跑一下测试")
  })
  const chip = view.getByRole("button", { name: /Queued/ })
  expect(chip.textContent).toContain("帮我跑一下测试")

  fireEvent.click(chip)
  expect(queuedPromptCount("chip-session")).toBe(0)
  expect(view.queryByRole("button")).toBeNull()
})

test("several waiting messages collapse into one chip with a count", () => {
  const view = render(<QueuedPromptChip session={session} />)
  act(() => {
    beginQueuedPrompt("chip-session", "one")
    beginQueuedPrompt("chip-session", "two")
  })
  expect(view.getByRole("button", { name: /2 queued/ })).toBeDefined()
})

test("compact mode keeps the count and cancel action without repeating the message", () => {
  const view = render(<QueuedPromptChip session={session} compact />)
  act(() => {
    beginQueuedPrompt("chip-session", "a long supplement that must not widen the strip")
  })
  const chip = view.getByRole("button", { name: /Queued/ })
  expect(chip.textContent).not.toContain("a long supplement")
  expect(chip.title).toContain("a long supplement")
})
