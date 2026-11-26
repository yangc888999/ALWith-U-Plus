import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"

import { MeetingsGlyph, ScheduledTasksGlyph } from "../../src/features/layout/components/feature-glyphs"

function GlyphBoard() {
  const rows = [
    { label: "定时任务", Glyph: ScheduledTasksGlyph },
    { label: "会议", Glyph: MeetingsGlyph }
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {rows.map(({ label, Glyph }) => (
        <div key={label} className="rounded-xl border border-border/60 bg-background p-4">
          <div className="flex items-center gap-3 text-foreground">
            <span className="grid size-9 place-items-center rounded-[10px] bg-muted">
              <Glyph className="size-[18px]" />
            </span>
            <span className="grid size-10 place-items-center rounded-xl border border-border/60">
              <Glyph className="size-6" />
            </span>
            <span className="text-sm font-medium">{label}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

const meta = {
  title: "Layout/Feature glyphs",
  component: GlyphBoard,
  globals: { locale: "zh-CN" }
} satisfies Meta<typeof GlyphBoard>
export default meta
type Story = StoryObj<typeof meta>

export const Light: Story = {
  globals: { theme: "light", locale: "zh-CN" },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll('[data-feature-glyph="scheduled-tasks"]')).toHaveLength(2)
    await expect(canvasElement.querySelectorAll('[data-feature-glyph="meetings"]')).toHaveLength(2)
  }
}

export const Dark: Story = {
  ...Light,
  globals: { theme: "dark", locale: "zh-CN" }
}
