// The one bootstrap for auxiliary windows (ALwith Desktop's aux-window-bootstrap): the
// same providers the main window mounts, minus the App and its Runtime connection.
import { attachConsole, error as logError } from "@tauri-apps/plugin-log"
import { type ComponentType, StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { installScrollActivity } from "@/lib/scroll-activity"
import { toast } from "sonner"

import { AppDirectionProvider } from "@/components/alwith-ui/app-direction-provider"
import { ErrorBoundary } from "@/components/error-boundary"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ZoomFeedback } from "@/features/appearance/zoom-feedback"
import { AuthGate } from "@/features/auth/auth-gate"
import { initPlatformAuth } from "@/features/auth/store"
import { hydrateNavigationSound } from "@/features/chat/codex/navigation-sound-store"
import { predictionPreference } from "@/features/chat/composer/prediction-preference"
import { hydrateProfileOverrides } from "@/features/profile/profile-store"
import { describeError } from "@/lib/error-text"
import { initI18n } from "@/lib/i18n"
import { installToastErrorLocalization } from "@/lib/toast-error"
import { startPreferenceSync } from "@/lib/preference-sync"
import { loadPreferences, type Preferences } from "@/lib/preferences"
import { bootstrapSettings } from "@/lib/settings-store"
import { companyModelConfig } from "@/lib/company-model-config"
import { commands } from "@/bindings"
import { hydrateZoom } from "@/lib/zoom"
import { startZoomViewport } from "@/lib/zoom-viewport"
import "../index.css"

// Same guard for the settings / floating windows: install before the first rejection can toast.
installToastErrorLocalization()

export function bootstrapAuxWindow(opts: {
  component: ComponentType<{ preferences: Preferences }>
  logTag: string
  toaster?: boolean
  zoomControls?: "feedback" | "silent"
  setup?: () => Promise<void>
  transparent?: boolean
}): void {
  const Component = opts.component
  async function bootstrap() {
    await bootstrapSettings()
    // Mirror the persisted company-model reasoning level into the backend so the engine catalog
    // uses it (the 大模型 page default is Max, which the backend also defaults to on first run).
    void commands
      .setCompanyModelReasoning({ level: companyModelConfig().reasoningLevel })
      .catch((failure: unknown) => console.error("[aux] company-model config push failed", failure))
    await attachConsole()
    window.addEventListener("unhandledrejection", (event) => {
      const error: unknown = event.reason
      const message = error instanceof Error ? error.message : String(error)
      // This handler used to toast the raw English rejection — "The operation was aborted."
      // came from here. The log keeps the original; the toast goes through the shared table.
      toast.error(describeError(error))
      void logError(`[${opts.logTag}] ${message}`).catch((failure: unknown) => console.error(failure))
    })
    const preferences = await loadPreferences()
    predictionPreference.setState({ enabled: preferences.composerPredictions ?? true })
    hydrateProfileOverrides({
      owner: preferences.profileOwner,
      nickname: preferences.profileNickname,
      avatar: preferences.profileAvatar
    })
    await initI18n(preferences.language)
    if (opts.zoomControls) await startZoomViewport()
    await hydrateZoom(preferences.zoomLevel)
    hydrateNavigationSound({ soundMode: preferences.navigationSoundMode, instrument: preferences.navigationInstrument })
    void startPreferenceSync()
    await initPlatformAuth()
    await opts.setup?.()
    if (opts.transparent) {
      document.documentElement.style.background = "transparent"
      document.body.style.background = "transparent"
    }
    const root = document.getElementById("root")
    if (!root) throw new Error("the window page has no #root")
    installScrollActivity()
    createRoot(root).render(
      <StrictMode>
        <AppDirectionProvider>
          <ThemeProvider>
            <TooltipProvider>
              <ErrorBoundary>
                <AuthGate auxiliary>
                  <Component preferences={preferences} />
                  {opts.zoomControls ? <ZoomFeedback showFeedback={opts.zoomControls === "feedback"} /> : null}
                </AuthGate>
              </ErrorBoundary>
              {opts.toaster ? <Toaster position="top-center" /> : null}
            </TooltipProvider>
          </ThemeProvider>
        </AppDirectionProvider>
      </StrictMode>
    )
  }
  bootstrap().catch((failure: unknown) =>
    logError(`[${opts.logTag}] bootstrap failed: ${failure instanceof Error ? failure.message : String(failure)}`)
  )
}
