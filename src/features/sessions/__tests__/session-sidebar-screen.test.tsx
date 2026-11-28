import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { useState } from "react"
import { afterEach, expect, test, vi } from "vitest"

import { usePlatformAuth } from "@/features/auth/store"
import { type MainScreen, MainSidebarLayout } from "@/features/layout/components/main-sidebar-layout"
import { useUpdaterStore } from "@/features/updater/store"
import { client } from "@/lib/client"
import { initI18n } from "@/lib/i18n"

import { SessionSidebar } from "../session-sidebar"
import { useSessionsUiStore } from "../store"
import { TitleBarLeadingActions } from "../title-bar-leading"

await initI18n("en")

// The collapsed-sidebar rail duplicates the panel's entries with the same accessible names.
// These tests exercise the panel rows, which mount before the portal, so take the first match.
const sidebarButton = (view: ReturnType<typeof render>, options: { name: string | RegExp }): HTMLElement =>
  view.getAllByRole("button", options)[0] as HTMLElement
const originalState = client.state
const originalAuth = usePlatformAuth.getState()
const originalUi = useSessionsUiStore.getState()
const originalUpdater = useUpdaterStore.getState()
afterEach(async () => {
  await act(async () => {
    cleanup()
    client.store.setState(originalState, true)
    usePlatformAuth.setState(originalAuth, true)
    useSessionsUiStore.setState(originalUi, true)
    useUpdaterStore.setState(originalUpdater, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})

test("plugins are selected only on the leading screen, and new chat returns to main", async () => {
  useUpdaterStore.setState({
    state: {
      type: "ready",
      update: { version: "0.2.5", filename: "update.tar.gz", signature: "sig", contentLength: 100 }
    }
  })
  // The plugins entry is fixed navigation: it does not wait for the engine to connect.
  client.store.setState({ connection: "connecting", agent: null })
  function Harness() {
    const [screen, setScreen] = useState<MainScreen>("main")
    return (
      <MainSidebarLayout
        initialPinned
        screen={screen}
        leading={<main>Plugin content</main>}
        main={<main>Chat content</main>}
        sidebar={
          <SessionSidebar
            screen={screen}
            leadingPage="plugins"
            selectedId={null}
            onSelect={() => setScreen("main")}
            onNewChat={() => setScreen("main")}
            onNewProjectChat={() => {}}
            onSearch={() => {}}
            onOpenSettings={() => {}}
            onOpenPlugins={() => setScreen("leading")}
            onOpenExtensions={() => {}}
            onOpenAutomation={() => {}}
            onSwitchScreen={() => setScreen(screen === "main" ? "leading" : "main")}
          />
        }
      />
    )
  }
  const view = render(<Harness />)
  // 插件 / 扩展 / 技能 share one row whose flyout lists them; a plain click opens the first one.
  const plugins = sidebarButton(view, { name: "Workbench" })
  const updateCard = sidebarButton(view, { name: /Downloaded — click to update/ })
  const phone = sidebarButton(view, { name: "Connect phone" })
  expect(updateCard.closest('[data-slot="sidebar-footer"]')).toBe(phone.closest('[data-slot="sidebar-footer"]'))
  expect(view.queryByRole("button", { name: "Open workbench" })).toBeNull()
  expect(view.queryByRole("button", { name: "Back to chats" })).toBeNull()
  expect(plugins.hasAttribute("aria-current")).toBe(false)
  await act(() => Promise.try(() => fireEvent.click(plugins)))
  expect(plugins.getAttribute("aria-current")).toBe("page")
  expect(view.container.querySelector('[data-screen-panel="main"]')?.getAttribute("aria-hidden")).toBe("true")
  await act(() => Promise.try(() => fireEvent.click(sidebarButton(view, { name: "New task" }))))
  expect(plugins.hasAttribute("aria-current")).toBe(false)
  await act(() => Promise.try(() => fireEvent.click(plugins)))
  expect(plugins.getAttribute("aria-current")).toBe("page")
  // 新建任务 goes straight into a new chat: no flyout stands between the click and the page.
  const newTask = sidebarButton(view, { name: "New task" })
  expect(newTask.hasAttribute("aria-haspopup")).toBe(false)
  await act(() => Promise.try(() => fireEvent.click(newTask)))
  expect(view.queryByRole("menu")).toBeNull()
  expect(plugins.hasAttribute("aria-current")).toBe(false)
})

test("extensions sit below plugins, select their own leading page and remain available without Codex plugins", async () => {
  client.store.setState({
    agent: {
      info: { name: "test", version: "1" },
      protocolVersion: 2,
      capabilities: { _meta: { codex: { plugins: true } } }
    }
  })
  function Harness() {
    const [screen, setScreen] = useState<MainScreen>("main")
    const [leadingPage, setLeadingPage] = useState<"plugins" | "extensions">("plugins")
    return (
      <MainSidebarLayout
        initialPinned
        screen={screen}
        leading={<main>{leadingPage === "extensions" ? "Extension management" : "Plugin content"}</main>}
        main={<main>Chat content</main>}
        sidebar={
          <SessionSidebar
            screen={screen}
            leadingPage={leadingPage}
            selectedId={null}
            onSelect={() => setScreen("main")}
            onNewChat={() => setScreen("main")}
            onNewProjectChat={() => {}}
            onSearch={() => {}}
            onOpenSettings={() => {}}
            onOpenPlugins={() => {
              setLeadingPage("plugins")
              setScreen("leading")
            }}
            onOpenExtensions={() => {
              setLeadingPage("extensions")
              setScreen("leading")
            }}
            onOpenAutomation={() => {}}
            onSwitchScreen={() => setScreen(screen === "main" ? "leading" : "main")}
          />
        }
      />
    )
  }
  const view = render(<Harness />)
  const toolbox = sidebarButton(view, { name: "Workbench" })
  const openFlyout = async () => {
    fireEvent.pointerEnter(toolbox)
    return await waitFor(() => view.getByRole("menu", { name: "Workbench" }))
  }
  expect(toolbox.hasAttribute("aria-current")).toBe(false)

  // 插件 and 扩展 are destinations of the hover flyout rather than rows of their own, in that order.
  const flyout = await openFlyout()
  expect(within(flyout).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "Plugins",
    "Extensions",
    "Skills"
  ])

  await act(() => Promise.try(() => fireEvent.click(within(flyout).getByRole("menuitem", { name: "Extensions" }))))
  expect(toolbox.getAttribute("aria-current")).toBe("page")
  expect(view.getByText("Extension management")).toBeTruthy()
  expect(view.container.querySelector('[data-screen-panel="main"]')?.getAttribute("aria-hidden")).toBe("true")
  // Choosing a destination puts the flyout away again.
  expect(view.queryByRole("menu")).toBeNull()

  await act(() => Promise.try(() => fireEvent.click(sidebarButton(view, { name: "New task" }))))
  expect(toolbox.hasAttribute("aria-current")).toBe(false)

  const reopened = await openFlyout()
  await act(() => Promise.try(() => fireEvent.click(within(reopened).getByRole("menuitem", { name: "Plugins" }))))
  expect(toolbox.getAttribute("aria-current")).toBe("page")
  expect(view.getByText("Plugin content")).toBeTruthy()

  await act(() => Promise.try(() => client.store.setState({ agent: null })))
  // Both destinations stay reachable while the agent is disconnected.
  const offline = await openFlyout()
  expect(within(offline).getByRole("menuitem", { name: "Plugins" })).toBeTruthy()
  expect(within(offline).getByRole("menuitem", { name: "Extensions" })).toBeTruthy()
})

test("Drive mounts on first visit and retains input across tab switches until access is lost", async () => {
  usePlatformAuth.setState({
    isAuthenticated: true,
    user: { ...originalAuth.user, login_email: "test@finture.id" } as NonNullable<typeof originalAuth.user>
  })
  useSessionsUiStore.setState({ view: "sessions" })
  const view = render(
    <MainSidebarLayout
      initialPinned
      screen="main"
      leading={null}
      main={null}
      leadingActions={<TitleBarLeadingActions onOpenWindow={() => {}} />}
      sidebar={
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
          drivePanel={<input aria-label="Drive filter" defaultValue="" />}
        />
      }
    />
  )
  expect(view.queryByLabelText("Drive filter")).toBeNull()
  // 资料库 是侧栏里的一条会话入口；云盘面板首次访问时挂载，之后保持不动。
  await act(() => Promise.try(() => fireEvent.click(sidebarButton(view, { name: "YUP Drive" }))))
  const input = view.getByLabelText("Drive filter")
  fireEvent.change(input, { target: { value: "report" } })
  await act(() => Promise.try(() => fireEvent.click(sidebarButton(view, { name: "Activity" }))))
  expect(input).toBeInTheDocument()
  expect(input).not.toBeVisible()
  await act(() => Promise.try(() => fireEvent.click(sidebarButton(view, { name: "YUP Drive" }))))
  expect(view.getByLabelText("Drive filter")).toBe(input)
  expect(input).toHaveValue("report")
  expect(input).toBeVisible()
  await act(() => Promise.try(() => usePlatformAuth.setState({ isAuthenticated: false })))
  expect(view.queryByLabelText("Drive filter")).toBeNull()
  expect(useSessionsUiStore.getState().view).toBe("sessions")
})

test("the sidebar keeps 资料库 and no longer carries a BI Metrics row", async () => {
  usePlatformAuth.setState({
    isAuthenticated: true,
    user: { ...originalAuth.user, login_email: "test@finture.id" } as NonNullable<typeof originalAuth.user>
  })
  useSessionsUiStore.setState({ view: "sessions" })
  const view = render(
    <MainSidebarLayout
      initialPinned
      screen="main"
      leading={null}
      main={null}
      sidebar={
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
          drivePanel={<input aria-label="Drive filter" defaultValue="" />}
        />
      }
    />
  )
  // 资料库 opens the drive panel and toggles back to the conversation list.
  const library = sidebarButton(view, { name: "YUP Drive" })
  await act(() => Promise.try(() => fireEvent.click(library)))
  expect(library.getAttribute("aria-current")).toBe("page")
  expect(view.getByLabelText("Drive filter")).toBeVisible()
  await act(() => Promise.try(() => fireEvent.click(library)))
  expect(library.hasAttribute("aria-current")).toBe(false)
  // BI destinations moved out of the sidebar: BI Metrics comes from extensions and Online BI
  // now lives in the workbench.
  expect(view.queryByRole("button", { name: "BI Metrics" })).toBeNull()
  expect(view.queryByRole("button", { name: "Online BI" })).toBeNull()
  // Without company access the 资料库 row stays visible but dimmed, with the reason on hover: a
  // destination the reader knows about must not disappear, and clicking it leads to the page that
  // can actually fix it (2026-11-08).
  await act(() => Promise.try(() => usePlatformAuth.setState({ isAuthenticated: false })))
  const driveRow = view.queryByRole("button", { name: "YUP Drive" })
  expect(driveRow).not.toBeNull()
  expect(driveRow?.getAttribute("aria-disabled")).toBe("true")
  expect(driveRow?.getAttribute("title")).toContain("company account")
})

test("the quick-chat group carries its count while project rows stay uncounted", () => {
  useSessionsUiStore.setState({ view: "sessions" })
  const newChat = vi.fn()
  client.store.setState({
    sessionListLoaded: true,
    sessionList: [
      { sessionId: "one", cwd: "/tmp/project", title: "One", updatedAt: null, archived: false },
      { sessionId: "two", cwd: "/tmp/project", title: "Two", updatedAt: null, archived: false }
    ]
  })
  const view = render(
    <MainSidebarLayout
      initialPinned
      screen="main"
      leading={null}
      main={null}
      sidebar={
        <SessionSidebar
          screen="main"
          leadingPage="plugins"
          selectedId={null}
          onSelect={() => {}}
          onNewChat={newChat}
          onNewProjectChat={() => {}}
          onSearch={() => {}}
          onOpenSettings={() => {}}
          onOpenPlugins={() => {}}
          onOpenExtensions={() => {}}
          onOpenAutomation={() => {}}
          onSwitchScreen={() => {}}
        />
      }
    />
  )
  // 聊天 keeps its count inline, exactly like 项目; the project groups below show only their names,
  // because a second number next to every folder read as two different measurements.
  const chatHeader = sidebarButton(view, { name: "Chats (0)" })
  expect(chatHeader).toHaveAttribute("aria-expanded", "true")
  fireEvent.pointerEnter(chatHeader)
  expect(view.queryByRole("dialog")).toBeNull()
  const plus = view.container.querySelector<HTMLButtonElement>("[data-quick-chat-new]")
  if (plus === null) throw new Error("quick-chat new button is missing")
  fireEvent.click(plus)
  expect(newChat).toHaveBeenCalledOnce()
  expect(view.queryByText("2", { exact: true })).toBeNull()
  expect(view.queryByText(/loaded/i)).toBeNull()
  expect(view.queryByRole("button", { name: "Load more" })).toBeNull()
})

test("new task opens the welcome handler while the chat + starts a quick chat directly", () => {
  useSessionsUiStore.setState({ view: "sessions" })
  const newTask = vi.fn()
  const newQuickChat = vi.fn()
  client.store.setState({ sessionListLoaded: true, sessionList: [] })
  const view = render(
    <MainSidebarLayout
      initialPinned
      screen="main"
      leading={null}
      main={null}
      sidebar={
        <SessionSidebar
          screen="main"
          leadingPage="overview"
          selectedId={null}
          onSelect={() => {}}
          onNewChat={newTask}
          onNewQuickChat={newQuickChat}
          onNewProjectChat={() => {}}
          onSearch={() => {}}
          onOpenSettings={() => {}}
          onOpenPlugins={() => {}}
          onOpenExtensions={() => {}}
          onOpenAutomation={() => {}}
          onSwitchScreen={() => {}}
        />
      }
    />
  )
  fireEvent.click(sidebarButton(view, { name: "New task" }))
  expect(newTask).toHaveBeenCalledOnce()
  expect(newQuickChat).not.toHaveBeenCalled()
  const plus = view.container.querySelector<HTMLButtonElement>("[data-quick-chat-new]")
  if (plus === null) throw new Error("quick-chat new button is missing")
  fireEvent.click(plus)
  expect(newQuickChat).toHaveBeenCalledOnce()
  expect(newTask).toHaveBeenCalledOnce()
})

test("Extensions sits below plugins and selects its own leading page without an agent connection", async () => {
  client.store.setState({ connection: "disconnected", agent: null })
  function Harness() {
    const [screen, setScreen] = useState<MainScreen>("main")
    const [page, setPage] = useState<"plugins" | "extensions">("plugins")
    const open = (next: typeof page) => {
      setPage(next)
      setScreen("leading")
    }
    return (
      <MainSidebarLayout
        initialPinned
        screen={screen}
        leading={<main>{page}</main>}
        main={<main>Chat content</main>}
        sidebar={
          <SessionSidebar
            screen={screen}
            leadingPage={page}
            selectedId={null}
            onSelect={() => setScreen("main")}
            onNewChat={() => setScreen("main")}
            onNewProjectChat={() => {}}
            onSearch={() => {}}
            onOpenSettings={() => {}}
            onOpenPlugins={() => open("plugins")}
            onOpenExtensions={() => open("extensions")}
            onOpenAutomation={() => {}}
            onSwitchScreen={() => setScreen(screen === "main" ? "leading" : "main")}
          />
        }
      />
    )
  }
  const view = render(<Harness />)
  const toolbox = sidebarButton(view, { name: "Workbench" })
  expect(toolbox.closest('[data-slot="sidebar-header"]')).not.toBeNull()
  fireEvent.pointerEnter(toolbox)
  const flyout = await waitFor(() => view.getByRole("menu", { name: "Workbench" }))
  await act(() => Promise.try(() => fireEvent.click(within(flyout).getByRole("menuitem", { name: "Extensions" }))))
  expect(toolbox.getAttribute("aria-current")).toBe("page")
  expect(view.container.querySelector('[data-screen-panel="main"]')?.getAttribute("aria-hidden")).toBe("true")
  await act(() => Promise.try(() => fireEvent.click(sidebarButton(view, { name: "New task" }))))
  expect(toolbox.hasAttribute("aria-current")).toBe(false)
})
