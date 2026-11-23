import { cleanup, fireEvent, render } from "@testing-library/react"
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
