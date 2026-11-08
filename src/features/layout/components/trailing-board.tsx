import { ChatRoundDotsIcon as MessageSquareIcon } from "@solar-icons/react/bold-duotone/chat-round-dots"
import { GamepadIcon as Gamepad2Icon } from "@solar-icons/react/bold-duotone/gamepad"
import { LibraryIcon as BookOpenIcon } from "@solar-icons/react/bold-duotone/library"
import { SettingsIcon } from "@solar-icons/react/bold-duotone/settings"
import { isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow"
import { GlobeIcon } from "lucide-react"
import { useCallback, useContext, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { commands } from "@/bindings"
import { openChatWindow } from "@/lib/chat-window"

import { CanvasContext } from "../lib/canvas-context"
import { useRunningApps } from "../lib/use-running-apps"
import { BrowserBridgeCard } from "./browser-bridge-card"
import { WindowCard } from "./window-card"

const tools = [
  { label: "settings", icon: SettingsIcon },
  { label: "chat", icon: MessageSquareIcon },
  { label: "guide", icon: BookOpenIcon },
  { label: "gamepad", icon: Gamepad2Icon }
] as const
interface ToolWindow {
  label: (typeof tools)[number]["label"]
  title: string
  window: WebviewWindow
}

/** Window enumeration can fail while a window is closing; keep it out of the user's way. */
const reportTrailingError = (error: unknown): void => {
  console.error("[trailing-board]", error)
}

/** Right rail: running apps and tool windows. The pet lounge that used to live here is gone. */
export function TrailingBoard() {
  const { t } = useTranslation()
  const canvas = useContext(CanvasContext)
  const [windows, setWindows] = useState<ToolWindow[]>([])
  const pane = useRef<HTMLDivElement>(null)
  const active = canvas?.trailingActive ?? false
  const runningApps = useRunningApps(active)
  const refresh = useCallback(async () => {
    const all = await WebviewWindow.getAll()
    const visible = await Promise.all(
      tools.map(async ({ label }) => {
        const window = all.find((item) => item.label === label)
        return window && (await window.isVisible()) ? { label, title: await window.title(), window } : null
      })
    )
    return visible.filter((item): item is ToolWindow => item !== null)
  }, [])
  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let checking = false
    const check = async () => {
      if (checking) return
      checking = true
      try {
        const next = await refresh()
        if (!disposed) setWindows(next)
      } catch (error) {
        if (!disposed) reportTrailingError(error)
      } finally {
        checking = false
      }
    }
    void check()
    const timer = setInterval(() => {
      if (active) void check()
    }, 1000)
    const stops = [
      getCurrentWebviewWindow().onFocusChanged(() => void check()),
      listen("tauri://destroyed", () => void check())
    ]
    return () => {
      disposed = true
      clearInterval(timer)
      for (const stop of stops) void stop.then((unlisten) => unlisten()).catch(reportTrailingError)
    }
  }, [active, refresh])
  return (
    <div
      ref={pane}
      className="relative flex h-full min-h-0 flex-col select-none"
      aria-label={t("sidebar.leadingNavigation")}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4">
        {runningApps.map((app) => {
          const icon = app.icon ? (
            <img src={app.icon} alt="" draggable={false} className="object-contain" />
          ) : (
            <GlobeIcon className="size-12" />
          )
          const onOpen = () => void commands.openAppById({ bundleId: app.bundle_id }).catch(reportTrailingError)
          return /chrome/i.test(`${app.bundle_id} ${app.name}`) ? (
            <BrowserBridgeCard key={app.bundle_id} title={app.name} icon={icon} onOpen={onOpen} active={active} />
          ) : (
            <WindowCard key={app.bundle_id} title={app.name} icon={icon} onOpen={onOpen} />
          )
        })}
        {windows.map((item) => {
          const entry = tools.find((tool) => tool.label === item.label)
          if (!entry) throw new Error("Unknown tool window")
          const Icon = entry.icon
          return (
            <WindowCard
              key={item.label}
              title={item.title}
              icon={<Icon size={48} className="size-12 text-muted-foreground" />}
              onOpen={() => {
                void (async () => {
                  if (item.label === "chat") await openChatWindow()
                  else {
                    await item.window.unminimize()
                    await item.window.show()
                    await item.window.setFocus()
                  }
                })().catch(reportTrailingError)
              }}
              onClose={() => void item.window.close().then(refresh).then(setWindows).catch(reportTrailingError)}
            />
          )
        })}
      </div>
    </div>
  )
}
