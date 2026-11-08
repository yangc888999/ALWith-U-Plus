import { beforeEach, expect, test } from "vitest"

import {
  armStartupWindow,
  expireStartupWindow,
  markStartupReady,
  resetStartupWindow,
  stallStartupWindow,
  startupSilent,
  startupStalled
} from "../startup-window"

beforeEach(() => resetStartupWindow())

test("before the window is armed nothing is silenced", () => {
  // 测试环境/未接线的窗口不应该被静默：否则错误会无声无息地消失。
  expect(startupSilent()).toBe(false)
})

test("the window silences errors until the engine is ready for the first time", () => {
  armStartupWindow()
  expect(startupSilent()).toBe(true)

  markStartupReady()
  expect(startupSilent()).toBe(false)

  // 幂等：再来一次 ready 也不会把窗口重新打开。
  markStartupReady()
  expect(startupSilent()).toBe(false)
})

test("a startup that never completes stops being silent after the fallback expires", () => {
  armStartupWindow()
  expect(startupSilent()).toBe(true)

  expireStartupWindow()
  // 真坏了必须能报出来，只是晚 20 秒 —— 静默窗不是永久隐藏。
  expect(startupSilent()).toBe(false)
})

test("ready closes the window even if the fallback already expired", () => {
  armStartupWindow()
  expireStartupWindow()
  markStartupReady()
  expect(startupSilent()).toBe(false)
})

test("a warm start never reaches the progress line", () => {
  // 热启动几百毫秒就 ready：stalled 一直是 false，所以屏幕上「正在启动」四个字都不会画，
  // 也就没有"画了再抹"的闪一下。
  armStartupWindow()
  expect(startupStalled()).toBe(false)
  markStartupReady()
  expect(startupStalled()).toBe(false)
})

test("a slow start gets the progress line, and ready takes it away", () => {
  armStartupWindow()
  stallStartupWindow()
  expect(startupStalled()).toBe(true)
  // 进度提示出现时仍然处于静默期：错误照旧不上屏，只是多了一句中性文案。
  expect(startupSilent()).toBe(true)

  markStartupReady()
  expect(startupStalled()).toBe(false)
})

test("the progress line never shows once the fallback has expired", () => {
  // 兜底过期后走的是真错误卡，不需要再叠一句"正在启动"。
  armStartupWindow()
  stallStartupWindow()
  expireStartupWindow()
  expect(startupStalled()).toBe(false)
})
