import type { DriveController, DriveState } from "@alwith/module-drive"

/**
 * Wrap a Drive controller so host events cannot update React synchronously.
 *
 * The module controller publishes inside the Tauri event callback. When a component subscribes
 * with useSyncExternalStore, that publish re-renders React while the event bridge is still on the
 * stack; a listener that publishes again (refresh/request) can then exceed React's nested-update
 * limit (#185). Keep the latest state available to imperative readers, but coalesce listener
 * notifications into one microtask.
 */
export function createStableDriveController(controller: DriveController): DriveController {
  let state = controller.getSnapshot()
  let unsubscribeTransport: (() => void) | null = null
  let notificationQueued = false
  let notificationGeneration = 0
  const listeners = new Set<() => void>()

  const publish = (): void => {
    state = controller.getSnapshot()
    if (notificationQueued || listeners.size === 0) return
    notificationQueued = true
    const generation = notificationGeneration
    queueMicrotask(() => {
      if (generation !== notificationGeneration) return
      notificationQueued = false
      if (listeners.size === 0) return
      for (const listener of [...listeners]) listener()
    })
  }

  const ensureSubscribed = (): void => {
    unsubscribeTransport ??= controller.subscribe(publish)
    state = controller.getSnapshot()
  }

  // Keep imperative readers current even before the first React subscription mounts.
  ensureSubscribed()

  return {
    getSnapshot: (): DriveState => state,
    subscribe(listener) {
      ensureSubscribed()
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    attach() {
      ensureSubscribed()
      return controller.attach()
    },
    refresh() {
      ensureSubscribed()
      return controller.refresh()
    },
    request(request) {
      ensureSubscribed()
      return controller.request(request)
    },
    dispose() {
      listeners.clear()
      notificationQueued = false
      notificationGeneration += 1
      unsubscribeTransport?.()
      unsubscribeTransport = null
      controller.dispose()
      state = controller.getSnapshot()
    }
  }
}
