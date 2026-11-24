import type { Session } from "@alwith/api"
import { textOf } from "@alwith/api"
import { invoke } from "@tauri-apps/api/core"
import { useEffect, useSyncExternalStore } from "react"

import { GROUP_TURN_PREFIX, type GroupTurn } from "@/agent/group-turns"
import { commands } from "@/bindings"
import { RemoteChatClient } from "@/lib/chat-window-client"
import { client } from "@/lib/client"
import { describeError } from "@/lib/error-text"
import { groupRoleFor, type GroupRole } from "@/lib/group-roles"
import {
  clearGroupControl,
  groupDiscussed,
  markGroupDiscussed,
  patchGroupDiscussion,
  subscribeGroupDiscussion,
  subscribeGroupSpeaker
} from "@/lib/group-runtime"
import { groupByDirectory, type GroupConfig } from "@/lib/groups"
import { groupPreferences } from "@/lib/group-preferences"
import { basename } from "@/lib/path"

import { recordFinalSummary, recordGroupRounds } from "./group-memory"

/**
 * Runs a group discussion after the user has spoken.
 *
 * The trigger is the end of the user's turn: the host (the user) opened with the topic, then the
 * roster goes round once per round — every member but the last speaks, and the last member closes
 * the round as the summarizer. The members read each other because they all speak in the same
 * conversation.
 */
const running = new Set<string>()

/**
 * A role's instructions: the persona, then the skill it was pointed at.
 *
 * The two are additive — the persona says what the role is responsible for, the skill adds the
 * method it works with — so a member can be "风控视角 + 交易指标口径" without duplicating either.
 */
async function resolveInstruction(role: GroupRole): Promise<string> {
  const parts: string[] = []
  try {
    if (role.persona.kind === "file")
      parts.push(await invoke<string>("read_text_file", { path: role.persona.path }))
    else parts.push(role.persona.text)
  } catch (error) {
    throw new Error(`${role.name}：${describeError(error)}`)
  }
  const skill = role.skill
  if (skill !== null)
    try {
      parts.push(await invoke<string>("skill_document_read", { id: skill }))
    } catch (error) {
      throw new Error(`${role.name}：${describeError(error)}`)
    }
  return parts.join("\n\n").trim()
}

/**
 * Assembles what every member reads before it speaks, in reading order:
 * 分析方向 → 本次议题 → 材料索引 → 历轮纪要 → the group document itself.
 *
 * The order is deliberate — direction before topic so each member frames the question the configured
 * way, and the minutes tail before the document so the carried-forward conclusions of past sessions
 * sit above the (possibly stale) standing brief.
 *
 * The material index is generated per round-start, never snapshotted at save time: folders change
 * between meetings, and an index of paths costs a few hundred characters where full text would
 * swamp the context. A folder that cannot be enumerated is reported as such and the discussion
 * continues — material going stale mid-week is normal, losing the meeting is not.
 */
export async function readDocument(group: GroupConfig, focusOverride?: string): Promise<string> {
  const sections: string[] = []
  // A direction typed on the "change direction" box overrides the standing focus for THIS run only;
  // it is never written back to group.focus, so the meeting's long-term angle is untouched.
  const focus = focusOverride !== undefined && focusOverride.trim() !== "" ? focusOverride.trim() : group.focus
  if (focus.trim() !== "") sections.push(`## 分析方向\n${focus.trim()}`)
  // One discussion, one question: the topic rides on top of the document, so nobody drifts.
  if (group.topic.trim() !== "") sections.push(`## 本次议题\n${group.topic.trim()}`)
  if (group.materialFolders.length > 0) {
    // Each folder renders as its own `### name` section (with the quote-path note); an inaccessible
    // folder is named and marked instead of aborting the whole discussion.
    const indexes = await Promise.allSettled(
      group.materialFolders.map(async (folder) => (await commands.groupMaterialIndex({ path: folder })).markdown)
    )
    const rendered = indexes
      .map((result, position) =>
        result.status === "fulfilled"
          ? result.value
          : `### ${basename(group.materialFolders[position] ?? "")}\n（该文件夹当前不可访问。）`
      )
      .join("\n\n")
    sections.push(`## 材料索引\n${rendered}\n\n（材料索引按文件名列出，需要内容时读文件，不要猜。）`)
  }
  // The minutes loop: every finished round's summary is appended to the project's memory.md, so the
  // tail of that file is what a new session of the same meeting carries forward.
  if (group.directory !== "") {
    try {
      const tail = await commands.groupTailText({ path: `${group.directory}/memory.md`, maxChars: 1200 })
      if (tail.text.trim() !== "") sections.push(`## 历轮纪要（最近）\n${tail.text.trim()}`)
    } catch {
      // No memory file yet — the first session of a fresh folder. Nothing to carry forward.
    }
  }
  try {
    const document = await invoke<string>("group_document_read", { document: group.document })
    if (document.trim() !== "") sections.push(document.trim())
  } catch {
    // A missing document is not a reason to skip the discussion; the roles still have their brief.
  }
  return sections.join("\n\n")
}

/** The last assistant answer and the question that produced it. */
export function groupTurnTarget(session: Session): { question: string; answer: string; answerId: string } | null {
  let answerIndex = -1
  for (let index = session.items.length - 1; index >= 0; index -= 1) {
    const item = session.items[index]
    if (item?.kind === "assistant") {
      answerIndex = index
      break
    }
  }
  if (answerIndex < 0) return null
  const answerItem = session.items[answerIndex]
  if (answerItem?.kind !== "assistant") return null
  let question = ""
  for (let index = answerIndex - 1; index >= 0; index -= 1) {
    const item = session.items[index]
    if (item?.kind !== "user") continue
    question = textOf(item.content).trim()
    break
  }
  // A member's own turn must not trigger another round of the roster.
  if (question.startsWith(GROUP_TURN_PREFIX)) return null
  return { question, answer: textOf(answerItem.content).trim(), answerId: answerItem.id }
}

/**
 * Runs one discussion and reports whether it actually ran.
 *
 * `force` is the manual entry (the 再讨论一轮 button): the user asked for the roster even when the
 * group itself is set to not start on its own. `rounds` overrides the configured count for a
 * single round asked from the bar.
 */
async function runDiscussion(
  sessionId: string,
  group: GroupConfig,
  session: Session,
  options: { rounds?: number; force?: boolean; direction?: string } = {}
): Promise<boolean> {
  if (running.has(sessionId)) return false
  // The group can be a plain project with a roster on paper; the switch decides whether a user
  // turn actually starts a discussion.
  if (!group.autoDiscuss && options.force !== true) return false
  const roles = group.roles.map((id) => groupRoleFor(id)).filter((role): role is GroupRole => role !== null)
  if (roles.length === 0) return false
  const target = groupTurnTarget(session)
  if (target === null && options.force !== true) return false
  // The floating window mirrors the main conversation; the discussion runs there already.
  if (client instanceof RemoteChatClient) return false
  if (client.state.connection !== "ready") return false
  const stop = session.lastStopReason
  if (stop !== null && stop !== "end_turn") return false

  running.add(sessionId)
  try {
    const turns: GroupTurn[] = []
    for (const role of roles) {
      turns.push({
        id: role.id,
        name: role.name,
        title: role.title ?? "",
        model: role.model,
        effort: role.effort,
        ...(role.fastMode === true ? { fastMode: true } : {}),
        instruction: await resolveInstruction(role),
        moderator: role.moderator
      })
    }
    // A direction typed on the "change direction" box overrides the standing focus for this run
    // only; it is never written back to group.focus, so the meeting's long-term angle is untouched.
    const effectiveFocus =
      options.direction !== undefined && options.direction.trim() !== "" ? options.direction.trim() : group.focus
    const document = await readDocument(group, effectiveFocus)
    patchGroupDiscussion(sessionId, { phase: "discussing", speaker: null, round: 0, members: roles.length, error: null })
    const rounds = options.rounds ?? group.rounds
    const result = await client.runGroupDiscussion(
      sessionId,
      turns,
      rounds,
      document,
      groupPreferences().summaryTemplate,
      { focus: effectiveFocus, materials: group.materialFolders.length > 0 },
      groupPreferences().summaryMode
    )
    patchGroupDiscussion(sessionId, { phase: result.outcome === "stopped" ? "stopped" : "done", speaker: null })
    // The written record is the point of a discussion that will be read later: one section per
    // round, with the summarizer's conclusion first and the speeches that produced it below.
    const topic = group.topic.trim() === "" ? (target?.question ?? "（未指定议题）") : group.topic.trim()
    void recordGroupRounds(group, topic, result.rounds, rounds)
    // The capstone minutes are appended as their own section, separate from the per-round blocks.
    if (result.finalSummary !== null && result.finalSummary.trim() !== "") {
      void recordFinalSummary(group, result.finalSummary, groupPreferences().summaryMode, topic)
    }
    // Marked here, before the caller's promise settles: the last member's turn also settles the
    // session, and a store event in that window must not start the roster all over again.
    markGroupDiscussed(sessionId)
    return true
  } catch (error) {
    patchGroupDiscussion(sessionId, { phase: "error", speaker: null, error: describeError(error) })
    return false
  } finally {
    running.delete(sessionId)
    clearGroupControl(sessionId)
  }
}

/**
 * Starts one discussion on demand: the bar's 开始讨论 / 再来一轮.
 *
 * `force` is what makes this the manual path — the roster runs even when the group is set to not
 * start on its own, and even when the last turn left no clear question to answer.
 */
export async function startGroupDiscussion(sessionId: string, rounds?: number, direction?: string): Promise<boolean> {
  const session = client.state.sessions[sessionId]
  if (session === undefined) return false
  const group = groupByDirectory(session.cwd)
  if (group === null) return false
  return runDiscussion(sessionId, group, session, { rounds, force: true, direction })
}

/** Watches a conversation and starts one group discussion on the first user turn. */
export function useGroupDiscussion(session: Session): void {
  const sessionId = session.id
  const group = groupByDirectory(session.cwd)
  const groupId = group?.id ?? null
  useSyncExternalStore(subscribeGroupDiscussion, () => groupId, () => groupId)
  useEffect(() => {
    // The agent announces who holds the floor; the status card shows it.
    return subscribeGroupSpeaker((speaker, round) => {
      patchGroupDiscussion(sessionId, { speaker, round, phase: speaker === null ? "done" : "discussing" })
    })
  }, [sessionId])
  useEffect(() => {
    if (group === null) return
    let previous = client.state.sessions[sessionId]?.state ?? "idle"
    return client.store.subscribe(() => {
      const current = client.state.sessions[sessionId]
      if (current === undefined) return
      const next = current.state
      const settled = previous !== "idle" && next === "idle"
      previous = next
      if (!settled || running.has(sessionId)) return
      // The group may have been deleted or reconfigured while the turn was running.
      const live = groupByDirectory(current.cwd)
      if (live === null) return
      // One question, one discussion: once the roster has spoken, the conversation is an ordinary
      // chat with the user's own model until they ask for another round from the group bar.
      if (groupDiscussed(sessionId)) return
      void runDiscussion(sessionId, live, current)
    })
  }, [sessionId, groupId])
}
