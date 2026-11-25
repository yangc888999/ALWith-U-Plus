/**
 * Underline support for the Markdown WYSIWYG editor.
 *
 * CommonMark has no underline mark, and the preset's `htmlSchema` is an atom that renders raw HTML
 * as plain text — `<u>x</u>` arrives from remark-parse as three sibling nodes (html/text/html) and
 * would be claimed by that atom. This module therefore rebuilds paired `<u>…</u>` runs into an
 * `underline` mdast node **before** the parser runs, teaches the parser/serializer the new node,
 * and registers a remark-stringify handler that writes the raw tags back out.
 */
import type { Ctx } from "@milkdown/ctx"
import { $markSchema, $remark } from "@milkdown/utils"
import type { RootContent } from "mdast"
import type { Handle, State as ToMarkdownState } from "mdast-util-to-markdown"
import { visit } from "unist-util-visit"

/** The mdast node type produced for a paired `<u>…</u>` run. */
export const UNDERLINE_NODE_TYPE = "underline"

const OPEN_U = /^<u(?:\s[^>]*)?>/i
const CLOSE_U = /^<\/u\s*>$/i

/** A parent node whose children we may rewrite (paragraph, heading, emphasis, …). */
interface MutableParent {
  children: RootContent[]
}

function isParent(node: unknown): node is MutableParent {
  return (
    node !== null &&
    typeof node === "object" &&
    Array.isArray((node as { children?: unknown }).children)
  )
}

/**
 * Rebuild paired inline `<u>` html nodes into `{ type: "underline", children }`.
 *
 * Depth counting keeps nested pairs intact; an unmatched opener (or closer) is left untouched so
 * the preset's html atom still renders it literally. Only *phrasing* containers are rewritten —
 * a block-level `<u>` wrapper keeps its raw HTML (documented limitation).
 */
export function regroupUnderline(tree: unknown): void {
  visit(tree as never, (node: unknown) => {
    if (!isParent(node)) return
    const children = node.children
    let index = 0
    while (index < children.length) {
      const opener = children[index]
      if (opener === undefined || opener.type !== "html" || !OPEN_U.test(String(opener.value ?? ""))) {
        index += 1
        continue
      }
      // Scan forward for the matching closer, tracking nested <u> openers.
      let depth = 1
      let end = index + 1
      while (end < children.length) {
        const candidate = children[end]
        if (candidate !== undefined && candidate.type === "html") {
          const value = String(candidate.value ?? "")
          if (OPEN_U.test(value)) depth += 1
          else if (CLOSE_U.test(value)) {
            depth -= 1
            if (depth === 0) break
          }
        }
        end += 1
      }
      if (depth !== 0 || end >= children.length) {
        // Unpaired opener: leave the raw html node in place and move on.
        index += 1
        continue
      }
      const inner = children.slice(index + 1, end)
      const underline = {
        type: UNDERLINE_NODE_TYPE,
        children: inner,
        data: { hName: "u" }
      } as unknown as RootContent
      children.splice(index, end - index + 1, underline)
      // Re-scan from the same index: the replacement may itself contain nested pairs, and the
      // visitor will descend into it anyway.
      index += 1
    }
  })
}

/** remark plugin (raw form for `$remark`): rewrite the tree in place, no options. */
function remarkUnderline(this: unknown): void {
  // The transformer receives (tree, file); only the tree matters here.
  return ((tree: unknown) => {
    regroupUnderline(tree)
  }) as never
}

/** `$remark` atom — installs the mdast rewrite ahead of the parser. */
export const underlineRemark = $remark("alwithUnderline", () => remarkUnderline as never)

/**
 * `$markSchema` atom for the underline mark. `toMarkdown` opens an `underline` mdast node whose
 * raw tags are written by the stringify handler registered in `underlineStringifyHandler`.
 */
export const underlineSchema = $markSchema("underline", () => ({
  parseDOM: [
    { tag: "u" },
    {
      style: "text-decoration",
      getAttrs: (value) => (value === "underline" ? {} : false)
    }
  ],
  toDOM: () => ["u", 0] as const,
  parseMarkdown: {
    match: (node) => node.type === UNDERLINE_NODE_TYPE,
    runner: (state, node, markType) => {
      state.openMark(markType)
      state.next((node.children ?? []) as never)
      state.closeMark(markType)
    }
  },
  toMarkdown: {
    match: (mark) => mark.type.name === "underline",
    runner: (state, mark) => {
      state.withMark(mark, UNDERLINE_NODE_TYPE)
    }
  }
}))

/** Serialize the children of an underline node; kept separate so tests can drive it directly. */
export function serializeUnderline(node: unknown, state: ToMarkdownState, info: Parameters<Handle>[3]): string {
  const parent = node as { children?: unknown[] }
  return `<u>${state.containerPhrasing(parent as never, { ...info, before: "<", after: ">" })}</u>`
}

/**
 * remark-stringify handler for the `underline` node. `mdast-util-to-markdown` emits raw HTML
 * unescaped, so the paired tags survive the round trip.
 */
export const underlineStringifyHandler: Handle = (node, _parent, state, info) =>
  serializeUnderline(node, state, info)

/** Convenience for `configure`: merge the handler into existing remark-stringify options. */
export function withUnderlineHandler<T extends { handlers?: Partial<Record<string, Handle>> | null }>(
  options: T
): T {
  return {
    ...options,
    handlers: { ...options.handlers, [UNDERLINE_NODE_TYPE]: underlineStringifyHandler }
  }
}

/** Resolve the underline MarkType from a Milkdown context (commands use this). */
export function underlineType(ctx: Ctx) {
  return underlineSchema.type(ctx)
}
