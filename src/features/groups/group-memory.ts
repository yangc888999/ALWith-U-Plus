/**
 * The written record of a group discussion.
 *
 * A flat "user said / assistant said" log is unreadable once a roster has spoken three rounds: the
 * reader cannot tell which round an argument belongs to, who was answering whom, or where the
 * decisions are. This writes the two levels a reader actually needs — the round (when, which round,
 * what topic, and the moderator's conclusion) and, under it, each speech (when, who, which turn,
 * what they argued) — so the discussion reads as one line of reasoning instead of a transcript.
 */
import { isTauri } from "@tauri-apps/api/core"

import type { GroupRoundRecord } from "@/agent/group-turns"
import type { GroupConfig } from "@/lib/groups"
import { appendProjectMemory } from "@/lib/project-memory"

/** One speech longer than this is a document, not a position: keep the record readable. */
const MAX_SPEECH_CHARS = 3000

function clip(text: string, max = MAX_SPEECH_CHARS): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max)}\n\n…（已截断 ${trimmed.length - max} 字）`
}

/** The first sentence carries the position; the rest is the argument. */
function gist(text: string): string {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "")
  if (line === undefined) return "（未给出观点）"
  // A one-line gist is read in a list, not rendered as Markdown: strip the emphasis and heading
  // marks instead of leaving `**我反对**` in the middle of a sentence.
  const clean = line
    .replace(/^[#>*\-\s]+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/：$/, "")
  return Array.from(clean).slice(0, 40).join("")
}

function speechSection(speech: GroupRoundRecord["speeches"][number], index: number): string {
  return [
    `#### ${speech.at} · ${speech.name} · 第 ${index + 1} 次发言`,
    `主旨：${gist(speech.text)}`,
    "",
    "详细内容：",
    "",
    clip(speech.text)
  ].join("\n")
}

/** One round, as the reader will see it in the group's `memory.md`. */
export function buildRoundMemoryBlock(record: GroupRoundRecord, totalRounds: number, topic: string): string {
  const parts = [`## 第 ${record.round + 1}/${totalRounds} 轮 · ${record.startedAt} · 主题：${topic}`]
  if (record.summary.trim() !== "") {
    parts.push("**本轮结论与待办**", clip(record.summary))
  }
  if (record.speeches.length > 0) {
    parts.push(`**发言（${record.speeches.length} 次）**`)
    record.speeches.forEach((speech, index) => parts.push(speechSection(speech, index)))
  }
  return parts.join("\n\n")
}

/**
 * Appends every finished round to the group's `memory.md`.
 *
 * Best-effort: a read-only folder must not turn a finished discussion into an error toast. The
 * native writer already adds the `# 项目记忆` header the first time, so a block is just a round.
 */
export async function recordGroupRounds(
  group: GroupConfig,
  topic: string,
  records: GroupRoundRecord[],
  totalRounds: number
): Promise<void> {
  if (!isTauri() || records.length === 0) return
  for (const record of records) {
    try {
      // Shared with the per-turn writer: both target the same synced memory.md, and an
      // unserialized second path is what produced Drive conflict copies.
      await appendProjectMemory(group.directory, buildRoundMemoryBlock(record, totalRounds, topic))
    } catch {
      // Memory is best-effort.
    }
  }
}
