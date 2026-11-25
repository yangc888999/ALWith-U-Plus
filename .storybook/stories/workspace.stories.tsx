import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactNode, useState } from "react"
import { expect, waitFor } from "storybook/test"

import { Button } from "../../src/components/ui/button"
import { ChatHeader } from "../../src/features/chat/chat-header"
import { getWorkspaceLayout, saveWorkspaceLayout } from "../../src/features/workspace/layout-preferences"
import { PreviewSurface } from "../../src/features/workspace/preview-surface"
import { WorkspacePanels } from "../../src/features/workspace/workspace-panels"

function WorkspaceExample({ width = 1200 }: { width?: number }): ReactNode {
  const [visible, setVisible] = useState(true)
  const [maximized, setMaximized] = useState(false)
  const [treeVisible, setTreeVisible] = useState(true)
  return (
    <div className="flex h-[700px] flex-col bg-sidebar p-1 text-foreground" style={{ width }}>
      <Button onClick={() => setVisible(true)}>Open preview</Button>
      <WorkspacePanels
        visible={visible}
        maximized={maximized}
        onVisibleChange={setVisible}
        onMaximizedChange={setMaximized}
        chat={
          <>
            <ChatHeader title="New chat">{null}</ChatHeader>
            <label className="p-4">
              Message
              <input aria-label="Message" className="border" />
            </label>
          </>
        }
        preview={
          <PreviewSurface
            treeVisible={treeVisible}
            onTreeVisibleChange={setTreeVisible}
            maximized={maximized}
            onMaximize={() => setMaximized((value) => !value)}
            onClose={() => {
              setVisible(false)
              setMaximized(false)
            }}
            tree={
              <div className="h-full">
                <Button onClick={() => setTreeVisible(false)}>Hide tree</Button>
                <p className="p-4">Project / notes.md</p>
              </div>
            }
            editor={({ leading, trailing }) => (
              <div className="alwith-editor">
                <div className="alwith-workspace-tabbar">
                  {leading}
                  <div className="alwith-workspace-tab-scroll">notes.md</div>
                  {trailing}
                </div>
                <label className="p-4">
                  Document
                  <textarea aria-label="Document" defaultValue="Retained draft" />
                </label>
              </div>
            )}
          />
        }
      />
    </div>
  )
}

const meta = {
  title: "Layout/Workspace",
  component: WorkspaceExample,
  beforeEach: () => {
    const original = getWorkspaceLayout()
    saveWorkspaceLayout({ navigationRatio: 0.16, chatRatio: 0.42, treeRatio: 0.12, previewRatio: 0.3 })
    return () => saveWorkspaceLayout(original)
  },
  parameters: { layout: "fullscreen" }
} satisfies Meta<typeof WorkspaceExample>
export default meta
type Story = StoryObj<typeof meta>

export const EqualPanels: Story = {
  play: async ({ canvasElement, canvas, userEvent }) => {
    const layout = canvasElement.querySelector<HTMLElement>(".file-workspace-layout")!
    const chat = canvasElement.querySelector<HTMLElement>(".file-workspace-chat")!
    const preview = canvasElement.querySelector<HTMLElement>(".file-workspace-panel")!
    await waitFor(async () => {
      const left = chat.getBoundingClientRect(),
        right = preview.getBoundingClientRect()
      await expect(left.width).toBe(layout.clientWidth / 2)
      await expect(right.width + 8).toBe(layout.clientWidth / 2)
      await expect(right.left - left.right).toBe(4)
      await expect(getComputedStyle(preview).borderRadius).toBe("14px")
    })
    await userEvent.type(canvas.getByRole("textbox", { name: "Message" }), "Keep this message")
    await userEvent.click(canvas.getByRole("button", { name: "Maximize" }))
    await waitFor(async () => {
      await expect(preview.getBoundingClientRect().width).toBe(layout.clientWidth - 8)
      await expect(chat.closest(".file-workspace-slide")).toHaveAttribute("inert")
    })
    await userEvent.click(canvas.getByRole("button", { name: "Restore" }))
    await waitFor(
      async () =>
        await expect(chat.getBoundingClientRect().width + preview.getBoundingClientRect().width + 8).toBe(
          layout.clientWidth
        )
    )
    await expect(canvas.getByRole("textbox", { name: "Message" })).toHaveValue("Keep this message")
    await userEvent.click(canvas.getByRole("button", { name: "Hide tree" }))
    await userEvent.click(canvas.getByRole("button", { name: "Show file tree" }))
    await waitFor(
      async () =>
        await expect(canvasElement.querySelector(".file-workspace-tree")).toHaveAttribute("data-collapsed", "false")
    )
    await userEvent.click(canvas.getByRole("button", { name: "Close preview" }))
    await waitFor(async () => expect(chat.getBoundingClientRect().width).toBe(layout.clientWidth))
    await userEvent.click(canvas.getByRole("button", { name: "Open preview" }))
    await waitFor(
      async () =>
        await expect(preview.getBoundingClientRect().width + chat.getBoundingClientRect().width + 8).toBe(
          layout.clientWidth
        )
    )
    await expect(canvas.getByRole("textbox", { name: "Document" })).toHaveValue("Retained draft")
  }
}

export const DarkPanels: Story = { ...EqualPanels, globals: { theme: "dark" } }

export const NarrowPanels: Story = {
  args: { width: 650 },
  play: async ({ canvasElement, canvas }) => {
    const viewport = canvasElement.querySelector<HTMLElement>(".file-workspace-layout")!
    const slides = canvasElement.querySelectorAll<HTMLElement>(".file-workspace-slide")
    await waitFor(async () => {
      await expect(slides[0].getBoundingClientRect().width).toBe(viewport.clientWidth)
      await expect(slides[1].getBoundingClientRect().width).toBe(viewport.clientWidth)
      await expect(canvas.getByRole("button", { name: "Next pane" })).toBeInTheDocument()
      await expect(canvas.queryByRole("button", { name: "Previous pane" })).toBeNull()
    })
  }
}

export const ResizeBoundaries: Story = {
  play: async ({ canvasElement, canvas, userEvent }) => {
    const layout = canvasElement.querySelector<HTMLElement>(".file-workspace-layout")!
    const divider = canvas.getByRole("separator", { name: "Resize workspace" })
    const preview = canvasElement.querySelector<HTMLElement>(".file-workspace-preview-slide")!
    await userEvent.click(divider)
    await userEvent.keyboard("{ArrowLeft}")
    await waitFor(async () => expect(preview.getBoundingClientRect().width).toBe(layout.clientWidth / 2 + 20))
    for (let index = 0; index < 12; index++) await userEvent.keyboard("{ArrowRight}")
    await waitFor(async () => {
      await expect(preview.getBoundingClientRect().width).toBe(layout.clientWidth)
      await expect(layout).toHaveAttribute("data-open", "true")
    })
    await userEvent.keyboard("{ArrowLeft}")
    await waitFor(async () => expect(preview.getBoundingClientRect().width).toBe(layout.clientWidth / 2 - 200))
    await userEvent.click(canvas.getByRole("separator", { name: "Resize workspace" }))
    for (let index = 0; index < 28; index++) await userEvent.keyboard("{ArrowLeft}")
    await waitFor(async () => {
      await expect(preview.getBoundingClientRect().width).toBe(layout.clientWidth)
      await expect(
        canvasElement.querySelector<HTMLElement>(".file-workspace-slide")!.getBoundingClientRect().width
      ).toBe(0)
    })
  }
}

export const WindowResize: Story = {
  play: async ({ canvasElement, canvas, userEvent }) => {
    const layout = canvasElement.querySelector<HTMLElement>(".file-workspace-layout")!
    const frame = layout.parentElement!
    const preview = canvasElement.querySelector<HTMLElement>(".file-workspace-preview-slide")!
    await waitFor(async () => expect(preview.getBoundingClientRect().width).toBe(layout.clientWidth / 2))
    frame.style.width = "1400px"
    await waitFor(async () => expect(preview.getBoundingClientRect().width).toBe(layout.clientWidth / 2))
    await userEvent.click(canvas.getByRole("separator", { name: "Resize workspace" }))
    await userEvent.keyboard("{ArrowLeft}")
    const draggedWidth = layout.clientWidth / 2 + 20
    const share = draggedWidth / layout.clientWidth
    await waitFor(async () => expect(preview.getBoundingClientRect().width).toBe(draggedWidth))
    frame.style.width = "1600px"
    await waitFor(async () => {
      const scaled = Math.round(share * layout.clientWidth)
      await expect(preview.getBoundingClientRect().width).toBe(scaled)
      await expect(
        canvasElement.querySelector<HTMLElement>(".file-workspace-slide")!.getBoundingClientRect().width
      ).toBe(layout.clientWidth - scaled)
    })
  }
}
