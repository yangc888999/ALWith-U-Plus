const STORAGE_KEY = "chat.overload-retry-count"
export const DEFAULT_OVERLOAD_RETRY_COUNT = 5
export const MIN_OVERLOAD_RETRY_COUNT = 1
export const MAX_OVERLOAD_RETRY_COUNT = 20

const listeners = new Set<() => void>()

function read(): number {
  if (typeof localStorage === "undefined") return DEFAULT_OVERLOAD_RETRY_COUNT
  const value = Number.parseInt(localStorage.getItem(STORAGE_KEY) ?? "", 10)
  return Number.isFinite(value)
    ? Math.min(MAX_OVERLOAD_RETRY_COUNT, Math.max(MIN_OVERLOAD_RETRY_COUNT, value))
    : DEFAULT_OVERLOAD_RETRY_COUNT
}

let current = read()

export function overloadRetryCount(): number {
  return current
}

export function setOverloadRetryCount(value: number): void {
  current = Math.min(MAX_OVERLOAD_RETRY_COUNT, Math.max(MIN_OVERLOAD_RETRY_COUNT, Math.round(value)))
  localStorage.setItem(STORAGE_KEY, String(current))
  for (const listener of listeners) listener()
}

export function subscribeOverloadRetryCount(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
