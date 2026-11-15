import { expect, test } from "vitest"

import changelog from "../../../../../CHANGELOG.md?raw"

import { parseChangeLog } from "../changelog"

test("the update-log dialog carries the shipped version and every bullet of it", () => {
  const groups = parseChangeLog(changelog)
  // 1.0.0 是当前唯一在维护的版本：旧版本条目已从 CHANGELOG 清掉，对话框只呈现这一版。
  expect(groups.map((group) => group.version)).toEqual(["1.0.0"])
  expect(groups[0].items).toHaveLength(18)
  expect(groups[0].items[0]).toContain("拉会脑暴")
  expect(groups[0].items.at(-1)).toContain("聊天项目")
})

test("a heading that is not a bare version ends the previous group", () => {
  const groups = parseChangeLog(
    ["# Changelog", "", "## 0.3.8", "* 第一条；", "* 第二条", "", "## 0.1.0 (unreleased)", "* English only", "", "## 0.0.9", "* 旧版本"].join("\n")
  )
  expect(groups).toEqual([
    { version: "0.3.8", items: ["第一条", "第二条"] },
    { version: "0.0.9", items: ["旧版本"] }
  ])
})

test("versions without bullets are left out instead of rendering as empty sections", () => {
  expect(parseChangeLog("## 0.3.8\n\n## 0.3.7\n* 只有一条")).toEqual([{ version: "0.3.7", items: ["只有一条"] }])
})
