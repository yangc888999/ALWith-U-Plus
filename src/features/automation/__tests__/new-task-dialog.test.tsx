import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeAll, beforeEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

const { openFolder, larkApi } = vi.hoisted(() => ({
  openFolder: vi.fn(),
  larkApi: { status: vi.fn(), auth: vi.fn(), targets: vi.fn() }
}))

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauri: () => true
}))
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openFolder }))
// The dialog only needs the catalog shape, not the settings bridge's IPC subscriptions.
vi.mock("@/lib/settings-bridge", () => ({ useSettingsNativeModels: () => undefined }))
vi.mock("@/lib/use-providers", () => ({ useProviders: () => null }))
// The dialog reads the default folder, the Lark CLI status and the Lark sign-in on open, and the
// target picker probes chats once it is expanded. Keeping those pending by default avoids React
// state updates outside act() while leaving the settled dialog (what these tests assert) unchanged;
// the Lark tests below resolve them explicitly.
vi.mock("@/bindings", () => ({
  commands: new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => {
      if (key === "larkCliStatus") return () => larkApi.status()
      if (key === "larkCliAuthStatus") return () => larkApi.auth()
      if (key === "larkCliTargets") return () => larkApi.targets()
      return () => new Promise(() => {})
    }
  })
}))
vi.mock("@/features/settings/sections/model-section", () => ({
  modelEntries: () => [
    {
      id: "gpt-6.1-sol",
      label: "GPT 6.1 Sol",
      // The real catalog names the ChatGPT group `chatgpt`; that id is what enables fast mode.
      groupId: "chatgpt",
      groupName: "ChatGPT",
      efforts: ["low", "medium", "high"],
      defaultEffort: "medium",
      available: true
    },
    {
      id: "gateway:qwen:qwen-flash",
      label: "Qwen Flash",
      groupId: "qwen",
      groupName: "Qwen",
      efforts: [],
      defaultEffort: null,
      available: true
    }
  ]
}))

import { DEFAULT_TASK_DRAFT, NewTaskDialog } from "../new-task-dialog"
import type { ScheduledTask } from "../types"

beforeAll(async () => {
  await initI18n("en")
})

beforeEach(() => {
  openFolder.mockReset()
  // 默认全部挂起：没有授权人本人、没有 CLI 状态，弹窗停在「推送关着」的初始态。
  larkApi.status.mockReset().mockImplementation(() => new Promise(() => {}))
  larkApi.auth.mockReset().mockImplementation(() => new Promise(() => {}))
  larkApi.targets.mockReset().mockImplementation(() => new Promise(() => {}))
})

const CLI_READY = { available: true, cliPath: "/usr/local/bin/lark-cli", version: "1.0.0", hint: "" }
const SIGNED_IN = {
  loggedIn: true,
  brand: "feishu",
  appId: "cli_a1",
  defaultIdentity: "auto",
  identities: [
    {
      kind: "user",
      available: true,
      status: "ready",
      userName: "测试同学",
      openId: "ou_self",
      tokenStatus: "valid",
      scopes: []
    },
    {
      kind: "bot",
      available: true,
      status: "ready",
      userName: null,
      openId: null,
      tokenStatus: null,
      scopes: []
    }
  ]
}

function renderDialog(onSubmit = vi.fn(), task: ScheduledTask | null = null) {
  const onOpenChange = vi.fn()
  const view = render(
    <NewTaskDialog open onOpenChange={onOpenChange} task={task} onSubmit={onSubmit} />
  )
  return { view, onSubmit, onOpenChange }
}

function fillRequiredFields(): void {
  fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "交易日切片更新" } })
  fireEvent.change(screen.getByLabelText("Add prompt"), { target: { value: "请更新" } })
}

test("a custom workspace is picked through the folder dialog, not typed in", async () => {
  openFolder.mockResolvedValue("/Users/flyme/Documents/YUP/部门")
  const { onSubmit } = renderDialog()
  fillRequiredFields()

  fireEvent.change(screen.getByLabelText("Select workspace"), { target: { value: "custom" } })
  const picker = screen.getByRole("button", { name: "Choose a folder…" })
  await act(async () => {
    fireEvent.click(picker)
  })

  expect(openFolder).toHaveBeenCalledWith(
    expect.objectContaining({ directory: true, multiple: false })
  )
  expect(screen.getByText("/Users/flyme/Documents/YUP/部门")).toBeTruthy()

  // A task can pin the model it runs on; the options come from the shared model catalog.
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "gateway:qwen:qwen-flash" }
  })
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }))
  })

  expect(onSubmit).toHaveBeenCalledOnce()
  expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
    cwd: "/Users/flyme/Documents/YUP/部门",
    model: "gateway:qwen:qwen-flash"
  })
})

test("custom workspace without a chosen folder cannot be submitted", () => {
  const { onSubmit } = renderDialog()
  fillRequiredFields()
  fireEvent.change(screen.getByLabelText("Select workspace"), { target: { value: "custom" } })

  const confirm = screen.getByRole("button", { name: /confirm/i }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  expect(onSubmit).not.toHaveBeenCalled()
})

test("the removed WeCom placeholder is no longer offered", () => {
  renderDialog()
  expect(screen.queryByText("Push messages to WeCom")).toBeNull()
  // Following the default model is still the out-of-the-box choice.
  expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("")
})

test("effort comes from the selected model and fast mode is GPT-only", async () => {
  const { onSubmit } = renderDialog()
  fillRequiredFields()

  // Nothing to pick before a model is chosen: the ladder belongs to the model.
  const effort = screen.getByLabelText("Reasoning effort") as HTMLSelectElement
  expect(effort.disabled).toBe(true)
  expect((screen.getByLabelText("Fast mode") as HTMLSelectElement).disabled).toBe(true)

  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-6.1-sol" } })
  await act(async () => undefined)
  expect((screen.getByLabelText("Reasoning effort") as HTMLSelectElement).disabled).toBe(false)
  expect(screen.getByRole("option", { name: "high" })).toBeTruthy()
  expect((screen.getByLabelText("Fast mode") as HTMLSelectElement).disabled).toBe(false)

  fireEvent.change(screen.getByLabelText("Reasoning effort"), { target: { value: "high" } })
  fireEvent.change(screen.getByLabelText("Fast mode"), { target: { value: "on" } })
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }))
  })

  expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
    model: "gpt-6.1-sol",
    effort: "high",
    fastMode: true
  })
})

test("switching to a non-GPT model clears the effort and hides fast mode", async () => {
  const { onSubmit } = renderDialog()
  fillRequiredFields()

  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-6.1-sol" } })
  await act(async () => undefined)
  fireEvent.change(screen.getByLabelText("Reasoning effort"), { target: { value: "high" } })
  fireEvent.change(screen.getByLabelText("Fast mode"), { target: { value: "on" } })

  // Qwen has no ladder in this fixture: keeping "high" would send an option it does not accept.
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gateway:qwen:qwen-flash" } })
  await act(async () => undefined)
  expect(screen.queryByRole("option", { name: "On" })).toBeNull()

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }))
  })
  expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
    model: "gateway:qwen:qwen-flash",
    effort: "",
    fastMode: false
  })
})

test("with no resolved Lark account yet, delivery stays off until it is switched on", async () => {
  const { onSubmit } = renderDialog()
  fillRequiredFields()

  fireEvent.click(screen.getByLabelText("Send the result to Lark (default)"))
  await act(async () => undefined)

  // Turning it on reveals the identity choice; targets are loaded lazily from the CLI.
  expect(screen.getByLabelText("Send as")).toBeTruthy()
  // Nothing selected yet: the dialog says so instead of saving a task that silently sends nowhere.
  expect(screen.getByText(/nothing will be sent/i)).toBeTruthy()

  // Delivery is on but no recipient has been selected: saving would create a task that
  // silently never sends anything, so the dialog must not let it through.
  expect(screen.getByRole("button", { name: /confirm/i }).hasAttribute("disabled")).toBe(true)
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }))
  })
  expect(onSubmit).not.toHaveBeenCalled()
})

test("a new task pushes to Lark by default, addressed to the signed-in user", async () => {
  larkApi.status.mockResolvedValue(CLI_READY)
  larkApi.auth.mockResolvedValue(SIGNED_IN)
  const { onSubmit } = renderDialog()
  fillRequiredFields()

  // 默认开：不用点任何东西，收件人就是授权人本人。
  await waitFor(() =>
    expect(
      screen.getByRole("switch", { name: "Send the result to Lark (default)" }).getAttribute("aria-checked")
    ).toBe("true")
  )
  expect(screen.getByLabelText("Send as")).toBeTruthy()
  // 收件人是异步补进来的（读 CLI 登录态 → 自动填本人），提交前等 chip 出现，别在两次更新之间点。
  await waitFor(() => expect(screen.getByText("测试同学")).toBeTruthy())

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }))
  })
  expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
    larkNotify: true,
    larkIdentity: "bot",
    larkTargets: [{ id: "ou_self", name: "测试同学", kind: "user" }]
  })
})

test("without the Lark CLI the toggle is disabled and points at the component installer", async () => {
  larkApi.status.mockResolvedValue({ available: false, cliPath: "", version: null, hint: "" })
  larkApi.auth.mockResolvedValue({
    loggedIn: false,
    brand: null,
    appId: null,
    defaultIdentity: null,
    identities: []
  })
  renderDialog()

  await waitFor(() => expect(screen.getByText(/not installed on this machine/i)).toBeTruthy())
  const toggle = screen.getByRole("switch", { name: "Send the result to Lark (default)" })
  // Base UI 把禁用态放在 data-disabled 上，不是原生 disabled 属性。
  expect(toggle.hasAttribute("disabled") || toggle.hasAttribute("data-disabled")).toBe(true)
  expect(screen.getByRole("button", { name: "Install" })).toBeTruthy()
  // 没装 CLI 就不该默认开：否则每个新任务都带一个必然发不出去的动作。
  expect(toggle.getAttribute("aria-checked")).toBe("false")
})

test("advanced settings are always visible, with one home for model / effort / fast", () => {
  renderDialog()

  // No collapsible wrapper and no section title (the flat redesign dropped it): the Lark switch is
  // in the DOM before any click, and every run control is editable right away.
  expect(screen.getByLabelText("Send the result to Lark (default)")).toBeTruthy()
  // Effort / fast used to be duplicated inside the collapsed section. One editable control each.
  expect(screen.getAllByLabelText("Model")).toHaveLength(1)
  expect(screen.getAllByLabelText("Reasoning effort")).toHaveLength(1)
  expect(screen.getAllByLabelText("Fast mode")).toHaveLength(1)
})

test("editing an existing task opens advanced settings without an extra click", () => {
  const task: ScheduledTask = {
    ...DEFAULT_TASK_DRAFT,
    id: "task-1",
    nextRunAt: null,
    monitorSessionId: null,
    createdAt: 0,
    updatedAt: 0,
    larkNotify: true
  }
  renderDialog(vi.fn(), task)

  expect(screen.getByLabelText("Send the result to Lark (default)")).toBeTruthy()
  // Turning it on for an existing task reveals the delivery fields without touching a collapse.
  expect(screen.getByLabelText("Send as")).toBeTruthy()
  expect(screen.getByText("Recipients")).toBeTruthy()
})

test("the recipient list stays folded until 添加对象 is clicked, and each open refreshes it", async () => {
  larkApi.status.mockResolvedValue(CLI_READY)
  larkApi.auth.mockResolvedValue(SIGNED_IN)
  larkApi.targets.mockResolvedValue([{ id: "oc_daily", name: "运营日报群", kind: "chat" }])
  renderDialog()

  await waitFor(() =>
    expect(
      screen.getByRole("switch", { name: "Send the result to Lark (default)" }).getAttribute("aria-checked")
    ).toBe("true")
  )
  // 折叠态：只有已选目标 + 添加对象这一个按钮，没有 tab / 搜索框，也还没去问 CLI 要群列表。
  expect(screen.queryByText("Chats")).toBeNull()
  expect(larkApi.targets).not.toHaveBeenCalled()

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /add recipient/i }))
  })
  expect(screen.getByText("Chats")).toBeTruthy()
  await waitFor(() => expect(larkApi.targets).toHaveBeenCalledTimes(1))
  expect(await screen.findByText("运营日报群")).toBeTruthy()

  // 收起再点开 = 重新拉一次，不吃上一轮的缓存。
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /add recipient/i }))
  })
  expect(screen.queryByText("Chats")).toBeNull()
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /add recipient/i }))
  })
  await waitFor(() => expect(larkApi.targets).toHaveBeenCalledTimes(2))
})
