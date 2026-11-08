// System notifications for conversation state changes (finished / needs your action).
//
// The notification plugin is registered on the Rust side; this wraps the permission dance so a
// denied permission only silences notifications instead of failing the caller.
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"

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
