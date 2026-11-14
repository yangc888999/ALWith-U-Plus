// The create/edit-meeting dialog: the sidebar's one entry into starting a discussion.
//
// The form reads top-to-bottom in the order a decision is actually made (name → members → folder →
// direction → materials). It opens at 640px and is resizable in both axes (drag the bottom-right
// corner) — the direction text and the material list both grow, and a fixed 460px box made long
// directions scroll inside a 3-line textarea.
//
// Folder flow (v2): the picked folder is the PARENT. The meeting always lands in
// `<parent>/<会议名>` — name first, pick the parent second, and the preview line shows the exact
// target path before anything is created. The old "attach" flow put group.md straight into the
// picked folder, which is how a meeting ended up living in `groups/` itself.
//
// Submitting runs the three steps in order — create the folder, store the GroupConfig, enter the
// conversation — and shows which step failed on the dialog itself rather than only in a toast, so
// a retry lands on the thing that actually broke.

import { CircleAlertIcon, FolderIcon, FolderPlusIcon, PlusIcon, XIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { commands } from "@/bindings"
import { groupRoles } from "@/lib/group-roles"
import { groups as listGroups, newGroupId, setGroup, type GroupConfig } from "@/lib/groups"
import { groupPreferences } from "@/lib/group-preferences"
import { basename } from "@/lib/path"
import { openSettingsWindow } from "@/lib/window-manager"

import { RosterEditor } from "./roster-editor"

type MaterialState = { path: string; status: "checking" | "ok" | "empty" | "missing" }

/** Mirrors Rust `slug_of`: alphanumerics (CJK included) survive, everything else is one dash. */
function slugOf(name: string): string {
  return name
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

/**
 * A name whose slug matches an existing meeting's folder — not an error, just worth confirming.
 *
 * `group_directory_create` reuses the folder when the slug collides, so the honest warning is
 * "this joins the existing meeting", asked once before submit; silently filing a second meeting
 * into someone else's folder is the outcome the user must not discover afterwards.
 */
function collidesWithExisting(name: string): GroupConfig | null {
  const wanted = normalize(slugOf(name.trim()))
  if (wanted === "") return null
  return listGroups().find((entry) => entry.directory !== "" && normalize(basename(entry.directory)) === wanted) ?? null
}

function normalize(pathOrName: string): string {
  return pathOrName
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase()
}

export function CreateMeetingDialog({
  open,
  group,
  onClose,
  onCreated
}: {
  open: boolean
  /** Present = edit mode (roster/direction/materials of an existing meeting). */
  group: GroupConfig | null
  onClose: () => void
  /** Called with the stored config and the directory to open. */
  onCreated: (created: GroupConfig, directory: string) => void
}) {
  const { t } = useTranslation()
  const editing = group !== null
  const [name, setName] = useState("")
  const [roles, setRoles] = useState<string[]>([])
  const [topic, setTopic] = useState("")
  const [autoDiscuss, setAutoDiscuss] = useState(true)
  const [focus, setFocus] = useState("")
  const [materialFolders, setMaterialFolders] = useState<MaterialState[]>([])
  const [parentDirectory, setParentDirectory] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [collision, setCollision] = useState<GroupConfig | null>(null)

  // Re-open starts from the meeting's own values; a fresh dialog starts from a sensible roster so
  // the common case (brainstorm with everyone on the shelf) is one click, not N.
  useEffect(() => {
    if (!open) return
    setFailure(null)
    setCollision(null)
    setSubmitting(false)
    if (group !== null) {
      setName(group.name)
      setRoles(group.roles)
      setTopic(group.topic)
      setAutoDiscuss(group.autoDiscuss)
      setFocus(group.focus)
      setMaterialFolders(group.materialFolders.map((path) => ({ path, status: "checking" as const })))
      setParentDirectory(null)
      return
    }
    setName("")
    setRoles(groupRoles().slice(0, 3).map((role) => role.id))
    setTopic("")
    setAutoDiscuss(true)
    setFocus("")
    setMaterialFolders([])
    setParentDirectory(null)
  }, [open, group])

  // Validate each material folder as it appears. The check doubles as the existence test the design
  // asks for: a folder the index command cannot enumerate is shown as missing, with a retry.
  useEffect(() => {
    for (const entry of materialFolders) {
      if (entry.status !== "checking") continue
      void commands
        .groupMaterialIndex({ path: entry.path })
        .then((section) => patchMaterial(entry.path, { status: section.markdown.includes("没有可读的文本文件") ? "empty" : "ok" }))
        .catch(() => patchMaterial(entry.path, { status: "missing" }))
    }
    // The loop only fires for entries still marked checking; patching clears that mark.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [materialFolders])

  const patchMaterial = (path: string, patch: Partial<MaterialState>): void => {
    setMaterialFolders((previous) => previous.map((entry) => (entry.path === path ? { ...entry, ...patch } : entry)))
  }

  // The role shelf is read when the dialog opens; it cannot change while a modal is up.
  const knownRoles = useMemo(() => groupRoles(), [open])
  const trimmedName = name.trim()
  const canSubmit = !submitting && trimmedName !== "" && roles.length > 0

  // The exact folder the meeting will live in, shown before anything is created. Editing keeps the
  // meeting where it is; a fresh one lands in <parent>/<slug>, parent defaulting to groups/.
  const targetPreview =
    editing && group.directory !== ""
      ? group.directory
      : trimmedName === ""
        ? null
        : `${(parentDirectory ?? "~/Documents/ALWith/groups").replace(/\/+$/, "")}/${slugOf(trimmedName)}`

  const addFolder = (): void => {
    void commands
      .pickGroupDirectory()
      .then((picked) => {
        if (picked === null || picked === "") return
        setMaterialFolders((previous) =>
          previous.some((entry) => normalize(entry.path) === normalize(picked))
            ? previous
            : [...previous, { path: picked, status: "checking" }]
        )
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
  }

  const pickParent = (): void => {
    void commands
      .pickGroupDirectory()
      .then((picked) => {
        if (picked !== null && picked !== "") setParentDirectory(picked.replace(/\/+$/, ""))
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
  }

  const submit = (): void => {
    if (!canSubmit) return
    // A name that slugifies onto an existing meeting's folder reuses that folder — say so first.
    if (collision === null && !editing) {
      const clash = collidesWithExisting(trimmedName)
      if (clash !== null) {
        setCollision(clash)
        return
      }
    }
    void run()
  }

  const run = async (): Promise<void> => {
    setSubmitting(true)
    setFailure(null)
    const nextFolders = materialFolders.filter((entry) => entry.status === "ok" || entry.status === "empty").map((entry) => entry.path)
    try {
      const created =
        group !== null && group.directory !== ""
          ? { directory: group.directory, document: group.document }
          : await commands.groupDirectoryCreate({ name: trimmedName, parent: parentDirectory })
      const record: GroupConfig = {
        id: group?.id ?? newGroupId(),
        name: trimmedName,
        roles,
        rounds: group?.rounds ?? groupPreferences().rounds,
        directory: created.directory,
        document: created.document,
        topic: topic.trim(),
        focus: focus.trim(),
        materialFolders: nextFolders,
        sessionId: group?.sessionId ?? null,
        autoDiscuss
      }
      setGroup(record)
      onCreated(record, created.directory)
      onClose()
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  const close = (): void => {
    if (submitting) return
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(value) => !value && close()}>
      <DialogContent className="flex max-h-[85vh] w-[640px] min-h-[420px] min-w-[480px] max-w-[92vw] resize overflow-auto sm:max-w-[92vw]">
        <div className="flex min-h-0 w-full flex-1 flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{editing ? t("groups.editTitle") : t("groups.createTitle")}</DialogTitle>
            <DialogDescription>{t("groups.createDesc")}</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pe-1">
            <label className="block space-y-1">
              <span className="text-[11px] text-muted-foreground">{t("groups.createNameLabel")}</span>
              <input
                className="h-8 w-full rounded-md border border-border/70 bg-background px-2 text-sm"
                value={name}
                placeholder={t("groups.createNamePlaceholder")}
                onChange={(event) => {
                  setName(event.target.value)
                  setCollision(null)
                }}
              />
              <span className="block text-[11px] text-muted-foreground">{t("groups.createNameHint")}</span>
            </label>

            <div className="space-y-1">
              <span className="text-[11px] text-muted-foreground">{t("groups.createRosterLabel")}</span>
              {knownRoles.length === 0 ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
                  <span className="text-[11px] text-muted-foreground">{t("groups.createNoRoles")}</span>
                  <Button variant="outline" size="sm" onClick={() => void openSettingsWindow("groups")}>
                    {t("groups.createGoRoles")}
                  </Button>
                </div>
              ) : (
                <RosterEditor
                  roles={knownRoles}
                  selected={roles}
                  onToggle={(id) =>
                    setRoles((previous) => (previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]))
                  }
                  onReorder={setRoles}
                />
              )}
            </div>

            {/* The meeting folder: parent picked here, subfolder named after the meeting. The
                preview is the contract — what it shows is exactly what gets created. */}
            {!editing && (
              <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/15 px-2.5 py-2">
                <span className="text-[11px] text-muted-foreground">{t("groups.createFolderLabel")}</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button variant="outline" size="sm" onClick={pickParent}>
                    <FolderPlusIcon className="size-3.5" aria-hidden="true" />
                    {t("groups.createPickParent")}
                  </Button>
                  {parentDirectory !== null && (
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground underline"
                      onClick={() => setParentDirectory(null)}
                    >
                      {t("groups.createUseAuto")}
                    </button>
                  )}
                </div>
                <p className="break-all text-[11px] leading-relaxed text-muted-foreground" data-meeting-target>
                  {targetPreview === null
                    ? t("groups.createFolderPending")
                    : `${t("groups.createFolderTarget")}：${targetPreview}`}
                </p>
              </div>
            )}

            {/* The topic is the one question this discussion answers; it used to live only in the
                settings page's duplicate meeting list, which is gone — the dialog owns it now. */}
            <label className="block space-y-1">
              <span className="text-[11px] text-muted-foreground">{t("groups.fieldTopic")}</span>
              <textarea
                className="min-h-[3.5rem] w-full resize-y rounded-md border border-border/70 bg-background px-2 py-1.5 text-xs leading-relaxed"
                placeholder={t("groups.fieldTopicPlaceholder")}
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] text-muted-foreground">{t("groups.createFocusLabel")}</span>
              <textarea
                className="min-h-[5rem] w-full resize-y rounded-md border border-border/70 bg-background px-2 py-1.5 text-xs leading-relaxed"
                placeholder={t("groups.createFocusPlaceholder")}
                value={focus}
                onChange={(event) => setFocus(event.target.value)}
              />
            </label>

            <div className="space-y-1.5">
              <span className="text-[11px] text-muted-foreground">{t("groups.createMaterialsLabel")}</span>
              {materialFolders.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">{t("groups.createMaterialsEmpty")}</p>
              ) : (
                <ul className="space-y-1">
                  {materialFolders.map((entry) => (
                    <li
                      key={entry.path}
                      className={
                        "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs " +
                        (entry.status === "missing"
                          ? "border-destructive/50 bg-destructive/5 text-destructive"
                          : entry.status === "empty"
                            ? "border-amber-500/40 bg-amber-500/5"
                            : "border-border/60 bg-muted/20")
                      }
                      title={entry.path}
                    >
                      <FolderIcon className="size-3 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{folderLabel(entry.path)}</span>
                      {entry.status === "checking" && <span className="text-[10px] text-muted-foreground">{t("groups.createMaterialChecking")}</span>}
                      {entry.status === "empty" && <span className="text-[10px] text-amber-700 dark:text-amber-300">{t("groups.createMaterialEmpty")}</span>}
                      {entry.status === "missing" && (
                        <button
                          type="button"
                          className="text-[10px] underline"
                          onClick={() => patchMaterial(entry.path, { status: "checking" })}
                        >
                          {t("groups.createMaterialRetry")}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={t("groups.createMaterialRemove")}
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setMaterialFolders((previous) => previous.filter((item) => item.path !== entry.path))}
                      >
                        <XIcon className="size-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="sm" onClick={addFolder}>
                  <PlusIcon className="size-3.5" />
                  {t("groups.createAddFolder")}
                </Button>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{t("groups.createMaterialsHint")}</p>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                aria-label={t("groups.groupAutoDiscuss")}
                checked={autoDiscuss}
                onCheckedChange={setAutoDiscuss}
              />
              <span className="text-[11px] text-muted-foreground">{t("groups.groupAutoDiscuss")}</span>
            </div>

            {collision !== null && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed">
                <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
                <span className="min-w-0 flex-1">{t("groups.createCollision", { name: collision.name })}</span>
                <Button variant="outline" size="sm" onClick={() => void run()}>
                  {t("groups.createCollisionConfirm")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setCollision(null)}>
                  {t("actions.cancel")}
                </Button>
              </div>
            )}

            {failure !== null && (
              <p className="rounded-md border border-destructive/50 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive">
                {failure}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={submitting}>
              {t("actions.cancel")}
            </Button>
            <Button onClick={submit} disabled={!canSubmit}>
              {submitting ? t("groups.createSubmitting") : editing ? t("groups.createSave") : t("groups.createSubmit")}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** The last path segment, for a chip label; the full path stays on hover. */
function folderLabel(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/")
  return parts[parts.length - 1] ?? path
}
