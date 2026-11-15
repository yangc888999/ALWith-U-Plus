// Entry of the standalone settings window (now only relevant if opened directly; the app opens
// Settings inside the main window as an overlay — see SettingsOverlay).

import { SettingsPage } from "@/features/settings/settings-page"
import { bootstrapAuxWindow } from "@/lib/aux-window-bootstrap"

bootstrapAuxWindow({ component: () => <SettingsPage />, logTag: "settings", toaster: true, zoomControls: "silent" })
