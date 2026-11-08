import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { useState } from "react"
import { afterEach, expect, test } from "vitest"

import { type MainScreen, MainSidebarLayout } from "@/features/layout/components/main-sidebar-layout"
import { client } from "@/lib/client"
import { initI18n } from "@/lib/i18n"
import { replaceAutomationSessionRows } from "@/lib/automation-sessions"

import { SessionSidebar } from "../session-sidebar"
import { useSessionsUiStore } from "../store"

await initI18n("zh-CN")

const originalState = client.state
const originalUi = useSessionsUiStore.getState()
afterEach(async () => {
  await act(async () => {
    cleanup()
    client.store.setState(originalState, true)
    useSessionsUiStore.setState(originalUi, true)
    replaceAutomationSessionRows([])
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})

function Harness() {
  const [screen, setScreen] = useState<MainScreen>("main")
  return (
    <MainSidebarLayout
      initialPinned
      screen={screen}
      leading={<main />}
      main={<main />}
      sidebar={
        <SessionSidebar
          screen={screen}
          leadingPage="plugins"
          selectedId={null}
          onSelect={() => {}}
          onNewChat={() => {}}
          onNewProjectChat={() => {}}
          onSearch={() => {}}
          onOpenSettings={() => {}}
          onOpenPlugins={() => {}}
          onOpenExtensions={() => {}}
          onOpenAutomation={() => {}}
          onSwitchScreen={() => setScreen(screen === "main" ? "leading" : "main")}
        />
      }
    />
  )
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

test("the chat section expands past its preview and collapses back to it", async () => {
  const cwd = "/Users/leo/Documents/ALwith"
  client.store.setState({
    sessionListLoaded: true,
    connection: "ready",
    agent: null,
    sessionList: Array.from({ length: 8 }, (_, index) => ({
      sessionId: `s-${index}`,
      title: `chat ${index}`,
      cwd,
      updatedAt: `2026-10-0${(index % 9) + 1}T10:00:00Z`,
      archived: false
    }))
  })

  const view = render(<Harness />)
  await settle()

  const rows = () => view.container.querySelectorAll("[data-session-id]").length
  expect(rows()).toBe(3)

  const expand = view.getByRole("button", { name: "展开显示" })
  // The row carries a chevron so it reads as a control, not as plain text.
  expect(expand.querySelector(".lucide-chevron-down")).toBeTruthy()
  expect(expand.querySelector(".rotate-180")).toBeNull()

  fireEvent.click(expand)
  await settle()

  const collapse = view.getByRole("button", { name: "收起显示" })
  // Virtualization decides how many of the revealed rows actually mount, so only the growth and
  // the presence of a late row are asserted.
  expect(rows()).toBeGreaterThan(3)
  expect(view.getByText("chat 6")).toBeTruthy()
  expect(collapse.querySelector(".rotate-180")).toBeTruthy()

  fireEvent.click(collapse)
  await settle()

  expect(rows()).toBe(3)
  expect(view.getByRole("button", { name: "展开显示" })).toBeTruthy()
})

test("scheduled runs live in their own section instead of the project groups", async () => {
  client.store.setState({
    sessionListLoaded: true,
    connection: "ready",
    agent: null,
    sessionList: [
      {
        sessionId: "typed-1",
        title: "帮我看下这笔交易",
        cwd: "/Users/leo/Documents/ALwith",
        updatedAt: "2026-11-04T10:00:00Z",
        archived: false
      }
    ]
  })
  replaceAutomationSessionRows([
    {
      sessionId: "run-1",
      title: "# 提额监控表盘每日更新任务",
      cwd: "/Users/leo/Documents/ALwith",
      updatedAt: "2026-11-04T09:00:00Z",
      archived: false
    }
  ])

  const view = render(<Harness />)
  await settle()

  // Its own section, open to the five newest monitors: a scheduled task is a peer of 聊天/项目,
  // not a folder inside 项目, so the row is visible without a click. The heading is 定时任务 now
  // that one task maps to one persistent monitor conversation instead of daily run rows.
  const header = view.getByRole("button", { name: "定时任务 (1)" })
  expect(view.getByText("提额监控表盘每日更新任务")).toBeTruthy()
  // The markdown heading marker is a prompt artifact, not part of the conversation's name.
  expect(view.queryByText("# 提额监控表盘每日更新任务")).toBeNull()

  // The heading still collapses it.
  fireEvent.click(header)
  await settle()
  expect(view.queryByText("提额监控表盘每日更新任务")).toBeNull()
})
