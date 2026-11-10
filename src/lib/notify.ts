// System notifications for conversation state changes (finished / needs your action).
//
// The notification plugin is registered on the Rust side; this wraps the permission dance so a
// denied permission only silences notifications instead of failing the caller. The free-model
// watch additionally paints the same event as an in-window toast: the notification plugin is a
// background surface, and a user sitting in another window would miss it entirely without the
// toast. Voice was dropped on request — a toast is enough.
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"
import { toast } from "sonner"

export async function notifyConversation(title: string, body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted()
    if (!granted) granted = (await requestPermission()) === "granted"
    if (!granted) return
    sendNotification({ title, body })
  } catch {
    // Notifications are a convenience; never surface their failures.
  }
}

/** An in-window toast for an event that also fires as a system notification. The toast is the
 *  one the user actually sees; the notification is the backup for when the app is backgrounded. */
export function notifyFreeModels(title: string, body: string): void {
  toast.info(title, { description: body, duration: 8000 })
}
