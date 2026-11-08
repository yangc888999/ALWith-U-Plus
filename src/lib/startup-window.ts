// 启动静默窗：从进程起来到引擎**第一次**连上之间，屏幕上只允许出现中性文案。
//
// 为什么需要它：这段时间里的失败几乎都是过程性的 —— 引擎冷启动、`~/.codex/config.toml` 自愈、
// runtime 端口刚绑定、adapter 自己重启一次。它们往往一两秒后就好了，但用户看到的是「一启动就报错」，
// 然后在错误消失前只来得及读到一个红框。2026-11-08 另一台机器反复出现的就是这个。
//
// 为什么必须是**一个**状态源：此前主窗口用 5 秒定时器猜、草稿页用 3 次重试猜、浮窗和 toast
// 干脆没猜 —— 四个出口各写一套启发式，任何一处猜错就闪一下红字。现在四个出口都只读这里：
//   · app.tsx 的连接横幅
//   · draft-chat.tsx 的错误卡
//   · chat-window.tsx 的断开 banner
//   · toast.error（统一在 toast-error.ts 拦）
//
// 语义（刻意保持简单，没有"部分静默"）：
//   armStartupWindow()   窗口开启（每个窗口的入口调用一次）
//   markStartupReady()   引擎第一次 ready：窗口永久关闭，之前的错误**不补发、不提示**
//   startupSilent()      现在是静默期吗 —— 错误出口读它
//   startupStalled()     静默期已经久到该给用户一句话了吗 —— **中性**进度条读它
//   过期兜底             20 秒还没 ready 就放行错误，否则真坏了会永远只显示"正在启动"
//
// 为什么进度提示要单独延迟 800ms：热启动（引擎缓存还在）从挂载到 ready 只要几百毫秒，
// 这期间画一个「正在启动」再抹掉，本身就是"闪一下"——只是从红字换成灰字。延迟到 800ms
// 之后才允许出现，热启动就**一个字都不会画**；真的慢（冷启动、换厂商后重启引擎）才出现。
//
// 这不是"藏错误"：真失败在窗口过期后照常显示，而且带着可点的重试；只是不再在自愈过程中闪一下。

const FALLBACK_MS = 20_000
/** 静默期里多久之后才允许出现中性进度提示（低于这个时长不画任何东西）。 */
const STALL_MS = 800

let armed = false
let ready = false
let expired = false
let stalled = false
let timer: ReturnType<typeof setTimeout> | null = null
let stallTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function clearTimers(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  if (stallTimer !== null) {
    clearTimeout(stallTimer)
    stallTimer = null
  }
}

/** 开启静默窗并开始 20 秒兜底计时。重复调用无副作用（每个窗口入口调用一次即可）。 */
export function armStartupWindow(): void {
  if (armed) return
  armed = true
  stallTimer = setTimeout(() => {
    stallTimer = null
    stalled = true
    emit()
  }, STALL_MS)
  timer = setTimeout(() => {
    timer = null
    expired = true
    emit()
  }, FALLBACK_MS)
}

/** 引擎第一次 ready。幂等；此后所有错误出口恢复正常。 */
export function markStartupReady(): void {
  if (ready) return
  ready = true
  clearTimers()
  emit()
}

/** 静默期：窗口已开启、引擎没 ready 过、兜底也没过期。 */
export function startupSilent(): boolean {
  return armed && !ready && !expired
}

/** 静默期里已经等够了 —— 可以出现一句中性的「正在启动」，而不是让窗口看着像卡死。 */
export function startupStalled(): boolean {
  return armed && !ready && !expired && stalled
}

export function subscribeStartupWindow(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 仅供测试：把窗口恢复到"刚启动"的状态。 */
export function resetStartupWindow(): void {
  clearTimers()
  armed = false
  ready = false
  expired = false
  stalled = false
  emit()
}

/** 仅供测试：跳过 800ms 的进度提示延迟。 */
export function stallStartupWindow(): void {
  if (stallTimer !== null) {
    clearTimeout(stallTimer)
    stallTimer = null
  }
  stalled = true
  emit()
}

/** 仅供测试：跳过 20 秒兜底，模拟"启动太久"。 */
export function expireStartupWindow(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  expired = true
  emit()
}
