import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

export interface SettingsSnapshot {
  revision: number
  values: Record<string, unknown>
  browserMigrated: boolean
}
export interface SettingsRequest {
  action: "read" | "update" | "importBrowser" | "saveVoice"
  changes?: Record<string, unknown>
  expectedRevision?: number
  apiKey?: string | null
}
type Request = (input: SettingsRequest) => Promise<SettingsSnapshot>
type Listener = (keys: string[]) => void

/** A webview projection. Rust remains the only writer and source of truth. */
export class SettingsClient {
  private snapshot: SettingsSnapshot = { revision: -1, values: {}, browserMigrated: false }
  private readonly listeners = new Set<Listener>()
  private readonly request: Request
  constructor(request: Request) {
    this.request = request
  }
  accept(next: SettingsSnapshot): void {
    if (next.revision <= this.snapshot.revision) return
    const previous = this.snapshot.values
    this.snapshot = next
    const keys = [...new Set([...Object.keys(previous), ...Object.keys(next.values)])].filter(
      (key) => JSON.stringify(previous[key]) !== JSON.stringify(next.values[key])
    )
    if (keys.length) for (const listener of this.listeners) listener(keys)
  }
  get<T>(key: string): T | undefined {
    return this.snapshot.values[key] as T | undefined
  }
  async read(): Promise<SettingsSnapshot> {
    this.accept(await this.request({ action: "read" }))
    return this.snapshot
  }
  async write(input: SettingsRequest): Promise<SettingsSnapshot> {
    const saved = await this.request(input)
    this.accept(saved)
    return saved
  }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
export const settingsStore = new SettingsClient((input) => invoke("settings_request", { input }))
let initialization: Promise<void> | undefined

function initializeSettings(): Promise<void> {
  if (initialization) return initialization
  initialization = (async () => {
    await listen<SettingsSnapshot>("settings:changed", (event) => settingsStore.accept(event.payload))
    const snapshot = await settingsStore.read()
    if (!snapshot.browserMigrated) {
      const changes: Record<string, unknown> = {}
      const theme = localStorage.getItem("theme")
      if (theme !== null) changes["appearance.theme"] = theme
      const editor = localStorage.getItem("workspace:editor-settings")
      if (editor !== null) {
        const value: unknown = JSON.parse(editor)
        if (typeof value !== "object" || value === null || Array.isArray(value))
          throw new Error("Invalid legacy editor settings")
        for (const [key, entry] of Object.entries(value)) changes[`editor.${key}`] = entry
      }
      const iconTheme = localStorage.getItem("workspace:editor-icon-theme")
      if (iconTheme !== null) changes["editor.iconTheme"] = JSON.parse(iconTheme)
      await settingsStore.write({ action: "importBrowser", changes })
    }
    applyInitialTheme()
  })()
  return initialization
}
function applyInitialTheme(): void {
  const theme = settingsStore.get<string>("appearance.theme") ?? "system"
  const resolved =
    theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme
  document.documentElement.classList.toggle("dark", resolved === "dark")
  document.documentElement.classList.toggle("light", resolved === "light")
  document.documentElement.style.colorScheme = resolved
}
/** Browser previews have no native persistence; production bootstrap always initializes Rust. */
export async function bootstrapSettings(): Promise<void> {
  try {
    if (isTauri()) await initializeSettings()
    else applyInitialTheme()
  } catch (error: unknown) {
    // 这一段跑在 React 挂载之前。以前把异常原文写进 #root，等于在启动画面上直接糊一段英文栈
    // —— 正是「启动界面闪一下报错」的来源之一。这里只留中性占位 + 一个重新启动入口，
    // 原始错误交给调用方记日志（main.tsx 的 bootstrap catch）。
    showBootFailureNotice()
    throw error
  } finally {
    document.documentElement.style.visibility = "visible"
  }
}

/** 启动没走完时的中性占位：不出现错误文本、不出现栈，只给一个能重新来一次的动作。 */
function showBootFailureNotice(): void {
  const root = document.getElementById("root")
  if (!root) return
  const chinese = (navigator.language ?? "").toLowerCase().startsWith("zh")
  const wrap = document.createElement("div")
  wrap.setAttribute("role", "status")
  wrap.style.cssText =
    "display:flex;width:100vw;height:100vh;align-items:center;justify-content:center;flex-direction:column;gap:12px;font:13px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;color:rgba(127,127,127,0.9)"
  const text = document.createElement("span")
  text.textContent = chinese ? "启动没有完成" : "Startup did not finish"
  const button = document.createElement("button")
  button.type = "button"
  button.textContent = chinese ? "重新启动" : "Reload"
  button.style.cssText =
    "cursor:pointer;border-radius:8px;border:1px solid rgba(127,127,127,0.35);background:transparent;color:inherit;padding:5px 14px;font:inherit"
  button.addEventListener("click", () => window.location.reload())
  wrap.append(text, button)
  root.replaceChildren(wrap)
}
export async function updateSettings(changes: Record<string, unknown>): Promise<void> {
  await settingsStore.write({ action: "update", changes })
}
