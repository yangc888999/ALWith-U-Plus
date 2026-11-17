import pkg from "../../../../../package.json"

import { expect, test } from "vitest"

import changelog from "../../../../../CHANGELOG.md?raw"
import { parseChangeLog } from "../changelog"

test("the update-log dialog carries the shipped version and every bullet of it", () => {
  const groups = parseChangeLog(changelog)
  // CHANGELOG 按版本倒序维护；第一组必须就是当前发布版本，且要有本次修复的中文条目。
  // 版本号跟随 package.json，避免每次发版都要改测试。
  expect(groups[0].version).toBe(pkg.version)
  expect(groups[0].items.length).toBeGreaterThan(0)
  // 1.2.0 起更新日志只保留「本次发版 + 1.0.0 特性清单」：历史逐版条目已按产品要求删除
  // （2026-11-17）。这里只守住三条不变式：最新一组等于当前版本、非空、含中文。
  expect(groups[0].items.length).toBeGreaterThan(0)
  expect(groups[0].items.join(" ")).toMatch(/[\u4e00-\u9fa5]/)
  // 唯一保留的历史组是 1.0.0 的功能清单，它必须还在。
  const shipped = groups.find((group) => group.version === "1.0.0")
  expect(shipped?.items.length ?? 0).toBeGreaterThan(0)
})

test("a heading that is not a bare version ends the previous group", () => {
  const groups = parseChangeLog(
    [
      "# Changelog",
      "",
      "## 0.3.8",
      "* 第一条；",
      "* 第二条",
      "",
      "## 0.1.0 (unreleased)",
      "* English only",
      "",
      "## 0.0.9",
      "* 旧版本"
    ].join("\n")
  )
  expect(groups).toEqual([
    { version: "0.3.8", items: ["第一条", "第二条"] },
    { version: "0.0.9", items: ["旧版本"] }
  ])
})

test("versions without bullets are left out instead of rendering as empty sections", () => {
  expect(parseChangeLog("## 0.3.8\n\n## 0.3.7\n* 只有一条")).toEqual([{ version: "0.3.7", items: ["只有一条"] }])
})
