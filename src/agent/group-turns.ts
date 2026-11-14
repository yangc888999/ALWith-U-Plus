/**
 * One role's turn in a group discussion, and the prompt that turn speaks with.
 *
 * The role's instructions are resolved before the discussion starts (from text, a markdown file or
 * a Codex skill), so a turn is just: who speaks, with which model, saying what.
 */
import { type SummaryMode } from "@/lib/group-preferences"

export interface GroupTurn {
  /** The role's id, so a failure can name the member that did not answer. */
  id: string
  /** What the member is called in the discussion. */
  name: string
  /** The member's title / office ("运营专家", "COO"); empty means no title. */
  title?: string
  /** The model this member speaks with. */
  model: string
  /** Explicit effort, or null to let the model decide. */
  effort: string | null
  /** GPT acceleration for this member, when its model publishes a fast mode. */
  fastMode?: boolean
  /** The member's instructions, already resolved to plain text. */
  instruction: string
  /** The moderator closes the discussion instead of adding another opinion. */
  moderator: boolean
}

/** What one member said in one turn, kept for the group's written record. */
export interface GroupSpeechRecord {
  name: string
  /** `YYYY-MM-DD HH:mm`, local time. */
  at: string
  text: string
}

/** One round: the members' speeches, then the moderator's summary of them. */
export interface GroupRoundRecord {
  /** Zero-based round number. */
  round: number
  /** `YYYY-MM-DD HH:mm` of the round's first speech. */
  startedAt: string
  /** The moderator's summary, as written. */
  summary: string
  speeches: GroupSpeechRecord[]
}

/** A participant named in the final capstone minutes, in speaking order. */
export interface FinalSummarySpeaker {
  /** The member's display name. */
  name: string
  /** The member's title / office; empty means none, show bare name. */
  title: string
}

/** The group's document is context, not a novel: a long one is trimmed from the front. */
const MAX_DOCUMENT_CHARS = 6000

/** The marker every internal group turn carries, so the scheduler can tell them from user turns. */
export const GROUP_TURN_PREFIX = "〔"

/** The moderator's summary when the user has not written a template of their own. */
export const DEFAULT_ROUND_SUMMARY_TEMPLATE = `结论：
- 

待办：
- 

说明：`

/**
 * Per-meeting framing added on top of the group document.
 *
 * `focus` is the meeting's long-term analysis direction (set once, applies to every session of the
 * meeting), deliberately separate from the per-session `topic` that lives in the document.
 * `materials` says the document carries a material index, which changes what members must do with
 * it: read the file named there instead of guessing at its contents.
 */
export interface GroupPromptFraming {
  focus: string
  materials: boolean
}

/** The direction block, or nothing when no direction is configured (legacy behaviour). */
function focusLines(framing: GroupPromptFraming | undefined, kind: "speech" | "summary"): string[] {
  const focus = framing?.focus.trim() ?? ""
  if (focus === "") return []
  if (kind === "summary")
    return ["", "【分析方向】", `本次讨论的长期方向：${focus}`, "总结须回应这个方向：明确哪些结论落在方向内、哪些属于溢出。"]
  return ["", "【分析方向】", `本次讨论的长期方向：${focus}`, "发言须围绕该方向展开，不要泛泛而谈。"]
}

export function groupTurnPrompt(
  turn: GroupTurn,
  round: number,
  document: string,
  kind: "speech" | "summary" | "finalSummary",
  template: string,
  framing?: GroupPromptFraming,
  summaryMode: SummaryMode = "perRole",
  speakers: FinalSummarySpeaker[] = []
): string {
  const context = document.trim().slice(0, MAX_DOCUMENT_CHARS)
  const lines: string[] = []
  // The capstone minutes: written by the user's own session model after every round has closed,
  // structured by the configured mode. `perRole` lists each participant in order as `name（title）`,
  // one block per role — the shape the product decision settled on for a readable meeting record.
  if (kind === "finalSummary") {
    lines.push(
      "你是这场多角色讨论的最终纪要撰写人。上面的对话是整场讨论的完整记录（含每一轮主持人的小结），请通读后产出一份最终总纪要。",
      "",
      "【群说明】",
      context === "" ? "（没有群说明文档。）" : context,
      ""
    )
    const longFocus = framing?.focus.trim() ?? ""
    if (longFocus !== "") lines.push("【长期方向】", longFocus, "最终总纪要须呼应这个方向。", "")
    if (summaryMode === "perRole") {
      lines.push(
        "【输出格式：逐角色陈述】",
        "严格按下列顺序，每位角色一段，逐角色陈述其在本场讨论中的核心立场 / 结论。每段标题固定为 `姓名（身份）`：身份取下方给出的职务，若某角色无职务则只用 `姓名`。",
        "",
        "角色顺序（务必逐一对应，不要遗漏、不要新增、不要合并）："
      )
      if (speakers.length > 0) {
        for (const speaker of speakers) {
          lines.push(`- ${speaker.title.trim() !== "" ? `${speaker.name}（${speaker.title.trim()}）` : speaker.name}`)
        }
      }
      lines.push(
        "",
        "要求：",
        "- 每段以 `姓名（身份）` 或 `姓名` 开头，紧随其后写该角色的观点，不要再写小标题；",
        "- 内容须基于该角色在各轮中的发言与结论提炼，不要复述别人的话；",
        "- 若某角色全程未表达明确立场，写明「（未明确表态）」；",
        "- 角色之间用空行分隔，不要编号。"
      )
    } else if (summaryMode === "decision") {
      lines.push(
        "【输出格式：决议与行动项】",
        "分三块输出：",
        "结论：本次讨论达成的主要结论；",
        "决议：明确拍板的事项；",
        "行动项：要做什么、谁负责、何时完成（能点名就点名）。"
      )
    } else if (summaryMode === "debate") {
      lines.push(
        "【输出格式：自由辩论纪要】",
        "按讨论脉络梳理关键分歧与共识，不按角色分块。用「一方认为……另一方认为……」的方式呈现主要交锋，并标明最终倾向。"
      )
    } else {
      lines.push(
        "【输出格式：精简要点】",
        "只提炼关键要点，简短列点，不要展开论述，不要逐角色罗列。"
      )
    }
    if (template.trim() !== "") {
      lines.push("", "【用户自定义模板（仅作补充关注点，以上面格式为准）】", template.trim())
    }
    return lines.join("\n")
  }
  if (kind === "summary") {
    const skeleton = template.trim() === "" ? DEFAULT_ROUND_SUMMARY_TEMPLATE : template.trim()
    lines.push(
      `你是「${turn.name}」，本次讨论的总结人（最后发言，负责定稿本轮）。第 ${round + 1} 轮已经结束，请给出这一轮的总结。`,
      "",
      "【群说明】",
      context === "" ? "（没有群说明文档。）" : context,
      "",
      "【你的职责】",
      turn.instruction,
      ...focusLines(framing, kind),
      "",
      "【输出要求】",
      "严格按下面的模板输出，标题照抄、不要增删：",
      "",
      skeleton,
      "",
      "内容要求：",
      "- 结论要能落地，不要写“视情况而定”；",
      "- 待办写清楚做什么，涉及具体的人就点名；",
      "- 只说这一轮得出的东西，不要复述讨论过程。"
    )
    if (framing?.materials === true) lines.push("- 引用材料时写明文件路径。")
    return lines.join("\n")
  }
  lines.push(
    `你是「${turn.name}」，正在参与一个多角色讨论（第 ${round + 1} 轮）。上面的对话是讨论记录。`,
    "",
    "【群说明】",
    context === "" ? "（没有群说明文档。）" : context,
    "",
    "【你的职责】",
    turn.instruction,
    ...(turn.title !== undefined && turn.title.trim() !== "" ? [`【身份】你的职务/身份是「${turn.title.trim()}」，发言请贴合这一身份视角。`] : []),
    ...focusLines(framing, kind),
    "",
    "请以自己的职责出发给出这一轮的判断：",
    "- 明确表态，指出你认为方案里成立的部分和站不住的部分；",
    "- 提出你的关键建议或反对意见，不要重复别人已经说过的内容；",
    "- 不要客套，不要为了和稀泥而模糊表态。",
    // The transcript reads like a group chat, not an agent trace: the answer is the speech.
    // Reasoning out loud and tool play-by-play are hidden by the surface anyway — asking for
    // them only spends tokens and delays the next speaker.
    "- 像群聊发言一样直接说结论和理由，不要展示推理过程、不要罗列步骤或工具调用；",
    "- 控制在 300 字以内，说清楚就停。"
  )
  if (framing?.materials === true)
    lines.push("- 材料清单在上面的群说明里；需要某个文件的内容时读文件，不要猜内容。")
  lines.push("", `最后一行以「${turn.name}：」开头，便于其他人识别发言者。`)
  return lines.join("\n")
}
