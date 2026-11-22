/**
 * OpenRouter's saved model order is a history of clicks, so the free models a reader already
 * checked can sit hundreds of paid rows down. Pin those checked free rows to the top without
 * disturbing the relative order of either group (a stable partition, not a score sort).
 */
export function pinCheckedFreeModels<T extends { api_id: string; enabled: boolean }>(
  rows: readonly T[],
  isFree: (apiId: string) => boolean
): T[] {
  const free: T[] = []
  const rest: T[] = []
  for (const row of rows) {
    if (row.enabled && isFree(row.api_id)) free.push(row)
    else rest.push(row)
  }
  return [...free, ...rest]
}
