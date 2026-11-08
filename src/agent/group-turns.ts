/**
 * One role's turn in a group discussion, and the prompt that turn speaks with.
 *
 * The role's instructions are resolved before the discussion starts (from text, a markdown file or
 * a Codex skill), so a turn is just: who speaks, with which model, saying what.
 */
export interface GroupTurn {
  /** The role's id, so a failure can name the member that did not answer. */
  id: string
  /** What the member is called in the discussion. */
  name: string
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

export function groupTurnPrompt(
  turn: GroupTurn,
  round: number,
  document: string,
  kind: "speech" | "summary",
  template: string
): string {
  const context = document.trim().slice(0, MAX_DOCUMENT_CHARS)
  const lines: string[] = []
  if (kind === "summary") {
    const skeleton = template.trim() === "" ? DEFAULT_ROUND_SUMMARY_TEMPLATE : template.trim()
    lines.push(
      `你是「${turn.name}」，本次讨论的主持人。第 ${round + 1} 轮已经结束，请给出这一轮的总结。`,
      "",
      "【群说明】",
      context === "" ? "（没有群说明文档。）" : context,
      "",
      "【你的职责】",
      turn.instruction,
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
    "",
    "请以自己的职责出发给出这一轮的判断：",
    "- 明确表态，指出你认为方案里成立的部分和站不住的部分；",
    "- 提出你的关键建议或反对意见，不要重复别人已经说过的内容；",
    "- 不要客套，不要为了和稀泥而模糊表态。",
    "",
    `最后一行以「${turn.name}：」开头，便于其他人识别发言者。`
  )
  return lines.join("\n")
}
