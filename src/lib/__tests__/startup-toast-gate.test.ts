import { expect, test, vi } from "vitest"

// 每个用例都重新加载模块：既要拿到未被包装过的 sonner，也要拿到与该包装同一实例的静默窗状态。
async function freshToast() {
  vi.resetModules()
  const gate = await import("../startup-window")
  const { toast } = await import("sonner")
  const shown = vi.spyOn(toast, "error")
  const { installToastErrorLocalization } = await import("../toast-error")
  installToastErrorLocalization()
  return { toast, shown, gate }
}

test("an error toast during the startup window only reaches the log", async () => {
  const { toast, shown, gate } = await freshToast()
  gate.armStartupWindow()

  toast.error("The agent is not connected")

  expect(shown).not.toHaveBeenCalled()
})

test("once the engine is ready, the same error goes to the screen again", async () => {
  const { toast, shown, gate } = await freshToast()
  gate.armStartupWindow()
  gate.markStartupReady()

  toast.error("The agent is not connected")

  expect(shown).toHaveBeenCalledOnce()
})

test("a startup that never completes starts reporting after the fallback", async () => {
  const { toast, shown, gate } = await freshToast()
  gate.armStartupWindow()
  gate.expireStartupWindow()

  toast.error("The agent is not connected")

  expect(shown).toHaveBeenCalledOnce()
})
