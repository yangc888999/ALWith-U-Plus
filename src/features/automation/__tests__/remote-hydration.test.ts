// 只在 Tauri 运行时才走得到的那两条路径：启动 hydrate 的复用、以及「本地写入在途时丢弃远端
// 快照」的闸门。其余 automation 测试都跑在 IN_TAURI=false 下，这两处结构性不可达，所以单开
// 一个文件：stub 出 __TAURI_INTERNALS__ + mock 掉原生存储层，让 task-store 走真实分支。
//
// 守的是本轮修复的 hydrate 回滚竞态：selfHeal 曾在首轮 tick 之后（此时本轮已 markTaskFired
// 推进排期、startAutomationRun 写 running）再发一次 readRemoteState；若读到写入落地前的旧
// 快照，applyRemote 整份替换会把排期与 running 记录一起回滚 → 下一轮 tick 重复执行一次。

import { afterEach, beforeEach, expect, test, vi } from "vitest"

/** 原生存储层的替身：按队列返回读数，并记下写入与事件订阅。 */
const remote = vi.hoisted(() => ({
  readCalls: 0,
  /** 每次 readRemoteState 依次取一个；取空返回 null（KV 还没有数据）。 */
  queue: [] as unknown[],
  writes: [] as unknown[],
  handler: null as ((value: unknown) => void) | null
}))

vi.mock("../automation-remote-store", () => ({
  readRemoteState: async (): Promise<unknown> => {
    remote.readCalls += 1
    return remote.queue.length > 0 ? remote.queue.shift() : null
  },
  writeRemoteState: async (state: unknown): Promise<void> => {
    remote.writes.push(state)
  },
  onRemoteStateChanged: (handler: (value: unknown) => void): (() => void) => {
    remote.handler = handler
    return () => {
      remote.handler = null
    }
  }
}))

/** 走 Tauri 分支的模块实例：IN_TAURI 在模块求值时读取，必须先 stub 再 import。 */
async function tauriStore(): Promise<typeof import("../task-store")> {
  vi.stubGlobal("__TAURI_INTERNALS__", {})
  vi.resetModules()
  localStorage.clear()
  remote.readCalls = 0
  remote.queue = []
  remote.writes = []
  remote.handler = null
  return import("../task-store")
}

/** 让串行的写入链彻底跑完（含动态 import 与原生命令的空实现）。 */
async function flushWrites(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

const draft = {
  name: "每日群消息汇总",
  prompt: "读取飞书群消息并生成日报",
  promptFile: "",
  cwd: "/tmp/project",
  fullAccess: true,
  model: "",
  effort: "",
  fastMode: false,
  larkNotify: false,
  larkTargets: [],
  larkIdentity: "bot",
  repeat: "daily" as const,
  intervalMinutes: 60,
  time: "08:05",
  validUntil: null,
  enabled: true
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

/**
 * 锁的是**单次读取契约**（机制级：数 readRemoteState 的调用次数），不是行为级断言。
 *
 * 它防的是「selfHeal 在首轮 tick 之后另发一次读」这个具体成因：那次读可能返回本地写入落地前
 * 的快照，applyRemote 整份替换会把排期推进与 running 记录一起回滚。之所以用计数而不是断言
 * "状态没被回滚"：后者需要模拟一个会返回旧快照的远端，容易写成与实现同构的假测试；计数则
 * 直接把"多了一次读"这个必要条件钉死。
 *
 * 因此这条用例与实现策略绑定：**若将来改成「重读 + 逐条合并」而不是整份替换，本用例需重新
 * 评估**——那时多一次读不再有害，计数断言反而会成为阻碍合理改动的枷锁。行为级的兜底由
 * 下面两条闸门用例（在途写入期间丢弃远端快照）承担。
 */
test("selfHealAutomationState reuses the startup read instead of issuing a second one", async () => {
  const store = await tauriStore()
  // 启动路径：startAutomationSync 发出唯一那次读取。
  const stop = store.startAutomationSync()
  await store.whenHydrated()
  expect(remote.readCalls).toBe(1)

  // 首轮 tick 之后 selfHeal 才跑到 await：这时本轮已经推进过排期、写过 running 记录。
  // 它必须复用上面那一次读取，绝不再发第二读（第二次读可能返回写入落地前的旧快照）。
  await store.selfHealAutomationState(Date.now())
  expect(remote.readCalls).toBe(1)

  // 连续调用同样不再新增读取（Promise 已被复用）。
  await store.selfHealAutomationState(Date.now())
  expect(remote.readCalls).toBe(1)

  stop()
})

test("whenHydrated resolves immediately when no startup read ever happened", async () => {
  const store = await tauriStore()
  // 没有 startAutomationSync 就没有那次读取；selfHeal 不该因此挂住。
  await expect(store.whenHydrated()).resolves.toBeUndefined()
  expect(remote.readCalls).toBe(0)
})

test("a remote snapshot arriving while a local write is queued is discarded", async () => {
  const store = await tauriStore()
  const stop = store.startAutomationSync()
  await store.whenHydrated()
  // 订阅注册在 `void remote().then(...)` 里，等一拍让 handler 就位。
  await flushWrites()
  expect(remote.handler).not.toBeNull()

  // 本地写入：这一版任务/排期是本窗口刚算出来的，比任何在途的远端读数都新。
  const task = store.createTask(draft)
  expect(store.listTasks()).toHaveLength(1)

  // 写入还排在队列里时，一份「没有这个任务」的旧快照到达 —— 正是回滚竞态的形态。
  remote.handler!({ tasks: [], runs: [] })
  // 内存状态必须原封不动：排期推进与运行记录不能被抹掉。
  expect(store.listTasks().map((entry) => entry.id)).toEqual([task.id])
  expect(store.getTask(task.id)?.nextRunAt).toBe(task.nextRunAt)

  // 闸门是「写入在途期间」的临时抑制，不是永久静音：写入落地后，真实的跨窗口变更照常生效。
  await flushWrites()
  expect(remote.writes.length).toBeGreaterThan(0)
  remote.handler!({ tasks: [], runs: [] })
  expect(store.listTasks()).toHaveLength(0)

  stop()
})

test("a remote snapshot is applied when nothing local is pending", async () => {
  const store = await tauriStore()
  const stop = store.startAutomationSync()
  await store.whenHydrated()
  await flushWrites()

  // 保存的任务从远端到达（另一个窗口刚编辑过），本地没有未落地的写入 → 必须接受。
  const saved = { ...store.createTask(draft) }
  await flushWrites()
  remote.handler!({ tasks: [{ ...saved, name: "另一窗口改名" }], runs: [] })
  expect(store.listTasks()[0]?.name).toBe("另一窗口改名")

  stop()
})

/**
 * memo 的失败路径必须可恢复。缓存住一个 null 会让跨窗口同步失效到进程重启为止 —— 而加载
 * 失败往往只是「这一刻原生层还没就绪」。所以 catch 里清空缓存、下一次调用重新尝试。
 *
 * 放在文件末尾并 doUnmock 还原：它要替换模块工厂，不应影响前面的用例。
 */
test("a failed module load is not cached: the next use retries and warns", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  let attempts = 0
  vi.resetModules()
  vi.doMock("../automation-remote-store", () => {
    attempts += 1
    if (attempts === 1) throw new Error("native store not ready")
    return {
      readRemoteState: async (): Promise<unknown> => null,
      writeRemoteState: async (): Promise<void> => undefined,
      onRemoteStateChanged: (): (() => void) => () => undefined
    }
  })
  try {
    vi.stubGlobal("__TAURI_INTERNALS__", {})
    localStorage.clear()
    const store = await import("../task-store")

    // 首次：加载失败。hydrate 内部吞掉错误（不 throw），但必须留下 warn，且不能缓存 null。
    await expect(store.hydrateAutomation()).resolves.toBeUndefined()
    expect(attempts).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain("will retry on next use")

    // 第二次：因为缓存被清空，会重新发起加载并成功。
    await store.hydrateAutomation()
    expect(attempts).toBe(2)
  } finally {
    vi.doUnmock("../automation-remote-store")
    vi.resetModules()
    warn.mockRestore()
  }
})

test("the non-Tauri path short-circuits without caching anything", async () => {
  // IN_TAURI=false 时必须立即返回 null：不 import 原生模块、不进 memo、不留缓存。
  vi.unstubAllGlobals()
  vi.resetModules()
  const store = await import("../task-store")
  remote.readCalls = 0
  await expect(store.hydrateAutomation()).resolves.toBeUndefined()
  await expect(store.hydrateAutomation()).resolves.toBeUndefined()
  expect(remote.readCalls).toBe(0)
  await expect(store.whenHydrated()).resolves.toBeUndefined()
})
