import { ConversationProvider, ModelMenu } from "@alwith/module-chat/conversation"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, test, vi } from "vitest"

import type { CustomModel } from "@/lib/providers"

/** 可用模型 as the app stores it. A withdrawn model stays here until the provider returns it. */
const saved = vi.hoisted(() => ({ rows: [] as CustomModel[] }))
vi.mock("@/lib/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers")>()
  return {
    ...actual,
    nativeModelOverrides: () => saved.rows,
    getProviderSnapshot: () => null
  }
})

const { chatModelMenu } = await import("../model-catalog")

function row(apiId: string, label: string): CustomModel {
  return { api_id: apiId, label, enabled: true } as CustomModel
}

/**
 * The dialog's menu is built from the catalog the session was prepared with. `served` is what that
 * catalog names — the engine's own answer to "what can run".
 */
function sessionOptions(served: string[]) {
  return [
    {
      configId: "model",
      category: "model",
      type: "select",
      currentValue: served[0],
      options: [
        {
          groupId: "chatgpt",
          name: "ChatGPT",
          options: served.map((id) => ({ value: id, name: id.toUpperCase() }))
        }
      ]
    }
  ]
}

/** The menu only needs a host for translations and a client for `configPending` + config writes. */
function renderMenu(served: string[]): void {
  const client = {
    store: { subscribe: () => () => {}, getState: () => ({ configPending: {} }) },
    setConfig: vi.fn()
  }
  const host = { t: (key: string) => key, reportError: vi.fn() }
  render(
    <ConversationProvider host={host as never} client={client as never}>
      <ModelMenu
        {...chatModelMenu}
        sessionId="s1"
        options={sessionOptions(served) as never}
        disabled={false}
      />
    </ConversationProvider>
  )
}

/** Rows the open menu actually renders, in order. */
async function offeredRows(): Promise<string[]> {
  await userEvent.click(screen.getByTestId("model-trigger"))
  await waitFor(() => expect(document.querySelectorAll("[data-slot='dropdown-menu-radio-item']").length).toBeGreaterThan(0))
  return [...document.querySelectorAll("[data-slot='dropdown-menu-radio-item']")].map(
    (item) => item.textContent?.trim() ?? ""
  )
}

test("the dialog's model menu keeps a saved model the engine stopped serving, with a hint", async () => {
  saved.rows = [row("gpt-6.1-sol", "6.1 Sol"), row("gpt-6.1-terra", "6.1 Terra")]
  renderMenu(["gpt-6.1-sol"])

  // Still one request-free list; the row is present and labelled as possibly unavailable.
  const rows = await offeredRows()
  expect(rows[0]).toBe("6.1 Sol")
  expect(rows[1]).toContain("6.1 Terra")
  expect(rows[1]).toContain("may be unavailable")
})

test("the same row returns as soon as the engine lists it again", async () => {
  saved.rows = [row("gpt-6.1-sol", "6.1 Sol"), row("gpt-6.1-terra", "6.1 Terra")]
  renderMenu(["gpt-6.1-sol", "gpt-6.1-terra"])

  expect(await offeredRows()).toEqual(["6.1 Sol", "6.1 Terra"])
})

test("a menu opening sends nothing to the engine", async () => {
  saved.rows = [row("gpt-6.1-sol", "6.1 Sol")]
  const setConfig = vi.fn()
  const client = {
    store: { subscribe: () => () => {}, getState: () => ({ configPending: {} }) },
    setConfig
  }
  const host = { t: (key: string) => key, reportError: vi.fn() }
  render(
    <ConversationProvider host={host as never} client={client as never}>
      <ModelMenu
        {...chatModelMenu}
        sessionId="s1"
        options={sessionOptions(["gpt-6.1-sol"]) as never}
        disabled={false}
      />
    </ConversationProvider>
  )

  await userEvent.click(screen.getByTestId("model-trigger"))
  await waitFor(() =>
    expect(document.querySelectorAll("[data-slot='dropdown-menu-radio-item']").length).toBeGreaterThan(0)
  )
  // Opening the picker used to write the current model back so the agent would restate its
  // catalog; that round trip is what kept the trigger spinning. Nothing is written now.
  expect(setConfig).not.toHaveBeenCalled()
})
