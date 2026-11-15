// 分流（frontend 侧跑，群记录存在 localStorage 里）：会议行必须离开 项目列表、进入 群聊面板 —— 即使群记录还没写（新建会议）、或记录还指着
// Groups 根（遗留数据）、或历史恢复带旧拼写。判定只有一处（`groupSessionKind`），client 的分流与
// 两个面板共用它，所以这里通过公开入口 `listSessions()` 观察结果。

import { afterEach, beforeEach, expect, test } from "vitest"

import { groupSessionRows, replaceGroupSessionRows } from "@/lib/group-sessions"
import { setGroup, type GroupConfig } from "@/lib/groups"

import { CodexClient } from "@/agent/client"
import { createFakeAgent } from "@/agent/__tests__/fake-agent"
import { FakeHubPort } from "@/agent/__tests__/fake-runtime-client"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop()
})
beforeEach(() => {
  localStorage.clear()
  replaceGroupSessionRows([])
})

async function make() {
  const fake = createFakeAgent()
  const port = new FakeHubPort(() => fake.app)
  const client = new CodexClient(() => Promise.resolve(port), { agentId: "codex", launch: { engine: "codex" } })
  await client.connect()
  cleanups.push(() => client.disconnect())
  return { client, fake }
}

const ROOT = "/Users/me/Documents/ALWith/groups"

function group(directory: string): GroupConfig {
  return {
    id: "g-meeting",
    name: "定价会",
    roles: [],
    rounds: 2,
    directory,
    document: `${directory}/group.md`,
    topic: "",
    focus: "",
    materialFolders: [],
    sessionId: null,
    autoDiscuss: true
  }
}

test("a meeting leaves 项目 by its folder alone, before any group record exists", async () => {
  const { client, fake } = await make()
  fake.listSessions.current = () => ({
    sessions: [
      { sessionId: "meeting", cwd: `${ROOT}/定价会`, title: "定价会" },
      { sessionId: "nested", cwd: `${ROOT}/定价会/资料`, title: "资料" },
      { sessionId: "project", cwd: "/Users/me/code/app", title: "App" }
    ]
  })

  await client.listSessions()

  // 项目 keeps only the real project.
  expect(client.state.sessionList.map((row) => row.sessionId)).toEqual(["project"])
  // Both meeting conversations are available to 群聊.
  expect(groupSessionRows().map((row) => row.sessionId).sort()).toEqual(["meeting", "nested"])
})

test("a legacy record pinned on the Groups root still diverts its row", async () => {
  const { client, fake } = await make()
  setGroup(group(ROOT))
  fake.listSessions.current = () => ({
    sessions: [
      { sessionId: "legacy", cwd: ROOT, title: "旧会议" },
      { sessionId: "project", cwd: "/Users/me/code/app", title: "App" }
    ]
  })

  await client.listSessions()

  expect(client.state.sessionList.map((row) => row.sessionId)).toEqual(["project"])
  expect(groupSessionRows().map((row) => row.sessionId)).toEqual(["legacy"])
})

test("a saved group record still wins for its own directory", async () => {
  const { client, fake } = await make()
  setGroup(group(`${ROOT}/定价会`))
  fake.listSessions.current = () => ({
    sessions: [{ sessionId: "meeting", cwd: `${ROOT}/定价会`, title: "定价会" }]
  })

  await client.listSessions()

  expect(client.state.sessionList).toEqual([])
  expect(groupSessionRows().map((row) => row.sessionId)).toEqual(["meeting"])
})

test("scheduled runs and normal projects keep their own roads", async () => {
  const { client, fake } = await make()
  fake.listSessions.current = () => ({
    sessions: [
      { sessionId: "run", cwd: "/Users/me/code/app", title: "# 提额监控表盘每日更新任务" },
      { sessionId: "project", cwd: "/Users/me/code/app", title: "App" }
    ]
  })

  await client.listSessions()

  // The automation heading is not a meeting: it belongs to 定时任务, and both rows keep their
  // destinations — only the run leaves 项目.
  expect(client.state.sessionList.map((row) => row.sessionId)).toEqual(["project"])
  expect(groupSessionRows()).toEqual([])
})
