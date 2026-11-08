import type { Session } from "@alwith/api"
import { textOf } from "@alwith/api"
import { invoke } from "@tauri-apps/api/core"
import { useEffect, useSyncExternalStore } from "react"

import { GROUP_TURN_PREFIX, type GroupTurn } from "@/agent/group-turns"
import { RemoteChatClient } from "@/lib/chat-window-client"
import { client } from "@/lib/client"
import { describeError } from "@/lib/error-text"
import { groupRoleFor, type GroupRole } from "@/lib/group-roles"
import {
  armGroupDiscussion,
  clearGroupControl,
  clearGroupDiscussion,
  groupDiscussed,
  markGroupDiscussed,
  patchGroupDiscussion,
  subscribeGroupDiscussion,
  subscribeGroupSpeaker
} from "@/lib/group-runtime"
import { groupByDirectory, type GroupConfig } from "@/lib/groups"
import { groupPreferences } from "@/lib/group-preferences"

import { recordGroupRounds } from "./group-memory"

/**
 * Runs a group discussion after the user has spoken.
 *
 * The trigger is the end of the user's turn: the roster goes round once per round, each member
 * taking the shared session for one turn, and the moderator closes with one agreed plan. The
 * members read each other because they all speak in the same conversation.
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

async function readDocument(group: GroupConfig): Promise<string> {
  let document = ""
  try {
    document = await invoke<string>("group_document_read", { document: group.document })
  } catch {
    // A missing document is not a reason to skip the discussion; the roles still have their brief.
  }
  // One discussion, one question: the topic rides on top of the document, so nobody drifts.
  if (group.topic.trim() !== "") document = `## 本次议题\n${group.topic.trim()}\n\n${document}`.trim()
  return document
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
  options: { rounds?: number; force?: boolean } = {}
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
        model: role.model,
        effort: role.effort,
        ...(role.fastMode === true ? { fastMode: true } : {}),
        instruction: await resolveInstruction(role),
        moderator: role.moderator
      })
    }
    const document = await readDocument(group)
    patchGroupDiscussion(sessionId, { phase: "discussing", speaker: null, round: 0, members: roles.length, error: null })
    const rounds = options.rounds ?? group.rounds
    const result = await client.runGroupDiscussion(
      sessionId,
      turns,
      rounds,
      document,
      groupPreferences().summaryTemplate
    )
    patchGroupDiscussion(sessionId, { phase: result.outcome === "stopped" ? "stopped" : "done", speaker: null })
    // The written record is the point of a discussion that will be read later: one section per
    // round, with the moderator's conclusion first and the speeches that produced it below.
    const topic = group.topic.trim() === "" ? (target?.question ?? "（未指定议题）") : group.topic.trim()
    void recordGroupRounds(group, topic, result.rounds, rounds)
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
export async function startGroupDiscussion(sessionId: string, rounds?: number): Promise<boolean> {
  const session = client.state.sessions[sessionId]
  if (session === undefined) return false
  const group = groupByDirectory(session.cwd)
  if (group === null) return false
  return runDiscussion(sessionId, group, session, { rounds, force: true })
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

/** Clears the status card when the user starts a new topic, and arms the roster for it. */
export function resetGroupDiscussion(sessionId: string): void {
  clearGroupDiscussion(sessionId)
  armGroupDiscussion(sessionId)
}
