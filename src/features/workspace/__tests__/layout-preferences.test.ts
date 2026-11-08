import { expect, test } from "vitest"

import {
  contentShares,
  LAYOUT_SHARE_MAX,
  LAYOUT_SHARE_MIN,
  loadWorkspaceLayout,
  saveLayoutShare,
  saveWorkspaceLayout,
  sharePercents,
  requestedPreviewWidth,
  withShare,
  workspaceLayoutDefaults
} from "../layout-preferences"

const total = (value: {
  navigationRatio: number
  chatRatio: number
  treeRatio: number
  previewRatio: number
}): number => value.navigationRatio + value.chatRatio + value.treeRatio + value.previewRatio

test("empty storage falls back to shares that add up to exactly 100%", () => {
  const layout = loadWorkspaceLayout()
  expect(layout).toEqual(workspaceLayoutDefaults)
  expect(total(layout)).toBeCloseTo(1, 10)
})

test("editing chat only moves the preview buffer; nav and tree stay fixed at 100%", () => {
  const layout = withShare(workspaceLayoutDefaults, "chat", 45)
  expect(total(layout)).toBeCloseTo(1, 10)
  expect(Math.round(layout.chatRatio * 100)).toBe(45)
  // Only the preview buffer absorbs the change; the other two non-preview columns keep their size.
  expect(layout.navigationRatio).toBeCloseTo(workspaceLayoutDefaults.navigationRatio, 10)
  expect(layout.treeRatio).toBeCloseTo(workspaceLayoutDefaults.treeRatio, 10)
  // preview = 100 - 12 - 13 - 45 = 30
  expect(Math.round(layout.previewRatio * 100)).toBe(30)
})

test("a share edit survives a reload and still totals 100%", () => {
  saveWorkspaceLayout({ ...workspaceLayoutDefaults })
  saveLayoutShare("navigation", 22)
  const layout = loadWorkspaceLayout()
  expect(total(layout)).toBeCloseTo(1, 10)
  expect(Math.round(layout.navigationRatio * 100)).toBe(22)
})

test("the four displayed percentages always sum to 100", () => {
  for (const percent of [10, 17, 23, 31, 44, 55, 63, 70]) {
    const layout = withShare(workspaceLayoutDefaults, "preview", percent)
    const percents = sharePercents(layout)
    expect(percents.navigation + percents.chat + percents.tree + percents.preview).toBe(100)
  }
})

test("editing a share has no per-column floor; the preview buffer keeps the total at 100%", () => {
  const big = withShare(workspaceLayoutDefaults, "chat", 99)
  // nav+tree are fixed (12+13); chat can grow only until the preview buffer hits 0 — here 75%.
  expect(Math.round(big.chatRatio * 100)).toBe(75)
  expect(big.previewRatio).toBeCloseTo(0, 10)
  expect(total(big)).toBeCloseTo(1, 10)

  const tiny = withShare(workspaceLayoutDefaults, "chat", 1)
  // No floor: chat can drop to a single percent and the preview soaks up the rest (74%).
  expect(Math.round(tiny.chatRatio * 100)).toBe(1)
  expect(Math.round(tiny.previewRatio * 100)).toBe(74)
  expect(total(tiny)).toBeCloseTo(1, 10)

  // Dragging the navigation column (the new sidebar divider) behaves the same way: chat and tree
  // stay put and the preview absorbs the change.
  const nav = withShare(workspaceLayoutDefaults, "navigation", 40)
  expect(Math.round(nav.navigationRatio * 100)).toBe(40)
  expect(Math.round(nav.chatRatio * 100)).toBe(15)
  expect(Math.round(nav.treeRatio * 100)).toBe(13)
  expect(Math.round(nav.previewRatio * 100)).toBe(32)
  expect(total(nav)).toBeCloseTo(1, 10)

  // Editing the preview takes its room from the sidebar and the file tree only: chat keeps the
  // width Settings gave it, so widening the preview never squeezes the conversation.
  const fromPreview = withShare(workspaceLayoutDefaults, "preview", 20)
  expect(Math.round(fromPreview.previewRatio * 100)).toBe(20)
  expect(Math.round(fromPreview.chatRatio * 100)).toBe(15)
  // The remaining 65% splits between nav and tree in their original 12:13 ratio.
  expect(Math.round(fromPreview.navigationRatio * 100)).toBe(31)
  expect(Math.round(fromPreview.treeRatio * 100)).toBe(34)
  expect(total(fromPreview)).toBeCloseTo(1, 10)
})

test("out-of-range and malformed stored values are normalized instead of breaking the layout", () => {
  localStorage.setItem(
    "workspace:layout",
    JSON.stringify({ navigationRatio: 0.01, chatRatio: 5, treeRatio: 0.99, previewRatio: 0.5 })
  )
  const layout = loadWorkspaceLayout()
  expect(total(layout)).toBeCloseTo(1, 10)
  expect(layout.navigationRatio).toBeGreaterThanOrEqual(LAYOUT_SHARE_MIN.navigation)
  expect(layout.chatRatio).toBeLessThanOrEqual(LAYOUT_SHARE_MAX.chat)
  localStorage.setItem("workspace:layout", "{not json")
  expect(loadWorkspaceLayout()).toEqual(workspaceLayoutDefaults)
})

test("a layout saved before the 100% budget existed is migrated without losing its split", () => {
  // The old shape had no preview share at all: chat was measured against the workspace budget
  // and the tree inside the preview column.
  localStorage.setItem(
    "workspace:layout",
    JSON.stringify({ navigationRatio: 0.18, chatRatio: 0.5, treeRatio: 0.16 })
  )
  const layout = loadWorkspaceLayout()
  expect(total(layout)).toBeCloseTo(1, 10)
  // The old model split the workspace evenly between chat and preview, and the tree sat inside
  // the preview column — that relationship must survive, with the preview a real column.
  const shares = contentShares(layout)
  expect(shares.preview).toBeGreaterThan(0.4)
  expect(shares.chat).toBeGreaterThan(0.4)
  expect(shares.tree).toBeLessThan(0.12)
})

test("a layout left by the pixel-field build migrates instead of tearing the columns apart", () => {
  // Verbatim from a user's machine: the pre-share build persisted navigation/tree/preview in
  // pixels and only chat as a fraction. The 2160px preview was dragged on a wide window.
  localStorage.setItem(
    "workspace:layout",
    JSON.stringify({ navigationWidth: 248, chatRatio: 0.2, previewWidth: 2160, treeWidth: 240 })
  )
  const layout = loadWorkspaceLayout()
  expect(total(layout)).toBeCloseTo(1, 10)
  // No pixel width is carried into the share model, so a width dragged on a wide monitor can
  // never starve the chat column on a narrow one.
  const shares = contentShares(layout)
  expect(shares.chat).toBeGreaterThan(0.15)
  expect(shares.chat).toBeLessThan(0.25)
  expect(shares.preview).toBeGreaterThan(0.6)
})

test("a small preview share still leaves a usable column", () => {
  // Narrow workspace: the share can no longer be honoured, but the split must not collapse.
  const shares = contentShares(withShare(workspaceLayoutDefaults, "preview", 15))
  expect(requestedPreviewWidth(744, shares.preview, 0)).toBe(400)
})

test("the requested preview width never collapses the column", () => {
  // A dragged width that fits beside chat's floor wins.
  expect(requestedPreviewWidth(744, 0.1, 520)).toBe(400)
  expect(requestedPreviewWidth(1440, 0.1, 520)).toBe(520)
  // A share big enough is honoured as-is.
  expect(requestedPreviewWidth(1200, 0.5, 0)).toBe(600)
  // Too small to honour: fall back to the smallest split the budget can hold.
  expect(requestedPreviewWidth(744, 0.1, 0)).toBe(400)
  // Not even that fits: let the library pick, which is the only case that may show one column.
  expect(requestedPreviewWidth(700, 0.1, 0)).toBe(0)
})

test("a pixel width that would starve chat falls back to the shares", () => {
  // The regression behind "opening a conversation tears the four columns apart": a width
  // larger than the budget minus chat's floor must never reach the split-view library, which
  // would push chat onto its own screen and page the preview in at full viewport width.
  const shares = contentShares(workspaceLayoutDefaults)
  // 2160px dragged on a wide display, replayed on a 1200px workspace.
  expect(requestedPreviewWidth(1200, shares.preview, 2160)).toBe(
    requestedPreviewWidth(1200, shares.preview, 0)
  )
  // Just past the floor: chat would keep 319px, still unfit, so the share decides.
  expect(requestedPreviewWidth(1000, 0.5, 681)).toBe(500)
  // Exactly at the floor: chat keeps its 320px, the drag is honoured.
  expect(requestedPreviewWidth(1000, 0.5, 680)).toBe(680)
  // Shrinking the preview below the library's own minimum still passes through — that is the
  // gesture that deliberately moves chat to the next screen.
  expect(requestedPreviewWidth(744, 0.5, 300)).toBe(300)
})

test("a share that outgrows the workspace is narrowed instead of paging the columns", () => {
  // The migrated pixel-field layout wants an 80% preview column. On a 1227px workspace that
  // asks for 982px and leaves chat 245px — below the library's floor — so the split has to be
  // narrowed to the widest request that still keeps two columns, not declared unfit.
  expect(requestedPreviewWidth(1227, 0.8, 0)).toBe(907)
  expect(requestedPreviewWidth(1227, 0.8, 0)).toBeLessThanOrEqual(1227 - 320)
  // A wide window can honour the same share untouched.
  expect(requestedPreviewWidth(2400, 0.8, 0)).toBe(1920)
})
