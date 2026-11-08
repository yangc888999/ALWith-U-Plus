// The group bar: the roster's own control strip, docked right above the composer.
//
// A group conversation is not a single model answering — it is a roster taking the floor in turn.
// That needs a place to say who holds the floor and how far the rounds have gone, and a brake the
// user can reach. The strip lives in the layout above the input instead of floating over it: the
// old pill sat on top of the composer, so the one thing a discussion must never block was the box
// you interject with.

import type { Session } from "@alwith/api"
import { CircleStopIcon, Loader2Icon, PauseIcon, PlayIcon, RotateCcwIcon, UsersIcon } from "lucide-react"
import { type ReactNode, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { RemoteChatClient } from "@/lib/chat-window-client"
import { client } from "@/lib/client"
import { groupRoleFor, type GroupRole } from "@/lib/group-roles"
import {
  groupControlFor,
  groupDiscussed,
  groupDiscussionSnapshot,
  requestGroupStop,
  setGroupPaused,
  subscribeGroupControl,
  subscribeGroupDiscussed,
  subscribeGroupDiscussion
} from "@/lib/group-runtime"
import { groupByDirectory } from "@/lib/groups"

import { startGroupDiscussion } from "./use-group-discussion"

export function GroupDiscussionBar({ session }: { session: Session }): ReactNode {
  const { t } = useTranslation()
  const group = groupByDirectory(session.cwd)
  const discussion = useSyncExternalStore(
    subscribeGroupDiscussion,
    () => groupDiscussionSnapshot(session.id),
    () => groupDiscussionSnapshot(session.id)
  )
  const control = useSyncExternalStore(
    subscribeGroupControl,
    () => groupControlFor(session.id),
    () => groupControlFor(session.id)
  )
  const discussed = useSyncExternalStore(
    subscribeGroupDiscussed,
    () => groupDiscussed(session.id),
    () => groupDiscussed(session.id)
  )
  if (group === null) return null

  const members = group.roles.map((id) => groupRoleFor(id)).filter((role): role is GroupRole => role !== null)
  const busy = discussion.phase === "discussing" || discussion.phase === "closing"
  // The floating window mirrors the main conversation; the roster only runs where the agent does.
  const remote = client instanceof RemoteChatClient
  // The brake takes effect between turns: while a member is still answering, the pause is queued,
  // and saying "已暂停" then would be a lie the user could act on.
  const braking = busy && control.paused
  const paused = braking && session.state === "idle"
  const idle = session.state === "idle"
  // The closing turn announces `rounds + 1`; the strip never claims a round that does not exist.
  const currentRound = Math.min(group.rounds, Math.max(1, discussion.round || 1))

  let status = discussed
    ? t("groups.barDone")
    : t("groups.barIdle", { count: members.length, rounds: group.rounds })
  if (busy)
    status = t("groups.barSpeaking", {
      round: currentRound,
      total: group.rounds,
      speaker: discussion.speaker ?? t("groups.barBetween")
    })
  if (braking) status = t("groups.barPausing")
  if (paused) status = t("groups.barPaused")
  if (!busy && discussion.phase === "stopped") status = t("groups.barStopped")
  if (!busy && discussion.phase === "error") status = t("groups.barFailed", { error: discussion.error ?? "" })

  const run = (count: number): void => {
    void startGroupDiscussion(session.id, count).catch((error: unknown) =>
      toast.error(error instanceof Error ? error.message : String(error))
    )
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-2" data-group-bar>
      <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-2.5 py-1.5 text-xs">
        {busy && !paused ? (
          <Loader2Icon className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" />
        ) : paused ? (
          <PauseIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        ) : (
          <UsersIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate font-medium" data-group-status-text>
          {status}
        </span>
        {members.length > 0 && (
          <div className="hidden min-w-0 flex-1 items-center gap-1 overflow-hidden md:flex">
            {members.map((member) => {
              const speaking = discussion.speaker === member.name
              return (
                <span
                  key={member.id}
                  className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] leading-none ${
                    speaking
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border/60 text-muted-foreground"
                  }`}
                  title={member.model}
                >
                  {member.name}
                  {member.moderator ? ` · ${t("groups.barModerator")}` : ""}
                </span>
              )
            })}
          </div>
        )}
        <div className="ms-auto flex shrink-0 items-center gap-0.5">
          {busy ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                onClick={() => setGroupPaused(session.id, !control.paused)}
              >
                {control.paused ? <PlayIcon className="size-3" /> : <PauseIcon className="size-3" />}
                {control.paused ? t("groups.barResume") : t("groups.barPause")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                onClick={() => requestGroupStop(session.id)}
              >
                <CircleStopIcon className="size-3" />
                {t("groups.barStop")}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px]"
              // A roster needs something to argue about: the first turn is the user's.
              disabled={remote || !idle || session.items.length === 0}
              onClick={() => run(discussed ? 1 : group.rounds)}
            >
              {discussed ? <RotateCcwIcon className="size-3" /> : <PlayIcon className="size-3" />}
              {discussed ? t("groups.barAgain") : t("groups.barStart")}
            </Button>
          )}
        </div>
      </div>
      {paused && (
        <p className="mt-1 px-1 text-[11px] leading-relaxed text-muted-foreground">{t("groups.barPausedHint")}</p>
      )}
      {!paused && discussion.phase !== "error" && discussion.error !== null && (
        <p className="mt-1 px-1 text-[11px] leading-relaxed text-muted-foreground">{discussion.error}</p>
      )}
    </div>
  )
}
