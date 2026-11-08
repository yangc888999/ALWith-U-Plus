import { reportBackgroundError } from "@/lib/background-errors"
import { describeError } from "@/lib/error-text"

import { drive } from "./controller"

export { drive } from "./controller"

import type { FailedUpload, RootInfo } from "@alwith/module-drive"
import {
  type DriveHost,
  DrivePanel,
  DriveSharing,
  driveTranslator,
  summarize,
  useDrive
} from "@alwith/module-drive/react"
import "@alwith/module-drive/styles.css"
import { type CondenseScope, DriveCondense } from "@alwith/module-drive/content"
import { containsPath } from "@alwith/module-fs"
import { isTauri } from "@tauri-apps/api/core"
import { confirm, open } from "@tauri-apps/plugin-dialog"
import { info } from "@tauri-apps/plugin-log"
import { revealItemsInDir } from "@tauri-apps/plugin-opener"
import { CloudIcon } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useWorkspace } from "@/features/workspace/context"
import { openExternal } from "@/lib/open"
import { openSettingsWindow } from "@/lib/window-manager"

import { driveControls, driveDialogClassName } from "./controls"
import { driveFileSystem, drivePathExists } from "./filesystem"
import { DriveIntegrations } from "./integrations"
import { saveDrivePins, useDrivePins } from "./pinned"
import { useDriveVisible } from "./use-drive-visible"
import { useYupDriveEnabled } from "./yup-drive-preference"

export function useDriveConnection(start = true): void {
  const yupEnabled = useYupDriveEnabled()
  const yupRef = useRef(yupEnabled)
  yupRef.current = yupEnabled
  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    void drive
      .attach()
      .then(async () => {
        if (!yupRef.current) {
          // The master switch is off: the Drive stays attached for settings reads but never syncs.
          await drive.request({ type: "stop" })
          return
        }
        if (start && !disposed && drive.getSnapshot().snapshot?.configured) {
          await drive.request({ type: "start" })
          await drive.request({ type: "refreshClientConfig" })
        }
      })
      .catch((error: unknown) => {
        if (!disposed) reportBackgroundError("drive-startup", error)
      })
    return () => {
      disposed = true
      drive.dispose()
    }
  }, [start])
  // Toggling the master switch stops or resumes synchronization immediately; the sidebar
  // visibility follows the same switch through `useDriveVisible`.
  useEffect(() => {
    if (!isTauri() || drive.getSnapshot().snapshot === null) return
    const request = yupEnabled && start ? drive.request({ type: "start" }) : drive.request({ type: "stop" })
    void request.catch((error: unknown) => reportBackgroundError("drive-toggle", error))
  }, [yupEnabled, start])
}

export function DrivePage({
  onOpenProject,
  renderProjectActions,
  currentProject
}: {
  renderProjectActions?: (root: RootInfo) => ReactNode
  currentProject?: string | null
  onOpenProject: (root: RootInfo) => Promise<void>
}): ReactNode {
  const workspace = useWorkspace()
  const { i18n } = useTranslation()
  const locale = i18n.language.startsWith("zh") ? "zh-CN" : "en"
  const { snapshot } = useDrive(drive)
  const profile = `${snapshot?.baseUrl ?? ""}|${snapshot?.localRoot ?? ""}`
  const pins = useDrivePins(profile)
  const [condense, setCondense] = useState<CondenseScope | null>(null)
  const openProject = async (root: RootInfo): Promise<void> => {
    if (!workspace) throw new Error("Drive requires a workspace host")
    await onOpenProject(root)
    await workspace.openProject(root.localPath)
  }
  const host: DriveHost = {
    renderProjectActions,
    readDirectory: async (path) =>
      (await (await driveFileSystem(path)).readDirectory(path)).map((entry) => ({
        name: entry.name,
        isDirectory: entry.kind === "directory"
      })),
    pathExists: drivePathExists,
    onOpenEntry: async (entry) => {
      if (!workspace) throw new Error("Drive requires a workspace host")
      const root = drive
        .getSnapshot()
        .snapshot?.roots.filter((root) => root.drivePath && containsPath(root.localPath, entry.path))
        .toSorted((a, b) => b.localPath.length - a.localPath.length)[0]
      if (!root) throw new Error("Drive project is unavailable")
      await openProject(root)
      if (entry.isDirectory) await workspace.revealEntry(entry.path, root.localPath)
      else await workspace.openFile(entry.path, root.localPath)
    },
    onRevealPath: (path) => revealItemsInDir(path),
    onOpenExternal: openExternal,
    pinnedDocs: pins,
    onPinnedDocsChange: (docs) => {
      return Promise.try(() => {
        saveDrivePins(profile, docs)
      })
    },
    onCondense: (root) => {
      return Promise.try(() => {
        setCondense({ projectId: root.projectId, projectName: root.name, scopePath: null })
      })
    }
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <DrivePanel
        controller={drive}
        mode="launcher"
        currentProject={currentProject ?? undefined}
        locale={locale}
        host={host}
        controls={driveControls}
        onOpenSettings={openDriveSettings}
        onOpenProject={openProject}
        confirm={(message) => confirm(message, { title: i18n.t("drive.confirmTitle"), kind: "warning" })}
      />
      <Dialog
        open={condense !== null}
        onOpenChange={(open) => {
          if (!open) setCondense(null)
        }}
      >
        <DialogContent className={driveDialogClassName}>
          <DialogHeader>
            <DialogTitle>{driveTranslator(locale)("condense.action")}</DialogTitle>
          </DialogHeader>
          {condense && (
            <DriveCondense
              controller={drive}
              scope={condense}
              controls={driveControls}
              locale={locale}
              onClose={() => setCondense(null)}
              onOpenFile={(path) => host.onOpenEntry({ path, isDirectory: false })}
              onOpenExternal={openExternal}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function DriveSharingDialog({ path, onClose }: { path: string | null; onClose: () => void }): ReactNode {
  const { i18n } = useTranslation()
  const locale = i18n.language.startsWith("zh") ? "zh-CN" : "en"
  const t = driveTranslator(locale)
  return (
    <Dialog
      open={path !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className={driveDialogClassName}>
        <DialogHeader>
          <DialogTitle>{t("grants.title")}</DialogTitle>
          <DialogDescription>{path}</DialogDescription>
        </DialogHeader>
        {path && (
          <DriveSharing
            key={path}
            controller={drive}
            path={path}
            locale={locale}
            host={{
              readDirectory: async (value) =>
                (await (await driveFileSystem(value)).readDirectory(value)).map((entry) => ({
                  name: entry.name,
                  isDirectory: entry.kind === "directory"
                })),
              pathExists: drivePathExists,
              onOpenEntry: () => {
                return Promise.try(() => {
                  throw new Error("Navigation is unavailable in this permissions dialog")
                })
              },
              onRevealPath: revealItemsInDir,
              onOpenExternal: openExternal,
              pinnedDocs: [],
              onPinnedDocsChange: () => {
                return Promise.try(() => {
                  throw new Error("Pins are unavailable in this permissions dialog")
                })
              }
            }}
            controls={driveControls}
            confirm={(message) => confirm(message, { title: i18n.t("drive.sharingTitle"), kind: "warning" })}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function openDriveSettings(): void {
  void openSettingsWindow("drive").catch((error: unknown) => toast.error(describeError(error)))
}

export function DriveSettings(): ReactNode {
  useDriveConnection(false)
  const { i18n } = useTranslation()
  const locale = i18n.language.startsWith("zh") ? "zh-CN" : "en"
  const host = useMemo<DriveHost>(
    () => ({
      readDirectory: () => {
        return Promise.try(() => {
          throw new Error("Project browsing belongs to the main window")
        })
      },
      pathExists: () => {
        return Promise.try(() => {
          throw new Error("Project browsing belongs to the main window")
        })
      },
      onOpenEntry: () => {
        return Promise.try(() => {
          throw new Error("Project browsing belongs to the main window")
        })
      },
      onRevealPath: (path) => revealItemsInDir(path),
      onOpenExternal: openExternal,
      pinnedDocs: [],
      onPinnedDocsChange: () => {
        return Promise.try(() => {
          throw new Error("Pinned documents belong to the main window")
        })
      },
      integrations: <DriveIntegrations />
    }),
    []
  )
  return (
    <DrivePanel
      controller={drive}
      mode="settings"
      locale={locale}
      host={host}
      controls={driveControls}
      defaultBaseUrl="https://yup-knowledge-server.finture.id/yup-knowledge"
      onOpenProject={() => {
        return Promise.try(() => {
          throw new Error("Project navigation belongs to the main window")
        })
      }}
      chooseDirectory={async () => {
        const path = await open({ directory: true, multiple: false })
        return typeof path === "string" ? path : null
      }}
      confirm={(message) => confirm(message, { title: "Drive", kind: "warning" })}
    />
  )
}

export function DriveStatus(): ReactNode {
  const visible = useDriveVisible()
  const { i18n } = useTranslation()
  const locale = i18n.language.startsWith("zh") ? "zh-CN" : "en"
  const t = driveTranslator(locale)
  const { connected, snapshot } = useDrive(drive)
  const [failures, setFailures] = useState<FailedUpload[]>([])
  useEffect(() => {
    let active = true
    if (!connected || !snapshot?.running || !snapshot.status?.failed) {
      setFailures([])
      return
    }
    void drive
      .request({ type: "failedUploads" })
      .then((response) => {
        if (response.type !== "failedUploads") throw new Error("Invalid Drive failed transfer response")
        if (active) setFailures(response.data)
      })
      .catch((error: unknown) => {
        if (active) toast.error(describeError(error))
      })
    return () => {
      active = false
    }
  }, [connected, snapshot?.running, snapshot?.status])
  if (!visible || !snapshot?.configured) return null
  const summary = summarize(snapshot.status, failures)
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="pointer-events-auto h-6 text-xs" aria-label={t("title")}>
            <CloudIcon />
            {t(summary.key, { count: summary.count })}
          </Button>
        }
      />
      <PopoverContent side="top" align="end" alignOffset={-8} className="w-80 p-0 text-xs">
        <DrivePanel
          controller={drive}
          mode="status"
          locale={locale}
          controls={driveControls}
          onOpenSettings={openDriveSettings}
          host={{
            readDirectory: () => {
              return Promise.try(() => {
                throw new Error("Project browsing belongs to the launcher")
              })
            },
            pathExists: () => {
              return Promise.try(() => {
                throw new Error("Project browsing belongs to the launcher")
              })
            },
            onOpenEntry: () => {
              return Promise.try(() => {
                throw new Error("Project navigation belongs to the launcher")
              })
            },
            onRevealPath: (path) => revealItemsInDir(path),
            onOpenExternal: openExternal,
            pinnedDocs: [],
            onPinnedDocsChange: () => {
              return Promise.try(() => {
                throw new Error("Pinned documents belong to the launcher")
              })
            }
          }}
          onOpenProject={() => {
            return Promise.try(() => {
              throw new Error("Projects cannot be opened from sync status")
            })
          }}
          confirm={(message) => confirm(message, { title: i18n.t("drive.confirmTitle"), kind: "warning" })}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Bulk-delete confirmation owned by the app.
 *
 * The vendored DriveMassDeleteDialog hardcodes `open={true}` and only closes after a successful
 * `cancelDeletes`/`confirmDeletes` round trip. While the sync engine is busy restoring files that
 * request can queue indefinitely, which leaves a modal whose X, Cancel and Confirm are all
 * disabled — the "卡住了关闭不了" report. Closing here is local and unconditional; the cloud
 * request keeps running in the background and reports failure through a toast.
 *
 * Deadlines live in `drive/controller.ts` at the IPC boundary. A timeout there also releases the
 * controller's shared `refresh()` promise, which is what used to wedge the whole Drive panel.
 */
export function DriveDeleteConfirmation(): ReactNode {
  const { i18n } = useTranslation()
  const locale = i18n.language.startsWith("zh") ? "zh-CN" : "en"
  const t = driveTranslator(locale)
  const { snapshot } = useDrive(drive)
  const pending = snapshot?.pendingDeletes ?? []
  const [dismissed, setDismissed] = useState<string[]>([])
  const identity = (entry: (typeof pending)[number]): string => `${entry.projectId}:${entry.count}`
  // A generation bump used to reopen a dialog the user had just dismissed. Only a genuinely new
  // batch — signaled by the pending list emptying in between — may surface again.
  useEffect(() => {
    if (pending.length === 0) setDismissed([])
  }, [pending.length])
  const remaining = pending.filter((entry) => !dismissed.includes(identity(entry)))
  const current = remaining[0]
  if (current === undefined) return null

  const close = (): void => {
    const key = identity(current)
    setDismissed((previous) => (previous.includes(key) ? previous : [...previous, key]))
  }
  const cancel = (): void => {
    const { projectId, count } = current
    close()
    void info(`[drive-delete] cancel project=${projectId} count=${count}`)
    void drive
      .request({ type: "cancelDeletes", projectId })
      .then(() => void info(`[drive-delete] cancel ok project=${projectId}`))
      .catch((error: unknown) => {
        void info(`[drive-delete] cancel failed project=${projectId} error=${String(error)}`)
        toast.error(
          i18n.language.startsWith("zh")
            ? "云端恢复仍在后台进行，请稍后在云盘状态里确认"
            : "Restore is still running in the background; check Drive status shortly."
        )
      })
  }
  const confirmDeletion = (): void => {
    const { projectId, count } = current
    close()
    void info(`[drive-delete] confirm project=${projectId} count=${count}`)
    void drive
      .request({ type: "confirmDeletes", projectId })
      .then(() => void info(`[drive-delete] confirm ok project=${projectId}`))
      .catch((error: unknown) => {
        void info(`[drive-delete] confirm failed project=${projectId} error=${String(error)}`)
        toast.error(
          i18n.language.startsWith("zh")
            ? "云端删除请求还没响应，已在后台继续，请稍后在云盘状态里确认结果"
            : "The cloud deletion is still running in the background; check Drive status shortly."
        )
      })
  }
  return (
    <Dialog open onOpenChange={(open) => { if (!open) cancel() }}>
      <DialogContent className={driveDialogClassName}>
        <DialogHeader>
          <DialogTitle>{t("massDelete.title", { count: current.count })}</DialogTitle>
          <DialogDescription>{t("massDelete.desc", { count: current.count, project: current.drivePath })}</DialogDescription>
        </DialogHeader>
        {remaining.length > 1 && (
          <p className="text-muted-foreground text-xs">
            {i18n.language.startsWith("zh")
              ? `还有 ${remaining.length - 1} 个项目待确认，关闭后会继续显示。`
              : `${remaining.length - 1} more projects are waiting for confirmation.`}
          </p>
        )}
        <div className="alwith-drive-actions">
          <Button type="button" variant="outline" onClick={cancel}>{t("massDelete.cancel")}</Button>
          <Button type="button" variant="destructive" onClick={confirmDeletion}>
            {t("massDelete.confirm")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
