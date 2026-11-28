import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest"

import type { SessionSummary } from "@/agent/client"
import { commands } from "@/bindings"
import { SidebarProvider } from "@/components/ui/sidebar"
import { SessionSidebar } from "@/features/sessions/session-sidebar"
import { useSessionsUiStore } from "@/features/sessions/store"
import { must } from "@/lib/__tests__/must"
import { useChatWindowSurface, useMainWindowSurface } from "@/lib/chat-window-state"
import { client } from "@/lib/client"
import { initI18n } from "@/lib/i18n"

import * as projectApps from "../open-in-editor"
import { ChatProjectMenu } from "../project-session-popover"

const original = client.state
const originalUi = useSessionsUiStore.getState()
const originalChatSurface = useChatWindowSurface.getState()
const originalMainSurface = useMainWindowSurface.getState()
const defaultCwd = "/Volumes/Work/Documents/ALwith"
const openDirectory = vi.fn(async (_cwd: string | null) => {})
const resolveDirectory = vi.spyOn(commands, "draftDirectory")
afterAll(() => resolveDirectory.mockRestore())

beforeEach(async () => {
  await initI18n("en")
  resolveDirectory.mockReset().mockResolvedValue(defaultCwd)
  openDirectory.mockClear()
  vi.spyOn(projectApps, "useProjectApps").mockImplementation((cwd) => ({
    apps: [],
    active: undefined,
    openWith: () => {},
    refresh: () => {},
    openPreferred: () => openDirectory(cwd)
  }))
  client.store.setState({ connection: "ready", sessionList: [], sessionListLoaded: true, sessionListError: null })
})
afterEach(() => {
  cleanup()
  client.store.setState(original, true)
  useSessionsUiStore.setState(originalUi, true)
  useChatWindowSurface.setState(originalChatSurface, true)
  useMainWindowSurface.setState(originalMainSurface, true)
  vi.mocked(projectApps.useProjectApps).mockRestore()
})

function sessionRow(sessionId: string, cwd: string): SessionSummary {
  return { sessionId, cwd, title: sessionId, updatedAt: "2026-10-14T00:00:00Z", archived: false }
}

test("a project menu shows its own pending chat before history loads and hands off to one native row", async () => {
  const cwd = "/project"
  const native = sessionRow("Native chat", cwd)
  client.store.setState({ connection: "disconnected", sessionListLoaded: false })
  const select = vi.fn()
  const selectPending = vi.fn()
  const menu = (directory: string, sessionId?: string) => (
    <ChatProjectMenu cwd={cwd} currentSessionId={sessionId} onNewChat={() => {}} onSelect={select}
      pendingChat={{ key: "creating", directory, status: "draft", sessionId }} onSelectPending={selectPending} />
  )
  const view = render(menu("/another"))
  await act(() => Promise.resolve(fireEvent.click(view.getByRole("button", { name: "project" }))))
  expect(view.queryByText("Creating the conversation")).toBeNull()
  view.rerender(menu(cwd))
  const status = view.getByText("Creating the conversation")
  expect(status).toBeInTheDocument()
  fireEvent.click(must(status.closest("button"), "pending chat"))
  expect(selectPending).toHaveBeenCalledOnce()
  expect(select).not.toHaveBeenCalled()
  view.rerender(menu(cwd, native.sessionId))
  act(() => client.store.setState({ sessionListLoaded: true, sessionList: [native], draftSessions: { [native.sessionId]: "main" } }))
  await act(() => Promise.resolve(fireEvent.click(view.getByRole("button", { name: "project" }))))
  expect(view.queryByText("Creating the conversation")).toBeNull()
  expect(view.getAllByRole("button", { name: native.title! })).toHaveLength(1)
})

test("quick chats update their empty state as windows hide and keep the current conversation excluded", async () => {
  const cwd = "/Users/mac/Documents/ALwith"
  const main = sessionRow("Main chat", cwd)
  const floating = sessionRow("Floating chat", cwd)
  client.store.setState({ sessionList: [main, floating] })
  useMainWindowSurface.setState({ sessionId: main.sessionId, visible: true })
  useChatWindowSurface.setState({ sessionId: floating.sessionId, visible: true })
  const view = render(
    <ChatProjectMenu cwd={cwd} currentSessionId={main.sessionId} onSelect={() => {}} onNewChat={() => {}} />
  )
  await act(() => Promise.resolve(fireEvent.click(view.getByRole("button", { name: "Chats" }))))
  expect(view.queryByText("0 chats")).toBeNull()
  expect(view.getByText("No chats found")).toBeVisible()
  expect(view.queryByRole("button", { name: "Show more" })).toBeNull()
  await act(() => {
    useChatWindowSurface.setState({ visible: false })
    useMainWindowSurface.setState({ visible: false })

    return Promise.resolve()
  })
  expect(view.queryByText("1 chat")).toBeNull()
  expect(view.queryByText("No chats found")).toBeNull()
  expect(view.getByRole("button", { name: "Floating chat" })).toBeVisible()
  expect(view.queryByRole("button", { name: "Main chat" })).toBeNull()
})

test("quick chats use the sidebar grouping and ordering before the default directory resolves", async () => {
  const pending = Promise.withResolvers<string>()
  resolveDirectory.mockReturnValueOnce(pending.promise)
  const select = vi.fn()
  const entries = [
    sessionRow("ALwith chat", "/Users/mac/Documents/ALwith"),
    { ...sessionRow("Codex chat", "/Users/mac/Documents/Codex/nested"), updatedAt: "2026-10-14T01:00:00Z" },
    { ...sessionRow("Windows chat", String.raw`C:\Users\Alice\Documents\Codex`), updatedAt: "2026-10-14T02:00:00Z" },
    sessionRow("Other project", "/tmp/project"),
    sessionRow("Nested project", "/Users/mac/Documents/ALwith/project"),
    sessionRow("Resolved directory chat", defaultCwd)
  ]
  client.store.setState({ sessionList: entries })
  const view = render(<ChatProjectMenu cwd={null} onSelect={select} onNewChat={() => {}} />)
  const folder = view.getByRole("button", { name: "Chats" })
  expect(folder.querySelector(".lucide-folder-closed")).not.toBeNull()
  await act(() => Promise.try(() => fireEvent.click(folder)))
  expect(view.getByRole("dialog", { name: "Chats" })).toBeVisible()
  expect(view.queryByText("3 chats")).toBeNull()
  expect(
    view.getAllByRole("button", { name: /^(ALwith|Codex|Windows) chat$/ }).map((item) => item.textContent)
  ).toEqual([
    expect.stringContaining("Windows chat"),
    expect.stringContaining("Codex chat"),
    expect.stringContaining("ALwith chat")
  ])
  expect(view.queryByRole("button", { name: "Other project" })).toBeNull()
  expect(view.queryByRole("button", { name: "Nested project" })).toBeNull()
  expect(view.queryByRole("button", { name: "Resolved directory chat" })).toBeNull()
  expect(view.getByRole("status")).toBeVisible()
  await act(() => Promise.try(() => pending.resolve(defaultCwd)))
  expect(resolveDirectory).toHaveBeenCalledWith({ cwd: null })
  expect(view.getByRole("button", { name: "Chats" })).toBe(folder)
  expect(folder).toHaveAttribute("title", "Chats")
  expect(view.getByRole("button", { name: "Open project folder" }).getAttribute("title")).toContain(defaultCwd)
  expect(view.queryByText("3 chats")).toBeNull()
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "ALwith chat" }))))
  expect(select).toHaveBeenCalledWith(entries[0])
})

test.each([
  "/Users/mac/Documents/ALwith",
  "/Users/mac/Documents/Codex",
  "/Users/mac/Documents/Codex/nested",
  String.raw`C:\Users\Alice\Documents\ALwith`
])("quick-chat directory %s keeps the default-folder and new-chat actions", async (cwd) => {
  const newChat = vi.fn()
  const view = render(<ChatProjectMenu cwd={cwd} onSelect={() => {}} onNewChat={newChat} />)
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Chats" }))))
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Open project folder" }).getAttribute("title")).toContain(defaultCwd)
  )
  expect(view.getByText("No chats found")).toBeVisible()
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Open project folder" }))))
  expect(openDirectory).toHaveBeenCalledWith(defaultCwd)
  expect(newChat).not.toHaveBeenCalled()
  await waitFor(() => expect(view.queryByRole("dialog")).toBeNull())
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Chats" }))))
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "New chat" }))))
  expect(newChat).toHaveBeenCalledOnce()
})

test.each([
  ["/tmp/project", "project"],
  ["/Users/mac/Documents/ALwith U", "ALwith U"]
])("project %s keeps its own menu without resolving the default directory", async (cwd, name) => {
  client.store.setState({ sessionList: [sessionRow("Project chat", cwd), sessionRow("Quick chat", defaultCwd)] })
  const view = render(<ChatProjectMenu cwd={cwd} onSelect={() => {}} onNewChat={() => {}} />)
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name }))))
  expect(view.getByRole("button", { name: "Project chat" })).toBeVisible()
  expect(view.queryByRole("button", { name: "Quick chat" })).toBeNull()
  expect(resolveDirectory).not.toHaveBeenCalled()
})

test("a project starts a chat in its own directory without waiting for history or the default directory", async () => {
  const start = vi.fn()
  client.store.setState({ connection: "disconnected", sessionListLoaded: false })
  const view = render(<ChatProjectMenu cwd="/work/alpha" onSelect={() => {}} onNewChat={start} />)
  fireEvent.click(view.getByRole("button", { name: "alpha" }))
  fireEvent.click(await view.findByRole("button", { name: "New chat" }))
  expect(start).toHaveBeenCalledExactlyOnceWith("/work/alpha")
  expect(resolveDirectory).not.toHaveBeenCalled()
})

test("a delayed default-directory result cannot replace a newly selected project", async () => {
  const pending = Promise.withResolvers<string>()
  resolveDirectory.mockReturnValueOnce(pending.promise)
  const view = render(<ChatProjectMenu cwd={null} onSelect={() => {}} onNewChat={() => {}} />)
  view.rerender(<ChatProjectMenu cwd="/tmp/project" onSelect={() => {}} onNewChat={() => {}} />)
  await act(() => Promise.try(() => pending.resolve(defaultCwd)))
  expect(view.getByRole("button", { name: "project" })).toHaveAttribute("title", "/tmp/project")
  expect(view.queryByRole("button", { name: "Chats" })).toBeNull()
})

test("directory errors leave quick chats available and support retry without inventing a path", async () => {
  resolveDirectory.mockRejectedValueOnce(new Error("Documents directory unavailable"))
  client.store.setState({ sessionList: [sessionRow("Existing quick chat", "/Users/mac/Documents/Codex")] })
  const view = render(<ChatProjectMenu cwd={null} onSelect={() => {}} onNewChat={() => {}} />)
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Chats" }))))
  expect(view.getByRole("alert")).toHaveTextContent("Documents directory unavailable")
  expect(view.getByRole("button", { name: "Existing quick chat" })).toBeVisible()
  expect(view.queryByRole("button", { name: "Open project folder" })).toBeNull()
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Retry" }))))
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Open project folder" }).getAttribute("title")).toContain(defaultCwd)
  )
  expect(resolveDirectory).toHaveBeenCalledTimes(2)
})

test("clearing a project switches the open menu to localized quick chats and follows the shared list", async () => {
  await initI18n("zh-CN")
  client.store.setState({ sessionList: [sessionRow("Project chat", "/tmp/project")] })
  const view = render(<ChatProjectMenu cwd="/tmp/project" onSelect={() => {}} onNewChat={() => {}} />)
  await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "project" }))))
  await act(() =>
    Promise.try(() => view.rerender(<ChatProjectMenu cwd={null} onSelect={() => {}} onNewChat={() => {}} />))
  )
  expect(view.getByRole("dialog", { name: "聊天" })).toBeVisible()
  expect(view.queryByRole("button", { name: "Project chat" })).toBeNull()
  await act(() =>
    Promise.try(() =>
      client.store.setState({ sessionList: [sessionRow("New quick chat", "/Users/mac/Documents/ALwith")] })
    )
  )
  expect(view.getByRole("button", { name: "New quick chat" })).toBeVisible()
})

test("the sidebar quick-chat group has no hover popup and its + creates a chat", async () => {
  client.store.setState({
    sessionList: [sessionRow("ALwith chat", "/Users/mac/Documents/ALwith")]
  })
  useSessionsUiStore.setState({ projectOpen: new Map(), view: "sessions" })
  const select = vi.fn()
  const newChat = vi.fn()
  const newProjectChat = vi.fn()
  const sidebar = render(
    <SidebarProvider>
      <SessionSidebar
        screen="main"
        leadingPage="plugins"
        selectedId={null}
        onSelect={select}
        onNewChat={newChat}
        onNewProjectChat={newProjectChat}
        onSearch={() => {}}
        onOpenSettings={() => {}}
        onOpenPlugins={() => {}}
        onOpenExtensions={() => {}}
        onOpenAutomation={() => {}}
        onSwitchScreen={() => {}}
      />
    </SidebarProvider>
  )
  // The sidebar group carries its chat count in the accessible name.
  const group = sidebar.getByRole("button", { name: "Chats (1)" })
  // Groups start expanded now, so a click collapses; click again to prove it expands.
  await act(() => Promise.try(() => fireEvent.click(group)))
  await act(() => Promise.try(() => fireEvent.click(group)))
  expect(group).toHaveAttribute("aria-expanded", "true")
  fireEvent.pointerEnter(group, { pointerType: "mouse" })
  fireEvent.mouseEnter(group)
  fireEvent.mouseMove(group)
  expect(sidebar.queryByRole("dialog")).toBeNull()
  fireEvent.click(sidebar.getByRole("button", { name: "Create new chat" }))
  expect(newChat).toHaveBeenCalledOnce()
  expect(newProjectChat).not.toHaveBeenCalled()
})
