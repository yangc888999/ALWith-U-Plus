// 回归探针 —— 首次打开白屏。
//
// 根因：index.html 用 `visibility: hidden` 避免首帧闪白，而全仓唯一撤销它的地方是
// `bootstrapSettings()` 的 `finally`。`finally` 只在 promise **settle** 时运行 —— 不是挂住时。
// 那个 promise 里 `settingsStore.read()` 是一次 IPC，冷启动（还没有 settings.json，Rust 侧
// 还要跑 importBrowser 迁移）可能长时间不返回，于是窗口一直是纯白：没有 loader、没有报错。
//
// 这里盯三件事：挂住的 IPC 不能挡住可见性、读失败必须降级而不是中断启动、index.html 必须
// 自带一条不依赖模块图/IPC/React 的兜底。

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, expect, test, vi } from "vitest"

const ipc = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: (_command: string, args: { input: unknown }) => ipc.request(args.input)
}))
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }))

const { bootstrapSettings, revealDocument } = await import("../settings-store")

/**
 * `initializeSettings()` memoises its promise at module scope, so a test that leaves it pending
 * would poison every later test. Re-import a fresh module per case.
 */
async function freshBootstrap(): Promise<typeof bootstrapSettings> {
  vi.resetModules()
  return (await import("../settings-store")).bootstrapSettings
}

beforeEach(() => {
  ipc.request.mockReset()
  document.documentElement.style.visibility = "hidden"
  document.getElementById("root")?.remove()
  const root = document.createElement("div")
  root.id = "root"
  document.body.append(root)
})

afterEach(() => {
  vi.useRealTimers()
  delete (window as { __alwithRevealTimer?: unknown }).__alwithRevealTimer
})

test("a settings read that never replies still reveals the document", async () => {
  vi.useFakeTimers()
  const boot = await freshBootstrap()
  // 永不 settle：这正是白屏现场的形态。
  ipc.request.mockImplementation(() => new Promise(() => {}))
  const running = boot().catch(() => {})
  await vi.advanceTimersByTimeAsync(8_000)
  await running
  expect(document.documentElement.style.visibility).toBe("visible")
})

test("a rejected settings read reveals the document and leaves a readable notice", async () => {
  const boot = await freshBootstrap()
  ipc.request.mockRejectedValue(new Error("Settings lock poisoned"))
  await expect(boot()).rejects.toThrow("Settings lock poisoned")
  expect(document.documentElement.style.visibility).toBe("visible")
  // 中性占位 + 重新启动入口，而不是英文栈（jsdom 默认英文 locale，故两种文案都接受）。
  const notice = document.getElementById("root")?.textContent ?? ""
  expect(notice).toMatch(/启动没有完成|Startup did not finish/)
  expect(notice).not.toContain("Settings lock poisoned")
  expect(document.querySelector("#root button")).not.toBeNull()
})

test("revealDocument cancels the inline fallback timer", () => {
  const timer = setTimeout(() => {}, 60_000)
  ;(window as { __alwithRevealTimer?: unknown }).__alwithRevealTimer = timer
  revealDocument()
  expect(document.documentElement.style.visibility).toBe("visible")
  expect((window as { __alwithRevealTimer?: unknown }).__alwithRevealTimer).toBeUndefined()
})

test("index.html reveals itself without the module graph, IPC or React", () => {
  const html = readFileSync(join(process.cwd(), "index.html"), "utf8")
  // 兜底必须是 head 里的内联脚本：模块加载失败时它照样跑。
  const head = html.slice(0, html.indexOf("</head>"))
  expect(head).toContain("__alwithRevealTimer")
  expect(head).toMatch(/setTimeout\([\s\S]*?visibility\s*=\s*"visible"/)
  // 而且必须早于模块脚本。
  expect(html.indexOf("__alwithRevealTimer")).toBeLessThan(html.indexOf('src="/src/main.tsx"'))
})
