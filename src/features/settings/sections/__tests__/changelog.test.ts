import { expect, test } from "vitest"

import changelog from "../../../../../CHANGELOG.md?raw"
import { parseChangeLog } from "../changelog"

test("the update-log dialog carries the shipped version and every bullet of it", () => {
  const groups = parseChangeLog(changelog)
  // CHANGELOG 按版本倒序维护；第一组必须就是当前发布版本，且要有本次修复的中文条目。
  expect(groups[0].version).toBe("1.0.9")
  expect(groups[0].items.length).toBeGreaterThan(0)
  expect(groups[0].items.join(" ")).toContain("按显示器记忆窗口尺寸")
  expect(groups[0].items.join(" ")).toContain("当前屏幕工作区")
  expect(groups[0].items.join(" ")).toContain("单一 ✕ 关闭按钮")
  // 上一版的四栏错位修复仍在日志里可读。
  const layout8 = groups.find((group) => group.version === "1.0.8")
  expect(layout8?.items.join(" ")).toContain("侧边栏被推到中间")
  // 更早一版的白屏修复仍在日志里可读。
  const boot = groups.find((group) => group.version === "1.0.7")
  expect(boot?.items.join(" ")).toContain("首次打开白屏")
  expect(boot?.items.join(" ")).toContain("首屏等待路径")
  // 更早一版的侧栏展开与四栏约束仍在日志里可读。
  const layout = groups.find((group) => group.version === "1.0.6")
  expect(layout?.items.join(" ")).toContain("完整展开模式")
  expect(layout?.items.join(" ")).toContain("四栏")
  // 更早一版的登录 / 侧边栏 / 窗口修复仍在日志里可读。
  const shipped = groups.find((group) => group.version === "1.0.5")
  expect(shipped?.items.join(" ")).toContain("口令登录卡顿")
  expect(shipped?.items.join(" ")).toContain("侧边栏无法展开")
  expect(shipped?.items.join(" ")).toContain("最大化")
  expect(shipped?.items.join(" ")).toContain("目标屏工作区")
  // 上一版的两条修复仍在日志里可读。
  const previous = groups.find((group) => group.version === "1.0.4")
  expect(previous?.items.join(" ")).toContain("正在安装更新")
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
