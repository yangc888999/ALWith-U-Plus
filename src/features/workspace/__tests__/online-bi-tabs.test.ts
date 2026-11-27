import { beforeEach, expect, test } from "vitest"

import {
  createOnlineBiTab,
  loadOnlineBiTabs,
  saveOnlineBiTabs,
  type OnlineBiTab
} from "../online-bi-tabs"
import { normalizeOnlineBiReportUrl } from "../online-bi"

beforeEach(() => localStorage.clear())

test("report URLs accept bi.finture.id paths and strip session-only parameters", () => {
  expect(normalizeOnlineBiReportUrl("personal_dashboard")).toBe("https://bi.finture.id/personal_dashboard")
  expect(normalizeOnlineBiReportUrl("/reports/sales?page=2&s=secret&embed=true&embed_options=show_padding")).toBe(
    "https://bi.finture.id/reports/sales?page=2"
  )
  expect(normalizeOnlineBiReportUrl("https://example.com/report")).toBeNull()
})

test("tabs persist labels, addresses and the active tab", () => {
  const tab = createOnlineBiTab("经营日报", "/reports/daily")
  if (tab === null) throw new Error("tab should be valid")
  saveOnlineBiTabs({ tabs: [tab], activeId: tab.id })
  expect(loadOnlineBiTabs("个人看板")).toEqual({ tabs: [tab], activeId: tab.id })
})

test("a fresh install promotes the old single-page address into the first tab", () => {
  localStorage.setItem("alwith:online-bi-path", "/reports/legacy")
  const state = loadOnlineBiTabs("个人看板")
  expect(state.tabs).toHaveLength(1)
  expect(state.tabs[0]?.label).toBe("个人看板")
  expect(state.tabs[0]?.url).toBe("https://bi.finture.id/reports/legacy")
  expect(state.activeId).toBe(state.tabs[0]?.id)
})

test("saved tab records with invalid addresses are discarded", () => {
  const valid = createOnlineBiTab("有效", "/reports/valid") as OnlineBiTab
  localStorage.setItem(
    "alwith:online-bi-tabs-v1",
    JSON.stringify({
      tabs: [
        valid,
        { id: "bad", label: "外部", url: "https://example.com/report" },
        { id: "bad-2", label: "", url: "/reports/empty-label" }
      ],
      activeId: "bad"
    })
  )
  expect(loadOnlineBiTabs("默认")).toEqual({ tabs: [valid], activeId: valid.id })
})
