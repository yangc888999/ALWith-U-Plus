// 定时任务的共享持久化层。
//
// localStorage 在 Tauri 的各个 webview 之间不保证共享、storage 事件也不跨 webview，
// 所以「只要 App 开着就跑」不能靠设置窗口的定时器。这里把任务和运行记录写进 Rust 侧
// 的命名 KV（app_data_dir/<name>.json），两个窗口都读同一份；named_store 还会把每次
// 写入广播成 `store-changed` 事件，UI 因此能实时刷新。
//
// 本文件只在 Tauri 运行时被 task-store.ts 动态 import，单测/Storybook 不会加载它。

import { listen } from "@tauri-apps/api/event"

import { commands, type Value } from "@/bindings"

const STORE_NAME = "automation"
const STATE_KEY = "state"

export async function readRemoteState(): Promise<unknown> {
  const entries = (await commands.storeEntries({ scope: "data", store: STORE_NAME })) as Record<string, unknown>
  return entries?.[STATE_KEY] ?? null
}

export async function writeRemoteState(state: unknown): Promise<void> {
  await commands.storeSet({
    scope: "data",
    store: STORE_NAME,
    key: STATE_KEY,
    value: state as Value
  })
}

/** 其它窗口（或本窗口）写入后触发。调用方自行比较，忽略自己写出的那份。 */
export function onRemoteStateChanged(handler: (value: unknown) => void): () => void {
  let disposed = false
  let unlisten: (() => void) | null = null
  const stop = listen<{ store: string; key: string; value: unknown }>("store-changed", (event) => {
    if (disposed) return
    if (event.payload.store !== STORE_NAME || event.payload.key !== STATE_KEY) return
    handler(event.payload.value)
  })
  void stop
    .then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    .catch(() => undefined)
  return () => {
    disposed = true
    unlisten?.()
  }
}
