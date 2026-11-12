import { expect, test } from "vitest"

import changelog from "../../../../../CHANGELOG.md?raw"

import { parseChangeLog } from "../changelog"

test("every released version in CHANGELOG.md reaches the update-log dialog", () => {
  const groups = parseChangeLog(changelog)
  const versions = groups.map((group) => group.version)
  // The newest version leads, and the history readers asked for is actually present — including
  // 0.3.7, which the locale list had already dropped.
  expect(versions[0]).toBe("0.3.8")
  for (const version of ["0.3.7", "0.3.6", "0.3.5", "0.3.4", "0.2.29"]) {
    expect(versions).toContain(version)
  }
  // Bullets keep their text but lose the list punctuation the changelog uses.
  const newest = groups[0]
  expect(newest.items[0]).toBe("接入公司认证，支持选择公司模型（企业模型目录跨窗口即时刷新）")
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
