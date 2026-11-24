import { ReadableStream, TransformStream, WritableStream } from "node:stream/web"

import { drafts, importDraft } from "@alwith/module-chat/conversation"
import * as core from "@tauri-apps/api/core"
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks"
import { act, fireEvent, render as renderView, waitFor, within } from "@testing-library/react"
import { type ReactElement, StrictMode, useState } from "react"
import { afterEach, expect, test, vi } from "vitest"

import { createFakeAgent } from "@/agent/__tests__/fake-agent"
import { FakeHubPort } from "@/agent/__tests__/fake-runtime-client"
import { type ClientOptions, CodexClient } from "@/agent/client"
import { ThemeProvider } from "@/components/theme-provider"
import { ChatWindow } from "@/features/chat-window/chat-window"
import { must } from "@/lib/__tests__/must"
import * as chatWindow from "@/lib/chat-window"
import { client, useApp, useSession } from "@/lib/client"
import { initI18n } from "@/lib/i18n"
import type { Preferences } from "@/lib/preferences"
import { type ProviderSnapshot, resolveSessionModel } from "@/lib/providers"
import { armStartupWindow, resetStartupWindow, stallStartupWindow } from "@/lib/startup-window"
import { mockOf } from "@/test/mock-of"

import { navigationSoundStore } from "../codex/navigation-sound-store"
import { DRAFT_SESSION_ID, DraftChat } from "../draft-chat"
import * as projectPicker from "../draft-project-picker"
import { Composer } from "./timeline-host"

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({ ...(await importOriginal<object>()) }))

// ACP uses native Web Streams; jsdom supplies only the browser surface.
Object.assign(globalThis, { TransformStream, ReadableStream, WritableStream })
await initI18n("en")
// DraftChat reads U's theme through the conversation host, as under the application's ThemeProvider.
const render = (ui: ReactElement) => renderView(ui, { wrapper: ThemeProvider })
const providers: ProviderSnapshot = {
  revision: 1,
  appliedRevision: 1,
  providers: {},
  customProviders: [],
  builtInModels: {}, managedProviders: [],
  status: "applied",
  error: null
}

function environment(nativeWindow = false, resolveModel?: ClientOptions["resolveModel"]) {
  return Promise.try(() => {
    const fake = createFakeAgent()
    const port = new FakeHubPort(() => fake.app)
    const real = new CodexClient(() => Promise.resolve(port), {
      agentId: "codex",
      launch: { engine: "codex" },
      resolveModel
    })
    const previous = client.state
    client.store.setState(real.state)
    const unsubscribe = real.store.subscribe((state) => client.store.setState(state))
    const invokeHost = core.invoke
    const mocks = [
      vi.spyOn(client, "connect").mockImplementation(() => real.connect()),
      vi.spyOn(client, "session").mockImplementation((id) => real.session(id)),
      vi.spyOn(client, "prepareDraft").mockImplementation((...args) => real.prepareDraft(...args)),
      vi.spyOn(client, "discardDraft").mockImplementation((...args) => real.discardDraft(...args)),
      vi.spyOn(client, "setConfig").mockImplementation((...args) => real.setConfig(...args)),
      vi.spyOn(client, "prompt").mockImplementation((...args) => real.prompt(...args)),
      vi.spyOn(client, "respond").mockImplementation((...args) => real.respond(...args)),
      vi.spyOn(core, "invoke").mockImplementation(async <T,>(command: string, args?: core.InvokeArgs): Promise<T> => {
        let result: unknown
        if (command === "enterprise_catalog") result = null
        else if (command === "draft_directory")
          result = (args as { cwd: string | null }).cwd ?? "/Users/mac/Documents/ALwith"
        else if (command === "providers_apply" || command === "providers_read") result = providers
        else if (command === "read_apps_info") result = []
        else if (nativeWindow) return invokeHost<T>(command, args)
        else throw new Error(`Unexpected host command: ${command}`)
        return result as T
      })
    ]
    return {
      real,
      fake,
      restore: () => {
        unsubscribe()
        for (const mock of mocks) mock.mockRestore()
        real.disconnect()
        client.store.setState(previous, true)
        drafts.clear()
      }
    }
  })
}

const windowPreferences: Preferences = {
  defaultStartSurface: "chat",
  sidebarPinned: false,
  lastProjectDirectory: "/tmp/window-original",
  language: "en",
  profileNickname: null,
  profileAvatar: null,
  profileOwner: null,
  zoomLevel: null,
  uiFont: "pingfang",
  modelSelections: { main: null, chat: null },
  navigationSoundMode: "none",
  navigationInstrument: "acoustic_grand_piano",
  externalEditor: null
}

async function windowEnvironment() {
  const sound = navigationSoundStore.getState()
  navigationSoundStore.setState({ soundMode: "none" })
  mockWindows("chat")
  let hidden = true
  mockIPC(
    (command) => {
      if (command === "plugin:log|log") return
      if (command === "plugin:window|is_focused" || command === "plugin:window|is_minimized") return false
      if (command === "plugin:window|is_visible") return !hidden
      if (command === "plugin:window|hide") {
        hidden = true
        return
      }
      if (command === "present_chat_window") {
        hidden = false
        return
      }
      throw new Error(`Unexpected window command: ${command}`)
    },
    { shouldMockEvents: true }
  )
  const env = await environment(true)
  type SurfaceHandler = Parameters<typeof chatWindow.serveChatSurface>[0]
  let surface: SurfaceHandler | null = null
  const mocks = [
    vi.spyOn(chatWindow, "serveChatSurface").mockImplementation((handler) => {
      surface = handler
      return Promise.resolve(() => {
        surface = null
      })
    }),
    vi.spyOn(chatWindow, "announceChatReady").mockResolvedValue(),
    vi.spyOn(chatWindow, "publishChatWindowSurface").mockResolvedValue(),
    vi.spyOn(projectPicker, "chooseFolder").mockResolvedValue("/tmp/window-replacement"),
    vi.spyOn(client, "open").mockImplementation(async (id, cwd) => {
      if (env.fake.deleted.has(id)) throw new Error("Cannot resume a deleted session")
      await env.real.open(id, cwd, "chat")
    })
  ]
  return {
    ...env,
    get hidden() {
      return hidden
    },
    async present(sessionId?: string): Promise<void> {
      await must(surface, "window handler")({ type: "present", sessionId })
    },
    async release(id: string): Promise<chatWindow.ChatTransfer | null> {
      return await must(surface, "window handler")({ type: "release", sessionId: id })
    },
    ready: (): boolean => surface !== null,
    restore: (): void => {
      for (const mock of mocks) mock.mockRestore()
      env.restore()
      navigationSoundStore.setState(sound)
      clearMocks()
    }
  }
}

test("floating project menus switch from a draft to another conversation and exclude the displayed session", async () => {
  const env = await windowEnvironment()
  const view = render(
    <ThemeProvider>
      <ChatWindow preferences={windowPreferences} />
    </ThemeProvider>
  )
  try {
    await waitFor(() => expect(env.ready()).toBe(true))
    await act(() => client.connect())
    let existing = ""
    await act(async () => {
      existing = await env.real.newSession("/tmp/window-original", null, "chat")
    })
    await act(() => env.present())
    await waitFor(() => expect(Object.keys(env.real.state.draftSessions)).toHaveLength(1))
    const draft = must(Object.keys(env.real.state.draftSessions)[0], "the floating draft")
    await act(() => {
      env.real.store.setState({
        sessionListLoaded: true,
        sessionList: [
          { sessionId: draft, cwd: "/tmp/window-original", title: "Current draft", updatedAt: null, archived: false },
          {
            sessionId: existing,
            cwd: "/tmp/window-original",
            title: "Other conversation",
            updatedAt: null,
            archived: false
          }
        ]
      })

      return Promise.resolve()
    })
    const header = within(must(view.container.querySelector("header"), "the floating window header"))
    await act(() => Promise.resolve(fireEvent.click(header.getByRole("button", { name: "window-original" }))))
    expect(view.queryByRole("button", { name: "Current draft" })).toBeNull()
    expect(view.getByText("1 chat")).toBeVisible()
    await act(() => Promise.resolve(fireEvent.click(view.getByRole("button", { name: "Other conversation" }))))
    await waitFor(() => expect(chatWindow.publishChatWindowSurface).toHaveBeenLastCalledWith(existing, true))
    expect(env.real.state.draftSessions[draft]).toBeUndefined()
    expect(env.real.state.sessionWindows[existing]).toBe("chat")
    await act(() => Promise.resolve(fireEvent.click(header.getByRole("button", { name: "window-original" }))))
    expect(view.queryByRole("button", { name: "Other conversation" })).toBeNull()
  } finally {
    await act(() => Promise.resolve(view.unmount()))
    env.restore()
  }
})

test.each([
  ["/private/var/folders/example/T/project", "/private/var/folders/example/T/project"],
  ["/Users/mac/Documents/Codex/project", "/Users/mac/Documents/ALwith"],
  ["/work/project", "/work/project"]
])("floating new chat from %s prepares in %s", async (cwd, expected) => {
  const env = await windowEnvironment()
  const discard = vi.spyOn(client, "discardDraft").mockImplementation((owner) => env.real.discardDraft(owner))
  const view = render(
    <ThemeProvider>
      <ChatWindow preferences={{ ...windowPreferences, lastProjectDirectory: cwd }} />
    </ThemeProvider>
  )
  try {
    await waitFor(() => expect(env.ready()).toBe(true))
    await act(() => env.present())
    await waitFor(() => expect(Object.keys(env.real.state.draftSessions)).toHaveLength(1))
    const previous = must(Object.keys(env.real.state.draftSessions)[0], "the first draft session")
    await act(() => {
      return Promise.try(() => {
        fireEvent.input(view.getByRole("textbox"), { target: { value: "First message" } })
        fireEvent.keyUp(view.getByRole("textbox"), { key: "e" })
      })
    })
    await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Send" }))))
    await waitFor(() => expect(env.real.state.draftSessions[previous]).toBeUndefined())
    await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "More actions" }))))
    await act(() => Promise.try(() => fireEvent.click(view.getByRole("menuitem", { name: "New chat" }))))
    await waitFor(() => {
      const id = must(Object.keys(env.real.state.draftSessions)[0], "the new draft session")
      expect(id).not.toBe(previous)
      expect(env.real.session(id).cwd).toBe(expected)
    })
    expect(discard).toHaveBeenCalledWith("chat")
    expect(env.real.session(previous).cwd).toBe(cwd)
    expect(env.real.session(previous).items.some((item) => item.kind === "user")).toBe(true)
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    discard.mockRestore()
    env.restore()
  }
})

test("work without a project asks for a folder only when the reader tries to send", async () => {
  const env = await windowEnvironment()
  const prompt = vi.spyOn(client, "prompt")
  const view = render(
    <ThemeProvider>
      <ChatWindow
        preferences={{
          ...windowPreferences,
          defaultStartSurface: "work",
          lastProjectDirectory: "/Users/mac/Documents/ALwith"
        }}
      />
    </ThemeProvider>
  )
  try {
    await waitFor(() => expect(env.ready()).toBe(true))
    await act(() => env.present())
    await waitFor(() => expect(view.getByRole("textbox")).toBeTruthy())

    // Entering Work is not itself a send: the reader can type first, and no modal interrupts the
    // empty state or the project picker.
    expect(view.queryByRole("alertdialog")).toBeNull()
    fireEvent.input(view.getByRole("textbox"), { target: { value: "draft stays here" } })
    await waitFor(() => expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false))
    await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Send" }))))

    const dialog = await view.findByRole("alertdialog")
    expect(within(dialog).getByText("Add a project folder before chatting.")).toBeVisible()
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeVisible()
    expect(within(dialog).getByRole("button", { name: "Add" })).toBeVisible()
    expect(prompt).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(view.queryByRole("alertdialog")).toBeNull())
    expect(view.getByRole("textbox")).toHaveValue("draft stays here")
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    prompt.mockRestore()
    env.restore()
  }
})

test("the new-task tabs keep Chat to one composer and open the newest recent conversation", async () => {
  const env = await environment()
  const onOpenProject = vi.fn()
  const props = {
    owner: "main" as const,
    onCwdChange: () => {},
    onCreated: () => {},
    onSendingChange: () => {},
    onAuthRequired: () => {},
    onNewChat: () => {},
    onOpenProject,
    providerSnapshot: providers
  }
  await act(() => {
    env.real.store.setState({
      sessionListLoaded: true,
      sessionList: [
        {
          sessionId: "a1",
          cwd: "/work/alpha",
          title: "older alpha",
          updatedAt: "2026-11-20T10:00:00Z",
          archived: false
        },
        {
          sessionId: "b2",
          cwd: "/work/beta",
          title: "newest beta",
          updatedAt: "2026-11-22T10:00:00Z",
          archived: false
        },
        {
          sessionId: "b1",
          cwd: "/work/beta",
          title: "older beta",
          updatedAt: "2026-11-21T10:00:00Z",
          archived: false
        }
      ]
    })
    return Promise.resolve()
  })
  const view = render(<DraftChat {...props} cwd="/tmp/chat-home" startSurface="chat" />)
  try {
    await waitFor(() => expect(view.getByRole("textbox")).toBeTruthy())
    const greeting = view.getByRole("heading", { level: 1 }).textContent
    expect(greeting).toBeTruthy()
    expect(view.queryByText("How can I help you?")).toBeNull()
    expect(view.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true")
    expect(view.container.querySelector(".welcome-hero")?.className).toContain("justify-center")
    const draftSurface = view.container.querySelector("[data-chat-drop-zone]")
    expect(draftSurface?.className).toContain("max-w-[var(--chat-column-width)]")
    expect(draftSurface?.className).not.toContain("max-w-[1120px]")
    const heroCore = view.container.querySelector(".welcome-hero-core")
    expect(heroCore).not.toBeNull()
    const composerFrame = view.container.querySelector(".welcome-hero-composer")
    expect(composerFrame?.className).toContain("max-w-3xl")
    expect(composerFrame?.className).not.toContain("max-w-4xl")
    expect(view.container.querySelector(".chat-project-picker")).toBeNull()
    expect(view.queryByRole("region", { name: "Recent projects" })).toBeNull()

    fireEvent.click(view.getByRole("tab", { name: "Work" }))
    expect(view.getByRole("tab", { name: "Work" })).toHaveAttribute("aria-selected", "true")
    expect(view.getByRole("heading", { level: 1 }).textContent).toBe(greeting)
    expect(view.container.querySelector(".welcome-hero-composer")).toBe(composerFrame)
    await waitFor(() => expect(view.container.querySelector(".chat-project-picker")).not.toBeNull())
    const recent = view.getByRole("region", { name: "Recent projects" })
    expect(heroCore?.contains(recent)).toBe(true)
    expect(recent.className).toContain("welcome-hero-recent")
    expect(recent.className).toContain("top-[calc(100%+1.5rem)]")
    const beta = within(recent).getAllByRole("button").find((button) => button.title === "/work/beta")
    expect(beta).toBeDefined()
    fireEvent.click(beta!)
    expect(onOpenProject).toHaveBeenCalledExactlyOnceWith("/work/beta", "b2")
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    env.restore()
  }
})

test("a draft keeps the project-memory action reachable", async () => {
  // Clearing the context archives the conversation and lands on a draft. The memory action lives on
  // the chat column's edge, not in a session menu, so it has to survive that swap — it used to be
  // missing exactly then, and after a reload too.
  const { restore } = await environment()
  const prompt = vi.spyOn(client, "prompt")
  const props = {
    owner: "main" as const,
    onCwdChange: () => {},
    onCreated: () => {},
    onSendingChange: () => {},
    onAuthRequired: () => {},
    onNewChat: () => {},
    providerSnapshot: providers
  }
  const view = render(<DraftChat {...props} cwd="/tmp/draft-memory" />)
  try {
    const read = await view.findByRole("button", { name: "Read project memory" })
    expect(read.getAttribute("title")).toBe("Read project memory")
    // The edge action sends straight away only once the draft has materialised; before that it has
    // to park the text in the composer instead.
    await waitFor(() => expect(Object.keys(client.state.draftSessions)).toHaveLength(1))
    await act(() => Promise.try(() => fireEvent.click(read)))
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
    const blocks = must(prompt.mock.calls[0], "memory prompt")[1]
    expect(
      blocks.some((block) => block.type === "text" && typeof block.text === "string" && block.text.includes("memory.md"))
    ).toBe(true)
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    restore()
  }
})

test("a hidden floating window reopens the replacement draft with its unsent input", async () => {
  const env = await windowEnvironment()
  importDraft(DRAFT_SESSION_ID, { text: "keep this draft", mentions: [], attachments: [], modelId: null })
  let release: (() => void) | undefined
  env.fake.newSessionDelay.current = (cwd) =>
    cwd === "/tmp/window-replacement"
      ? new Promise((resolve) => {
          release = resolve
        })
      : Promise.resolve()
  const view = render(
    <ThemeProvider>
      <ChatWindow preferences={windowPreferences} />
    </ThemeProvider>
  )
  try {
    await waitFor(() => expect(env.ready()).toBe(true))
    expect(env.fake.modelHints.size).toBe(0)
    await act(() => env.present())
    await waitFor(() => expect(view.getByRole("textbox")).toBeTruthy())
    const original = must(Object.keys(env.real.state.draftSessions)[0], "original draft")
    await act(async () => {
      await expect(env.present("a-different-session")).rejects.toThrow("conversation changed")
    })
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("keep this draft")
    await act(() => env.present(original))
    expect(chatWindow.publishChatWindowSurface).toHaveBeenLastCalledWith(original, true)
    await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "More actions" }))))
    await act(() => Promise.try(() => fireEvent.click(view.getByRole("menuitem", { name: "New project" }))))
    await waitFor(() => expect(release).toBeDefined())
    // Escape belongs to the menu until its exit transition removes it.
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull())
    await act(() => Promise.try(() => fireEvent.keyDown(window, { key: "Escape" })))
    expect(env.hidden).toBe(true)
    expect(chatWindow.publishChatWindowSurface).toHaveBeenLastCalledWith(original, false)
    await act(() => Promise.try(() => must(release, "pending replacement")()))
    await waitFor(() => expect(env.fake.deleted.has(original)).toBe(true))
    await act(() => env.present())
    expect(env.hidden).toBe(false)
    await waitFor(() => expect(view.getByRole("textbox")).toBeTruthy())
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("keep this draft")
    expect(
      within(must(view.container.querySelector("header"), "the floating window header")).getByRole("button", {
        name: "window-replacement"
      })
    ).toBeVisible()
    const replacement = must(Object.keys(env.real.state.draftSessions)[0], "replacement draft")
    let transfer: chatWindow.ChatTransfer | null = null
    await act(async () => {
      transfer = await env.release(replacement)
    })
    expect(transfer).toMatchObject({ sessionId: replacement, cwd: "/tmp/window-replacement" })
    expect(env.hidden).toBe(true)
    expect(view.queryByRole("textbox")).toBeNull()
    expect(chatWindow.publishChatWindowSurface).toHaveBeenLastCalledWith(null, false)
    expect(env.fake.modelHints.size).toBe(2)
  } finally {
    release?.()
    await act(() => Promise.try(() => view.unmount()))
    env.restore()
  }
})

test("a first message sent outside the composer opens the conversation and preserves unsent input", async () => {
  const env = await windowEnvironment()
  importDraft(DRAFT_SESSION_ID, { text: "my unsent input", mentions: [], attachments: [], modelId: null })
  const view = render(
    <ThemeProvider>
      <ChatWindow preferences={windowPreferences} />
    </ThemeProvider>
  )
  try {
    await waitFor(() => expect(env.ready()).toBe(true))
    await act(() => env.present())
    await waitFor(() => expect(view.getByRole("textbox")).toBeTruthy())
    const id = must(Object.keys(env.real.state.draftSessions)[0], "draft")
    await act(() => env.real.prompt(id, [{ type: "text", text: "Message from extension" }]))
    await waitFor(() => expect(view.getByText("Message from extension")).toBeTruthy())
    expect(env.real.state.draftSessions[id]).toBeUndefined()
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("my unsent input")
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    env.restore()
  }
})

test.each(["success", "failure", "unmount", "directory-change"] as const)(
  "preparation blocks submission through %s without losing or misrouting input",
  async (outcome) => {
    const { fake, real, restore } = await environment()
    let release: (() => void) | undefined
    fake.newSessionDelay.current = (cwd) =>
      cwd === "/tmp/slow-start"
        ? new Promise<void>((resolve, reject) => {
            release = () => (outcome === "failure" ? reject(new Error("Preparation failed")) : resolve())
          })
        : Promise.resolve()
    const prompt = vi.spyOn(client, "prompt")
    const props = {
      owner: "main" as const,
      onCwdChange: () => {},
      onCreated: () => {},
      onSendingChange: () => {},
      onAuthRequired: () => {},
      onNewChat: () => {},
      providerSnapshot: providers
    }
    const view = render(<DraftChat {...props} cwd="/tmp/slow-start" />)
    try {
      await waitFor(() => expect(release).toBeDefined())
      const input = view.getByRole("textbox") as HTMLTextAreaElement
      expect(input.disabled).toBe(false)
      await act(() => {
        return Promise.try(() => {
          fireEvent.focusIn(input)
          fireEvent.input(input, { target: { value: "send after preparation" } })
          fireEvent.keyUp(input, { key: "n" })
        })
      })
      expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true)
      expect(view.getByRole("button", { name: "Send" }).getAttribute("aria-busy")).toBe("true")
      expect(view.getByRole("button", { name: "Send" }).querySelector(".animate-spin")).not.toBeNull()
      await act(() => {
        return Promise.try(() => {
          fireEvent.click(view.getByRole("button", { name: "Send" }))
          fireEvent.keyDown(input, { key: "Enter", code: "Enter" })
          fireEvent.submit(must(input.form, "composer form"))
        })
      })
      expect(prompt).not.toHaveBeenCalled()
      expect(input.value).toBe("send after preparation")
      expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true)
      if (outcome === "unmount") await act(() => Promise.try(() => view.unmount()))
      if (outcome === "directory-change") view.rerender(<DraftChat {...props} cwd="/tmp/other-project" />)
      await act(() => Promise.try(() => must(release, "initial preparation")()))
      if (outcome === "success") {
        await waitFor(() => expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false))
        expect(view.getByRole("button", { name: "Send" }).getAttribute("aria-busy")).toBe("false")
        expect(view.getByRole("button", { name: "Send" }).querySelector(".animate-spin")).toBeNull()
        expect(prompt).not.toHaveBeenCalled()
        expect(input.value).toBe("send after preparation")
        await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Send" }))))
        await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1))
        const id = must(prompt.mock.calls[0], "sent prompt")[0]
        expect(id).not.toBe(DRAFT_SESSION_ID)
        expect(real.session(id).cwd).toBe("/tmp/slow-start")
        expect(real.session(id).items.some((item) => item.kind === "user")).toBe(true)
        await waitFor(() => expect(input.value).toBe(""))
        expect(view.getByRole("textbox")).toBe(input)
      } else {
        if (outcome === "failure") {
          await waitFor(() => expect(view.getByRole("button", { name: "Retry" })).toBeTruthy())
          expect(view.getByRole("status").textContent).toContain("Internal error")
        }
        if (outcome === "directory-change")
          await waitFor(() => expect(view.getByRole("button", { name: "other-project" })).toBeTruthy())
        expect(prompt).not.toHaveBeenCalled()
        if (outcome !== "unmount") {
          expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("send after preparation")
          await waitFor(() =>
            expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(outcome === "failure")
          )
          expect(view.getByRole("button", { name: "Send" }).getAttribute("aria-busy")).toBe("false")
        }
      }
    } finally {
      release?.()
      await act(() => Promise.try(() => view.unmount()))
      restore()
    }
  }
)

test("sending after default-directory resolution keeps the submitted conversation selected", async () => {
  const { fake, real, restore } = await environment()
  let accept!: () => void
  const receipt = new Promise<void>((resolve) => {
    accept = resolve
  })
  vi.spyOn(client, "prompt").mockImplementation(async (...args) => {
    const sent = await real.prompt(...args)
    await receipt
    return sent
  })
  let release: (() => void) | undefined
  fake.newSessionDelay.current = () =>
    new Promise((resolve) => {
      release = resolve
    })
  importDraft(DRAFT_SESSION_ID, { text: "first launch", mentions: [], attachments: [], modelId: null })
  let selected: string | null = null
  function Surface() {
    const [cwd, setCwd] = useState<string | null>(null)
    const [id, setId] = useState<string | null>(null)
    const [sendingId, setSendingId] = useState<string | null>(null)
    const draft = useApp((state) => id === null || Boolean(state.draftSessions[id]))
    if (id && !draft && sendingId !== id) return <div data-testid="submitted">{id}</div>
    return (
      <DraftChat
        owner="main"
        startSurface="chat"
        cwd={cwd}
        onCwdChange={setCwd}
        onCreated={(value) => {
          selected = value
          setId(value)
        }}
        onSendingChange={(value, sending) => setSendingId(sending ? value : null)}
        onAuthRequired={() => {}}
        onNewChat={() => {}}
        providerSnapshot={providers}
      />
    )
  }
  const view = render(<Surface />)
  try {
    await waitFor(() => expect(release).toBeDefined())
    fake.newSessionDelay.current = null
    await act(() => Promise.try(() => must(release, "default preparation")()))
    await waitFor(() => expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false))
    await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Send" }))))
    await waitFor(() => expect(real.state.sessionList).toHaveLength(1))
    await waitFor(() => expect(view.queryByRole("status")).toBeNull())
    expect(fake.modelHints.size).toBe(1)
    expect(Object.keys(real.state.draftSessions)).toHaveLength(0)
    await act(() => Promise.try(() => accept()))
    await waitFor(() =>
      expect(view.getByTestId("submitted").textContent).toBe(must<string>(selected, "selected conversation"))
    )
    expect(fake.modelHints.size).toBe(1)
    expect(Object.keys(real.state.draftSessions)).toHaveLength(0)
    expect(real.session(must<string>(selected, "submitted session")).items.some((item) => item.kind === "user")).toBe(
      true
    )
  } finally {
    release?.()
    accept()
    await act(() => Promise.try(() => view.unmount()))
    restore()
  }
})

test("the composer stays visible while initial providers and the native draft are loading", async () => {
  const { fake, real, restore } = await environment()
  importDraft(DRAFT_SESSION_ID, { text: "saved input", mentions: [], attachments: [], modelId: null })
  let release: (() => void) | undefined
  fake.newSessionDelay.current = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const props = {
    owner: "main" as const,
    cwd: "/tmp/initial-project",
    onCwdChange: () => {},
    onCreated: () => {},
    onSendingChange: () => {},
    onAuthRequired: () => {},
    onNewChat: () => {}
  }
  const view = render(<DraftChat {...props} providerSnapshot={null} />)
  try {
    const input = view.getByRole("textbox") as HTMLTextAreaElement
    expect(input.value).toBe("saved input")
    expect(input.disabled).toBe(false)
    expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true)
    expect(view.getByRole("button", { name: "Send" }).getAttribute("aria-busy")).toBe("true")
    expect(view.queryByTestId("model-trigger")).toBeNull()
    expect(view.container.querySelector(".chat-project-picker")).toHaveAttribute("aria-busy", "true")
    expect(view.container.querySelector(".chat-project-picker .lucide-loader-circle")).toBeNull()
    expect(view.container.querySelector(".chat-project-picker .lucide-folder-closed")).toBeVisible()
    expect(Object.keys(real.state.sessions)).toHaveLength(0)
    view.rerender(<DraftChat {...props} providerSnapshot={providers} />)
    await waitFor(() => expect(release).toBeDefined())
    expect(view.getByRole("textbox")).toBe(input)
    expect(input.disabled).toBe(false)
    await act(() => Promise.try(() => must(release, "initial session creation")()))
    await waitFor(() => expect(view.getByTestId("model-trigger")).toBeTruthy())
    expect(view.getByRole("textbox")).toBe(input)
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("saved input")
    expect(view.getByTestId("model-trigger")).toHaveTextContent(/^6.1-Sol$/)
    expect(view.container.querySelector(".chat-project-picker")).toHaveAttribute("aria-busy", "false")
    expect(view.container.querySelector(".chat-project-picker .lucide-loader-circle")).toBeNull()
    expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false)
    expect(Object.keys(real.state.sessions)).toHaveLength(1)
    // The unsent draft is visible in the sidebar immediately, not deferred to the first message.
    expect(real.state.sessionList).toHaveLength(1)
  } finally {
    release?.()
    await act(() => Promise.try(() => view.unmount()))
    restore()
  }
})

test("initial preparation failure keeps the composer visible and retry preserves its draft", async () => {
  const { restore } = await environment()
  importDraft(DRAFT_SESSION_ID, { text: "retry input", mentions: [], attachments: [], modelId: null })
  const failure = vi.spyOn(client, "prepareDraft").mockRejectedValueOnce(new Error("Preparation failed"))
  const view = render(
    <DraftChat
      owner="main"
      cwd="/tmp/retry"
      onCwdChange={() => {}}
      onCreated={() => {}}
      onSendingChange={() => {}}
      onAuthRequired={() => {}}
      onNewChat={() => {}}
      providerSnapshot={providers}
    />
  )
  try {
    await waitFor(() => expect(view.getByText(/Preparation failed/)).toBeTruthy())
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("retry input")
    expect((view.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false)
    expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true)
    expect(view.getByRole("button", { name: "Send" }).getAttribute("aria-busy")).toBe("false")
    await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Retry" }))))
    await waitFor(() => expect(view.getByTestId("model-trigger")).toBeTruthy())
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("retry input")
    expect(view.queryByText("Preparation failed")).toBeNull()
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    failure.mockRestore()
    restore()
  }
})

test("a startup router/config failure retries without flashing the raw ACP error", async () => {
  const { restore } = await environment()
  // Exact text from the other Mac's 2026-11-07 screenshot (backticks, not single quotes). The
  // native host repairs config.toml before the engine is spawned; one client can still fail once.
  const failure = vi
    .spyOn(client, "prepareDraft")
    .mockRejectedValueOnce(
      new Error("acpRequest: Codex process has exited with code 1: Error: Model provider `alwith` not found")
    )
  const view = render(
    <DraftChat
      owner="main"
      cwd="/tmp/startup"
      onCwdChange={() => {}}
      onCreated={() => {}}
      onSendingChange={() => {}}
      onAuthRequired={() => {}}
      onNewChat={() => {}}
      providerSnapshot={providers}
    />
  )
  try {
    // No red error card / Retry button for a transient startup failure, and the second attempt
    // materialises the draft on its own — nobody has to click anything.
    await waitFor(() => expect(view.getByTestId("model-trigger")).toBeTruthy(), { timeout: 3000 })
    expect(failure).toHaveBeenCalledTimes(2)
    expect(view.queryByText(/Codex process has exited/)).toBeNull()
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull()
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    failure.mockRestore()
    restore()
  }
})

test("new chat prepares once under StrictMode and exposes the real model before sending", async () => {
  const { fake, real, restore } = await environment()
  let selected: string | null = null
  function Surface() {
    const [cwd, setCwd] = useState<string | null>(null)
    return (
      <DraftChat
        owner="main"
        startSurface="chat"
        cwd={cwd}
        onCwdChange={setCwd}
        onCreated={(id) => {
          selected = id
        }}
        onSendingChange={() => {}}
        onAuthRequired={() => {
          throw new Error("Unexpected authentication")
        }}
        providerSnapshot={providers}
        onNewChat={() => {
          throw new Error("Unexpected new chat")
        }}
      />
    )
  }
  const view = render(
    <StrictMode>
      <Surface />
    </StrictMode>
  )
  try {
    await waitFor(() => expect(view.getByTestId("model-trigger")).toHaveTextContent(/^6.1-Sol$/))
    await waitFor(() => expect(view.getByRole("textbox").hasAttribute("disabled")).toBe(false))
    expect(selected).not.toBeNull()
    expect(fake.modelHints.size).toBe(1)
    expect(real.session(must<string>(selected, "selected draft")).cwd).toBe("/Users/mac/Documents/ALwith")
    expect(real.session(must<string>(selected, "selected draft")).items).toEqual([])
    expect(real.state.sessionList.map((row) => row.sessionId)).toEqual([selected])
    await act(() => Promise.try(() => fireEvent.click(view.getByTestId("model-trigger"))))
    expect(view.getByRole("menuitemradio", { name: "GPT-6.1 Sol" })).toBeTruthy()
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    restore()
  }
})

test.each(["hello", ""])(
  "first send with text %j clears persisted file references before the normal composer mounts",
  async (text) => {
    const { real, restore } = await environment()
    importDraft(DRAFT_SESSION_ID, { text, mentions: ["/tmp/source.ts"], attachments: [], modelId: null })
    let prepared: string | null = null
    function Surface() {
      const [id, setId] = useState<string | null>(null)
      const [sending, setSending] = useState(false)
      const session = useSession(id)
      const draft = useApp((state) => id === null || Boolean(state.draftSessions[id]))
      if (!draft && !sending && session) return <Composer session={session} />
      return (
        <DraftChat
          owner="main"
          cwd="/tmp/first-send"
          onCwdChange={() => {}}
          onCreated={(value) => {
            prepared = value
            setId(value)
          }}
          onSendingChange={(_id, sending) => setSending(sending)}
          onAuthRequired={() => {}}
          providerSnapshot={providers}
          onNewChat={() => {}}
        />
      )
    }
    const view = render(<Surface />)
    try {
      await waitFor(() => expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false))
      await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Send" }))))
      await waitFor(() => expect(real.state.draftSessions[must<string>(prepared, "prepared draft")]).toBeUndefined())
      await waitFor(() => expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe(""))
      expect(drafts.get(must<string>(prepared, "prepared draft"))?.mentions).toEqual([])
      expect(real.session(must<string>(prepared, "prepared draft")).items.some((item) => item.kind === "user")).toBe(
        true
      )
    } finally {
      await act(() => Promise.try(() => view.unmount()))
      restore()
    }
  }
)

test("choosing a gateway in a prepared draft preserves input and sends on a newly created target-model session", async () => {
  const { real, fake, restore } = await environment()
  fake.gateways.set("deepseek", {
    providerId: "openai",
    apiType: "openai",
    baseUrl: "https://example.test",
    _meta: { codex: { id: "deepseek", name: "DeepSeek" }, alwith: { models: [{ id: "deepseek-flash" }] } }
  })
  importDraft(DRAFT_SESSION_ID, {
    text: "preserve this question",
    mentions: ["/tmp/source.ts"],
    attachments: [],
    modelId: null
  })
  let selected: string | null = null
  const view = render(
    <DraftChat
      owner="main"
      cwd="/tmp/model-picker"
      onCwdChange={() => {}}
      onCreated={(id) => {
        selected = id
      }}
      onSendingChange={() => {}}
      onAuthRequired={() => {}}
      onNewChat={() => {}}
      providerSnapshot={providers}
    />
  )
  try {
    await waitFor(() => expect(view.getByRole("button", { name: "Send" })).not.toBeDisabled())
    const original = must<string>(selected, "original draft")
    await act(() => Promise.try(() => fireEvent.click(view.getByTestId("model-trigger"))))
    await act(() => Promise.try(() => fireEvent.click(view.getByText("deepseek-flash"))))
    await waitFor(() => expect(selected).not.toBe(original))
    await waitFor(() => expect(view.getByRole("button", { name: "Send" })).not.toBeDisabled())
    const replacement = must<string>(selected, "replacement draft")
    expect(fake.modelHints.get(replacement)).toBe("deepseek-flash")
    expect(fake.configChanges).toEqual([])
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("preserve this question")
    expect(drafts.get(replacement)?.mentions).toEqual(["/tmp/source.ts"])
    await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Send" }))))
    await waitFor(() => expect(real.session(replacement).items.some((item) => item.kind === "user")).toBe(true))
    expect(fake.deleted.has(original)).toBe(true)
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    restore()
  }
})

test("a queued directory failure retains the last successful replacement and its input", async () => {
  const { fake, real, restore } = await environment()
  importDraft(DRAFT_SESSION_ID, { text: "keep this input", mentions: [], attachments: [], modelId: null })
  let selected: string | null = null
  let release: (() => void) | undefined
  fake.newSessionDelay.current = (cwd) =>
    cwd === "/tmp/slow-project"
      ? new Promise((resolve) => {
          release = resolve
        })
      : Promise.resolve()
  const props = {
    owner: "main" as const,
    onCwdChange: () => {},
    onCreated: (id: string) => {
      selected = id
    },
    onAuthRequired: () => {},
    onSendingChange: () => {},
    providerSnapshot: providers,
    onNewChat: () => {}
  }
  const view = render(<DraftChat {...props} cwd="/tmp/original" />)
  try {
    await waitFor(() => expect(selected).not.toBeNull())
    const original = must<string>(selected, "selected draft")
    view.rerender(<DraftChat {...props} cwd="/tmp/slow-project" />)
    await waitFor(() => expect(release).toBeDefined())
    expect(view.container.querySelector(".chat-project-picker")).toHaveAttribute("aria-busy", "true")
    expect(view.container.querySelector(".chat-project-picker .lucide-loader-circle")).toBeNull()
    expect(view.container.querySelector(".chat-project-picker .lucide-folder-closed")).toBeVisible()
    view.rerender(<DraftChat {...props} cwd="/needs-auth" />)
    await act(() => Promise.try(() => must(release, "pending session creation")()))
    await waitFor(() => expect(view.getByRole("button", { name: "Configure provider" })).toBeTruthy())
    expect(view.container.querySelector(".chat-project-picker")).toHaveAttribute("aria-busy", "false")
    expect(view.container.querySelector(".chat-project-picker .lucide-loader-circle")).toBeNull()
    expect(selected).not.toBe(original)
    expect(real.session(must<string>(selected, "selected draft")).cwd).toBe("/tmp/slow-project")
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("keep this input")
    expect(fake.deleted.has(must<string>(selected, "selected draft"))).toBe(false)
    expect(Object.keys(real.state.draftSessions)).toEqual([must<string>(selected, "selected draft")])
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    restore()
  }
})

test.each([false, true])(
  "a failed first send preserves input and exits the draft only after dispatch: %s",
  async (dispatched) => {
    const { real, restore } = await environment()
    importDraft(DRAFT_SESSION_ID, { text: "keep for retry", mentions: [], attachments: [], modelId: null })
    vi.spyOn(client, "prompt").mockImplementation(async (id, prompt) => {
      if (dispatched) await real.prompt(id, prompt)
      throw new Error("Request failed")
    })
    const sendingStates: boolean[] = []
    const view = render(
      <DraftChat
        owner="main"
        cwd="/tmp/lost-receipt"
        onCwdChange={() => {}}
        onCreated={() => {}}
        onSendingChange={(_id, sending) => {
          sendingStates.push(sending)
        }}
        onAuthRequired={() => {}}
        providerSnapshot={providers}
        onNewChat={() => {}}
      />
    )
    try {
      await waitFor(() => expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false))
      await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Send" }))))
      await waitFor(() => expect(view.getByRole("button", { name: /Send|Steer/ }).hasAttribute("disabled")).toBe(false))
      expect(sendingStates).toEqual([true, false])
      expect(Object.keys(real.state.draftSessions)).toHaveLength(dispatched ? 0 : 1)
      expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("keep for retry")
    } finally {
      await act(() => Promise.try(() => view.unmount()))
      restore()
    }
  }
)

test("a failed project change preserves the real draft and leaves the project picker usable", async () => {
  const { fake, real, restore } = await environment()
  let selected: string | null = null
  const props = {
    owner: "main" as const,
    onCwdChange: () => {},
    onCreated: (id: string) => {
      selected = id
    },
    onAuthRequired: () => {},
    onSendingChange: () => {},
    providerSnapshot: providers,
    onNewChat: () => {}
  }
  const view = render(<DraftChat {...props} cwd="/tmp/old-project" />)
  try {
    await waitFor(() => expect(selected).not.toBeNull())
    const original = must<string>(selected, "selected draft")
    view.rerender(<DraftChat {...props} cwd="/needs-auth" />)
    await waitFor(() => expect(view.getByRole("button", { name: "Configure provider" })).toBeTruthy())
    expect(real.state.draftSessions[original]).toBe("main")
    expect(fake.deleted.has(original)).toBe(false)
    expect(view.getByRole("button", { name: "old-project" }).hasAttribute("disabled")).toBe(false)
    view.rerender(<DraftChat {...props} cwd="/tmp/recovered-project" />)
    await waitFor(() => expect(selected).not.toBe(original))
    expect(real.session(must<string>(selected, "selected draft")).cwd).toBe("/tmp/recovered-project")
    expect(fake.deleted.has(original)).toBe(true)
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    restore()
  }
})

test("deleting a sent conversation does not resurrect startup placeholder input", async () => {
  const { fake, real, restore } = await environment()
  let release: (() => void) | undefined
  fake.newSessionDelay.current = () =>
    new Promise<void>((resolve) => {
      release = resolve
    })
  const props = {
    owner: "main" as const,
    cwd: "/tmp/review-draft",
    onCwdChange: () => {},
    onCreated: () => {},
    onSendingChange: () => {},
    onAuthRequired: () => {},
    onNewChat: () => {},
    providerSnapshot: providers
  }
  let view = render(<DraftChat {...props} />)
  try {
    await waitFor(() => expect(release).toBeDefined())
    const input = view.getByRole("textbox") as HTMLTextAreaElement
    await act(() => {
      return Promise.try(() => {
        fireEvent.input(input, { target: { value: "already sent text" } })
        fireEvent.keyUp(input, { key: "t" })
      })
    })
    fake.newSessionDelay.current = null
    await act(() => Promise.try(() => must(release, "prepare")()))
    await waitFor(() => expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false))
    const id = must(Object.keys(real.state.draftSessions)[0], "draft")
    await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Send" }))))
    await waitFor(() => expect(real.state.draftSessions[id]).toBeUndefined())
    await waitFor(() => expect(input.value).toBe(""))
    await act(() => Promise.try(() => view.unmount()))
    await act(async () => real.delete(id))
    view = render(<DraftChat {...props} />)
    await waitFor(() => expect(view.getByTestId("model-trigger")).toBeTruthy())
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("")
  } finally {
    release?.()
    await act(() => Promise.try(() => view.unmount()))
    restore()
  }
})

test("switching writable conversations enables sending only for the selected conversation input", async () => {
  const { real, restore } = await environment()
  await real.connect()
  const first = await real.newSession("/tmp/first-conversation")
  const second = await real.newSession("/tmp/second-conversation")
  function Surface({ id }: { id: string }) {
    const session = must(useSession(id), "selected conversation")
    return <Composer key={id} session={session} />
  }
  const view = render(<Surface id={first} />)
  try {
    await act(() => {
      return Promise.try(() => {
        fireEvent.input(view.getByRole("textbox"), { target: { value: "first draft" } })
        fireEvent.keyUp(view.getByRole("textbox"), { key: "t" })
      })
    })
    expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false)
    view.rerender(<Surface id={second} />)
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("")
    expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true)
    await act(() => {
      return Promise.try(() => {
        fireEvent.input(view.getByRole("textbox"), { target: { value: "second message" } })
        fireEvent.keyUp(view.getByRole("textbox"), { key: "e" })
      })
    })
    expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false)
    await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "Send" }))))
    await waitFor(() => expect(real.session(second).items.some((item) => item.kind === "user")).toBe(true))
    expect(real.session(first).items.some((item) => item.kind === "user")).toBe(false)
    view.rerender(<Surface id={first} />)
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("first draft")
    expect(view.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false)
    expect(view.getByRole("button", { name: "Send" }).getAttribute("aria-busy")).toBe("false")
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    restore()
  }
})

test("returning a floating draft transfers its input and releases the surface only after acceptance", async () => {
  const env = await windowEnvironment()
  const requests: { target: string; action: Parameters<typeof chatWindow.requestChatSurface>[1] }[] = []
  let reject = true
  const request = vi.spyOn(chatWindow, "requestChatSurface").mockImplementation((target, action) => {
    return Promise.try(() => {
      requests.push({ target, action })
      if (reject) throw new Error("Main window is busy")
      return null
    })
  })
  importDraft(DRAFT_SESSION_ID, { text: "return this input", mentions: [], attachments: [], modelId: null })
  const view = render(
    <ThemeProvider>
      <ChatWindow preferences={windowPreferences} />
    </ThemeProvider>
  )
  try {
    await waitFor(() => expect(env.ready()).toBe(true))
    await act(() => env.present())
    await waitFor(() => expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("return this input"))
    const id = must(Object.keys(env.real.state.draftSessions)[0], "floating draft")
    const returnToMain = async (): Promise<void> => {
      await act(() => Promise.try(() => fireEvent.click(view.getByRole("button", { name: "More actions" }))))
      await act(() => Promise.try(() => fireEvent.click(view.getByRole("menuitem", { name: "Return to main window" }))))
    }
    await returnToMain()
    expect(env.hidden).toBe(false)
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("return this input")
    reject = false
    await returnToMain()
    await waitFor(() => expect(env.hidden).toBe(true))
    expect(view.queryByRole("textbox")).toBeNull()
    expect(requests).toEqual(
      [0, 1].map(() => ({
        target: "main",
        action: {
          type: "present",
          transfer: {
            sessionId: id,
            cwd: windowPreferences.lastProjectDirectory,
            draft: { text: "return this input", mentions: [], attachments: [], modelId: null }
          }
        }
      }))
    )
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    request.mockRestore()
    env.restore()
  }
})

test("extension drafts fill the mounted composer without sending and protect existing input", async () => {
  const { setComposerDraft } = await import("@alwith/module-chat/conversation")
  const { real, restore } = await environment()
  await real.connect()
  const id = await real.prepareDraft("main", "/tmp/extension-draft")
  const view = render(<Composer session={real.session(id)} />)
  try {
    await act(() => Promise.try(() => setComposerDraft(id, "Review this before sending")))
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Review this before sending")
    expect(drafts.get(id)?.text).toBe("Review this before sending")
    expect(real.session(id).items.filter((item) => item.kind === "user")).toHaveLength(0)
    expect(() => setComposerDraft(id, "replacement")).toThrow("already has a draft")
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Review this before sending")
    await act(() => Promise.try(() => view.unmount()))
    expect(() => setComposerDraft(id, "after close")).toThrow("composer is not open")
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    restore()
  }
})

test.each(["attachments", "mentions"] as const)("extension drafts preserve existing %s and model", async (content) => {
  const { setComposerDraft } = await import("@alwith/module-chat/conversation")
  const { real, restore } = await environment()
  await real.connect()
  const id = await real.prepareDraft("main", "/tmp/extension-draft")
  const original = {
    text: "",
    attachments:
      content === "attachments"
        ? [{ id: "image", type: "file" as const, mediaType: "image/png", url: "data:image/png;base64,aW1hZ2U=" }]
        : [],
    mentions: content === "mentions" ? ["/tmp/report.md"] : [],
    modelId: "keep/model"
  }
  importDraft(id, original)
  const view = render(<Composer session={real.session(id)} />)
  try {
    expect(() => setComposerDraft(id, "replacement")).toThrow("already has a draft")
    expect(drafts.get(id)).toEqual(original)
    expect(real.session(id).items.filter((item) => item.kind === "user")).toHaveLength(0)
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    restore()
  }
})

test("packaged Plugin SDK fills the real U composer through the public chat bridge", async () => {
  const { ExtensionHost } = await import("@alwith/module-extension/host")
  const { extensionApiVersion } = await import("@alwith/module-extension")
  const { createPluginExtension, Plugin } = await import("@alwith/module-extension/plugin")
  const { createMemoryData } = await import("@alwith/module-extension/testing")
  const { createExtensionChatBridge } = await import("@/features/extensions/chat/bridge")
  const { setExtensionDraft, sendExtensionMessage } = await import("@/features/extensions/chat/chat")
  const { setComposerDraft } = await import("@alwith/module-chat/conversation")
  const { real, restore } = await environment()
  await real.connect()
  const id = await real.prepareDraft("main", "/tmp/extension-draft")
  const view = render(<Composer session={real.session(id)} />)
  let presented = false
  let application: import("@alwith/module-extension/plugin").PluginApp | undefined
  const dependencies = {
    session: (target: string) => (target === id ? { cwd: "/tmp/extension-draft" } : null),
    skills: () => Promise.resolve([]),
    writeDraft: setComposerDraft,
    present: () => {
      presented = true
    },
    prompt: async (target: string, text: string) => {
      await real.prompt(target, [{ type: "text", text }])
    }
  }
  const chat = createExtensionChatBridge({
    check: () => {},
    session: () => ({ id, cwd: "/tmp/extension-draft", title: "Chat" }),
    send: (target, text) => sendExtensionMessage(target, text, [], dependencies),
    setDraft: (target, text) => setExtensionDraft(target, text, [], dependencies)
  })
  const host = new ExtensionHost({
    apiVersion: extensionApiVersion,
    capabilities: {
      "plugin.host": {
        version: "1.0.0",
        value: {
          ...chat,
          fetch: () => Promise.try(() => new Response("")),
          captureChatContext: () => {},
          openView: () => {},
          notify: () => ({ hide() {}, setMessage() {} }),
          language: () => "en",
          primary: true,
          openExternal: async () => {},
          vault: { write: async () => {}, remove: async () => {} }
        }
      }
    },
    contributions: { commands: "1.0.0", surfaces: "1.0.0", settingsPages: "1.0.0" }
  })
  const manifest = {
    manifestVersion: 3 as const,
    id: "chat-fixture",
    name: "Chat",
    version: "1.0.0",
    entry: "main.js",
    dependencies: { "@alwith/module-extension": "^0.1.0-rc.11" },
    hosts: {},
    dataSchemaVersion: 1
  }
  try {
    await host.activate(
      manifest,
      "fixture",
      (context) =>
        createPluginExtension(context, {
          manifest,
          create(_api, app, metadata) {
            application = app
            return new Plugin(app, metadata)
          }
        }),
      { data: createMemoryData(), resource: (path) => path }
    )
    const app = must(application, "plugin application")
    await act(async () => app.chat.setDraft("Draft from a plugin"))
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Draft from a plugin")
    expect(presented).toBe(true)
    expect(real.session(id).items.some((item) => item.kind === "user")).toBe(false)
    await act(async () => app.chat.sendMessage("Send directly"))
    expect(real.session(id).items.some((item) => item.kind === "user")).toBe(true)
    expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Draft from a plugin")
  } finally {
    await host.dispose()
    await act(() => Promise.try(() => view.unmount()))
    restore()
  }
})

test("floating background sessions reopen in their host and returning one hides the window", async () => {
  const env = await windowEnvironment()
  const view = render(
    <ThemeProvider>
      <ChatWindow preferences={windowPreferences} />
    </ThemeProvider>
  )
  try {
    await waitFor(() => expect(env.ready()).toBe(true))
    await act(() => client.connect())
    let first = ""
    let second = ""
    await act(async () => {
      first = await env.real.newSession("/tmp/first", null, "chat")
      second = await env.real.newSession("/tmp/second", null, "chat")
    })
    importDraft(first, { text: "first unsent input", mentions: [], attachments: [], modelId: null })
    await act(() => env.present(first))
    await waitFor(() => expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("first unsent input"))
    await act(() => env.present(second))
    expect(env.real.state.sessionWindows).toMatchObject({ [first]: "chat", [second]: "chat" })
    expect(chatWindow.publishChatWindowSurface).toHaveBeenLastCalledWith(second, true)
    await act(() => env.present(first))
    await waitFor(() => expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("first unsent input"))
    await act(() => env.present(second))
    let transfer: chatWindow.ChatTransfer | null = null
    await act(async () => {
      transfer = await env.release(first)
    })
    expect(transfer).toMatchObject({ sessionId: first, cwd: "/tmp/first", draft: { text: "first unsent input" } })
    expect(env.hidden).toBe(true)
    expect(chatWindow.publishChatWindowSurface).toHaveBeenLastCalledWith(second, false)
    await act(() => env.real.open(first, "/tmp/first", "main"))
    expect(env.real.state.sessionWindows).toMatchObject({ [first]: "main", [second]: "chat" })
    await act(async () => {
      await expect(env.present(first)).rejects.toThrow("conversation changed")
    })
    await act(() => env.real.close(first))
    expect(env.real.state.sessionWindows[first]).toBeUndefined()
    expect(env.real.state.sessionWindows[second]).toBe("chat")
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    env.restore()
  }
})

test("floating window readiness survives a failed connection and a later explicit open", async () => {
  const env = await windowEnvironment()
  const connect = mockOf(client, "connect")
  connect.mockImplementationOnce(() => {
    return Promise.try(() => {
      throw new Error("Main host is not ready")
    })
  })
  const view = render(
    <ThemeProvider>
      <ChatWindow preferences={windowPreferences} />
    </ThemeProvider>
  )
  try {
    await waitFor(() => expect(env.ready()).toBe(true))
    expect(connect).not.toHaveBeenCalled()
    expect(chatWindow.announceChatReady).toHaveBeenCalled()
    await act(async () => {
      await expect(env.present()).rejects.toThrow("Main host is not ready")
    })
    expect(env.ready()).toBe(true)
    expect(env.hidden).toBe(true)
    await act(() => env.present())
    expect(env.hidden).toBe(false)
    await waitFor(() => expect(view.getByRole("textbox")).toBeTruthy())
    expect(env.real.state.connection).toBe("ready")
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    env.restore()
  }
})

test.each(["main", "chat"] as const)(
  "%s first-send forms remain visible before prompt acceptance reaches the surface",
  async (owner) => {
    const env = await environment()
    let release!: () => void
    const receipt = new Promise<void>((resolve) => {
      release = resolve
    })
    mockOf(client, "prompt").mockImplementation(async (...args) => {
      const sent = await env.real.prompt(...args)
      await receipt
      return sent
    })
    let selected: string | null = null
    const view = render(
      <ThemeProvider>
        <DraftChat
          owner={owner}
          cwd="/tmp/question-before-receipt"
          onCwdChange={() => {}}
          onCreated={(id) => {
            selected = id
          }}
          onSendingChange={() => {}}
          onAuthRequired={() => {}}
          onNewChat={() => {}}
          providerSnapshot={providers}
        />
      </ThemeProvider>
    )
    let answer: Promise<unknown> | undefined
    try {
      await waitFor(() => expect(view.getByRole("button", { name: "Send" })).toBeDisabled())
      await waitFor(() => expect(selected).not.toBeNull())
      fireEvent.change(view.getByRole("textbox"), { target: { value: "Ask before accepting this first send" } })
      await waitFor(() => expect(view.getByRole("button", { name: "Send" })).toBeEnabled())
      fireEvent.click(view.getByRole("button", { name: "Send" }))
      await waitFor(() => expect(env.real.state.draftSessions[must(selected, "question session")]).toBeUndefined())
      answer = env.fake.requestForm({
        sessionId: must<string>(selected, "question session"),
        mode: "form",
        message: "Choose while the first send is still being accepted",
        requestedSchema: {
          type: "object",
          properties: { choice: { type: "string", enum: ["Alpha", "Beta"] } },
          required: ["choice"]
        }
      })
      await waitFor(() => expect(env.real.state.actions).toHaveLength(1))
      await waitFor(() => expect(view.getByRole("dialog")).toBeVisible())
      fireEvent.click(view.getByRole("radio", { name: "Beta" }))
      fireEvent.click(view.getByRole("button", { name: "Submit" }))
      expect(await answer).toMatchObject({ action: "accept", content: { choice: "Beta" } })
    } finally {
      await act(async () => {
        for (const action of env.real.state.actions) env.real.respond(action.id, { action: "cancel" })
        release()
        await answer
      })
      view.unmount()
      env.restore()
    }
  }
)

test("a collection draft is saved only after its first send is accepted", async () => {
  const env = await environment()
  const collections = await import("@/features/collection/store")
  const saved = vi.spyOn(collections, "dispatchCollection").mockResolvedValue()
  importDraft(DRAFT_SESSION_ID, { text: "Save this conversation", mentions: [], attachments: [], modelId: null })
  let sessionId: string | null = null
  const view = render(
    <DraftChat
      owner="main"
      collectionId="work"
      cwd="/tmp/collection"
      onCwdChange={() => {}}
      onCreated={(id) => {
        sessionId = id
      }}
      onSendingChange={() => {}}
      onAuthRequired={() => {}}
      onNewChat={() => {}}
      providerSnapshot={providers}
    />
  )
  try {
    await waitFor(() => expect(view.getByRole("button", { name: "Send" })).toBeEnabled())
    expect(sessionId).not.toBeNull()
    expect(saved).not.toHaveBeenCalled()
    await act(() => Promise.resolve(fireEvent.click(view.getByRole("button", { name: "Send" }))))
    await waitFor(() => expect(saved).toHaveBeenCalledExactlyOnceWith({ type: "add", collectionId: "work", sessionId }))
  } finally {
    await act(() => Promise.resolve(view.unmount()))
    saved.mockRestore()
    env.restore()
  }
})

test("the main window's draft drops its title bar while the floating window keeps one", async () => {
  const env = await environment()
  const props = {
    owner: "main" as const,
    cwd: "/tmp/draft-header",
    onCwdChange: () => {},
    onCreated: () => {},
    onSendingChange: () => {},
    onAuthRequired: () => {},
    onNewChat: () => {},
    providerSnapshot: providers
  }
  const view = render(<DraftChat {...props} />)
  try {
    // Nothing to title before the first message: the conversation starts at the greeting.
    expect(view.container.querySelector("[data-main-chat-header]")).toBeNull()
    expect(view.getByRole("heading", { level: 1 })).toBeVisible()

    const floating = document.createElement("div")
    document.body.append(floating)
    try {
      // The floating window has no native title bar, so its header is portalled into one.
      view.rerender(<DraftChat {...props} headerTarget={floating} />)
      expect(within(floating).getByText("New chat")).toBeVisible()
    } finally {
      floating.remove()
    }
  } finally {
    await act(() => Promise.resolve(view.unmount()))
    env.restore()
  }
})

// 静默窗是这一轮的核心承诺：引擎还没 ready 时，草稿页只许说「正在启动」，不许闪红字。
afterEach(() => resetStartupWindow())

test("a warm start paints no status line at all before the engine is ready", async () => {
  // 热启动只要几百毫秒：这段时间什么都不画，否则"画了再抹"本身就是闪一下（2026-11-08）。
  const { restore } = await environment()
  armStartupWindow()
  const failure = vi
    .spyOn(client, "prepareDraft")
    .mockRejectedValue(new Error("Runtime is not running: connect ECONNREFUSED 127.0.0.1:1"))
  const view = render(
    <DraftChat
      owner="main"
      cwd="/tmp/startup"
      onCwdChange={() => {}}
      onCreated={() => {}}
      onSendingChange={() => {}}
      onAuthRequired={() => {}}
      onNewChat={() => {}}
      providerSnapshot={providers}
    />
  )
  try {
    await waitFor(() => expect(failure).toHaveBeenCalled())
    expect(view.queryByText("Starting chat service")).toBeNull()
    expect(view.queryByText(/ECONNREFUSED/)).toBeNull()
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull()
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    failure.mockRestore()
    restore()
  }
})

test("a startup that drags says 正在启动 instead of the raw error", async () => {
  const { restore } = await environment()
  armStartupWindow()
  stallStartupWindow()
  const failure = vi
    .spyOn(client, "prepareDraft")
    .mockRejectedValue(new Error("Runtime is not running: connect ECONNREFUSED 127.0.0.1:1"))
  const view = render(
    <DraftChat
      owner="main"
      cwd="/tmp/startup"
      onCwdChange={() => {}}
      onCreated={() => {}}
      onSendingChange={() => {}}
      onAuthRequired={() => {}}
      onNewChat={() => {}}
      providerSnapshot={providers}
    />
  )
  try {
    await waitFor(() => expect(view.getByText("Starting chat service")).toBeTruthy())
    expect(view.queryByText(/ECONNREFUSED/)).toBeNull()
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull()
  } finally {
    await act(() => Promise.try(() => view.unmount()))
    failure.mockRestore()
    restore()
  }
})

test.each(["gateway", "native"] as const)(
  "unavailable account models recover through %s selection without losing draft input",
  async (choice) => {
    const { real, fake, restore } = await environment()
    fake.gateways.set("deepseek", {
      providerId: "openai",
      apiType: "openai",
      baseUrl: "https://example.test",
      _meta: {
        codex: { id: "deepseek", name: "DeepSeek" },
        alwith: { models: [{ id: "gateway:deepseek:deepseek-flash" }] }
      }
    })
    importDraft(DRAFT_SESSION_ID, { text: "keep this draft", mentions: [], attachments: [], modelId: null })
    const failure = vi
      .spyOn(client, "prepareDraft")
      .mockRejectedValueOnce(
        Object.assign(
          new Error("The selected ALwith account model is unavailable. Select another model before sending."),
          { code: "account_model_unavailable" }
        )
      )
    const configure = vi.fn()
    let selected: string | null = null
    const view = render(
      <DraftChat
        owner="main"
        cwd="/tmp/recovery"
        onCwdChange={() => {}}
        onCreated={(id) => {
          selected = id
        }}
        onSendingChange={() => {}}
        onAuthRequired={configure}
        onNewChat={() => {}}
        providerSnapshot={{ ...providers, providers: { deepseek: { configured: true, region: null, base_url: null, disabled: false, protocol: "responses" } } }}
      />
    )
    try {
      await waitFor(() => expect(view.getByRole("button", { name: "Configure provider" })).toBeTruthy())
      expect(fake.modelHints.size).toBe(0)
      fireEvent.click(view.getByRole("button", { name: "Configure provider" }))
      expect(configure).toHaveBeenCalledOnce()
      // The fork's draft error row carries a collapsed model pill: open it, then pick the row.
      await act(() => Promise.try(() => fireEvent.click(view.getByTestId("model-trigger"))))
      fireEvent.click(
        await view.findByRole("menuitemradio", { name: choice === "native" ? "ChatGPT" : "DeepSeek-Flash" })
      )
      await waitFor(() => expect(view.getByRole("button", { name: "Send" })).not.toBeDisabled())
      const id = must<string>(selected, "recovered draft")
      // The fork's picker names the native default with its empty placeholder id (""), which the
      // adapter treats exactly like upstream's null hint: the draft starts on the engine's own model.
      expect(fake.modelHints.get(id)).toBe(choice === "native" ? "" : "gateway:deepseek:deepseek-flash")
      expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("keep this draft")
      expect(real.state.sessionList.map((row) => row.sessionId)).toEqual([id])
    } finally {
      await act(() => Promise.try(() => view.unmount()))
      failure.mockRestore()
      restore()
    }
  }
)

test.each([false, true])(
  "enterprise logout preserves unsent input with revocation delivered first: %s",
  async (revokedFirst) => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    const accountModel = "gateway:finture-enterprise:company"
    let snapshot: ProviderSnapshot = {
      ...providers,
      managedProviders: [
        {
          id: "finture-enterprise",
          name: "Enterprise",
          baseUrl: "https://gateway.example",
          models: [{ api_id: "company", label: "Company" }]
        }
      ]
    }
    const env = await environment(false, async (model, purpose) => resolveSessionModel(model, snapshot, purpose))
    env.fake.gateways.set("finture-enterprise", {
      providerId: "openai",
      apiType: "openai",
      baseUrl: "https://gateway.example",
      _meta: { codex: { id: "finture-enterprise", name: "Enterprise" }, alwith: { models: [{ id: accountModel }] } }
    })
    env.real.setModelSelections({ main: accountModel, chat: null })
    let selected: string | null = null
    const onCreated = (id: string) => {
      selected = id
    }
    const ui = () => (
      <DraftChat
        owner="main"
        cwd="/tmp/enterprise-logout"
        onCwdChange={() => {}}
        onCreated={onCreated}
        onSendingChange={() => {}}
        onAuthRequired={() => {}}
        onNewChat={() => {}}
        providerSnapshot={snapshot}
      />
    )
    const view = render(ui())
    try {
      await waitFor(() => expect(selected).not.toBeNull())
      const previous = must<string>(selected, "enterprise draft")
      await act(() =>
        Promise.try(() => {
          fireEvent.input(view.getByRole("textbox"), { target: { value: "keep my input after logout" } })
          fireEvent.keyUp(view.getByRole("textbox"), { key: "t" })
        })
      )
      snapshot = { ...providers, revision: 2, appliedRevision: 2 }
      env.fake.gateways.delete("finture-enterprise")
      if (revokedFirst) await act(() => Promise.try(() => env.real.markAccountModelsUnavailable([previous])))
      view.rerender(ui())
      await waitFor(() => expect(selected).not.toBe(previous))
      await waitFor(() => expect(view.getByRole("button", { name: "Send" })).not.toBeDisabled())
      const replacement = must<string>(selected, "native replacement")
      expect(env.fake.modelHints.get(replacement)).toBeNull()
      expect(env.fake.deleted.has(previous)).toBe(true)
      expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe("keep my input after logout")
      expect(view.queryByText(/selected ALwith account model is unavailable/i)).toBeNull()
      expect(env.real.state.sessionList.map((row) => row.sessionId)).toEqual([replacement])
    } finally {
      await act(() => Promise.try(() => view.unmount()))
      env.restore()
      clearMocks()
    }
  }
)
