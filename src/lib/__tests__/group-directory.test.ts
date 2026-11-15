// 拉会（群聊）与项目的区隔，靠的是**路径形状**，不是「有没有一条群记录」。
//
// 原来的判定只有 `groupByDirectory(cwd)`：新建会议在群记录写入之前就有会话、历史恢复的会话可能带
// 旧拼写、修好的/从未绑定的会议可能仍指着 Groups 根。这些行因此漏过分流，被侧栏当项目列出来。
// 这里把形状判定钉死：Groups 根不算会议，Groups 下面的任何层级都算，其他路径一律不算。

import { expect, test } from "vitest"

import { isGroupDirectory } from "@/lib/groups"
import { groupsFolderName, isGroupsRootDirectory } from "@/lib/path"

const HOME = "/Users/me"
const ROOT = `${HOME}/Documents/ALWith/groups`

test("anything inside the Groups folder is a meeting", () => {
  expect(isGroupDirectory(`${ROOT}/定价会`)).toBe(true)
  expect(isGroupDirectory(`${ROOT}/定价会/`)).toBe(true)
  // Nested material/output folders belong to the same meeting.
  expect(isGroupDirectory(`${ROOT}/定价会/资料`)).toBe(true)
  expect(isGroupDirectory(`${ROOT}/定价会/资料/2026`)).toBe(true)
})

test("the Groups root itself is not a meeting", () => {
  // The retired "attach" flow pointed records at the root; opening it as a project would list every
  // meeting at once, and calling it a meeting would file every meeting under one bogus folder.
  expect(isGroupDirectory(ROOT)).toBe(false)
  expect(isGroupDirectory(`${ROOT}/`)).toBe(false)
  expect(isGroupsRootDirectory(ROOT)).toBe(true)
  expect(groupsFolderName(ROOT)).toBeNull()
})

test("an ordinary project is never mistaken for a meeting", () => {
  expect(isGroupDirectory(`${HOME}/code/app`)).toBe(false)
  expect(isGroupDirectory("/tmp/project")).toBe(false)
  // Same leaf name, different parent: a project may legitimately be called 定价会.
  expect(isGroupDirectory(`${HOME}/Documents/Other/定价会`)).toBe(false)
  expect(isGroupDirectory("")).toBe(false)
  expect(isGroupDirectory(null)).toBe(false)
  expect(isGroupDirectory(undefined)).toBe(false)
})

test("case, trailing slashes and Windows separators do not change the answer", () => {
  // The on-disk spelling mixes ALwith / ALWith / ALWITH on case-insensitive macOS volumes.
  expect(isGroupDirectory(`${HOME}/documents/alwith/GROUPS/定价会`)).toBe(true)
  expect(isGroupDirectory(`${HOME}/Documents/ALWITH/Groups/定价会//`)).toBe(true)
  expect(isGroupDirectory(`  ${ROOT}/定价会  `)).toBe(true)
  expect(isGroupDirectory("C:\\Users\\me\\Documents\\ALWith\\groups\\定价会")).toBe(true)
  expect(isGroupDirectory("C:\\Users\\me\\Documents\\ALWith\\groups")).toBe(false)
  // The leaf keeps its own case: it is a folder name, not a fixed segment.
  expect(groupsFolderName(`${ROOT}/定价会`)).toBe("定价会")
})

test("the folder name is the first segment below the root", () => {
  expect(groupsFolderName(`${ROOT}/定价会`)).toBe("定价会")
  expect(groupsFolderName(`${ROOT}/定价会/资料`)).toBe("定价会")
  expect(groupsFolderName(`${HOME}/code/app`)).toBeNull()
  expect(groupsFolderName(null)).toBeNull()
})

test("a path that only mentions the segments later is still located", () => {
  // Home may itself be nested under anything; the fixed triple is searched from the end.
  expect(isGroupDirectory(`/Volumes/Work/Users/me/Documents/ALWith/groups/周会`)).toBe(true)
  expect(groupsFolderName(`/Volumes/Work/Users/me/Documents/ALWith/groups/周会`)).toBe("周会")
})
