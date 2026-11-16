/**
 * QA 独立集成验证（trailing 功能屏结构补全）。
 *
 * 与工程师的单元测试不同，这里把真实的 TrailingBoard 挂进真实的 MainSidebarLayout，
 * 用真实 i18n 文案（en / zh-CN），走「状态栏圆点停靠 → 屏头返回按钮 / chat 圆点返回」的
 * 完整回路，证明：
 *   a. 空列表时屏头与「返回对话」仍在，点击真的把画布带回 chat；
 *   b. 回到 chat 后 trailing 恢复 inert、侧栏恢复 pinned；
 *   c. 非空列表 / 存在工具窗口时不误报空态；
 *   d. 中文文案正确落到屏头。
 */
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, expect, type MockInstance, test, vi } from "vitest"

import { must } from "@/lib/__tests__/must"
import { initI18n } from "@/lib/i18n"
import * as preferences from "@/lib/preferences"

import { MainSidebarLayout } from "../../components/main-sidebar-layout"
import { TrailingBoard } from "../../components/trailing-board"

await initI18n("en")

/** 可变的运行中应用列表：空态用例需要零卡片。 */
const running = vi.hoisted(() => ({
  apps: [] as Array<{ name: string; bundle_id: string; icon: string | null }>
}))
/** 可变的 Tauri 环境与工具窗口列表：验证「有工具窗口就不算空」的分支。 */
const env = vi.hoisted(() => ({
  tauri: false,
  windows: [] as Array<{ label: string; isVisible: () => Promise<boolean>; title: () => Promise<string> }>
}))

vi.mock("@/bindings", () => ({
  commands: new Proxy({}, { get: () => vi.fn(async () => null) }),
  events: new Proxy({}, { get: () => ({ name: "stub", listen: () => Promise.resolve(() => {}) }) })
}))
vi.mock("@/lib/chat-window", () => ({ openChatWindow: vi.fn(async () => {}) }))
vi.mock("@/lib/background-errors", () => ({ reportBackgroundError: vi.fn() }))
vi.mock("../use-running-apps", () => ({ useRunningApps: () => running.apps }))
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => env.tauri }))
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }))
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getAll: () => Promise.resolve(env.windows) },
  getCurrentWebviewWindow: () => ({
    onFocusChanged: () => Promise.resolve(() => {}),
    // useWindowFullscreen（MainSidebarLayout 内）在 Tauri 档还会订阅 resize / 查询全屏。
    onResized: () => Promise.resolve(() => {}),
    isFullscreen: () => Promise.resolve(false)
  })
}))

let save: MockInstance<typeof preferences.savePreference>
beforeEach(() => {
  save = vi.spyOn(preferences, "savePreference").mockResolvedValue()
  running.apps = []
  env.tauri = false
  env.windows = []
})
afterEach(() => {
  cleanup()
  save.mockRestore()
})

/** jsdom 不推进 Embla 动画帧；reduced-motion 让每次跳转瞬时落位（与真实窗口动画结束态一致）。 */
function withReducedMotion(run: () => Promise<void>): Promise<void> {
  const media = window.matchMedia
  window.matchMedia = ((query: string) => ({
    ...media(query),
    matches: query.includes("prefers-reduced-motion")
  })) as typeof window.matchMedia
  return Promise.resolve()
    .then(run)
    .finally(() => {
      window.matchMedia = media
    })
}

/** jsdom 所有盒子都是 0x0，画布未测量时导航请求不会被消费；临时供给真实尺寸。 */
function withCanvasGeometry(run: () => Promise<void>, viewport = 1200, sidebar = 248): Promise<void> {
  const keys = ["clientWidth", "offsetWidth", "scrollWidth"] as const
  const original = keys.map((key) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, key))
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
  return Promise.resolve()
    .then(run)
    .finally(() => {
      keys.forEach((key, index) => {
        const descriptor = original[index]
        if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor)
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
      })
    })
}

function renderLayout() {
  return render(
    <MainSidebarLayout
      initialPinned
      screen="main"
      sidebar={<div>Sidebar</div>}
      leading={<main>Plugins</main>}
      main={<main>Chat</main>}
      trailing={<TrailingBoard />}
      statusBar={<span>Sync status</span>}
    />
  )
}

function dotsOf(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".canvas-dots button")]
}

async function parkOnTrailing(container: HTMLElement) {
  const dots = dotsOf(container)
  expect(dots).toHaveLength(2)
  await act(() => Promise.try(() => fireEvent.click(must(dots[1], "trailing dot"))))
}

async function backToChat(container: HTMLElement) {
  await act(() => Promise.try(() => fireEvent.click(must(dotsOf(container)[0], "chat dot"))))
}

function trailingPanel(container: HTMLElement): HTMLElement {
  return must(container.querySelector<HTMLElement>('[data-screen-panel="trailing"]'), "trailing screen")
}

function sidebarMode(container: HTMLElement): string | null {
  return container.querySelector("[data-sidebar-mode]")?.getAttribute("data-sidebar-mode") ?? null
}

test("empty trailing screen keeps a working back-to-chat action that restores inert and pinned", async () => {
  await withReducedMotion(() =>
    withCanvasGeometry(async () => {
      const view = renderLayout()
      const trailing = trailingPanel(view.container)
      // 启动停在 chat：trailing 尚未激活。
      expect(trailing.hasAttribute("inert")).toBe(true)
      await parkOnTrailing(view.container)
      expect(trailing.hasAttribute("inert")).toBe(false)

      const scope = within(trailing)
      expect(scope.getByRole("heading", { name: "Apps" })).toBeVisible()
      expect(scope.getByText("Running apps and tool windows appear here. Select a card to switch to it.")).toBeVisible()
      expect(scope.getByText("No running apps or tool windows right now.")).toBeVisible()

      // 空列表下「返回对话」仍是唯一出口，点击必须真的回到 chat。
      await act(() => Promise.try(() => fireEvent.click(scope.getByRole("button", { name: "Back to chat" }))))
      await waitFor(() => expect(dotsOf(view.container)[0]).toHaveAttribute("aria-current", "page"))
      expect(trailing.hasAttribute("inert")).toBe(true)
      expect(sidebarMode(view.container)).toBe("pinned")
      expect(must(view.container.querySelector(".main-sidebar-panel"), "sidebar panel").hasAttribute("inert")).toBe(false)
      view.unmount()
    })
  )
})

test("a populated trailing screen hides the empty hint and its back action still returns to chat", async () => {
  running.apps = [{ name: "Feishu", bundle_id: "com.electron.lark", icon: null }]
  await withReducedMotion(() =>
    withCanvasGeometry(async () => {
      const view = renderLayout()
      const trailing = trailingPanel(view.container)
      await parkOnTrailing(view.container)
      const scope = within(trailing)
      expect(scope.queryByText("No running apps or tool windows right now.")).not.toBeInTheDocument()
      expect(scope.getByRole("button", { name: "Feishu" })).toBeVisible()
      await act(() => Promise.try(() => fireEvent.click(scope.getByRole("button", { name: "Back to chat" }))))
      await waitFor(() => expect(dotsOf(view.container)[0]).toHaveAttribute("aria-current", "page"))
      expect(trailing.hasAttribute("inert")).toBe(true)
      expect(sidebarMode(view.container)).toBe("pinned")
      view.unmount()
    })
  )
})

test("the chat status-bar dot also leaves trailing inert and re-pins the sidebar", async () => {
  await withReducedMotion(() =>
    withCanvasGeometry(async () => {
      const view = renderLayout()
      const trailing = trailingPanel(view.container)
      await parkOnTrailing(view.container)
      expect(trailing.hasAttribute("inert")).toBe(false)
      expect(sidebarMode(view.container)).toBe("hidden")
      await backToChat(view.container)
      await waitFor(() => expect(dotsOf(view.container)[0]).toHaveAttribute("aria-current", "page"))
      expect(trailing.hasAttribute("inert")).toBe(true)
      expect(sidebarMode(view.container)).toBe("pinned")
      view.unmount()
    })
  )
})

test("a visible tool window counts as content, so the empty hint stays hidden", async () => {
  env.tauri = true
  env.windows = [{ label: "settings", isVisible: async () => true, title: async () => "Settings" }]
  await withReducedMotion(() =>
    withCanvasGeometry(async () => {
      const view = renderLayout()
      const trailing = trailingPanel(view.container)
      await parkOnTrailing(view.container)
      const scope = within(trailing)
      expect(await scope.findByRole("button", { name: "Settings" })).toBeVisible()
      expect(scope.queryByText("No running apps or tool windows right now.")).not.toBeInTheDocument()
      view.unmount()
    })
  )
})

test("the trailing header speaks Simplified Chinese when the locale is zh-CN", async () => {
  await initI18n("zh-CN")
  try {
    await withReducedMotion(() =>
      withCanvasGeometry(async () => {
        const view = renderLayout()
        const trailing = trailingPanel(view.container)
        await parkOnTrailing(view.container)
        const scope = within(trailing)
        expect(scope.getByRole("heading", { name: "功能" })).toBeVisible()
        expect(scope.getByText("这里列出正在运行的应用与工具窗口，点击卡片即可切换过去。")).toBeVisible()
        expect(scope.getByText("暂无正在运行的应用或工具窗口。")).toBeVisible()
        await act(() => Promise.try(() => fireEvent.click(scope.getByRole("button", { name: "返回对话" }))))
        await waitFor(() => expect(dotsOf(view.container)[0]).toHaveAttribute("aria-current", "page"))
        expect(trailing.hasAttribute("inert")).toBe(true)
        expect(sidebarMode(view.container)).toBe("pinned")
        view.unmount()
      })
    )
  } finally {
    await initI18n("en")
  }
})
