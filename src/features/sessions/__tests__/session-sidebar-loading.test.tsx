import { act, cleanup, fireEvent, render, within } from "@testing-library/react"
import { SessionRow } from "@alwith/module-chat/session-list"
import { afterEach, expect, test, vi } from "vitest"

import { SidebarProvider } from "@/components/ui/sidebar"
import { must } from "@/lib/__tests__/must"
import { client } from "@/lib/client"
import { initI18n } from "@/lib/i18n"

import { SessionSidebar } from "../session-sidebar"
import { SessionListHostProvider } from "../session-list-host"
import type { PendingChatRow } from "../pending-chat"
import { useSessionsUiStore } from "../store"

await initI18n("en")

const originalState = client.state
const originalUi = useSessionsUiStore.getState()
afterEach(async () => {
  await act(async () => {
    cleanup()
    useSessionsUiStore.setState(originalUi, true)
    client.store.setState(originalState, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})

function showSidebar(pendingDirectory?: string | null, pendingChat?: PendingChatRow) {
  return render(
    <SidebarProvider>
      <SessionSidebar
        pendingDirectory={pendingDirectory}
        pendingChat={pendingChat}
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

test("the session row offers one delete action and requires confirmation for that session", async () => {
  const session = { sessionId: "row-to-delete", cwd: "/project", title: "Example chat", updatedAt: null, archived: false }
  client.store.setState({ sessionListLoaded: true, sessionList: [session] })
  useSessionsUiStore.setState({ projectOpen: new Map([[session.cwd, true]]) })
  const remove = vi.spyOn(client, "delete").mockResolvedValue(undefined)
  try {
    const view = showSidebar()
    const row = view.getByRole("button", { name: session.title })
    await act(async () => row.focus())
    const archive = await view.findByRole("button", { name: "Archive" })
    const actions = within(must(archive.closest<HTMLElement>('[data-slot="hover-info-card-actions"]'), "row actions"))
    fireEvent.click(actions.getByRole("button", { name: "Delete" }))
    const dialog = await view.findByRole("dialog")
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
    expect(remove).toHaveBeenCalledExactlyOnceWith(session.sessionId)
  } finally {
    remove.mockRestore()
  }
})

test("a session without a runtime state still shows the idle turn indicator", () => {
  const session = {
    sessionId: "idle-indicator",
    cwd: "/project",
    title: "Idle session",
    updatedAt: null,
    archived: false
  }
  client.store.setState({ sessionListLoaded: true, sessionList: [session], runStates: {} })
  const view = render(
    <SessionListHostProvider>
      <SessionRow sessionRow={session} active={false} onSelect={() => {}} />
    </SessionListHostProvider>
  )
  const leading = view.container.querySelector('[data-slot="navigation-leading"]')
  expect(leading?.querySelector(".bg-green-500")).not.toBeNull()
})

test.each([
  [null, true],
  [null, false],
  ["/new-project", true],
  ["/new-project", false]
] as const)("shows the pending row for %s, list loaded=%s", (cwd, loaded) => {
  client.store.setState({ sessionListLoaded: loaded, sessionList: [] })
  const view = showSidebar(cwd)
  expect(view.getByRole("button", { name: "New chat" })).toBeInTheDocument()
  expect(view.getByRole("status")).toHaveTextContent("Creating the conversation")
  expect(client.state.sessionList).toEqual([])
})

test("only the matching, renderable native row can replace a new project placeholder", () => {
  const row = { sessionId: "previous", cwd: "/project", title: "Previous draft", updatedAt: null, archived: false }
  client.store.setState({ sessionListLoaded: true, sessionList: [row], draftSessions: { previous: "main" } })
  const view = showSidebar(undefined, { key: "next", directory: row.cwd, status: "draft" })
  expect(view.getByRole("button", { name: "New chat" })).toBeVisible()
  view.unmount()
  client.store.setState({ sessionListLoaded: false, sessionList: [{ ...row, sessionId: "next-real" }] })
  const loading = showSidebar(undefined, { key: "next", directory: row.cwd, status: "connecting", sessionId: "next-real" })
  expect(loading.getByRole("button", { name: "New chat" })).toBeVisible()
  act(() => client.store.setState({ sessionListLoaded: true }))
  expect(loading.queryByRole("button", { name: "New chat" })).toBeNull()
  expect(loading.getByRole("button", { name: "Previous draft" })).toBeVisible()
})

test("empty quick chats stays first, collapsed, with an inline create button and no hover card", () => {
  client.store.setState({ sessionListLoaded: true, sessionList: [] })
  const view = showSidebar()
  const quick = view.getByRole("button", { name: "Chats (0)" })
  expect(quick).toHaveAttribute("aria-expanded", "false")
  expect(quick.closest('[data-slot="popover-trigger"]')).toBeNull()
  expect(view.getByRole("button", { name: "Create new chat" })).toBeVisible()
  // Every group starts collapsed, so nothing in the sidebar is expanded yet.
  expect(view.queryAllByRole("button", { expanded: true })).toHaveLength(0)
})

test("the local pending row is clickable and reports a retryable failure", () => {
  client.store.setState({ sessionListLoaded: true, sessionList: [] })
  let selected = 0
  const view = render(
    <SidebarProvider>
      <SessionSidebar
        pendingChat={{ key: "pending-1", directory: null, status: "retryable" }}
        onSelectPending={() => {
          selected += 1
        }}
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
  fireEvent.click(view.getByRole("button", { name: "New chat" }))
  expect(selected).toBe(1)
  expect(view.getByRole("status")).toHaveTextContent("Preparation failed; click to retry")
})

test("the local row disappears once its native session is in the list", () => {
  client.store.setState({
    sessionListLoaded: true,
    sessionList: [{ sessionId: "native-1", cwd: "/project", title: "Real chat", updatedAt: null, archived: false }]
  })
  const view = showSidebar()
  view.rerender(
    <SidebarProvider>
      <SessionSidebar
        pendingChat={{ key: "pending-1", directory: "/project", status: "connecting", sessionId: "native-1" }}
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
  expect(view.queryByRole("button", { name: "New chat" })).toBeNull()
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
