import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect } from "storybook/test"

import type { WorkbenchFeatureId } from "../../src/features/layout/components/workbench-features"
import { WorkbenchOverview } from "../../src/features/layout/components/workbench-overview"

function OverviewPreview() {
  const [opened, setOpened] = useState<WorkbenchFeatureId | null>(null)
  return (
    <div className="h-[640px] w-[920px] max-w-full bg-background">
      <WorkbenchOverview onOpen={setOpened} />
      <output aria-label="Opened workbench page" className="sr-only">
        {opened ?? ""}
      </output>
    </div>
  )
}

const meta = {
  title: "Layout/Workbench overview",
  component: OverviewPreview,
  globals: { locale: "zh-CN", theme: "light" }
} satisfies Meta<typeof OverviewPreview>
export default meta
type Story = StoryObj<typeof meta>

export const Overview: Story = {
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByRole("heading", { name: "工作台" })).toBeVisible()
    for (const heading of ["能力", "工作流", "记录"]) await expect(canvas.getByText(heading)).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: /^插件/ }))
    await expect(canvas.getByLabelText("Opened workbench page")).toHaveTextContent("plugins")
  }
}
