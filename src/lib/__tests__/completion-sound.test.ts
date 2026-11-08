import { afterEach, beforeEach, expect, test, vi } from "vitest"

class FakeParam {
  setValueAtTime = vi.fn()
  exponentialRampToValueAtTime = vi.fn()
}

const oscillators: Array<{
  type: string
  frequency: FakeParam
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
}> = []
const contexts: FakeAudioContext[] = []
let initialState = "running"

class FakeAudioContext {
  state = initialState
  currentTime = 0
  destination = {}
  resume = vi.fn(async () => {
    this.state = "running"
  })
  constructor() {
    contexts.push(this)
  }
  createOscillator() {
    const oscillator = {
      type: "sine",
      frequency: new FakeParam(),
      start: vi.fn(),
      stop: vi.fn(),
      connect: vi.fn()
    }
    oscillators.push(oscillator)
    return oscillator
  }
  createGain() {
    return { gain: new FakeParam(), connect: vi.fn() }
  }
}

beforeEach(() => {
  oscillators.length = 0
  contexts.length = 0
  initialState = "running"
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    writable: true,
    value: FakeAudioContext
  })
})

afterEach(() => {
  Reflect.deleteProperty(window, "AudioContext")
  vi.restoreAllMocks()
})

test("done and requires_action map to different cues; everything else is silent", async () => {
  const { soundForRunState } = await import("../completion-sound")
  expect(soundForRunState("done")).toBe("done")
  expect(soundForRunState("requires_action")).toBe("attention")
  expect(soundForRunState("running")).toBeNull()
  expect(soundForRunState("failed")).toBeNull()
  expect(soundForRunState("idle")).toBeNull()
})

test("the two cues differ in note count and waveform", async () => {
  const { SOUND_PATTERNS } = await import("../completion-sound")
  expect(SOUND_PATTERNS.done.frequencies).toHaveLength(2)
  expect(SOUND_PATTERNS.done.type).toBe("sine")
  expect(SOUND_PATTERNS.attention.frequencies).toHaveLength(3)
  expect(SOUND_PATTERNS.attention.type).toBe("triangle")
  expect(SOUND_PATTERNS.done.frequencies[0]).not.toBe(SOUND_PATTERNS.attention.frequencies[0])
})

test("playing each cue schedules its own notes", async () => {
  vi.resetModules()
  const { playCompletionSound } = await import("../completion-sound")
  playCompletionSound("done")
  await vi.waitFor(() => expect(oscillators).toHaveLength(2))
  expect(oscillators.every((oscillator) => oscillator.type === "sine")).toBe(true)
  expect(oscillators.every((oscillator) => oscillator.start.mock.calls.length === 1)).toBe(true)

  playCompletionSound("attention")
  await vi.waitFor(() => expect(oscillators).toHaveLength(5))
  expect(oscillators.slice(2).every((oscillator) => oscillator.type === "triangle")).toBe(true)
})

test("a suspended context is resumed before the notes are scheduled", async () => {
  vi.resetModules()
  initialState = "suspended"
  const { playCompletionSound } = await import("../completion-sound")
  playCompletionSound("done")
  await vi.waitFor(() => expect(oscillators).toHaveLength(2))
  expect(contexts).toHaveLength(1)
  expect(contexts[0].resume).toHaveBeenCalledOnce()
})
