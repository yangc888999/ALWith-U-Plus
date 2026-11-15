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
      <ModelMenu {...chatModelMenu} sessionId="s1" options={sessionOptions(served) as never} disabled={false} />
    </ConversationProvider>
  )
}

/** Rows the open menu actually renders, in order. */
async function offeredRows(): Promise<string[]> {
  await userEvent.click(screen.getByTestId("model-trigger"))
  await waitFor(() =>
    expect(document.querySelectorAll("[data-slot='dropdown-menu-radio-item']").length).toBeGreaterThan(0)
  )
  return [...document.querySelectorAll("[data-slot='dropdown-menu-radio-item']")].map(
    (item) => item.textContent?.trim() ?? ""
  )
}

test("the dialog's model menu keeps an enabled model the recommended subset omitted, with no hint", async () => {
  saved.rows = [row("gpt-6.1-sol", "6.1 Sol"), row("gpt-6.1-terra", "6.1 Terra")]
  renderMenu(["gpt-6.1-sol"])

  // v1.0.3：会话 picker 只是推荐子集，没列出 Terra 不代表不可用。四处统一由
  // 「供应商与可用模型」shortlist 给出候选，且不再有「可能不可用 / 星号别名」这类私有标记。
  const rows = await offeredRows()
  expect(rows[0]).toBe("6.1 Sol")
  expect(rows[1]).toBe("6.1 Terra")
  expect(rows.join(" ")).not.toContain("may be unavailable")
  expect(rows.join(" ")).not.toContain("*")
})

test("回归：4 个已启用 GPT 在推荐子集只列 2 个时，聊天下拉仍全部可选且无提示", async () => {
  const four = [
    row("gpt-6-astra", "6 Astra"),
    row("gpt-6.1-sol", "6.1 Sol"),
    row("gpt-6.1-terra", "6.1 Terra"),
    row("gpt-6-luna", "6 Luna")
  ]
  saved.rows = four
  renderMenu(["gpt-6-astra", "gpt-6.1-sol"])

  const rows = await offeredRows()
  expect(rows).toEqual(["6 Astra", "6.1 Sol", "6.1 Terra", "6 Luna"])
  expect(rows.join(" ")).not.toContain("may be unavailable")
  expect(rows.join(" ")).not.toContain("*")
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
