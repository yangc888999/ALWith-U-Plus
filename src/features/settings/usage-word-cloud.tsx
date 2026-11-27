// "What do I ask about" — a word cloud over the user's own prompts, not the assistant's answers.
// The Rust ledger ships the raw prompt text; segmentation happens here with Intl.Segmenter so the
// OS dictionary decides what a Chinese "word" is. No charting dependency and no word list in the
// binary: one flex row of type whose size is its frequency, with a hover lift + count bubble.

import { type ReactNode, useMemo } from "react"
import { useTranslation } from "react-i18next"

import { SERIES_COLORS } from "./usage-charts"

export type Term = { text: string; count: number }

// Intl.Segmenter is present in WKWebView and Node, but not in every TS lib target, so describe
// only the slice we use instead of depending on ES2022.Intl types.
type SegmenterLike = { segment: (input: string) => Iterable<{ segment: string }> }
type SegmenterCtor = new (locale?: string, options?: { granularity?: "word" }) => SegmenterLike
const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter

/** Function words, pronouns and app boilerplate would otherwise be the biggest words in the cloud. */
const STOP_WORDS = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "这", "那", "和", "就", "都", "也", "把", "被",
  "给", "与", "及", "或", "一个", "一下", "可以", "怎么", "什么", "为什么", "如何", "请", "帮我", "谢谢",
  "还有", "以及", "但是", "如果", "因为", "所以", "这个", "那个", "现在", "看看", "需要", "能不能",
  "是否", "有没有", "多少", "哪些", "这样", "那样", "之后", "之前", "然后", "还是", "不是", "没有",
  "一些", "很多", "比较", "或者", "而且", "不过", "其实", "可能", "应该", "已经", "一直", "这里",
  "那里", "我们", "你们", "他们", "所有", "关于", "对于", "通过", "使用", "进行", "时候", "这些",
  "那些", "里面", "出来", "知道", "觉得", "看到", "直接", "一下", "问题", "现在", "这里", "还有",
  "下面", "上面", "针对", "当前", "打开", "消息", "内容", "主题", "以上", "如下", "要求", "说明",
  "格式", "输出", "回答", "hi", "hello", "ok", "okay",
  "是不是", "不要", "不需要", "了解", "复述", "简要", "要点", "对应", "既有", "约定", "指令",
  "增量", "下一步", "背景", "模板", "风格", "首先", "其次", "最后", "总之", "综上",
  "the", "and", "for", "with", "this", "that", "you", "are", "not", "but", "can", "how", "what",
  "why", "please", "from", "into", "about", "it", "to", "of", "on", "in", "be", "my", "your",
  "we", "our", "do", "does", "did", "have", "has", "had", "will", "would", "could", "should",
  "me", "i", "as", "at", "by", "or", "if", "so", "just", "then", "than", "more", "most", "some",
  "any", "all", "one", "two", "get", "got", "make", "let", "use", "using", "want", "need", "like",
  "also", "only", "very", "too"
])

/** English words that come from the harness, file names or markup rather than from a question. */
const NOISE_WORDS = new Set([
  "html", "json", "markdown", "codex", "transcript", "tool", "tools", "instructions", "action",
  "request", "response", "message", "messages", "system", "prompt", "default", "index", "src",
  "app", "mac", "macos", "file", "files", "document", "documents", "user", "users", "true",
  "false", "yes", "error", "warning", "info", "debug", "test", "tests", "start", "end", "type",
  "name", "value", "data", "api", "url", "http", "https", "www", "the", "and"
])

const MIN_TERM_DOCUMENTS = 2
const MIN_PHRASE_COUNT = 3
const MAX_TERM_CHARS = 24
const MAX_NGRAM_UNITS = 3

function isCandidateWord(word: string): boolean {
  if (word.length === 0 || word.length > 12) return false
  if (STOP_WORDS.has(word) || NOISE_WORDS.has(word) || /^\d+$/.test(word)) return false
  // File names and paths arrive as segmented tokens ("memory.md"); they name a file, not a topic.
  if (word.includes(".") || word.includes("_") || word.includes("/")) return false
  if (/^[\p{P}\p{S}]+$/u.test(word)) return false
  // A lone Latin letter comes from markup or a code fragment, never from a useful topic.
  if (word.length === 1 && !/^[\p{Script=Han}]$/u.test(word)) return false
  return true
}

function tokensOf(prompt: string, segmenter: SegmenterLike | null): string[] {
  const words = segmenter
    ? Array.from(segmenter.segment(prompt), (part) => part.segment.trim().toLowerCase())
    : prompt.split(/[^\p{L}\p{N}]+/u).map((word) => word.trim().toLowerCase())
  return words.filter(isCandidateWord)
}

function phraseOf(tokens: string[]): string | null {
  if (tokens.length < 2 || tokens.length > MAX_NGRAM_UNITS) return null
  const text = tokens.join("")
  if (text.length < 3 || text.length > MAX_TERM_CHARS) return null
  return text
}

/**
 * Ranked words and short phrases (highest frequency first). A term must appear in at least two
 * different prompts — one long pasted document repeating a token 50 times says nothing about what
 * the user asks about. The n-grams are bounded by adjacent segmented words, not arbitrary
 * characters, so repeated prose does not turn into a wall of substrings.
 */
export function topTerms(prompts: readonly string[], limit = 40): Term[] {
  const segmenter = Segmenter === undefined ? null : new Segmenter("zh-CN", { granularity: "word" })
  const candidates = new Map<string, { count: number; docs: number; units: number }>()
  for (const prompt of prompts) {
    const tokens = tokensOf(prompt, segmenter)
    const seen = new Set<string>()
    const add = (text: string, units: number): void => {
      seen.add(text)
      const previous = candidates.get(text)
      candidates.set(text, { count: (previous?.count ?? 0) + 1, docs: previous?.docs ?? 0, units })
    }
    for (const token of tokens) {
      if (token.length >= 2) add(token, 1)
    }
    for (let size = 2; size <= MAX_NGRAM_UNITS; size += 1) {
      for (let index = 0; index <= tokens.length - size; index += 1) {
        const phrase = phraseOf(tokens.slice(index, index + size))
        if (phrase !== null) add(phrase, size)
      }
    }
    // Document frequency is what stops one giant prompt from dominating the cloud. `seen` is
    // already unique per prompt, so every candidate can simply add one here.
    for (const text of seen) {
      const candidate = candidates.get(text)
      if (candidate !== undefined) candidate.docs += 1
    }
  }
  return [...candidates.entries()]
    .filter(
      ([, candidate]) =>
        candidate.docs >= MIN_TERM_DOCUMENTS &&
        candidate.count >= (candidate.units > 1 ? MIN_PHRASE_COUNT : 2)
    )
    .sort((left, right) => {
      const score = (entry: [string, { count: number; units: number }]): number =>
        entry[1].count * (1 + (entry[1].units - 1) * 0.2)
      return score(right) - score(left) || right[1].count - left[1].count || left[0].localeCompare(right[0])
    })
    .slice(0, limit)
    .map(([text, candidate]) => ({ text, count: candidate.count }))
}

export function WordCloud({ prompts }: { prompts: readonly string[] }): ReactNode {
  const { t } = useTranslation()
  const terms = useMemo(() => topTerms(prompts), [prompts])
  if (terms.length === 0) {
    return (
      <p className="py-10 text-center text-[11px] text-muted-foreground">
        {t("usageReport.wordCloudEmpty")}
      </p>
    )
  }
  const high = terms[0]?.count ?? 1
  const low = terms[terms.length - 1]?.count ?? 1
  const span = Math.max(1, high - low)
  return (
    <div
      className="flex min-h-[184px] flex-wrap content-center items-center justify-center gap-x-3 gap-y-1.5 py-4"
      data-word-cloud=""
    >
      {terms.map((term, index) => {
        const ratio = (term.count - low) / span
        const count = t("usageReport.wordCloudCount", { count: term.count })
        return (
          <button
            key={term.text}
            type="button"
            className="usage-word"
            data-count={count}
            aria-label={`${term.text} · ${count}`}
            style={{
              fontSize: `${(13 + ratio * 29).toFixed(1)}px`,
              color: SERIES_COLORS[index % SERIES_COLORS.length],
              animationDelay: `${Math.min(index * 18, 700)}ms`
            }}
          >
            {term.text}
          </button>
        )
      })}
    </div>
  )
}
