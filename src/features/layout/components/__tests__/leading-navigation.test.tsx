import { fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { expect, test } from "vitest"

import { initI18n } from "@/lib/i18n"

import { LeadingNavigation } from "../leading-navigation"
import { MainSidebarLayout } from "../main-sidebar-layout"
import type { WorkbenchPage } from "../workbench-features"

await initI18n("en")

test("leading navigation switches pages and is inaccessible on the main screen", () => {
  function Screen() {
    const [page, setPage] = useState<WorkbenchPage>("plugins")
    const [screen, setScreen] = useState<"leading" | "main">("leading")
    return (
      <MainSidebarLayout
        initialPinned={false}
        screen={screen}
        onScreenChange={setScreen}
        sidebar={
          <button type="button" onClick={() => setScreen("main")}>
            Return to chat
          </button>
        }
        leading={
          <>
            <LeadingNavigation
              activePage={page}
              onOpenOverview={() => setPage("overview")}
              onOpenPlugins={() => setPage("plugins")}
              onOpenExtensions={() => setPage("extensions")}
              onOpenArchives={() => setPage("archives")}
              onOpenAutomation={() => setPage("automation")}
              onOpenOnlineBi={() => setPage("online-bi")}
              onOpenGroups={() => setPage("groups")}
              onOpenUsage={() => setPage("usage")}
              onOpenSkills={() => setPage("skills")}
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
    ["Overview", "overview"],
    ["Extensions", "extensions"],
    ["Plugins", "plugins"],
    ["Skills", "skills"],
    ["Meetings", "groups"],
    ["Scheduled tasks", "automation"],
    ["Online BI", "online-bi"],
    ["Archive", "archives"],
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
  fireEvent.click(view.getByRole("button", { name: "Page 2" }))
  expect(view.queryByRole("button", { name: "Plugins" })).not.toBeInTheDocument()
  expect(view.getByRole("main")).toHaveTextContent("Chat")
})

test("the navigation collapse control uses a compact chevron", () => {
  localStorage.setItem("alwith.workbench.navigation.expanded", "true")
  const view = render(
    <LeadingNavigation
      activePage="overview"
      onOpenOverview={() => {}}
      onOpenPlugins={() => {}}
      onOpenExtensions={() => {}}
      onOpenArchives={() => {}}
      onOpenAutomation={() => {}}
      onOpenOnlineBi={() => {}}
      onOpenGroups={() => {}}
      onOpenUsage={() => {}}
      onOpenSkills={() => {}}
    />
  )
  try {
    const collapse = view.getByRole("button", { name: "Collapse navigation" })
    expect(collapse).toHaveClass("size-5")
    expect(collapse.querySelector(".lucide-chevron-left")).not.toBeNull()
    fireEvent.click(collapse)
    const expand = view.getByRole("button", { name: "Expand navigation" })
    expect(expand.querySelector(".lucide-chevron-right")).not.toBeNull()
  } finally {
    localStorage.removeItem("alwith.workbench.navigation.expanded")
  }
})
