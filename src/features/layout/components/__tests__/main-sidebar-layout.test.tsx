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
    settingsStore.accept({
      revision: revision + 1,
      values: { "appearance.sidebarPinned": true },
      browserMigrated: true
    })
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

test("resizing follows the pointer one pixel per pixel however fast it moves", async () => {
  // A share that resolves above the 180px floor, so the drag has room to move both ways.
  localStorage.setItem(
    "workspace:layout",
    JSON.stringify({ navigationRatio: 0.3, chatRatio: 0.2, treeRatio: 0.15, previewRatio: 0.35 })
  )
  try {
    // The drag bounds come from the *measured* canvas width, which jsdom reports as 0.
    await withCanvasGeometry(async () => {
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
      view.unmount()
    })
  } finally {
    localStorage.removeItem("workspace:layout")
  }
})

// ── A canvas parked off the chat screen ────────────────────────────────────────────────────────
// The canvas has one snap per region and the reader parks it with the status-bar dots, so "the
// sidebar is pinned" and "the canvas is on the chat screen" are two different facts. Tying the
// *controls* to the second one is what made the panel impossible to bring back: it collapsed to
// the rail and the title-bar pin button was not rendered at all (2026-11-16, 「侧边栏不能正常展开」).
function workspaceLayout(initialPinned: boolean) {
  return (
    <MainSidebarLayout
      initialPinned={initialPinned}
      screen="main"
      sidebar={<SidebarContent />}
      leading={<main data-testid="plugins">Plugins</main>}
      main={<ChatContent />}
      trailing={<aside data-testid="workspace">Workspace</aside>}
      statusBar={<span>Sync status</span>}
    />
  )
}

/**
 * jsdom reports every box as 0x0, which leaves the canvas unmeasured and its navigation requests
 * unconsumed. These cases are about the canvas actually changing region, so the boxes are supplied
 * for the duration of one test and restored afterwards.
 */
function withCanvasGeometry(run: () => void, viewport = 1200, sidebar = 248) {
  const patched = ["clientWidth", "offsetWidth", "scrollWidth"] as const
  const original = patched.map((key) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, key))
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("main-canvas-viewport") ? viewport : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("main-sidebar-shell") ? sidebar : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => viewport })
  const restore = () => {
    patched.forEach((key, index) => {
      const descriptor = original[index]
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
    })
  }
  return Promise.resolve().then(run).finally(restore)
}

async function parkOnWorkspace(container: HTMLElement) {
  const dots = [...container.querySelectorAll<HTMLButtonElement>(".canvas-dots button")]
  // Two dots: the chat screen and the workspace beside it.
  expect(dots).toHaveLength(2)
  await act(() => Promise.try(() => fireEvent.click(must(dots[1], "workspace dot"))))
}

/**
 * Same boxes as {@link withCanvasGeometry}, but the canvas width can be changed mid-test and the
 * `ResizeObserver` is driven by hand. jsdom's stub never fires, and the point of these cases is
 * precisely that a *measurement* — not a `resize` event — is what moves the sidebar.
 */
function withResizableCanvas(run: (resize: (viewport: number) => Promise<void>) => Promise<void>) {
  const callbacks: ResizeObserverCallback[] = []
  const realObserver = globalThis.ResizeObserver
  const keys = ["clientWidth", "offsetWidth", "scrollWidth"] as const
  const original = keys.map((key) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, key))
  let viewport = 1200
  let sidebar = 248
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("main-canvas-viewport") ? viewport : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("main-sidebar-shell") ? sidebar : 0
    }
  })
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => viewport })
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback)
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  const restore = () => {
    globalThis.ResizeObserver = realObserver
    keys.forEach((key, index) => {
      const descriptor = original[index]
      if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
    })
  }
  const resize = async (next: number) => {
    viewport = next
    await act(async () => {
      for (const callback of callbacks) callback([], {} as ResizeObserver)
    })
  }
  sidebar = 248
  return Promise.resolve()
    .then(() => run(resize))
    .finally(restore)
}

// 该用例描述的是 1.0.x 的「按实测画布宽度换算侧栏」——2026-11-16 用户要求主界面整体回到 0.4.3，
// 而 1.0.8 引入的占位几何/实时测量正是「折叠后聊天被推到窗口左缘」的根因，已随画布逻辑一并回退。
// 保留用例文本作为历史，跳过执行；若将来重新引入实测宽度，再把 skip 去掉。
test.skip("the sidebar width follows the measured canvas, not window.innerWidth", async () => {
  // A share big enough that the 34% ceiling — not the 180px floor — decides the column, so the
  // number on the divider is a direct readout of which width the component resolved against. The
  // four shares must total exactly 1, otherwise `loadWorkspaceLayout` normalises them.
  localStorage.setItem(
    "workspace:layout",
    JSON.stringify({ navigationRatio: 0.34, chatRatio: 0.2, treeRatio: 0.16, previewRatio: 0.3 })
  )
  const innerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth")
  let reported = 1920
  Object.defineProperty(window, "innerWidth", { configurable: true, get: () => reported })
  try {
    await withResizableCanvas(async (resize) => {
      const view = render(workspaceLayout(true))
      const width = () => Number(view.getByRole("separator").getAttribute("aria-valuenow"))
      // A 1200px canvas: 34% is 408px. Resolved against `window.innerWidth` (1920) it would have
      // been capped at 420 — the "wide window, narrow sidebar" mix-up this replaced.
      expect(width()).toBe(408)

      // The panel changed underneath the window: the CSS width is 700px now, and no `resize` event
      // is dispatched because the native side set the physical size — the window's own reported
      // width never moved. Measuring again is the only thing that can notice.
      reported = 960
      await resize(700)
      expect(width()).toBe(238)

      // …and it keeps following the measurement, still without a `resize` event.
      reported = 1600
      await resize(1400)
      expect(width()).toBe(420)
      view.unmount()
    })
  } finally {
    if (innerWidth) Object.defineProperty(window, "innerWidth", innerWidth)
    localStorage.removeItem("workspace:layout")
  }
})

test("a fresh main screen parks on chat, never on the trailing apps screen", async () => {
  await withCanvasGeometry(async () => {
    const view = render(workspaceLayout(true))
    const dots = [...view.container.querySelectorAll<HTMLButtonElement>(".canvas-dots button")]
    // First dot = chat, last dot = trailing. Startup must select chat…
    expect(dots[0]).toHaveAttribute("aria-current", "page")
    expect(dots.at(-1)).not.toHaveAttribute("aria-current")
    // …and the apps screen stays inert until the reader explicitly travels there.
    const trailing = must(view.container.querySelector('[data-screen-panel="trailing"]'), "trailing screen")
    expect(trailing.hasAttribute("inert")).toBe(true)
    // Mutual exclusivity is by data-active, not by translate: a collapsed sidebar changes the
    // track widths, and geometry alone used to let the leading/trailing columns bleed into view.
    const leading = must(view.container.querySelector('[data-screen-panel="leading"]'), "leading screen")
    const chat = must(view.container.querySelector('[data-screen-panel="main"]'), "chat screen")
    expect(chat.hasAttribute("data-active")).toBe(true)
    expect(leading.hasAttribute("data-active")).toBe(false)
    expect(trailing.hasAttribute("data-active")).toBe(false)
    expect(view.container.querySelector("[data-sidebar-mode]")).toHaveAttribute("data-sidebar-mode", "pinned")
    view.unmount()
  })
})

test("the pin button survives the canvas moving to the workspace screen", async () => {
  await withCanvasGeometry(async () => {
    const view = render(workspaceLayout(true))
    expect(view.container.querySelector("[data-sidebar-mode]")).toHaveAttribute("data-sidebar-mode", "pinned")
    await parkOnWorkspace(view.container)
    // The docked column belongs to the chat screen, so the panel itself gives way…
    expect(view.container.querySelector("[data-sidebar-mode]")).toHaveAttribute("data-sidebar-mode", "hidden")
    // …but the only control that can bring it back must still be there.
    expect(view.getByRole("switch")).toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
    view.unmount()
  })
})

test("the apps screen becomes interactive when parked and the chat dot brings the reader back", async () => {
  // jsdom never advances Embla's animation frames, so an eased return trip would not settle
  // within the test. Reduced motion makes every jump instant — the settled end state is the
  // same one a real window reaches after the animation.
  const media = window.matchMedia
  window.matchMedia = ((query: string) => ({
    ...media(query),
    matches: query.includes("prefers-reduced-motion")
  })) as typeof window.matchMedia
  try {
    await withCanvasGeometry(async () => {
      const view = render(workspaceLayout(true))
      const trailing = must(view.container.querySelector('[data-screen-panel="trailing"]'), "trailing screen")
      await parkOnWorkspace(view.container)
      // Parked on trailing: its controls (the board's back-to-chat button) must be reachable.
      expect(trailing.hasAttribute("inert")).toBe(false)
      const dots = [...view.container.querySelectorAll<HTMLButtonElement>(".canvas-dots button")]
      expect(dots.at(-1)).toHaveAttribute("aria-current", "page")
      await act(() => Promise.try(() => fireEvent.click(must(dots[0], "chat dot"))))
      expect(dots[0]).toHaveAttribute("aria-current", "page")
      expect(trailing.hasAttribute("inert")).toBe(true)
      expect(view.container.querySelector("[data-sidebar-mode]")).toHaveAttribute("data-sidebar-mode", "pinned")
      view.unmount()
    })
  } finally {
    window.matchMedia = media
  }
})

test("pressing the pin button from the workspace screen returns to chat and docks", async () => {
  await withCanvasGeometry(async () => {
    const view = render(workspaceLayout(false))
    await parkOnWorkspace(view.container)
    expect(view.container.querySelector("[data-sidebar-mode]")).toHaveAttribute("data-sidebar-mode", "hidden")
    await act(() => Promise.try(() => fireEvent.click(view.getByRole("switch"))))
    expect(save).toHaveBeenLastCalledWith("sidebarPinned", true)
    // `changePinned` jumps the canvas back to the chat region before docking: expanding must never
    // leave the reader looking at the workspace with no sidebar.
    expect(view.container.querySelector("[data-sidebar-mode]")).toHaveAttribute("data-sidebar-mode", "pinned")
    expect([...view.container.querySelectorAll(".canvas-dots button")][0]).toHaveAttribute("aria-current", "page")
    view.unmount()
  })
})

test("a collapsed sidebar never lets the leading or trailing screen bleed into chat", async () => {
  await withCanvasGeometry(async () => {
    const view = render(workspaceLayout(false))
    const panels = (name: string) => must(view.container.querySelector(`[data-screen-panel="${name}"]`), `${name} screen`)
    expect(view.container.querySelector("[data-sidebar-mode]")).toHaveAttribute("data-sidebar-mode", "hidden")
    // Regardless of how the collapsed column reshapes the track, only the chat screen is active:
    // neither neighbour is painted, so no strip can leak into the conversation's edges.
    expect(panels("main").hasAttribute("data-active")).toBe(true)
    expect(panels("leading").hasAttribute("data-active")).toBe(false)
    expect(panels("trailing").hasAttribute("data-active")).toBe(false)
    view.unmount()
  })
})

test("an unpinned sidebar parked on the workspace still expands and persists", async () => {
  await withCanvasGeometry(async () => {
    const view = render(workspaceLayout(false))
    await parkOnWorkspace(view.container)
    const toggle = view.getByRole("switch")
    expect(toggle).toHaveAttribute("aria-checked", "false")
    await act(() => Promise.try(() => fireEvent.click(toggle)))
    expect(view.container.querySelector("[data-sidebar-mode]")).toHaveAttribute("data-sidebar-mode", "pinned")
    expect(save).toHaveBeenLastCalledWith("sidebarPinned", true)
    view.unmount()
  })
})
