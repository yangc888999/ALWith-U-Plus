import { useSidebarOverlay } from "@alwith/module-chat/session-list"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { createPortal } from "react-dom"
import { afterEach, beforeEach, expect, type MockInstance, test, vi } from "vitest"

import {
  WindowsTitleBarContext,
  WindowsWorkspaceControlsContext
} from "@/components/alwith-ui/windows-main-window-shell"
import { Button } from "@/components/ui/button"
import { must } from "@/lib/__tests__/must"
import { initI18n } from "@/lib/i18n"
import * as preferences from "@/lib/preferences"
import { settingsStore } from "@/lib/settings-store"

import { type MainScreen, MainSidebarLayout } from "../main-sidebar-layout"

await initI18n("en")

let save: MockInstance<typeof preferences.savePreference>
beforeEach(() => {
  save = vi.spyOn(preferences, "savePreference").mockResolvedValue()
})
afterEach(() => {
  cleanup()
  save.mockRestore()
})

function SidebarContent() {
  const [count, setCount] = useState(0)
  const [open, setOpen] = useState(false)
  useSidebarOverlay(open)
  return (
    <>
      <Button onClick={() => setCount((value) => value + 1)}>Count {count}</Button>
      <Button onClick={() => setOpen(true)}>Menu</Button>
      <div data-testid="list" style={{ overflow: "auto", height: 100 }}>
        <div style={{ height: 1000 }}>Scrollable threads</div>
      </div>
      {open &&
        createPortal(
          <div data-testid="portal">
            <Button onClick={() => setOpen(false)}>Close menu</Button>
          </div>,
          document.body
        )}
    </>
  )
}

function ChatContent() {
  const [draft, setDraft] = useState("")
  return (
    <main data-testid="chat">
      <textarea aria-label="Draft" value={draft} onInput={(event) => setDraft(event.currentTarget.value)} />
      <div data-testid="chat-scroll" style={{ overflow: "auto", height: 100 }}>
        <div style={{ height: 1000 }}>History</div>
      </div>
    </main>
  )
}

function setup(initialPinned = false, initialScreen: MainScreen = "main") {
  const layout = (screen: MainScreen) => (
    <MainSidebarLayout
      initialPinned={initialPinned}
      screen={screen}
      sidebar={<SidebarContent />}
      leading={<main data-testid="plugins">Plugins</main>}
      main={<ChatContent />}
    />
  )
  const view = render(layout(initialScreen))
  return {
    ...view,
    showScreen: (screen: MainScreen) => view.rerender(layout(screen)),
    get toggle() {
      return view.getByRole("switch")
    },
    panel: must(view.container.querySelector<HTMLElement>(".main-sidebar-panel"), "sidebar panel"),
    viewport: must(view.container.querySelector<HTMLElement>(".main-sidebar-viewport"), "sidebar viewport"),
    shell: must(view.container.querySelector<HTMLElement>(".main-sidebar-shell"), "sidebar shell"),
    mode: () => view.container.querySelector("[data-sidebar-mode]")?.getAttribute("data-sidebar-mode"),
    presentation: () =>
      view.container.querySelector("[data-sidebar-presentation]")?.getAttribute("data-sidebar-presentation")
  }
}

async function afterCloseDelay() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550))
  })
}
test("click pins and persists; leaving a pinned sidebar neither hides it nor steals focus", async () => {
  const view = setup()
  await act(() => Promise.try(() => fireEvent.click(view.toggle)))
  expect(view.mode()).toBe("pinned")
  expect(view.presentation()).toBe("docked")
  expect(view.toggle.getAttribute("aria-checked")).toBe("true")
  expect(save).toHaveBeenLastCalledWith("sidebarPinned", true)
  const count = view.getByRole("button", { name: "Count 0" })
  act(() => count.focus())
  expect(view.mode()).toBe("pinned")
  expect(document.activeElement).toBe(count)
  await act(() => Promise.try(() => fireEvent.click(view.toggle)))
  expect(view.mode()).toBe("hidden")
  expect(view.presentation()).toBe("docked")
  expect(view.panel.hasAttribute("inert")).toBe(true)
  expect(save).toHaveBeenLastCalledWith("sidebarPinned", false)
})

test("restores a saved pinned preference without rewriting it", () => {
  const view = setup(true)
  expect(view.mode()).toBe("pinned")
  expect(view.toggle.querySelector(".lucide-panel-left")).toBeTruthy()
  expect(view.container.querySelector(".main-sidebar-edge")).toBeNull()
  expect(save).not.toHaveBeenCalled()
})

test("follows sidebar pin updates received from settings store", async () => {
  const view = setup(true)
  const revision = 100
  act(() => {
    settingsStore.accept({ revision, values: { "appearance.sidebarPinned": false }, browserMigrated: true })
  })
  expect(view.mode()).toBe("hidden")
  expect(view.toggle.querySelector(".lucide-panel-left-dashed")).toBeTruthy()
  expect(view.container.querySelector("[data-rail-show]")).toBeTruthy()

  act(() => {
    settingsStore.accept({ revision: revision + 1, values: { "appearance.sidebarPinned": true }, browserMigrated: true })
  })
  expect(view.mode()).toBe("pinned")
  expect(view.toggle.querySelector(".lucide-panel-left")).toBeTruthy()
})

test("solid and dashed sidebar icons follow the pin preference", async () => {
  const view = setup()
  expect(view.toggle.querySelector(".lucide-panel-left-dashed")).toBeTruthy()
  await act(() => Promise.try(() => fireEvent.click(view.toggle)))
  expect(view.toggle.querySelector(".lucide-panel-left")).toBeTruthy()
  expect(view.toggle.querySelector(".lucide-panel-left-dashed")).toBeNull()
  await act(() => Promise.try(() => fireEvent.click(view.toggle)))
  expect(view.mode()).toBe("hidden")
  expect(view.toggle.querySelector(".lucide-panel-left-dashed")).toBeTruthy()
})

test("collapsing preserves the sidebar instance, local state and scroll position", async () => {
  const view = setup(true)
  const list = view.getByTestId("list")
  list.scrollTop = 180
  fireEvent.click(view.getByRole("button", { name: "Count 0" }))
  await act(() => Promise.try(() => fireEvent.click(view.toggle)))
  // The collapsed panel is inert; queries must look past it to prove the instance survived.
  expect(view.container.querySelector("[data-testid='list']")).toBe(list)
  expect(list.scrollTop).toBe(180)
  // The Count button survives collapse (same instance, count preserved) even though the panel
  // is inert now — query the raw DOM, inert subtrees are skipped by role queries.
  expect([...view.container.querySelectorAll("button")].some((b) => b.textContent === "Count 1")).toBe(true)
  expect(list.closest(".main-sidebar-panel")?.hasAttribute("inert")).toBe(true)
})

test("switching between collapsed and docked states retains the viewport and sidebar state", async () => {
  const view = setup()
  // Start from pinned: the collapsed start is inert, so the count button is only reachable
  // after an explicit pin — exactly how a reader reaches it now that hover peeking is gone.
  await act(() => Promise.try(() => fireEvent.click(view.toggle)))
  fireEvent.click(view.getByRole("button", { name: "Count 0" }))
  expect(view.presentation()).toBe("docked")
  await act(() => Promise.try(() => fireEvent.click(view.toggle)))
  expect(view.mode()).toBe("hidden")
  expect(view.presentation()).toBe("docked")
  expect(view.container.querySelector(".main-sidebar-viewport")).toBe(view.viewport)
  expect(view.container.querySelector(".main-sidebar-panel")).toBe(view.panel)
  expect(view.container.innerHTML).toContain("Count 1")
})

test("rapid pin reversals keep the last choice and serialize preference writes", async () => {
  const view = setup()
  // Separate input events commit separately, still well inside the 200ms animation.
  for (let index = 0; index < 3; index += 1) await act(() => Promise.try(() => fireEvent.click(view.toggle)))
  expect(view.mode()).toBe("pinned")
  expect(view.presentation()).toBe("docked")
  expect(save.mock.calls).toEqual([
    ["sidebarPinned", true],
    ["sidebarPinned", false],
    ["sidebarPinned", true]
  ])
})

test("leading screen stays docked without a toggle and ignores dismissal and the sidebar shortcut", async () => {
  const view = setup(false, "leading")
  expect(view.mode()).toBe("pinned")
  expect(view.presentation()).toBe("docked")
  expect(view.queryByRole("switch")).toBeNull()
  expect(view.container.querySelector(".main-sidebar-edge")).toBeNull()
  fireEvent.keyDown(window, { key: "Escape" })
  fireEvent.keyDown(window, { key: "b", metaKey: true })
  fireEvent.pointerDown(view.getByTestId("plugins"))
  await afterCloseDelay()
  expect(view.mode()).toBe("pinned")
  expect(view.panel.hasAttribute("inert")).toBe(false)
  expect(save).not.toHaveBeenCalled()
})

test.each([false, true])(
  "screen switches preserve the main preference (%p) while the leading sidebar stays open",
  (pinned) => {
    const view = setup(pinned)
    view.showScreen("leading")
    expect(view.mode()).toBe("pinned")
    expect(view.queryByRole("switch")).toBeNull()
    view.showScreen("main")
    expect(view.mode()).toBe(pinned ? "pinned" : "hidden")
    expect(view.toggle.getAttribute("aria-checked")).toBe(String(pinned))
    view.showScreen("leading")
    expect(view.mode()).toBe("pinned")
    expect(view.queryByRole("switch")).toBeNull()
    expect(save).not.toHaveBeenCalled()
  }
)

test("switching screens keeps the same sidebar, chat draft and scroll nodes, with only the visible screen interactive", () => {
  const view = setup(true)
  const draft = view.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement
  const chatScroll = view.getByTestId("chat-scroll")
  const sidebarScroll = view.getByTestId("list")
  const mainPanel = must(view.container.querySelector('[data-screen-panel="main"]'), "main screen")
  const leadingPanel = must(view.container.querySelector('[data-screen-panel="leading"]'), "leading screen")
  fireEvent.input(draft, { target: { value: "Unsent draft" } })
  expect(draft.value).toBe("Unsent draft")
  chatScroll.scrollTop = 120
  sidebarScroll.scrollTop = 180
  fireEvent.click(view.getByRole("button", { name: "Count 0" }))

  view.showScreen("leading")
  expect(mainPanel.hasAttribute("inert")).toBe(true)
  expect(mainPanel.getAttribute("aria-hidden")).toBe("true")
  expect(leadingPanel.hasAttribute("inert")).toBe(false)
  expect(view.queryByRole("textbox", { name: "Draft" })).toBeNull()
  expect(view.getByRole("button", { name: "Count 1" })).toBeTruthy()
  view.showScreen("main")
  expect(view.getByRole("textbox", { name: "Draft" })).toBe(draft)
  expect(draft.value).toBe("Unsent draft")
  expect(view.getByTestId("chat-scroll")).toBe(chatScroll)
  expect(chatScroll.scrollTop).toBe(120)
  expect(view.getByTestId("list")).toBe(sidebarScroll)
  expect(sidebarScroll.scrollTop).toBe(180)
  expect(mainPanel.hasAttribute("inert")).toBe(false)
  expect(leadingPanel.getAttribute("aria-hidden")).toBe("true")
  expect(view.container.querySelector(".main-sidebar-panel")).toBe(view.panel)
})

test("returning to a collapsed main sidebar moves focus from its now hidden controls to the top switch", () => {
  const view = setup(false, "leading")
  act(() => view.getByRole("button", { name: "Count 0" }).focus())
  view.showScreen("main")
  expect(view.mode()).toBe("hidden")
  expect(document.activeElement).toBe(view.toggle)
})

test("the Windows titlebar hosts the same working sidebar switch", () => {
  const target = document.createElement("div")
  document.body.append(target)
  try {
    const view = render(
      <WindowsTitleBarContext.Provider value={target}>
        <MainSidebarLayout
          initialPinned={true}
          screen="main"
          sidebar={<div>Sidebar</div>}
          leading={null}
          main={<main>Chat</main>}
        />
      </WindowsTitleBarContext.Provider>
    )
    const toggle = view.getByRole("switch")
    expect(target).toContainElement(toggle)
    expect(toggle).toHaveAttribute("aria-checked", "true")
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-checked", "false")
    expect(view.container.querySelector("[data-sidebar-mode]")).toHaveAttribute("data-sidebar-mode", "hidden")
    view.unmount()
    expect(target).toBeEmptyDOMElement()
  } finally {
    target.remove()
  }
})

test("window chrome stays outside the sliding screens across navigation and sidebar changes", () => {
  const layout = (screen: MainScreen) => (
    <MainSidebarLayout
      initialPinned
      screen={screen}
      sidebar={<div>Sidebar</div>}
      leading={<main>Plugins</main>}
      main={<main>Chat</main>}
      toolbar={<button type="button">Workspace</button>}
      statusBar={<span>Sync status</span>}
    />
  )
  const view = render(layout("main"))
  const header = view.getByRole("banner")
  const footer = view.getByRole("contentinfo")
  const body = must(view.container.querySelector(".main-window-body"), "window body")
  expect(header.parentElement).toBe(body.parentElement)
  expect(footer.parentElement).toBe(body.parentElement)
  expect(header).toContainElement(view.getByRole("switch"))
  expect(header).toContainElement(view.getByRole("button", { name: "Workspace" }))
  expect(footer).toHaveTextContent("Sync status")
  expect(body).not.toContainElement(header)
  expect(body).not.toContainElement(footer)
  fireEvent.click(view.getByRole("switch"))
  view.rerender(layout("leading"))
  expect(view.getByRole("banner")).toBe(header)
  expect(view.getByRole("contentinfo")).toBe(footer)
  expect(view.queryByRole("button", { name: "Workspace" })).not.toBeInTheDocument()
  expect(view.queryByRole("switch")).not.toBeInTheDocument()
})

test("Windows hosts workspace actions in the title bar instead of the body", () => {
  const target = document.createElement("div")
  document.body.append(target)
  try {
    const view = render(
      <WindowsWorkspaceControlsContext.Provider value={target}>
        <MainSidebarLayout
          initialPinned
          screen="main"
          sidebar={null}
          leading={null}
          main={<main>Chat</main>}
          toolbar={<button type="button">Workspace</button>}
          statusBar={<span>Sync status</span>}
        />
      </WindowsWorkspaceControlsContext.Provider>
    )
    expect(target).toContainElement(view.getByRole("button", { name: "Workspace" }))
    expect(view.getByRole("main")).not.toContainElement(target)
    expect(view.getByRole("contentinfo")).toHaveTextContent("Sync status")
    view.unmount()
    expect(target).toBeEmptyDOMElement()
  } finally {
    target.remove()
  }
})

test("resizing follows the pointer one pixel per pixel however fast it moves", () => {
  // A share that resolves above the 180px floor, so the drag has room to move both ways.
  localStorage.setItem(
    "workspace:layout",
    JSON.stringify({ navigationRatio: 0.3, chatRatio: 0.2, treeRatio: 0.15, previewRatio: 0.35 })
  )
  try {
    const view = setup(true)
    const divider = view.getByRole("separator")
    divider.setPointerCapture = vi.fn()
    const start = Number(divider.getAttribute("aria-valuenow"))
    const width = () => Number(divider.getAttribute("aria-valuenow"))
    expect(start).toBeGreaterThan(0)

    fireEvent.pointerDown(divider, { button: 0, clientX: 400, pointerId: 1 })
    // Two steps to the same place must land where one jump would: the width depends on the distance
    // from the press, not on how many pointermove events it took to get there.
    fireEvent.pointerMove(divider, { clientX: 450, pointerId: 1 })
    expect(width() - start).toBe(50)
    fireEvent.pointerMove(divider, { clientX: 500, pointerId: 1 })
    expect(width() - start).toBe(100)
    // Holding still must not creep.
    fireEvent.pointerMove(divider, { clientX: 500, pointerId: 1 })
    expect(width() - start).toBe(100)

    // Crossing back past the press point narrows by the same rule.
    fireEvent.pointerMove(divider, { clientX: 370, pointerId: 1 })
    expect(width() - start).toBe(-30)
    fireEvent.pointerUp(divider, { pointerId: 1 })
  } finally {
    localStorage.removeItem("workspace:layout")
  }
})
