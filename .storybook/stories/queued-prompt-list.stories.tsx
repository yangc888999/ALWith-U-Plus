import { createSession, type Session } from "@alwith/api"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactNode, useEffect, useMemo } from "react"
import { expect, waitFor } from "storybook/test"

import { QueuedPromptList } from "../../src/features/chat/composer/queued-prompt-list"
import { beginQueuedPrompt, cancelQueuedPrompt, pauseQueuedPrompts } from "../../src/lib/queued-prompt"

function QueuedPreview(): ReactNode {
  const session = useMemo(
    () => ({ ...createSession("queued-prompt-preview", "/Projects/alwith") }) as Session,
    []
  )
  useEffect(() => {
    beginQueuedPrompt(session.id, "测算")
    beginQueuedPrompt(session.id, "看一下这张图里的指标异常", {
      body: "看一下这张图里的指标异常",
      image: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23202024'/%3E%3Crect x='8' y='38' width='6' height='16' fill='%23e15d4f'/%3E%3Crect x='18' y='28' width='6' height='26' fill='%23e15d4f'/%3E%3Crect x='28' y='20' width='6' height='34' fill='%23ff9b8e'/%3E%3Crect x='38' y='32' width='6' height='22' fill='%23e15d4f'/%3E%3Crect x='48' y='12' width='6' height='42' fill='%23ff9b8e'/%3E%3C/svg%3E",
      imageCount: 2
    })
    return () => cancelQueuedPrompt(session.id)
  }, [session.id])
  return (
    <div className="w-[640px] max-w-full rounded-2xl border border-border/60 p-4">
      <QueuedPromptList session={session} />
    </div>
  )
}

const meta = {
  title: "Chat/Queued prompts",
  component: QueuedPreview,
  globals: { locale: "zh-CN" }
} satisfies Meta<typeof QueuedPreview>
export default meta
type Story = StoryObj<typeof meta>

export const Waiting: Story = {
  play: async ({ canvas, canvasElement }) => {
    const rows = await canvas.findAllByRole("listitem")
    await expect(rows).toHaveLength(2)
    await expect(rows[0]).toHaveTextContent("测算")
    await expect(rows[1]).toHaveTextContent("看一下这张图里的指标异常")
    await expect(canvasElement.querySelector('[data-queued-prompt-image] img')).not.toBeNull()
    await expect(canvas.getAllByRole("button", { name: "插队到当前轮" })).toHaveLength(2)
    await expect(canvas.getAllByRole("button", { name: "编辑排队消息" })).toHaveLength(2)
    await expect(canvas.getAllByRole("button", { name: "删除排队消息" })).toHaveLength(2)
    await waitFor(async () => {
      const list = canvasElement.querySelector<HTMLElement>("[data-queued-prompt-list]")!
      for (const row of rows)
        await expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(list.getBoundingClientRect().right)
    })
  }
}

function PausedPreview(): ReactNode {
  const session = useMemo(() => ({ ...createSession("queued-prompt-paused", "/Projects/alwith") }) as Session, [])
  useEffect(() => {
    beginQueuedPrompt(session.id, "继续分析净利润")
    beginQueuedPrompt(session.id, "再补一张图", { image: "data:image/png;base64,AAAA", imageCount: 1 })
    pauseQueuedPrompts(session.id, "model-error")
    return () => cancelQueuedPrompt(session.id)
  }, [session.id])
  return (
    <div className="w-[640px] max-w-full rounded-2xl border border-border/60 p-4">
      <QueuedPromptList session={session} />
    </div>
  )
}

export const Paused: Story = {
  render: () => <PausedPreview />,
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("队列已暂停")).toBeTruthy()
    await expect(canvas.getByRole("button", { name: "继续发送" })).toBeEnabled()
    await expect(canvas.getByRole("button", { name: "清空队列" })).toBeEnabled()
    for (const button of canvas.getAllByRole("button", { name: "插队到当前轮" }))
      await expect(button).toBeDisabled()
  }
}
