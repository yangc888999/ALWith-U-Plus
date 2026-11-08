import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

import { SidebarProvider } from "@/components/ui/sidebar"
import { must } from "@/lib/__tests__/must"
import { client } from "@/lib/client"
import { initI18n } from "@/lib/i18n"

import { SessionSidebar } from "../session-sidebar"
import { useSessionsUiStore } from "../store"

await initI18n("en")

const originalState = client.state
afterEach(async () => {
  await act(async () => {
    cleanup()
    client.store.setState(originalState, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})

function showSidebar() {
  return render(
    <SidebarProvider>
      <SessionSidebar
        screen="main"
        leadingPage="plugins"
        selectedId={null}
        onSelect={() => {}}
        onNewChat={() => {}}
        onNewProjectChat={() => {}}
        onSearch={() => {}}
        onOpenSettings={() => {}}
        onOpenPlugins={() => {}}
        onOpenExtensions={() => {}}
        onOpenAutomation={() => {}}
        onSwitchScreen={() => {}}
      />
    </SidebarProvider>
  )
}

test("empty quick chats stays first and collapsed with a project hover card", () => {
  client.store.setState({ sessionListLoaded: true, sessionList: [] })
  const view = showSidebar()
  const quick = view.getByRole("button", { name: "Chats (0)" })
  expect(quick).toHaveAttribute("aria-expanded", "false")
  expect(quick.closest('[data-slot="popover-trigger"]')).not.toBeNull()
  // Every group starts collapsed, so nothing in the sidebar is expanded yet.
  expect(view.queryAllByRole("button", { expanded: true })).toHaveLength(0)
})

test("group expansion, load more and collapse update the scrollbar without scrolling or resizing the viewport", async () => {
  const originalUi = useSessionsUiStore.getState()
  const observers = new Map<ResizeObserverCallback, Set<Element>>()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private elements = new Set<Element>()
      private callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        observers.set(callback, this.elements)
      }
      observe(element: Element) {
        this.elements.add(element)
      }
      unobserve(element: Element) {
        this.elements.delete(element)
      }
      disconnect() {
        observers.delete(this.callback)
      }
    }
  )
  try {
    useSessionsUiStore.setState({ projectOpen: new Map(), revealed: new Map() })
    client.store.setState({
      sessionListLoaded: true,
      sessionListError: null,
      sessionList: Array.from({ length: 205 }, (_, index) => ({
        sessionId: String(index),
        cwd: "/project",
        title: `Chat ${index}`,
        updatedAt: null,
        archived: false
      }))
    })
    const view = showSidebar()
    const viewport = must(
      view.container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]'),
      "the scroll viewport"
    )
    const content = must(viewport.firstElementChild, "the viewport content")
    let contentHeight = 100
    Object.defineProperties(viewport, {
      clientHeight: { value: 320 },
      clientWidth: { value: 240 },
      scrollWidth: { value: 240 },
      scrollHeight: { get: () => contentHeight }
    })
    const deliverResize = async (target: Element) => {
      await act(async () => {
        for (const [callback, elements] of observers) {
          if (elements.has(target)) callback([], {} as ResizeObserver)
        }
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })
    }
    // Deliver initial measurements, as the browser does when observation starts.
    await deliverResize(viewport)
    await deliverResize(content)
    expect(view.container.querySelector('[data-slot="scroll-area-scrollbar"]')).toBeNull()

    await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "project" }))))
    contentHeight = 3300
    await deliverResize(content)
    const scrollbar = must(
      view.container.querySelector<HTMLElement>('[data-slot="scroll-area-scrollbar"]'),
      "the scrollbar"
    )
    Object.defineProperty(scrollbar, "offsetHeight", { value: 320 })
    await deliverResize(content)
    const expandedThumb = Number.parseFloat(scrollbar.style.getPropertyValue("--scroll-area-thumb-height"))
    expect(expandedThumb).toBeGreaterThan(20)

    // Projects are expanded by default; collapsing them shrinks the content and therefore
    // lengthens the scrollbar thumb.
    await act(() => Promise.try(() => useSessionsUiStore.setState({ projectOpen: new Map() })))
    contentHeight = 1200
    await deliverResize(content)
    expect(Number.parseFloat(scrollbar.style.getPropertyValue("--scroll-area-thumb-height"))).toBeGreaterThan(
      expandedThumb
    )

    await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "project" }))))
    contentHeight = 100
    await deliverResize(content)
    expect(view.container.querySelector('[data-slot="scroll-area-scrollbar"]')).toBeNull()
    expect(viewport.scrollTop).toBe(0)
  } finally {
    cleanup()
    useSessionsUiStore.setState(originalUi, true)
    vi.unstubAllGlobals()
  }
}, 20_000)
