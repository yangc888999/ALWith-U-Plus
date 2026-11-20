import { beforeEach, expect, test, vi } from "vitest"
import { adoptRemoteAccent, useAccentStore } from "../accent-store"

const payload = (accent: string): string => JSON.stringify({ state: { accent } })

beforeEach(() => {
  useAccentStore.setState({ accent: "yup-red" })
})

// 两个窗口（主窗口 + 设置窗口）各持一份 zustand store，跨窗口只靠 localStorage 的 storage 事件同步。
// persist 每次 setState 都会再写一次 localStorage，那次写入又会在另一个窗口触发 storage 事件——
// 只要两边各持一个不同的值，就会互相采纳、互相回写，永不停歇。现场表现就是强调色在「柠檬绿 ⇄ 少女粉」
// 之间一直切，整窗色调跟着闪。所以「值本来一致」必须直接返回，不能回写。
test("a remote accent is adopted once and never echoed back", () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem")
  adoptRemoteAccent(payload("girly-pink"))
  expect(useAccentStore.getState().accent).toBe("girly-pink")
  // persist writes on every state change — that write IS the echo that starts the loop.
  expect(setItem).toHaveBeenCalled()

  setItem.mockClear()
  adoptRemoteAccent(payload("girly-pink"))
  expect(setItem).not.toHaveBeenCalled()
  expect(useAccentStore.getState().accent).toBe("girly-pink")

  // A genuinely different value still lands — the guard must not freeze cross-window sync.
  adoptRemoteAccent(payload("lemon-green"))
  expect(useAccentStore.getState().accent).toBe("lemon-green")
  setItem.mockRestore()
})

test("malformed or empty payloads leave the accent untouched", () => {
  adoptRemoteAccent(null)
  adoptRemoteAccent("{not json")
  adoptRemoteAccent(JSON.stringify({ state: {} }))
  expect(useAccentStore.getState().accent).toBe("yup-red")
})
