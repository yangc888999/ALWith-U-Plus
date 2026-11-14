import { describe, expect, test } from "vitest"
import { remark } from "remark"
import remarkStringify from "remark-stringify"

import {
  regroupUnderline,
  serializeUnderline,
  UNDERLINE_NODE_TYPE,
  underlineStringifyHandler,
  withUnderlineHandler
} from "../markdown-underline"

/** Parse markdown into mdast with the stock remark parser (same one Milkdown uses). */
function parse(markdown: string): unknown {
  return remark().parse(markdown)
}

function findUnderline(tree: unknown): Array<{ children: unknown[] }> {
  const found: Array<{ children: unknown[] }> = []
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return
    const record = node as { type?: string; children?: unknown[] }
    if (record.type === UNDERLINE_NODE_TYPE) found.push(record as { children: unknown[] })
    for (const child of record.children ?? []) walk(child)
  }
  walk(tree)
  return found
}

describe("regroupUnderline", () => {
  test("pairs a simple <u>x</u> into one underline node", () => {
    const tree = parse("a <u>x</u> b")
    regroupUnderline(tree)
    const nodes = findUnderline(tree)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.children).toEqual([expect.objectContaining({ type: "text", value: "x" })])
  })

  test("keeps nested marks inside the underline (<u>**b**</u>)", () => {
    const tree = parse("<u>**b**</u>")
    regroupUnderline(tree)
    const nodes = findUnderline(tree)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.children[0]).toEqual(expect.objectContaining({ type: "strong" }))
  })

  test("handles nested <u> pairs with depth counting", () => {
    const tree = parse("<u>a <u>b</u> c</u>")
    regroupUnderline(tree)
    const nodes = findUnderline(tree)
    // Outer and inner both become underline nodes.
    expect(nodes).toHaveLength(2)
  })

  test("leaves an unpaired opener untouched", () => {
    const tree = parse("a <u> b")
    regroupUnderline(tree)
    expect(findUnderline(tree)).toHaveLength(0)
    // The raw html node survives for the preset's html atom.
    const htmlNodes: unknown[] = []
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return
      const record = node as { type?: string; children?: unknown[] }
      if (record.type === "html") htmlNodes.push(record)
      for (const child of record.children ?? []) walk(child)
    }
    walk(tree)
    expect(htmlNodes.length).toBeGreaterThan(0)
  })

  test("leaves a stray closer untouched", () => {
    const tree = parse("a </u> b")
    regroupUnderline(tree)
    expect(findUnderline(tree)).toHaveLength(0)
  })

  test("merges two adjacent underline runs into separate nodes", () => {
    const tree = parse("<u>a</u><u>b</u>")
    regroupUnderline(tree)
    expect(findUnderline(tree)).toHaveLength(2)
  })
})

describe("underline serialization", () => {
  test("round-trips <u>x</u> through parse → regroup → stringify", () => {
    const processor = remark()
      .use(remarkStringify, withUnderlineHandler({}))
      .use(() => (tree: unknown) => {
        regroupUnderline(tree)
      })
    const output = String(processor.processSync("a <u>x</u> b"))
    expect(output).toContain("<u>x</u>")
  })

  test("round-trips nested strong inside underline", () => {
    const processor = remark()
      .use(remarkStringify, withUnderlineHandler({}))
      .use(() => (tree: unknown) => {
        regroupUnderline(tree)
      })
    const output = String(processor.processSync("<u>**b**</u>"))
    expect(output).toContain("<u>**b**</u>")
  })

  test("serializeUnderline wraps containerPhrasing output in raw tags", () => {
    const calls: Array<{ before: string; after: string }> = []
    const fakeState = {
      containerPhrasing: (_node: unknown, info: { before: string; after: string }) => {
        calls.push(info)
        return "x"
      }
    }
    const result = serializeUnderline({ children: [] }, fakeState as never, {} as never)
    expect(result).toBe("<u>x</u>")
    expect(calls[0]).toEqual(expect.objectContaining({ before: "<", after: ">" }))
  })

  test("withUnderlineHandler preserves existing handlers", () => {
    const existing = () => "keep"
    const options = withUnderlineHandler({
      handlers: { custom: existing } as Record<string, typeof existing>,
      bullet: "-" as const
    })
    expect(options.handlers?.custom).toBe(existing)
    expect(options.handlers?.[UNDERLINE_NODE_TYPE]).toBe(underlineStringifyHandler)
    expect(options.bullet).toBe("-")
  })
})