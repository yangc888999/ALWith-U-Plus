// The roster editor's dnd contract: the chips are a `flex flex-wrap` row that folds onto several
// lines, so the sortable strategy must be rect-based — verticalListSortingStrategy computes drop
// points for a single column and lands the chip on the wrong slot once the row wraps. Dragging
// cannot be simulated meaningfully in jsdom (every rect is 0×0), so the test wraps the real
// SortableContext — rendering is unchanged — and records the strategy prop the editor hands it.

import { vi } from "vitest"

const recorded = vi.hoisted(() => ({ strategies: [] as unknown[] }))

vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>()
  const { createElement } = await import("react")
  const { SortableContext: RealSortableContext, ...others } = actual
  return {
    ...others,
    SortableContext: (props: Parameters<typeof RealSortableContext>[0]) => {
      recorded.strategies.push(props.strategy)
      return createElement(RealSortableContext, props)
    }
  }
})

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } })
}))

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, test } from "vitest"

import { rectSortingStrategy } from "@dnd-kit/sortable"
import { RosterEditor } from "../roster-editor"
import type { GroupRole } from "@/lib/group-roles"

const roles: GroupRole[] = [
  { id: "r1", name: "策略", model: "m", effort: null, persona: { kind: "inline", text: "" }, skill: null, moderator: false },
  { id: "r2", name: "数据", model: "m", effort: null, persona: { kind: "inline", text: "" }, skill: null, moderator: false },
  { id: "r3", name: "CFO", model: "m", effort: null, persona: { kind: "inline", text: "" }, skill: null, moderator: false }
]

beforeEach(() => {
  recorded.strategies.length = 0
})

afterEach(() => {
  cleanup()
})

test("the wrapped chip row sorts with rectSortingStrategy", () => {
  render(<RosterEditor roles={roles} selected={["r1", "r2", "r3"]} onToggle={() => undefined} onReorder={() => undefined} />)
  expect(recorded.strategies).toEqual([rectSortingStrategy])
})

test("selected members render as drag pills with the last one holding the summarizer badge", () => {
  render(<RosterEditor roles={roles} selected={["r1", "r2", "r3"]} onToggle={() => undefined} onReorder={() => undefined} />)
  // One grip handle per selected member (the only drag source); the last pill carries the badge.
  expect(screen.getAllByLabelText("groups.dragMember")).toHaveLength(3)
  expect(screen.getByText("groups.roleSummarizerBadge")).toBeTruthy()
})

test("dangling selected ids (roles deleted since) drop out without breaking the render", () => {
  render(<RosterEditor roles={roles} selected={["r1", "gone", "r3"]} onToggle={() => undefined} onReorder={() => undefined} />)
  expect(screen.getAllByLabelText("groups.dragMember")).toHaveLength(2)
  // r3 — the surviving last one — is the summarizer.
  expect(screen.getByText("groups.roleSummarizerBadge")).toBeTruthy()
})
