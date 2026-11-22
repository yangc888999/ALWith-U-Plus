import { fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { expect, test } from "vitest"

import { initI18n } from "@/lib/i18n"

import { LeadingNavigation } from "../leading-navigation"
import { MainSidebarLayout } from "../main-sidebar-layout"

await initI18n("en")

test("leading navigation switches pages and is inaccessible on the main screen", () => {
  function Screen() {
    const [page, setPage] = useState<"plugins" | "extensions" | "archives" | "usage">("plugins")
    const [screen, setScreen] = useState<"leading" | "main">("leading")
    return (
      <MainSidebarLayout
        initialPinned={false}
        screen={screen}
        sidebar={
          <button type="button" onClick={() => setScreen("main")}>
            Return to chat
          </button>
        }
        leading={
          <>
            <LeadingNavigation
              activePage={page}
              onOpenPlugins={() => setPage("plugins")}
              onOpenExtensions={() => setPage("extensions")}
              onOpenArchives={() => setPage("archives")}
              onOpenUsage={() => setPage("usage")}
            />
            <main aria-label="Current page">{page}</main>
          </>
        }
        main={<main>Chat</main>}
      />
    )
  }
  const view = render(<Screen />)
  expect(view.getByRole("button", { name: "Plugins" })).toHaveAttribute("aria-current", "page")
  for (const [name, page] of [
    ["Features", "extensions"],
    ["Plugins", "plugins"],
    ["Archived chats", "archives"],
    ["Usage", "usage"]
  ] as const) {
    fireEvent.click(view.getByRole("button", { name }))
    expect(view.getByRole("main", { name: "Current page" })).toHaveTextContent(page)
    expect(view.getByRole("button", { name })).toHaveAttribute("aria-current", "page")
    expect(
      view
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-current") === "page" && !button.closest(".canvas-dots"))
    ).toHaveLength(1)
  }
  fireEvent.click(view.getByRole("button", { name: "Return to chat" }))
  expect(view.queryByRole("button", { name: "Plugins" })).not.toBeInTheDocument()
  expect(view.getByRole("main")).toHaveTextContent("Chat")
})
