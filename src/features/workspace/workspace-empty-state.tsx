/**
 * What the file column shows when there is no workspace to display.
 *
 * Previously every "no directory" branch in `FileWorkspace` was a bare `return`: clicking 文件栏
 * with no project did nothing at all, which read as a dead button. Each state here explains itself
 * and offers a button that actually changes something — pick a folder, heal a Groups-root record,
 * or re-open the column — so a click always has a visible effect. The `invalid` state always keeps
 * two ways out: the one-click heal AND a manual folder picker, because a heal that finds no named
 * subfolder must not leave the reader with no next step.
 */
import { FolderOpen, RefreshCw, Wrench } from "lucide-react"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { commands } from "@/bindings"
import { Button } from "@/components/ui/button"
import { describeError } from "@/lib/error-text"
import { groupByDirectory } from "@/lib/groups"
import { basename } from "@/lib/path"

import {
  bindProjectDirectory,
  DRAFT_DIRECTORY_KEY,
  isGroupsRoot,
  type WorkspaceEmptyReason
} from "./project-directory"

export function WorkspaceEmptyState({
  reason,
  directory = null,
  groupId = null,
  bindingKey = DRAFT_DIRECTORY_KEY,
  guidance = null,
  onRetry
}: {
  reason: WorkspaceEmptyReason
  /** The directory that could not be opened (the Groups root for `invalid`). */
  directory?: string | null
  groupId?: string | null
  /** Conversation (or `__draft__`) whose binding a repair must update. */
  bindingKey?: string
  guidance?: string | null
  /** Re-opens the file column so the new binding is loaded. */
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [fixed, setFixed] = useState(false)

  /**
   * Applies a picked folder. The Groups root is not a usable project: it would list every meeting
   * at once. Binding it as `invalid` switches the surface to the repair state (see ①: the raw
   * attempt now publishes a snapshot), and the reader gets the reason instead of a false success.
   */
  const applyPicked = (picked: string | null): void => {
    if (picked === null) {
      // Cancelled: leave the binding and the empty state exactly as they were.
      toast.info(t("workspace.noFolderPicked"))
      return
    }
    if (picked.trim() === "" || isGroupsRoot(picked)) {
      bindProjectDirectory(bindingKey, picked, groupId)
      toast.error(t("workspace.groupsRootPicked"))
      onRetry?.()
      return
    }
    const pickedGroup = groupByDirectory(picked)
    bindProjectDirectory(bindingKey, picked, pickedGroup?.id ?? groupId)
    toast.success(t("workspace.folderBound"))
    onRetry?.()
  }

  /** `missing` / `temporary`: any project folder will do. */
  const pickFolder = async (): Promise<void> => {
    setBusy(true)
    try {
      applyPicked(await commands.pickProjectDirectory())
    } catch (error) {
      toast.error(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  /** `invalid`: the meeting's own folder picker is the way out when heal cannot find a subfolder. */
  const pickMeetingFolder = async (): Promise<void> => {
    setBusy(true)
    try {
      applyPicked(await commands.pickGroupDirectory())
    } catch (error) {
      toast.error(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  const healDirectory = async (): Promise<void> => {
    if (directory === null || directory.trim() === "") {
      // A rejected binding can carry no usable path; still say something instead of doing nothing.
      toast.info(t("workspace.noDirectory"))
      onRetry?.()
      return
    }
    setBusy(true)
    try {
      const group = groupByDirectory(directory)
      const name = group?.name ?? basename(directory)
      const healed = await commands.groupDirectoryHeal({ name, directory })
      if (healed === null) {
        // `group_directory_heal` returns None when `<parent>/<slug(name)>` is not a directory.
        // Say that, and point at the manual picker that is always available in this state.
        toast.info(t("groups.noMeetingSession"))
        return
      }
      bindProjectDirectory(bindingKey, healed.directory, group?.id ?? groupId)
      setFixed(true)
      toast.success(t("groups.directoryHealed"))
      onRetry?.()
    } catch (error) {
      toast.error(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  const retry = (): void => {
    toast.info(t("workspace.retryOpen"))
    onRetry?.()
  }

  const title =
    reason === "invalid"
      ? t("workspace.invalidDirectory")
      : reason === "temporary"
        ? t("workspace.temporaryNoFiles")
        : t("workspace.noDirectory")
  const hint =
    reason === "invalid"
      ? t("workspace.invalidDirectoryHint")
      : reason === "temporary"
        ? t("workspace.selectFileHint")
        : t("workspace.noDirectoryHint")

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col items-center justify-center gap-3 px-6 py-8 text-center"
      data-testid="workspace-empty-state"
      data-workspace-empty-reason={reason}
      aria-busy={busy}
    >
      <FolderOpen className="size-7 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="text-sm font-medium">{title}</div>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        {fixed ? t("workspace.directoryFixedHint") : guidance ?? hint}
      </p>
      {reason === "invalid" ? (
        <>
          <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => void healDirectory()}>
            <Wrench className="size-3.5" aria-hidden="true" />
            {t("workspace.fixDirectory")}
          </Button>
          {/* The heal is not guaranteed: it needs `<parent>/<slug(name)>` to already exist. Keep a
              manual way out so a failed repair never becomes a dead end. */}
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={busy}
            onClick={() => void pickMeetingFolder()}
          >
            <FolderOpen className="size-3.5" aria-hidden="true" />
            {t("workspace.selectFileHint")}
          </Button>
        </>
      ) : (
        <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={() => void pickFolder()}>
          <FolderOpen className="size-3.5" aria-hidden="true" />
          {t("workspace.selectFileHint")}
        </Button>
      )}
      <Button size="sm" variant="ghost" className="gap-1.5" disabled={busy} onClick={retry}>
        <RefreshCw className="size-3.5" aria-hidden="true" />
        {t("workspace.retryOpen")}
      </Button>
    </div>
  )
}
