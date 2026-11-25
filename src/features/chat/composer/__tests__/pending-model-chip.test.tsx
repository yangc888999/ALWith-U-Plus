import { createSession } from "@alwith/api"
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

import { client } from "@/lib/client"
import { initI18n } from "@/lib/i18n"

import { PendingModelChip } from "../pending-model-chip"

await initI18n("en")

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test("a parked switch names both the current and the next-turn model", async () => {
  const session = {
    ...createSession("pending-chip", "/tmp/project"),
    configOptions: [
      {
        type: "select" as const,
        configId: "model",
        name: "Model",
        category: "model",
        currentValue: "gpt-6.2-sol",
        options: [
          { value: "gpt-6.2-sol", name: "6.2 Sol" },
          { value: "gpt-6.2-astra", name: "6.2 Astra" }
        ]
      }
    ]
  }
  vi.spyOn(client, "pendingModelFor").mockReturnValue("gpt-6.2-astra")
  const apply = vi.spyOn(client, "applyPendingModelNow").mockResolvedValue()
  const view = render(<PendingModelChip session={session} />)
  const chip = view.getByRole("status")
  expect(chip.textContent).toContain("6.2 Sol")
  expect(chip.textContent).toContain("→")
  expect(chip.textContent).toContain("6.2 Astra")
  expect(chip.textContent?.toLowerCase()).toContain("next")
  await act(() => Promise.try(() => fireEvent.click(chip)))
  expect(apply).toHaveBeenCalledWith("pending-chip")
})
