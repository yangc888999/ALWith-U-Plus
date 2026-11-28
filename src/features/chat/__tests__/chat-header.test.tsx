import { render } from "@testing-library/react"
import { expect, test } from "vitest"

import { ChatHeader } from "../chat-header"

test("the conversation header is just the title and its actions", () => {
  const view = render(
    <ChatHeader title="Conversation">
      <span>Actions</span>
    </ChatHeader>
  )
  const header = view.container.querySelector("header")
  expect(header?.textContent).toContain("Conversation")
  expect(header?.textContent).toContain("Actions")
  // The project selector lived here before 1.8.0; the header must not grow another control.
  expect(header?.querySelector("button")).toBeNull()
})
