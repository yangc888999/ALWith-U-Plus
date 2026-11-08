import { beforeEach, expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"

const host = vi.hoisted(() => ({
  prompt: vi.fn(async (_id: string, _blocks: unknown[]) => "receipt"),
  info: vi.fn(async () => {}),
  error: vi.fn()
}))

vi.mock("@/lib/client", () => ({ client: { prompt: host.prompt } }))
vi.mock("@tauri-apps/plugin-log", () => ({ info: host.info }))
vi.mock("sonner", () => ({ toast: { error: host.error } }))

await initI18n("zh-CN")
const { nudgeTurn } = await import("../nudge-turn")

beforeEach(() => {
  host.prompt.mockClear()
  host.error.mockClear()
})

test("a nudge is an ordinary prompt into the turn that is already running", async () => {
  await nudgeTurn({ id: "chat-1" } as never)
  // Same path the composer takes mid-turn, so the nudge lands in the transcript as the message it
  // is and no second mechanism has to be kept in sync.
  expect(host.prompt).toHaveBeenCalledWith("chat-1", [{ type: "text", text: "继续" }])
})

test("a refused nudge is reported instead of vanishing", async () => {
  host.prompt.mockRejectedValueOnce(new Error("a turn is already running"))
  await nudgeTurn({ id: "chat-1" } as never)
  // nudgeTurn deliberately does not block on the prompt (it settles when the turn ends), so the
  // rejection arrives a microtask later.
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(host.error).toHaveBeenCalled()
})
