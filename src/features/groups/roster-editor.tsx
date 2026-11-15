// The roster editor, shared by 设置 → 拉会 and the sidebar's create-meeting dialog.
//
// It was lifted out of the settings section verbatim (0.3.8) so the two entry points cannot drift
// apart: the same chips, the same drag-to-reorder semantics, the same "last member summarizes"
// badge, in both places.

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
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  SortableContext,
  useSortable
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { CheckIcon, GripVerticalIcon, UserIcon, XIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import type { GroupRole } from "@/lib/group-roles"

/**
 * The roster editor: the chosen speakers as a drag-to-reorder row (earlier = speaks first), with
 * the still-unselected bots below as plain add-pills. Only the grip handle starts a drag, so tapping
 * the pill body still toggles it out and the × removes it without a mis-fire.
 */
export function RosterEditor({
  roles,
  selected,
  onToggle,
  onReorder
}: {
  roles: GroupRole[]
  selected: string[]
  onToggle: (id: string) => void
  onReorder: (next: string[]) => void
}) {
  const { t } = useTranslation()
  // A group can still name roles that were deleted since (retired bundled personas, for example).
  // `find` returns undefined for those, so the guard must drop undefined, not just null — the old
  // code iterated the role list and never looked up a dangling id.
  const selectedRoles = selected
    .map((id) => roles.find((role) => role.id === id))
    .filter((role): role is GroupRole => role !== undefined)
  const available = roles.filter((role) => !selected.includes(role.id))
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const onDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (over === null || active.id === over.id) return
    const from = selected.indexOf(String(active.id))
    const to = selected.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    const next = [...selected]
    const [moved] = next.splice(from, 1)
    if (moved === undefined) return
    next.splice(to, 0, moved)
    onReorder(next)
  }
  return (
    <div className="space-y-2" role="group" aria-label={t("groups.rolesTitle")}>
      {/* The host is always you: the topic you type opens the discussion, right-aligned like any
          user bubble. It is shown here so the roster reads as "you + the speakers", never as if a
          bot were chairing the meeting. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 text-xs text-muted-foreground"
          title={t("groups.hostHint")}
        >
          <UserIcon className="size-3" aria-hidden="true" />
          <span className="max-w-[10rem] truncate">{t("groups.hostLabel")}</span>
        </span>
      </div>
      {selectedRoles.length === 0 ? (
        <p className="rounded-md border border-border/50 bg-muted/20 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
          {t("groups.noMembersYet")}
        </p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
          {/* The chips wrap onto several rows (`flex flex-wrap`), so the sortable strategy must be
              rect-based: verticalListSortingStrategy assumes one column and computes drop points
              that land on the wrong chip once the list folds. */}
          <SortableContext items={selected} strategy={rectSortingStrategy}>
            <div className="flex flex-wrap items-center gap-1.5">
              {selectedRoles.map((role, index) => (
                <SortableRosterPill
                  key={role.id}
                  id={role.id}
                  name={role.name}
                  title={role.title ?? ""}
                  order={index + 1}
                  summarizer={index === selectedRoles.length - 1}
                  onRemove={() => onToggle(role.id)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
      {available.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {available.map((role) => (
            <button
              key={role.id}
              type="button"
              aria-pressed={false}
              title={role.name}
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border/60 bg-muted/25 px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted/55"
              onClick={() => onToggle(role.id)}
            >
              <span className="size-3 shrink-0 rounded-full border border-muted-foreground/50" aria-hidden="true" />
              <span className="max-w-[10rem] truncate">
                {role.title !== undefined && role.title.trim() !== "" ? `${role.name}（${role.title.trim()}）` : role.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function SortableRosterPill({
  id,
  name,
  title,
  order,
  summarizer,
  onRemove
}: {
  id: string
  name: string
  title: string
  order: number
  summarizer: boolean
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "inline-flex h-7 items-center rounded-full border border-primary/45 bg-primary/10 text-xs text-primary",
        isDragging && "opacity-70 shadow-sm"
      )}
    >
      <button
        type="button"
        aria-label={t("groups.dragMember")}
        className="flex h-full cursor-grab items-center rounded-l-full px-1.5 text-primary/55 hover:text-primary active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-3" aria-hidden="true" />
      </button>
      <span className="flex h-full items-center gap-1.5 pr-1">
        <CheckIcon className="size-3 shrink-0" aria-hidden="true" />
        <span className="max-w-[10rem] truncate">
          {title.trim() !== "" ? `${name}（${title.trim()}）` : name}
        </span>
        <span className="tabular-nums opacity-65">{order}</span>
        {summarizer && (
          <span className="rounded-full bg-amber-500/15 px-1 text-[9px] text-amber-700 dark:text-amber-300">
            {t("groups.roleSummarizerBadge")}
          </span>
        )}
      </span>
      <button
        type="button"
        aria-label={t("groups.removeMember")}
        className="flex h-full items-center rounded-r-full px-1.5 text-primary/50 hover:text-destructive"
        onClick={onRemove}
      >
        <XIcon className="size-3" aria-hidden="true" />
      </button>
    </div>
  )
}
