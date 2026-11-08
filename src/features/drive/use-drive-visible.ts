import { useDrive } from "@alwith/module-drive/react"

import { usePlatformAuth } from "@/features/auth/store"

import { drive } from "./controller"
import { isDriveVisible } from "./visibility"
import { useYupDriveEnabled } from "./yup-drive-preference"

/**
 * The drive panel is visible when the account policy allows it and the master switch is on. A
 * configured (synced) drive counts as access even without a company-domain login email, so the
 * same condition that starts the sync also decides whether its panel can be found.
 */
export function useDriveVisible(): boolean {
  const yupEnabled = useYupDriveEnabled()
  const { snapshot } = useDrive(drive)
  const configured = snapshot?.configured === true
  return usePlatformAuth(
    (state) => isDriveVisible(state.isAuthenticated, state.user?.login_email, configured) && yupEnabled
  )
}
