// The create/edit-meeting dialog: the sidebar's one entry into starting a discussion.
//
// The form reads top-to-bottom in the order a decision is actually made (name → members → folder →
// direction → materials). It opens centered at min(880px, 100vw - 32px) with its height capped to
// 100vh - 32px, and behaves like a small window: drag the header to move (double-click resets),
// drag any edge or corner to resize. The box is clamped to the viewport on every move and on
// window resize, so it can never hang off-screen.
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
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react"
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

/**
 * One frame for every editable field. The old per-field borders were `border-border/70` on
 * `bg-background`, which is the same colour as the popover in both themes — the boxes vanished and
 * the form read as loose text (the reported "框体不对"). A full-strength border, a subtle shadow
 * and one focus ring give every control the same, visible frame.
 */
const FIELD_CLASS =
  // `block` + `border-box` keeps the field's border on the label's left edge; an inline-block
  // input with content-box sizing let the padding push the box outside the text column. The ring
  // is inset so focus never draws outside the field and fakes a wider box.
  "block w-full box-border appearance-none rounded-md border border-border bg-background px-2.5 shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/25"

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
  // Header drag / edge-and-corner resize: once used, the dialog is positioned and sized
  // explicitly. Inline styles win over the shared base classes deterministically — the base
  // `sm:max-w-md` capped the dialog at 448px and its translate utility did not survive composition.
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const dragOffset = useRef<{ x: number; y: number } | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  // Latest box for the window-resize clamp; the listener mounts once per open, not per move.
  const boxRef = useRef<{ position: { x: number; y: number } | null; size: { w: number; h: number } | null }>({
    position: null,
    size: null
  })
  boxRef.current = { position, size }

  // Re-open starts from the meeting's own values; a fresh dialog starts from a sensible roster so
  // the common case (brainstorm with everyone on the shelf) is one click, not N.
  useEffect(() => {
    if (!open) return
    setFailure(null)
    setCollision(null)
    setSubmitting(false)
    setPosition(null)
    setSize(null)
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
  // A pure-emoji / pure-punctuation name trims fine but slugifies to nothing, which would create a
  // folder with an empty name and degrade the path preview — so the slug, not the raw string, is
  // what must be non-empty for the submit to be legal.
  const nameHasSlug = slugOf(trimmedName) !== ""
  const canSubmit = !submitting && trimmedName !== "" && nameHasSlug && roles.length > 0

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

  /** Header drag: the dialog follows the pointer until release; position sticks for the session. */
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const rect = event.currentTarget.closest("[data-slot=dialog-content]")?.getBoundingClientRect()
    if (rect === undefined) return
    dragOffset.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    const move = (moveEvent: PointerEvent): void => {
      if (dragOffset.current === null) return
      // The dialog stays fully inside the window at all times — a partially off-screen box
      // reads as the clipping bug it once had, and is hard to grab back.
      const x = Math.min(
        Math.max(moveEvent.clientX - dragOffset.current.x, 8),
        Math.max(8, window.innerWidth - rect.width - 8)
      )
      const y = Math.min(
        Math.max(moveEvent.clientY - dragOffset.current.y, 8),
        Math.max(8, window.innerHeight - rect.height - 8)
      )
      setPosition({ x, y })
    }
    const up = (): void => {
      dragOffset.current = null
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  /** Native-window resize: every edge and corner drags the box. WebKit refuses CSS `resize`
   *  on an explicitly sized element, so the handles are real pointer handlers. Each axis is
   *  clamped so the whole dialog stays inside the window with an 8px margin. */
  const startResize =
    (edge: "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw") =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      const rect = event.currentTarget.closest("[data-slot=dialog-content]")?.getBoundingClientRect()
      if (rect === undefined) return
      const start = {
        x: event.clientX,
        y: event.clientY,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      }
      const move = (moveEvent: PointerEvent): void => {
        const dx = moveEvent.clientX - start.x
        const dy = moveEvent.clientY - start.y
        const minW = Math.min(560, Math.max(320, window.innerWidth - 16))
        const minH = Math.min(420, Math.max(260, window.innerHeight - 16))
        let { left, top, right, bottom } = start
        // Opposite edges stay anchored; a corner moves one horizontal and one vertical edge,
        // so each clamp below always reads the untouched opposite side.
        if (edge.includes("e")) right = Math.min(Math.max(start.right + dx, left + minW), window.innerWidth - 8)
        if (edge.includes("w")) left = Math.max(Math.min(start.left + dx, right - minW), 8)
        if (edge.includes("s")) bottom = Math.min(Math.max(start.bottom + dy, top + minH), window.innerHeight - 8)
        if (edge.includes("n")) top = Math.max(Math.min(start.top + dy, bottom - minH), 8)
        setPosition({ x: left, y: top })
        setSize({ w: right - left, h: bottom - top })
      }
      const up = (): void => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
    }

  // Shrinking the window must never leave the dialog hanging off-screen: re-clamp the explicit
  // box on every window resize. The centered default needs no help — vw/vh + margin:auto follow
  // the viewport on their own.
  useEffect(() => {
    if (!open) return
    const clampToWindow = (): void => {
      const box = boxRef.current
      if (box.position === null) return
      const popup = popupRef.current
      const w = Math.min(box.size?.w ?? popup?.offsetWidth ?? 420, Math.max(240, window.innerWidth - 16))
      const h = Math.min(box.size?.h ?? popup?.offsetHeight ?? 360, Math.max(200, window.innerHeight - 16))
      setPosition({
        x: Math.min(Math.max(box.position.x, 8), Math.max(8, window.innerWidth - w - 8)),
        y: Math.min(Math.max(box.position.y, 8), Math.max(8, window.innerHeight - h - 8))
      })
      if (box.size !== null) setSize({ w, h })
    }
    window.addEventListener("resize", clampToWindow)
    return () => window.removeEventListener("resize", clampToWindow)
  }, [open])

  const close = (): void => {
    if (submitting) return
    // Position and size are per-open only: a stale offset made the dialog reopen off-center.
    setPosition(null)
    setSize(null)
    onClose()
  }

  // The centered default is pure CSS (fixed + inset:0 + margin:auto): no measurement, no
  // timer, nothing to drift between dev and release builds. Inline styles outrank the shared
  // base Popup classes, which matter here: `relative` passed via className once overrode the
  // base `fixed` and parked the dialog off-screen; Tailwind v4's -translate-x/y-1/2 compile to
  // the `translate` property (not `transform`), so both are neutralized; maxWidth:none defeats
  // the base sm:max-w-md 448px cap. After a drag/resize we switch to explicit left/top.
  // Explicit geometry in both states. The old centered branch relied on `inset: 0; margin: auto`
  // while the shared popup still carried `start-1/2` / `-translate-*`; the two centering models
  // fought, which is how a dragged box ended up off-centre or past the window edge (the reported
  // "框体不对"). Setting left/top + translate directly is immune to those base classes, and the
  // 32px inset guarantees the frame — including the footer — always fits the window.
  const dialogStyle: React.CSSProperties = {
    position: "fixed",
    transform: "none",
    maxWidth: "none",
    ...(position === null
      ? {
          inset: "auto",
          left: "50%",
          top: "50%",
          translate: "-50% -50%",
          margin: 0,
          width: "min(880px, calc(100vw - 32px))",
          height: "fit-content",
          maxHeight: "calc(100vh - 32px)"
        }
      : {
          inset: "auto",
          left: position.x,
          top: position.y,
          translate: "none",
          margin: 0,
          width: size?.w ?? "min(880px, calc(100vw - 32px))",
          ...(size !== null
            ? { height: size.h, maxHeight: "none" }
            : { height: "fit-content", maxHeight: "calc(100vh - 32px)" })
        })
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
          : await commands.groupDirectoryCreate({
              name: trimmedName,
              parent: parentDirectory,
              // The starter group.md is what every member reads; the question and direction
              // typed here must land in it, not only in the saved config.
              topic: topic.trim() || null,
              focus: focus.trim() || null
            })
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
      // Creation is the start of the meeting, not a preview of it: the parent already enters the
      // new conversation, so the dialog must step out of the way instead of sitting on top of it
      // with a "已创建" confirmation. Edit mode closes for the same reason.
      onClose()
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => !value && close()}>
      <DialogContent ref={popupRef} style={dialogStyle} className="flex min-h-[min(420px,92vh)] overflow-hidden">
        <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4">
          <DialogHeader
            className="cursor-move select-none pe-10"
            title={t("groups.dialogHint")}
            onPointerDown={startDrag}
            onDoubleClick={() => {
              // Double-click the header: back to the centered default size and position.
              setPosition(null)
              setSize(null)
            }}
          >
            <DialogTitle>{editing ? t("groups.editTitle") : t("groups.createTitle")}</DialogTitle>
            <DialogDescription>{t("groups.createDesc")}</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto pe-1">
            <label className="block space-y-1">
              <span className="text-[11px] text-muted-foreground">{t("groups.createNameLabel")}</span>
              <input
                className={`h-9 text-sm ${FIELD_CLASS}`}
                value={name}
                placeholder={t("groups.createNamePlaceholder")}
                onChange={(event) => {
                  setName(event.target.value)
                  setCollision(null)
                }}
              />
              <span className="block text-[11px] text-muted-foreground">{t("groups.createNameHint")}</span>
              {/* Only while a name exists but leaves nothing after the slug filter (pure emoji or
                  punctuation): the empty field already has its own disabled submit + hint. */}
              {trimmedName !== "" && !nameHasSlug && (
                <span className="block text-[11px] text-destructive" data-name-slug-error>
                  {t("groups.createNameNoSlug")}
                </span>
              )}
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
                className={`min-h-[3.5rem] resize-y py-1.5 text-xs leading-relaxed ${FIELD_CLASS}`}
                placeholder={t("groups.fieldTopicPlaceholder")}
                value={topic}
                onChange={(event) => setTopic(event.target.value)}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-[11px] text-muted-foreground">{t("groups.createFocusLabel")}</span>
              <textarea
                className={`min-h-[5rem] resize-y py-1.5 text-xs leading-relaxed ${FIELD_CLASS}`}
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

          <DialogFooter className="shrink-0 border-t border-border/60 pt-4">
            <Button variant="outline" onClick={close} disabled={submitting}>
              {t("actions.cancel")}
            </Button>
            <Button onClick={submit} disabled={!canSubmit}>
              {submitting ? t("groups.createSubmitting") : editing ? t("groups.createSave") : t("groups.createSubmit")}
            </Button>
          </DialogFooter>
        </div>
        {/* Native-window resize affordances: every edge and corner is a live handle with the
            matching cursor, so resizing is discoverable by feel, not by hunting one grip. The
            bottom-right corner carries a visible diagonal mark. Handles sit above the form but
            inside the popup, so they never trigger the backdrop close. */}
        <div aria-hidden="true" onPointerDown={startResize("n")} className="absolute inset-x-4 top-0 z-20 h-2 cursor-ns-resize touch-none" />
        <div aria-hidden="true" onPointerDown={startResize("s")} className="absolute inset-x-4 bottom-0 z-20 h-2 cursor-ns-resize touch-none" />
        <div aria-hidden="true" onPointerDown={startResize("e")} className="absolute inset-y-4 end-0 z-20 w-2 cursor-ew-resize touch-none" />
        <div aria-hidden="true" onPointerDown={startResize("w")} className="absolute inset-y-4 start-0 z-20 w-2 cursor-ew-resize touch-none" />
        <div aria-hidden="true" onPointerDown={startResize("nw")} className="absolute start-0 top-0 z-20 size-4 cursor-nwse-resize touch-none" />
        <div aria-hidden="true" onPointerDown={startResize("ne")} className="absolute end-0 top-0 z-20 size-4 cursor-nesw-resize touch-none" />
        <div aria-hidden="true" onPointerDown={startResize("sw")} className="absolute bottom-0 start-0 z-20 size-4 cursor-nesw-resize touch-none" />
        <div
          aria-hidden="true"
          onPointerDown={startResize("se")}
          className="absolute end-0 bottom-0 z-20 size-5 cursor-nwse-resize touch-none"
          data-dialog-resize
        >
          <svg viewBox="0 0 10 10" className="absolute end-1 bottom-1 size-2.5 text-muted-foreground/60">
            <path d="M9 1 1 9M9 5 5 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
          </svg>
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
