import { expect, test } from "vitest"

import changelog from "../../../../../CHANGELOG.md?raw"
import { parseChangeLog } from "../changelog"

test("the update-log dialog carries the shipped version and every bullet of it", () => {
  const groups = parseChangeLog(changelog)
  // CHANGELOG 按版本倒序维护；第一组必须就是当前发布版本，且要有本次修复的中文条目。
  expect(groups[0].version).toBe("1.0.4")
  expect(groups[0].items.length).toBeGreaterThan(0)
  expect(groups[0].items.join(" ")).toContain("正在安装更新")
  // 历史条目仍完整可读，1.0.0 的 18 条一条都不能少。
  const initial = groups.find((group) => group.version === "1.0.0")
  expect(initial).toBeDefined()
  expect(initial?.items).toHaveLength(18)
  expect(initial?.items[0]).toContain("拉会脑暴")
  expect(initial?.items.at(-1)).toContain("聊天项目")
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
