// 免费模型的能力画像：只从 OpenRouter 公开目录里**已经存在**的字段推导，不编造评分。
//
// `/api/v1/models` 没有「评分」这种字段——它给的是 `context_length`、`architecture.input_modalities`、
// `supported_parameters` 这几项**事实**。用户要的「按能力和评分推荐」，能诚实做到的是：
// 把这些事实折算成一个可解释的能力参考分（0-100），并把多模态单独标出来。
//
// 每一项都对应一个读者能自己核对的事实，权重写在这里而不是散在 UI 里：
//   上下文窗口  0-40 分（8k → 0，1M → 40，对数刻度，再长就没有意义了）
//   多模态      +20（输入模态里有 image / audio / video / file）
//   工具调用    +15（`supported_parameters` 含 `tools`）
//   推理        +25（`supported_parameters` 含 `reasoning`）
//
// 这是「参考分」而不是厂商评分：卡片上必须这么写，否则就是拿一个我们自己编的数字冒充排行榜。

import type { CachedFreeModel } from "./free-model-watch"

/** 从目录行里取出的、确实公布了的四件事。缺一项就是 `null` / `false`，绝不用默认值补齐。 */
export type ModelFacts = {
  /** `context_length`，不是正数时为 null。 */
  contextLength: number | null
  /** `architecture.input_modalities`，只保留认识的那几个。 */
  inputModalities: readonly string[]
  /** `supported_parameters` 含 `tools`。 */
  tools: boolean
  /** `supported_parameters` 含 `reasoning`。 */
  reasoning: boolean
}

/** 算得上「多模态输入」的模态。文本之外任意一种都算。 */
const NON_TEXT_MODALITIES: readonly string[] = ["image", "audio", "video", "file"]
/** `context_length` 的评分为 0 和 40 的两个端点。 */
const CONTEXT_FLOOR = 8_000
const CONTEXT_CEILING = 1_000_000
const CONTEXT_WEIGHT = 40

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/** Reads the four published facts out of one catalog row. Anything unreadable stays absent. */
export function modelFacts(row: CachedFreeModel): ModelFacts {
  const context = row.context_length
  const architecture = row.architecture
  const modalities =
    typeof architecture === "object" && architecture !== null
      ? strings((architecture as { input_modalities?: unknown }).input_modalities)
      : []
  const parameters = strings(row.supported_parameters)
  return {
    contextLength: typeof context === "number" && Number.isFinite(context) && context > 0 ? context : null,
    inputModalities: modalities,
    tools: parameters.includes("tools"),
    reasoning: parameters.includes("reasoning")
  }
}

/** 输入侧支持文本以外的模态 —— 图片/音频/视频/文件任意一种。 */
export function isMultimodal(facts: ModelFacts): boolean {
  return facts.inputModalities.some((modality) => NON_TEXT_MODALITIES.includes(modality))
}

/**
 * 0-100 的能力参考分。上下文用对数刻度：8k→0、1M→40，中间线性，两端夹紧。
 *
 * 端点以外的上下文不会再加分（更长的窗口确实存在，但它对「这个免费模型值不值得试」已经不再
 * 是变量），所以是夹紧而不是继续放大。
 */
export function capabilityScore(facts: ModelFacts): number {
  let score = 0
  if (facts.contextLength !== null) {
    const ratio = Math.log(facts.contextLength / CONTEXT_FLOOR) / Math.log(CONTEXT_CEILING / CONTEXT_FLOOR)
    score += Math.round(Math.min(1, Math.max(0, ratio)) * CONTEXT_WEIGHT)
  }
  if (isMultimodal(facts)) score += 20
  if (facts.tools) score += 15
  if (facts.reasoning) score += 25
  return Math.min(100, score)
}

export type FreeModelProfile = {
  id: string
  score: number
  multimodal: boolean
  /** 免费模型里分数最高的那几个 —— 「推荐」只在这批上出现。 */
  recommended: boolean
}

/** 推荐位的数量：够覆盖「第一屏能看到的几个」，又不会让推荐变成默认标签。 */
const RECOMMENDED_SLOTS = 3

/**
 * 给每个免费模型一份画像，并挑出推荐位。
 *
 * 只有**免费**模型参与排名：`rows` 是 `parseFreeModels` 的结果，本来就只含免费项。分数相同时
 * 用 id 排序，保证同一份目录每次给出同一批推荐（否则刷新一次推荐位就跳一次）。
 */
export function freeModelProfiles(rows: readonly CachedFreeModel[]): Map<string, FreeModelProfile> {
  const scored = rows.map((row) => {
    const facts = modelFacts(row)
    return { id: row.id, score: capabilityScore(facts), multimodal: isMultimodal(facts) }
  })
  const top = [...scored]
    // 0 分意味着目录什么也没公布，不是「能力平庸」——它不该占掉一个推荐位。
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
    .slice(0, RECOMMENDED_SLOTS)
    .map((entry) => entry.id)
  const recommended = new Set(top)
  return new Map(
    scored.map((entry) => [entry.id, { ...entry, recommended: recommended.has(entry.id) }] as const)
  )
}
