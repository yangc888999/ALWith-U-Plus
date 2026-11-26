import type { Session } from "@alwith/api"
import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVerticalIcon, Loader2Icon, PauseIcon, PencilIcon, Trash2Icon, ZapIcon } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { client } from "@/lib/client"
import { describeError } from "@/lib/error-text"
import { cn } from "@/lib/utils"
import {
  clearQueuedPrompts,
  deleteQueuedPrompt,
  editQueuedPrompt,
  jumpQueuedPrompt,
  moveQueuedPrompt,
  type QueuedPromptItem,
  queuedPromptItems,
  queuedPromptRevision,
  subscribeQueuedPrompts
} from "@/lib/queued-prompt"

/** The simple waiting list in the composer's status area. */
export function QueuedPromptList({ session, embedded = false }: { session: Session; embedded?: boolean }): ReactNode {
  const { t } = useTranslation()
  const revision = useSyncExternalStore(
    subscribeQueuedPrompts,
    () => queuedPromptRevision(session.id),
    () => 0
  )
  const items = useMemo(() => queuedPromptItems(session.id), [revision, session.id])
  const busyRow = items.some((item) => item.jumping || item.dispatching)
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null)
  const [resuming, setResuming] = useState(false)
  const [clearArmed, setClearArmed] = useState(false)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  useEffect(() => {
    if (editing !== null && !items.some((item) => item.id === editing.id)) setEditing(null)
  }, [editing, items])

  const pausedItem = useMemo(() => items.find((item) => item.paused), [items])

  useEffect(() => {
    if (!clearArmed) return
    const timer = setTimeout(() => setClearArmed(false), 3_000)
    return () => clearTimeout(timer)
  }, [clearArmed])

  useEffect(() => {
    if (pausedItem === undefined && clearArmed) setClearArmed(false)
  }, [clearArmed, pausedItem])

  if (items.length === 0) return null

  const onDragEnd = (event: DragEndEvent): void => {
    const over = event.over
    if (over === null) return
    moveQueuedPrompt(session.id, String(event.active.id), String(over.id))
  }

  const saveEdit = (): void => {
    if (editing === null) return
    if (editQueuedPrompt(session.id, editing.id, editing.draft)) setEditing(null)
  }

  const resumeQueue = async (): Promise<void> => {
    setResuming(true)
    try {
      await client.resumeQueuedPromptQueue(session.id, session.cwd)
    } catch (error) {
      toast.error(describeError(error))
    } finally {
      setResuming(false)
    }
  }

  const clearQueue = (): void => {
    if (!clearArmed) {
      setClearArmed(true)
      return
    }
    setClearArmed(false)
    clearQueuedPrompts(session.id)
  }

  const pauseMessage =
    pausedItem?.pauseReason === "model-error"
      ? t("chat.queuePausedModel")
      : pausedItem?.pauseReason === "turn-error"
        ? t("chat.queuePausedTurnError")
        : pausedItem?.pauseReason === "steer-unknown"
          ? t("chat.queuePausedSteerUnknown")
          : t("chat.queuePausedStop")

  return (
    <div
      data-queued-prompt-list=""
      className={cn(
        "flex max-h-40 w-full flex-col gap-1 overflow-y-auto overscroll-contain",
        embedded ? "pb-0.5" : "mx-auto max-w-[var(--chat-column-width)] px-4 pb-1.5"
      )}
    >
      {pausedItem !== undefined && (
        <div
          role="status"
          data-queued-prompt-paused=""
          className="flex flex-col gap-1 rounded-lg border border-amber-500/25 bg-amber-500/8 px-2 py-1.5 text-[11px]"
        >
          <div className="flex items-start gap-1.5">
            <PauseIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-foreground/85">{t("chat.queuePaused")}</p>
              <p className="leading-4 text-foreground/70">{pauseMessage}</p>
              <p className="leading-4 text-foreground/65">{t("chat.queuePausedHint")}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                disabled={resuming || busyRow}
                className="rounded-md bg-foreground/8 px-1.5 py-1 font-medium text-foreground/85 hover:bg-foreground/12 disabled:opacity-50"
                onClick={() => void resumeQueue()}
              >
                {t("chat.queueResume")}
              </button>
              <button
                type="button"
                disabled={busyRow}
                className={cn(
                  "rounded-md px-1.5 py-1 text-foreground/75 hover:bg-destructive/10 hover:text-destructive",
                  clearArmed && "bg-destructive/10 text-destructive",
                  busyRow && "opacity-50"
                )}
                onClick={clearQueue}
              >
                {t(clearArmed ? "chat.queueClearConfirm" : "chat.queueClear")}
              </button>
            </div>
          </div>
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
        <div
          role="list"
          aria-live="polite"
          aria-label={t("chat.queuePendingCount", { count: items.length })}
          className="flex flex-col gap-1"
        >
          <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
            {items.map((item) => (
              <SortableQueuedPrompt
                key={item.id}
                item={item}
                sessionBusy={busyRow}
                editing={editing?.id === item.id ? editing.draft : null}
                onDraftChange={(draft) => setEditing({ id: item.id, draft })}
                onStartEdit={() => setEditing({ id: item.id, draft: item.body })}
                onCancelEdit={() => setEditing(null)}
                onSaveEdit={saveEdit}
                onDelete={() => deleteQueuedPrompt(session.id, item.id)}
                onJump={() => {
                  void jumpQueuedPrompt(session.id, item.id).catch((error: unknown) => {
                    toast.error(describeError(error))
                  })
                }}
              />
            ))}
          </SortableContext>
        </div>
      </DndContext>
    </div>
  )
}

function QueuedPromptThumb({ item }: { item: QueuedPromptItem }): ReactNode {
  if (item.image === null) return null
  return (
    <span
      data-queued-prompt-image=""
      className="relative size-8 shrink-0 overflow-hidden rounded-md border border-border/60 bg-muted/40"
    >
      <img src={item.image} alt="" className="size-full object-cover" draggable={false} />
      {item.imageCount > 1 && (
        <span className="absolute end-0 bottom-0 rounded-ss bg-background/90 px-1 text-[9px] leading-3 text-foreground/80 tabular-nums">
          +{item.imageCount - 1}
        </span>
      )}
    </span>
  )
}

function SortableQueuedPrompt({
  item,
  sessionBusy,
  editing,
  onDraftChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  onJump
}: {
  item: QueuedPromptItem
  sessionBusy: boolean
  editing: string | null
  onDraftChange: (draft: string) => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: () => void
  onDelete: () => void
  onJump: () => void
}): ReactNode {
  const { t } = useTranslation()
  const rowBusy = item.jumping || item.dispatching
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: rowBusy
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  }
  const label = item.text ?? t("chat.queueAttachmentOnly")
  const editDisabled = editing === "" && item.imageCount === 0

  return (
    <div
      ref={setNodeRef}
      style={style}
      role="listitem"
      data-queued-prompt-id={item.id}
      data-queued-prompt-editing={editing === null ? undefined : ""}
      title={editing === null ? t("chat.queueRowHint") : undefined}
      className={cn(
        "group flex min-h-8 items-center gap-0.5 rounded-xl border border-border/60 bg-muted/40 px-1 py-1 shadow-sm backdrop-blur-sm transition-colors hover:bg-muted/55",
        editing !== null && "items-start gap-1 p-1.5",
        isDragging && "z-10 opacity-75 shadow-md"
      )}
    >
      {editing === null ? (
        <>
          <button
            ref={setActivatorNodeRef}
            type="button"
            aria-label={t("chat.queueDrag")}
            className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground/55 hover:bg-foreground/8 hover:text-foreground active:cursor-grabbing"
            disabled={rowBusy}
            {...(rowBusy ? {} : attributes)}
            {...(rowBusy ? {} : listeners)}
          >
            <GripVerticalIcon className="size-3.5" aria-hidden="true" />
          </button>
          <QueuedPromptThumb item={item} />
          <span className="min-w-0 flex-1 truncate px-0.5 text-xs text-foreground/85">{label}</span>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              aria-label={t("chat.queueJump")}
              title={item.paused ? t("chat.queuePaused") : t("chat.queueJumpHint")}
              disabled={rowBusy || item.paused || sessionBusy}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-primary/80 hover:bg-primary/10 hover:text-primary disabled:opacity-50"
              onClick={onJump}
            >
              {rowBusy ? (
                <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <ZapIcon className="size-3.5" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              aria-label={t("chat.queueEdit")}
              title={t("chat.queueEditHint")}
              disabled={rowBusy}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/65 hover:bg-foreground/8 hover:text-foreground disabled:opacity-50"
              onClick={onStartEdit}
            >
              <PencilIcon className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={t("chat.queueDelete")}
              title={t("chat.queueDeleteHint")}
              disabled={rowBusy}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/65 hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
              onClick={onDelete}
            >
              <Trash2Icon className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        </>
      ) : (
        <>
          <QueuedPromptThumb item={item} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <textarea
              aria-label={t("chat.queueEdit")}
              value={editing}
              rows={2}
              className="min-h-12 w-full resize-none rounded-md border-0 bg-muted/35 px-2 py-1 text-xs leading-5 outline-none focus-visible:bg-background/45"
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault()
                  onCancelEdit()
                  return
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  if (!editDisabled) onSaveEdit()
                }
              }}
              autoFocus
            />
            <div className="flex justify-end gap-1">
              <button
                type="button"
                className="rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
                onClick={onCancelEdit}
              >
                {t("chat.queueEditCancel")}
              </button>
              <button
                type="button"
                disabled={editDisabled}
                className="rounded-md bg-primary px-1.5 py-1 text-[11px] text-primary-foreground disabled:opacity-50"
                onClick={onSaveEdit}
              >
                {t("chat.queueEditSave")}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
