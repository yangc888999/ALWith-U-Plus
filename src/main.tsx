import { DriveNotificationProvider } from "@alwith/module-drive/react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { attachConsole, error as logError, info } from "@tauri-apps/plugin-log"
import { locale as systemLocale, platform } from "@tauri-apps/plugin-os"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { toast } from "sonner"

import { App } from "@/app"
import { AppDirectionProvider } from "@/components/alwith-ui/app-direction-provider"
import { WindowsMainWindowShell } from "@/components/alwith-ui/windows-main-window-shell"
import { ErrorBoundary } from "@/components/error-boundary"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ZoomFeedback } from "@/features/appearance/zoom-feedback"
import { AuthGate } from "@/features/auth/auth-gate"
import { initPlatformAuth } from "@/features/auth/store"
import { hydrateNavigationSound } from "@/features/chat/codex/navigation-sound-store"
import { startModelOverloadAlerts } from "@/features/chat/model-overload-alert"
import { startModelRetryingAlerts } from "@/features/chat/model-retrying-alert"
import { predictionPreference } from "@/features/chat/composer/prediction-preference"
import { requestDefaultScreenCapture, restoreComputer } from "@/features/computer/operations"
import { reportExtensionError } from "@/features/extensions/runtime"
import { startStartupImports } from "@/features/extensions/startup-import-control"
import { initializeMobile } from "@/features/mobile/bridge"
import { hydrateProfileOverrides } from "@/features/profile/profile-store"
import { useUpdaterStore } from "@/features/updater/store"
import { installErrorTextFormatter } from "@/lib/error-text"
import { installToastErrorLocalization } from "@/lib/toast-error"
import { armStartupWindow } from "@/lib/startup-window"
import { initI18n } from "@/lib/i18n"
import { startPreferenceSync } from "@/lib/preference-sync"
import { startGatewayRetrySync } from "@/lib/gateway-retry-settings"
import { startOverload429MuteSync } from "@/lib/overload-429-settings"
import { loadPreferences, defaultPreferences } from "@/lib/preferences"
import { isQueueCancelled } from "@/lib/queued-prompt"
import { bootstrapSettings } from "@/lib/settings-store"
import { hydrateZoom } from "@/lib/zoom"
import { startZoomViewport } from "@/lib/zoom-viewport"
import "./index.css"
import { installScrollActivity } from "@/lib/scroll-activity"
import { primeQuickChatRoot } from "@/lib/quick-chat"
import { clampWindowToScreen } from "@/lib/window-fit"
// Install before anything can toast: early startup rejections were the last raw-English path.
installToastErrorLocalization()
// 引擎第一次 ready 之前的一切失败都不上屏（只进日志）。顺序很重要：必须在第一个 await 之前开启，
// 否则 bootstrap 里的失败会抢在窗口之前弹出来（2026-11-08）。
armStartupWindow()

const driveNotices = {
  error(message: string): void {
    toast.error(message, { id: "drive-background-error" })
  },
  success(message: string): void {
    toast.success(message, { id: "drive-task-completed" })
  }
}

// Dev-only probe for the selection/right-click path: writes what the document actually receives
// to the diagnostic log, so a missing floating menu can be explained instead of guessed at.
if (import.meta.env.DEV) {
  const probe = (line: string): void => {
    void invoke("append_diagnostic", { line: `[probe] ${line}` }).catch(() => undefined)
  }
  const describeMenu = (selector: string): Record<string, unknown> | null => {
    const node = document.querySelector<HTMLElement>(selector)
    if (node === null) return null
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const px = Math.round(rect.left + rect.width / 2)
    const py = Math.round(rect.top + rect.height / 2)
    return {
      rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
      position: style.position,
      zIndex: style.zIndex,
      visibility: style.visibility,
      opacity: style.opacity,
      background: style.backgroundColor,
      color: style.color,
      topmost: document.elementFromPoint(px, py)?.tagName ?? null,
      inside: document.elementFromPoint(px, py) === node || node.contains(document.elementFromPoint(px, py))
    }
  }
  const describeTarget = (target: EventTarget | null): Record<string, unknown> => ({
    at: new Date().toISOString(),
    tag: target instanceof Element ? target.tagName : null,
    composer: target instanceof Element ? target.closest("[data-composer]") !== null : false,
    pill: document.querySelector("[data-selection-menu]") !== null,
    ctx: document.querySelector("[data-chat-context-menu]") !== null
  })
  window.addEventListener(
    "pointerup",
    (event) => {
      const selection = window.getSelection()
      probe(
        JSON.stringify({
          ev: "pointerup",
          button: event.button,
          text: selection?.toString().trim().slice(0, 12) ?? "",
          ...describeTarget(event.target)
        })
      )
      setTimeout(() => {
        probe(JSON.stringify({ ev: "pointerup+180ms", box: describeMenu("[data-selection-menu]") }))
      }, 180)
    },
    true
  )
  window.addEventListener(
    "contextmenu",
    (event) => {
      probe(JSON.stringify({ ev: "contextmenu", ...describeTarget(event.target) }))
      setTimeout(() => {
        probe(JSON.stringify({ ev: "contextmenu+50ms", ...describeTarget(event.target), box: describeMenu("[data-chat-context-menu]") }))
      }, 50)
    },
    true
  )
}

function describe(value: unknown): string {
  return value instanceof Error ? `${value.message}\n${value.stack ?? ""}` : String(value)
}

// Uncaught errors are shown once per cause (a polling failure must not flood the screen)
// and always written to the Tauri log file. A failing log call must not re-enter these
// handlers, so its rejection is swallowed here.
const seenGlobalErrors = new Set<string>()
function surfaceGlobalError(message: string): void {
  const cause = message.split("\n", 1)[0]
  if (!seenGlobalErrors.has(cause)) {
    seenGlobalErrors.add(cause)
    toast.error(cause)
  }
  logError(message).catch((failure: unknown) => console.error("[logError]", failure))
}

// A cancelled queued message rejects by design (it is how the composer restores the text), so it
// must not be reported as an uncaught failure.
window.addEventListener("unhandledrejection", (event) => {
  if (isQueueCancelled(event.reason)) {
    event.preventDefault()
    return
  }
  surfaceGlobalError(describe(event.reason))
})
window.addEventListener("error", (event) => {
  // Benign browser noise: the layout settled one frame late. VS Code and Sentry filter it too.
  if (event.message.startsWith("ResizeObserver loop")) return
  surfaceGlobalError(
    `${event.message} @ ${event.filename}:${event.lineno}:${event.colno}\n${(event.error as { stack?: string } | null | undefined)?.stack ?? ""}`
  )
})

async function bootstrap(): Promise<void> {
  if (isTauri()) {
    // A window taller than its screen loses macOS's rounded corners and clips its bottom rows;
    // clamp it back into the visible frame (also re-runs after drags).
    void clampWindowToScreen()
  }
  if (isTauri() && platform() === "windows") {
    document.documentElement.dataset.windowBackdrop = "acrylic"
  }
  // Every `await` before the first render is a frame the window spends on the boot placeholder, and
  // each of these is a separate IPC round trip. The ones that do not feed each other now run
  // together; only what the first frame actually shows (preferences, translations, zoom) is still
  // awaited in order.
  //
  // Settings must not be able to abort the boot. Its read is an IPC call into the Rust store, and
  // on a cold first launch it can be slow or stay pending; letting that rejection escape used to
  // skip `createRoot` entirely, so the window showed a blank page instead of a running app with
  // default settings. Degrade to defaults, log it, and keep going.
  const settingsReady = bootstrapSettings().catch((error: unknown) => {
    console.warn("[settings] boot read failed; continuing with defaults", error)
  })
  // Same reasoning for preferences: it reads the same store over IPC. A hung or failed read must
  // degrade to a fresh-install default set, never leave the window blank.
  const preferencesReady = loadPreferences().catch((error: unknown) => {
    console.warn("[preferences] boot read failed; continuing with defaults", error)
    return defaultPreferences()
  })
  const [, preferences] = await Promise.all([settingsReady, preferencesReady])
  predictionPreference.setState({ enabled: preferences.composerPredictions ?? true })
  hydrateProfileOverrides({
    owner: preferences.profileOwner,
    nickname: preferences.profileNickname,
    avatar: preferences.profileAvatar
  })
  // WKWebView reports the app bundle's language, not the user's system language. On a first
  // launch there is no saved `language` preference yet, so trusting navigator.language renders the
  // whole UI in English even on a Chinese Mac. Ask the OS directly before i18n is initialised.
  let language = preferences.language
  if (language === null && isTauri()) {
    language = await systemLocale().catch(() => null)
  }
  await initI18n(language)
  // Legacy chats record the provider they were born on, and codex can only resume them by
  // restarting the whole engine — which aborts whatever other chats are streaming. Move those
  // records onto the shared router before the runtime starts, so no chat costs anyone else's turn.
  if (isTauri()) {
    // Thread migration is housekeeping for legacy chats, not something the first frame needs. It
    // walks every stored thread, so on a first launch after an upgrade it can take a long time —
    // and while it ran, the window sat on the placeholder. Move it off the first-frame path.
    void invoke("migrate_threads_to_router").catch((error: unknown) => {
      console.warn("[router-migration]", error)
    })
  }
  // Turn errors are painted by the chat package itself; it asks this formatter for the wording.
  installErrorTextFormatter()
  await Promise.all([
    initializeMobile().catch((error: unknown) => surfaceGlobalError(describe(error))),
    // Logging must be attached before the first line is written, but nothing renders for it.
    attachConsole()
      .then(() => info("frontend booting"))
      .catch((error: unknown) => console.error("[attachConsole]", error)),
    startZoomViewport(),
    isTauri()
      ? listen<string>("power:error", ({ payload }) => surfaceGlobalError(payload)).catch((error: unknown) =>
          console.error("[power:error]", error)
        )
      : Promise.resolve(),
    isTauri() ? initPlatformAuth() : Promise.resolve()
  ])
  await hydrateZoom(preferences.zoomLevel)
  hydrateNavigationSound({ soundMode: preferences.navigationSoundMode, instrument: preferences.navigationInstrument })
  void startPreferenceSync()
  // The bridge keeps 「连接中断自动重试」 and 「禁用模型异常提醒」 in in-process AtomicBools that reset
  // to their defaults on every launch, while both switches live in localStorage. Without these
  // pushes the mirrors are only corrected when someone happens to open 设置 → 供应商 — so a user who
  // switched either one off and then restarted got the old behaviour back while the UI still showed
  // the saved value. Boot, not import: see the module headers. Both calls are idempotent and swallow
  // failures, so the cost is one IPC round trip each (and none at all outside Tauri).
  startGatewayRetrySync()
  startOverload429MuteSync()
  const root = document.getElementById("root")
  if (!root) throw new Error("index.html has no #root")
  // Cache the quick-chat root before the first render decides what a chat is.
  void primeQuickChatRoot()

  installScrollActivity()
  createRoot(root).render(
    <StrictMode>
      <AppDirectionProvider>
        <ThemeProvider>
          <TooltipProvider>
            <ErrorBoundary>
              <DriveNotificationProvider notify={driveNotices}>
                <WindowsMainWindowShell>
                  <AuthGate>
                    <App initialPreferences={preferences} />
                    <ZoomFeedback />
                  </AuthGate>
                </WindowsMainWindowShell>
              </DriveNotificationProvider>
            </ErrorBoundary>
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </ThemeProvider>
      </AppDirectionProvider>
    </StrictMode>
  )
  if (isTauri()) {
    // Off the first-frame path: the computer driver, the screen-capture permission and the
    // extension/updater checks are only needed once the surface is on screen, and waiting for them
    // held the window on the boot placeholder for a whole startup round trip.
    void restoreComputer().catch((error: unknown) => surfaceGlobalError(describe(error)))
    void requestDefaultScreenCapture().catch((error: unknown) => surfaceGlobalError(describe(error)))
    void startStartupImports().catch(reportExtensionError)
    void startModelOverloadAlerts().catch((error: unknown) => surfaceGlobalError(describe(error)))
    void startModelRetryingAlerts().catch((error: unknown) => surfaceGlobalError(describe(error)))
    void useUpdaterStore
      .getState()
      .init()
      .catch((error: unknown) => surfaceGlobalError(describe(error)))
  }
}

bootstrap().catch((failure: unknown) => surfaceGlobalError(`bootstrap failed: ${describe(failure)}`))
