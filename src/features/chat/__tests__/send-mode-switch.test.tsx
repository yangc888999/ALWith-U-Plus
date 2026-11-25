import { act, cleanup, fireEvent, render, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, test } from "vitest"

import { getQueueSendMode, setQueueSendMode } from "@/lib/chat-display-preferences"
import { initI18n } from "@/lib/i18n"

import { SendModeSwitch } from "../send-mode-switch"

await initI18n("en")

beforeEach(() => setQueueSendMode("immediate"))
afterEach(() => {
  setQueueSendMode("immediate")
  cleanup()
})

test("the header switch defaults to interject and writes the queued mode", () => {
  const view = render(<SendModeSwitch />)
  const interject = view.getByRole("button", { name: "Interject" })
  const queue = view.getByRole("button", { name: "Queue" })

  expect(interject).toHaveAttribute("aria-pressed", "true")
  expect(queue).toHaveAttribute("aria-pressed", "false")

  fireEvent.click(queue)

  expect(getQueueSendMode()).toBe("queued")
  expect(queue).toHaveAttribute("aria-pressed", "true")
  expect(interject).toHaveAttribute("aria-pressed", "false")
})

test("changing the preference keeps the visible cue and accessible selection in sync without moving focus", () => {
  const view = render(<SendModeSwitch />)
  const modes = within(view.getByRole("group", { name: "Sending during a running turn" }))
  const interject = modes.getByRole("button", { name: "Interject", pressed: true })
  const queue = modes.getByRole("button", { name: "Queue", pressed: false })

  expect(interject).toHaveClass("chat-send-mode-option")
  expect(interject).not.toHaveClass("bg-send-interject")
  expect(queue).not.toHaveClass("underline")
  expect(interject.tabIndex).toBe(0)
  expect(queue.tabIndex).toBe(0)
  interject.focus()
  expect(interject).toHaveFocus()
  act(() => setQueueSendMode("queued"))
  expect(modes.getByRole("button", { pressed: true })).toBe(queue)
  expect(queue).toHaveClass("chat-send-mode-option")
  expect(queue).not.toHaveClass("bg-send-queue")
  expect(interject).not.toHaveClass("underline")
  expect(interject).toHaveFocus()
})
