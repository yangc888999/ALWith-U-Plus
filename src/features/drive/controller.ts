import {
  createDriveController,
  type DriveController,
  type DriveRequest,
  type DriveResponse,
  type DriveTransport
} from "@alwith/module-drive"
import { commands, events } from "@alwith/module-drive/commands"
import { emitTo } from "@tauri-apps/api/event"
import { info } from "@tauri-apps/plugin-log"
import i18n from "i18next"
import { toast } from "sonner"

/**
 * The Drive engine is a closed native library reached through a *synchronous* C ABI call
 * (`DriveService::execute` -> `Handle::call_async` -> `spawn_blocking` -> dylib). Nothing in that
 * chain has a deadline. When a request wedges (the mass-delete restore is the observed case),
 * `createDriveController.request` also leaves its deduplicated `refresh()` promise pending, so
 * every later Drive request joins the same stuck promise and the whole panel freezes — not just
 * the one dialog. Capping the IPC at the transport is what releases that dedup handle.
 *
 * Interactive sign-in is deliberately uncapped: the user may spend minutes in the browser.
 */
const DEFAULT_TIMEOUT_MS = 45_000
const LONG_TIMEOUT_MS = 180_000
const DELETE_TIMEOUT_MS = 20_000

const UNBOUNDED_REQUESTS = new Set(["login", "ssoLogin"])
const LONG_REQUESTS = new Set([
  "start",
  "sync",
  "syncProject",
  "reconcile",
  "recheckCloudOnly",
  "cleanupScan",
  "cleanup",
  "retryUploads",
  "download",
  "land",
  "createProject",
  "condensePreflight",
  "condenseStart",
  "archiveSession",
  "archivePrivateSessions",
  "publishBetweenProjects",
  "moveBetweenProjects",
  "ssoConfig"
])
/** Requests that change the Drive policy the rest of the app has cached. */
const POLICY_REQUESTS = ["login", "ssoLogin", "logout", "start", "setPreferences"]

export function driveRequestTimeoutMs(request: DriveRequest): number | null {
  if (UNBOUNDED_REQUESTS.has(request.type)) return null
  if (request.type === "confirmDeletes" || request.type === "cancelDeletes") return DELETE_TIMEOUT_MS
  return LONG_REQUESTS.has(request.type) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
}

/**
 * Session credentials (`mcpSessionConfig`, `collabSession`) travel through Drive's separate
 * `sessionRequest` command, which only the main window is granted; every other request uses the
 * plugin's ordinary `request` command.
 */
function carriesCredentials(request: DriveRequest): boolean {
  return request.type === "mcpSessionConfig" || request.type === "collabSession"
}

async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Drive request timed out: ${label} after ${ms}ms`)), ms)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function invokeDrive(request: DriveRequest): Promise<DriveResponse> {
  const budget = driveRequestTimeoutMs(request)
  const pending = carriesCredentials(request)
    ? commands.sessionRequest({ request })
    : commands.request({ request })
  if (budget === null) return pending
  try {
    return await withDeadline(pending, budget, request.type)
  } catch (error) {
    // The native call may still complete later. Rejecting here is intentional: it releases the
    // controller's shared refresh promise so the rest of the Drive UI stays usable.
    void info(`[drive-transport] deadline type=${request.type} ms=${budget} error=${String(error)}`)
    throw error
  }
}

/**
 * The module ships `createTauriDriveTransport()`, but it hardcodes the commands and therefore
 * loses the IPC deadline above and the `drive:policy-changed` broadcast below. Both are fixes for
 * observed incidents, so the transport stays here.
 */
export const driveTransport: DriveTransport = {
  async request(request: DriveRequest): Promise<DriveResponse> {
    const response = await invokeDrive(request)
    if (POLICY_REQUESTS.includes(request.type)) {
      await emitTo("main", "drive:policy-changed", null)
    }
    return response
  },
  subscribe: (handler) => events["drive:event"].listen((event) => handler(event.payload))
}

const controller = createDriveController(driveTransport)
export const drive: DriveController = {
  ...controller,
  async request(request: DriveRequest): Promise<DriveResponse> {
    const response = await controller.request(request)
    if (["reconfigure", "setPreferences", "setMaxAutoDownloadMb"].includes(request.type)) {
      toast.success(i18n.language?.startsWith("zh") ? "云盘配置已保存" : "Drive settings saved", {
        id: "drive-settings-saved"
      })
    }
    return response
  }
}
