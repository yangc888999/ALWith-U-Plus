import { logBackgroundError } from "@/lib/background-errors"

import { drive, driveTransport } from "./controller"

export { drive } from "./controller"

import { CONTRACT_VERSION, type FailedUpload, type RootInfo } from "@alwith/module-drive"
import {
  type DriveHost,
  DriveMassDeleteDialog,
  DrivePanel,
  DriveSharing,
  driveTranslator,
  summarize,
  useDrive,
  useDriveSelector
} from "@alwith/module-drive/react"
import "@alwith/module-drive/styles.css"
import { type CondenseScope, DriveCondense } from "@alwith/module-drive/content"
import { containsPath } from "@alwith/module-fs"
import { isTauri } from "@tauri-apps/api/core"
import { confirm, open } from "@tauri-apps/plugin-dialog"
import { CloudIcon, MessageSquareIcon } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import type { SessionSummary } from "@/agent/client"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ProjectSessionPopover } from "@/features/chat/project-session-popover"
import { useSessionsUiStore } from "@/features/sessions/store"
import { useWorkspace } from "@/features/workspace/context"
import { openExternal, revealInFileManager } from "@/lib/open"
import { openSettingsWindow } from "@/lib/window-manager"

import { driveControls, driveDialogClassName } from "./controls"
import { driveFileSystem, drivePathExists } from "./filesystem"
import { DriveIntegrations } from "./integrations"
import { saveDrivePins, useDrivePins } from "./pinned"
import { useDriveVisible } from "./use-drive-visible"

export function useDriveConnection(start = true): void {
  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    void (async () => {
      // 先问一次快照，用契约版本给这次启动定性，再决定要不要 start。
      //
      // 旧顺序是 `attach()` 之后读 `getSnapshot().configured`：attach 会先订阅事件流，而
      // start / refreshClientConfig 会推进 generation —— 消费者因此可能挂在上一代快照上，
      // 首帧显示「未配置」，随后被一次推送改回来。先校验再启动，订阅只发生在定稿之后。
      if (start) {
        try {
          const response = await driveTransport.request({ type: "snapshot" })
          if (disposed) return
          if (response.type !== "snapshot" || response.data.version !== CONTRACT_VERSION)
            throw new Error("Incompatible Drive contract")
          if (response.data.configured) {
            await driveTransport.request({ type: "start" })
            if (disposed) return
            await driveTransport.request({ type: "refreshClientConfig" })
          }
        } catch (error) {
          if (!disposed) logBackgroundError("drive-startup", error)
        }
      }
      // 启动失败也要 attach：否则云盘状态面板连错误都显示不出来，只剩一个空壳。
      if (!disposed) await drive.attach()
    })().catch((error: unknown) => {
      if (!disposed) logBackgroundError("drive-startup", error)
    })
    return () => {
      disposed = true
      drive.dispose()
    }
  }, [start])
}

export function DrivePage({
  onOpenProject,
  currentProject,
  currentSessionId,
  onSelectSession
}: {
  currentProject?: string | null
  currentSessionId?: string | null
  onSelectSession: (session: SessionSummary) => void
  onOpenProject: (root: RootInfo) => Promise<void>
}): ReactNode {
  const workspace = useWorkspace()
  // 本应用的会话 store（module-chat 0.5.x）没有 driveSearchOpen：搜索面板由侧栏自己的
  // 状态驱动，这里恒为 false，云盘侧栏就不会去抢搜索的展开态。
  const searchVisible = false
  void useSessionsUiStore
  const { i18n } = useTranslation()
  const locale = i18n.language.startsWith("zh") ? "zh-CN" : "en"
  const profile = useDriveSelector(drive, ({ snapshot }) => `${snapshot?.baseUrl ?? ""}|${snapshot?.localRoot ?? ""}`)
  const pins = useDrivePins(profile)
  const [condense, setCondense] = useState<CondenseScope | null>(null)
  const openProject = async (root: RootInfo): Promise<void> => {
    if (!workspace) throw new Error("Drive requires a workspace host")
    await onOpenProject(root)
    await workspace.openProject(root.localPath)
  }
  const host: DriveHost = {
    searchShortcut: false,
    searchVisible,
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
    onRevealPath: (path) => revealInFileManager(path),
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
    },
    renderProjectActions: (root) => (
      <span onClick={(event) => event.stopPropagation()}>
        <ProjectSessionPopover
          cwd={root.localPath}
          currentSessionId={currentSessionId}
          onSelect={onSelectSession}
          onNewChat={() => void openProject(root).catch((error: unknown) => toast.error(String(error)))}
          trigger={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={locale === "zh-CN" ? "最近会话" : "Recent conversations"}
            >
              <MessageSquareIcon />
            </Button>
          }
        />
      </span>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <DrivePanel
        controller={drive}
        mode="launcher"
        currentProject={currentProject ?? undefined}
        locale={locale}
        host={host}
        controls={driveControls}
        onOpenSettings={openDriveSettings}
        onOpenProject={openProject}
        confirm={(message) => confirm(message, { title: "YUP Drive", kind: "warning" })}
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
              onRevealPath: revealInFileManager,
              onOpenExternal: openExternal,
              pinnedDocs: [],
              onPinnedDocsChange: () => {
                return Promise.try(() => {
                  throw new Error("Pins are unavailable in this permissions dialog")
                })
              }
            }}
            controls={driveControls}
            confirm={(message) => confirm(message, { title: "Drive sharing", kind: "warning" })}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function openDriveSettings(): void {
  void openSettingsWindow("drive").catch((error: unknown) => toast.error(String(error)))
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
      onRevealPath: (path) => revealInFileManager(path),
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
  const { connected, snapshot, error: connectionError } = useDrive(drive)
  const [failures, setFailures] = useState<FailedUpload[]>([])
  const [failuresReady, setFailuresReady] = useState(false)
  useEffect(() => {
    let active = true
    if (!connected || !snapshot?.running || !snapshot.status?.failed) {
      setFailures([])
      setFailuresReady(true)
      return
    }
    setFailuresReady(false)
    void drive
      .request({ type: "failedUploads" })
      .then(async (response) => {
        if (response.type !== "failedUploads") throw new Error("Invalid Drive failed transfer response")
        // A failed upload can outlive the local file (the file was deleted, moved, or replaced).
        // Those records retry forever inside Drive and otherwise leave a permanent "1 not uploaded"
        // badge over unrelated work. Keep only failures that still have a local subject.
        const current = await Promise.all(
          response.data.map(async (failure) => {
            try {
              return (await drivePathExists(failure.localPath)) ? failure : null
            } catch {
              return failure
            }
          })
        )
        if (!active) return
        setFailures(current.filter((failure): failure is FailedUpload => failure !== null))
        setFailuresReady(true)
      })
      .catch((error: unknown) => {
        if (active) {
          setFailuresReady(true)
          logBackgroundError("drive-status", error)
        }
      })
    return () => {
      active = false
    }
  }, [connected, snapshot?.generation, snapshot?.running, snapshot?.status?.failed, snapshot?.status?.lastSyncAt])
  if (!visible || !snapshot?.configured) return null
  const summaryStatus =
    snapshot.status === null || !failuresReady ? snapshot.status : { ...snapshot.status, failed: failures.length }
  const summary = summarize(summaryStatus, failuresReady ? failures : undefined)
  const summaryKey = connectionError || snapshot.error ? "drive.summary.error" : summary.key
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="pointer-events-auto h-6 text-xs" aria-label={t("title")}>
            <CloudIcon />
            {t(summaryKey, { count: summary.count })}
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
            onRevealPath: (path) => revealInFileManager(path),
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
          confirm={(message) => confirm(message, { title: "YUP Drive", kind: "warning" })}
        />
      </PopoverContent>
    </Popover>
  )
}

export function DriveDeleteConfirmation(): ReactNode {
  const { i18n } = useTranslation()
  return (
    <DriveMassDeleteDialog
      controller={drive}
      controls={driveControls}
      locale={i18n.language.startsWith("zh") ? "zh-CN" : "en"}
    />
  )
}
