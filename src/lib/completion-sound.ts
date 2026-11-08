// Two distinct cues for a settled conversation, generated with Web Audio so the app ships no audio
// asset and no platform-specific NSSound/WinRT code:
//   done            → a rising two-note sine chime ("it finished")
//   requires_action → a brighter three-note triangle pattern ("it is waiting on you")
// A failed turn stays silent: the system notification and the Dock badge already report it.
//
// WKWebView suspends AudioContext until the page has been interacted with; resume() is best effort
// and a missing/suspended context simply means silence. A notification is never blocked by sound.

export type CompletionSoundKind = "done" | "attention"

export interface SoundPattern {
  frequencies: number[]
  type: OscillatorType
  spacing: number
  peak: number
}

export const SOUND_PATTERNS: Record<CompletionSoundKind, SoundPattern> = {
  // A soft, reassuring two-note rising sine — "it finished, you can look now".
  done: { frequencies: [880, 1174.66], type: "sine", spacing: 0.14, peak: 0.09 },
  // A brighter, louder ascending triangle run — unmistakably an "attention needed" alert,
  // not a completion. Different waveform + one more rising note + higher peak keeps the two
  // cues from blurring together when several turns settle back to back.
  attention: { frequencies: [659.25, 987.77, 1318.51], type: "triangle", spacing: 0.1, peak: 0.15 }
}

/** Which cue a settled run deserves. Everything else (running, idle, failed) is silent. */
export function soundForRunState(state: string): CompletionSoundKind | null {
  if (state === "done") return "done"
  if (state === "requires_action") return "attention"
  return null
}

let shared: AudioContext | null = null

/** Schedules the notes on an already-running context. */
function chime(context: AudioContext, pattern: SoundPattern): void {
  const start = context.currentTime + 0.01
  for (const [index, frequency] of pattern.frequencies.entries()) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const at = start + index * pattern.spacing
    const length = pattern.spacing + 0.06
    oscillator.type = pattern.type
    oscillator.frequency.setValueAtTime(frequency, at)
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(pattern.peak, at + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(at)
    oscillator.stop(at + length + 0.01)
  }
}

export function playCompletionSound(kind: CompletionSoundKind): void {
  // 用户正看着 App 时不提示：结果已经在屏幕上，没必要再「叮」一下来吓人。仅在后台时提示，
  // 与 Dock 角标的焦点守卫（dock-badge.ts）保持一致。
  if (typeof document !== "undefined" && document.hasFocus()) return
  try {
    const Ctor = window.AudioContext
    if (Ctor === undefined) return
    shared ??= new Ctor()
    const context = shared
    // A task can finish while nobody has touched the app, so the context may still be suspended.
    // Scheduling notes before resume() resolves silently swallows the whole chime: wait for it,
    // and treat a rejected resume as "no sound" rather than an error.
    void Promise.resolve(context.state === "suspended" ? context.resume() : undefined)
      .then(() => chime(context, SOUND_PATTERNS[kind]))
      .catch(() => undefined)
  } catch {
    // Sound is a convenience; never surface its failures.
  }
}
