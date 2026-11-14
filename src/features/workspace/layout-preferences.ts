// Persisted proportions for the workspace's resizable regions.
//
// The four visible columns — session sidebar, chat, file tree and preview — share one
// percentage budget that always adds up to 100%. Editing any one of them redistributes the
// remainder proportionally across the other three, so the numbers in Settings and the columns
// on screen describe the same thing.
//
// The chat/preview split lives in `workspace-panels.tsx` and the file tree lives in an
// `allotment` split view; both used component-local state, so a session switch (which briefly
// tears the workspace down) restored the library defaults. Reading and writing the shares
// through this one store keeps a manually adjusted layout across sessions and remounts.
//
// Shares are the single source of truth. At render time each consumer multiplies its share by
// the live window width it measures (a ResizeObserver tracks the ALWith window), so the split
// is purely proportional and adapts to any resolution — nothing pixel-based is ever persisted,
// which is what kept a width dragged on a wide monitor from starving the chat column on a narrow
// one. A divider drag still feels pixel-accurate while it is happening, but on release only the
// new share is stored.
export type LayoutShare = "navigation" | "chat" | "tree" | "preview"

export interface WorkspaceLayoutPreferences {
  /** Session sidebar share of the workspace width. */
  navigationRatio: number
  /** Chat column share of the workspace width. */
  chatRatio: number
  /** File tree share of the workspace width. */
  treeRatio: number
  /** Preview content share of the workspace width. */
  previewRatio: number
}

const STORAGE_KEY = "workspace:layout"

// No per-column floor or ceiling. A column may be dragged to any size from 0% up to the whole
// workspace; the preview column is the buffer that always soaks up the difference so the four
// shares keep adding up to exactly 100%. These bounds exist only so a malformed stored value
// cannot escape the [0, 1] share range — they are not UI guardrails.
export const LAYOUT_SHARE_MIN: Record<LayoutShare, number> = {
  navigation: 0,
  chat: 0,
  tree: 0,
  preview: 0
}
export const LAYOUT_SHARE_MAX: Record<LayoutShare, number> = {
  navigation: 1,
  chat: 1,
  tree: 1,
  preview: 1
}

// Kept for the pixel bounds that keep the docked sidebar and tree usable on any display once
// the share is resolved against the live window width.
export const NAVIGATION_PX_MIN = 180
export const NAVIGATION_PX_MAX = 460
export const TREE_PX_MIN = 150
export const TREE_PX_MAX = 1200
// The split-view library refuses to show two columns unless chat keeps at least this much
// room; below it the panes count as "no longer fitting" and chat gets pushed onto its own
// screen, which the user reads as the layout being torn apart.
const CHAT_PX_MIN = 320

export const workspaceLayoutDefaults: WorkspaceLayoutPreferences = {
  navigationRatio: 0.12,
  chatRatio: 0.15,
  treeRatio: 0.13,
  previewRatio: 0.6
}

const SHARE_KEYS: LayoutShare[] = ["navigation", "chat", "tree", "preview"]

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function clampShare(key: LayoutShare, value: unknown, fallback: number): number {
  return clamp(value, fallback, LAYOUT_SHARE_MIN[key], LAYOUT_SHARE_MAX[key])
}

/**
 * Makes the four shares add up to exactly 1 with no per-column clamping.
 *
 * Every share is scaled by the same factor onto a unit sum, so the columns keep their relative
 * proportions (important when migrating a pre-budget or pixel-field layout). Any rounding
 * residue is dropped onto the preview column, which is the designated buffer: it is the one
 * column allowed to be the odd one out so the other three can sit wherever the user put them.
 */
export function normalizeShares(shares: Record<LayoutShare, number>): Record<LayoutShare, number> {
  const out = { ...shares }
  const total = SHARE_KEYS.reduce((sum, key) => sum + out[key], 0)
  if (!Number.isFinite(total) || total <= 0) return readDefaults()
  for (const key of SHARE_KEYS) out[key] = out[key] / total
  // Preview is the buffer: absorb the tiny float drift there so the four always total exactly 1.
  const residue = 1 - SHARE_KEYS.reduce((sum, key) => sum + out[key], 0)
  out.preview = Math.max(0, out.preview + residue)
  return out
}

function readDefaults(): Record<LayoutShare, number> {
  return {
    navigation: workspaceLayoutDefaults.navigationRatio,
    chat: workspaceLayoutDefaults.chatRatio,
    tree: workspaceLayoutDefaults.treeRatio,
    preview: workspaceLayoutDefaults.previewRatio
  }
}

/** Reads the four shares out of a stored layout. */
export function layoutShares(layout: WorkspaceLayoutPreferences): Record<LayoutShare, number> {
  return {
    navigation: layout.navigationRatio,
    chat: layout.chatRatio,
    tree: layout.treeRatio,
    preview: layout.previewRatio
  }
}

/**
 * Returns an updated layout where `key` becomes `percent` of the budget.
 *
 * The preview column is the buffer. Editing navigation, chat or tree pins that one column and the
 * other two non-preview columns stay exactly where they were — only the preview absorbs the
 * whole difference, so the four always total 100%. Editing the preview itself distributes the
 * leftover across navigation/chat/tree in proportion to their current sizes.
 *
 * There is no minimum floor on any column. If a nav/chat/tree edit would push the preview below
 * zero, the edited column is pulled back just enough that the preview floors at 0 and the budget
 * still closes at 100%; the preview can never go negative.
 */
export function withShare(
  layout: WorkspaceLayoutPreferences,
  key: LayoutShare,
  percent: number
): WorkspaceLayoutPreferences {
  // The chat column is deliberately absent from every drag path: the sidebar divider writes
  // `navigation`, the preview divider writes `tree`/`preview`. So only the Settings slider can move
  // chat, and a manual drag can never pull it away — which is the rule. (Rejecting `chat` edits here
  // would also disable that slider, so it is not rejected.)
  const shares = layoutShares(layout)
  const NON_PREVIEW: LayoutShare[] = SHARE_KEYS.filter((entry) => entry !== "preview")
  const next: Record<LayoutShare, number> = { ...shares }
  if (key === "preview") {
    // Preview takes its room from the sidebar and the file tree only. Chat stays exactly where the
    // settings put it, so widening the preview never squeezes the conversation.
    const adjustable: LayoutShare[] = ["navigation", "tree"]
    const ceiling = Math.max(0, 1 - shares.chat)
    const target = Math.min(clamp(percent / 100, 0, 0, 1), ceiling)
    const room = 1 - target - shares.chat
    const adjustableTotal = adjustable.reduce((sum, entry) => sum + shares[entry], 0)
    next.preview = target
    if (adjustableTotal <= 1e-9) {
      for (const entry of adjustable) next[entry] = room / adjustable.length
    } else {
      for (const entry of adjustable) next[entry] = (shares[entry] / adjustableTotal) * room
    }
  } else {
    // Pin the edited column, keep the other non-preview columns fixed, preview is the buffer.
    const fixed = NON_PREVIEW.filter((entry) => entry !== key)
    const fixedSum = fixed.reduce((sum, entry) => sum + shares[entry], 0)
    const target = clamp(percent / 100, 0, 0, 1)
    let edited = target
    let preview = 1 - target - fixedSum
    if (preview < 0) {
      // Preview floors at 0; pull the edited column back so the budget still closes at 100%.
      preview = 0
      edited = 1 - fixedSum
    }
    next[key] = edited
    next.preview = preview
  }
  return {
    ...layout,
    navigationRatio: next.navigation,
    // Only the Settings slider reaches this branch; every drag path edits another column and
    // leaves chat untouched, so the conversation width stays exactly where Settings put it.
    chatRatio: next.chat,
    treeRatio: next.tree,
    previewRatio: next.preview
  }
}

/**
 * Normalizes the three shares that live inside the workspace (everything right of the session
 * sidebar) so consumers can convert them straight against their own container width.
 */
export function contentShares(
  layout: WorkspaceLayoutPreferences
): { chat: number; tree: number; preview: number } {
  const total = layout.chatRatio + layout.treeRatio + layout.previewRatio
  if (!Number.isFinite(total) || total <= 0) return { chat: 0.36, tree: 0.14, preview: 0.5 }
  return {
    chat: layout.chatRatio / total,
    tree: layout.treeRatio / total,
    preview: layout.previewRatio / total
  }
}

/** Rounds raw percentages to whole numbers that add up to exactly 100. */
function roundToHundred(raw: Array<{ key: LayoutShare; value: number }>): Record<LayoutShare, number> {
  const rounded = raw.map((entry) => ({ key: entry.key, value: Math.round(entry.value) }))
  const drift = 100 - rounded.reduce((sum, entry) => sum + entry.value, 0)
  if (drift !== 0) {
    // Give the rounding remainder to the share that lost the most in rounding.
    const worst = rounded
      .map((entry, index) => ({ index, delta: raw[index].value - entry.value }))
      .sort((a, b) => b.delta - a.delta)[0]
    rounded[worst.index].value += drift
  }
  return Object.fromEntries(rounded.map((entry) => [entry.key, entry.value])) as Record<LayoutShare, number>
}

/** Rounds the four shares to whole percentages that always add up to exactly 100. */
export function sharePercents(layout: WorkspaceLayoutPreferences): Record<LayoutShare, number> {
  const shares = layoutShares(layout)
  return roundToHundred(SHARE_KEYS.map((key) => ({ key, value: shares[key] * 100 })))
}

/**
 * Percentages over the columns that are currently *on*, summing to exactly 100.
 *
 * A closed column takes no room on screen, so it must not take a slice of the displayed budget
 * either: with the file tree and the preview both off, a sidebar saved at 12% of four columns and
 * a chat saved at 15% render as roughly 44 / 56 of the window. Showing 12% and 15% next to that
 * bar describes a layout the user is not looking at. Hidden columns therefore drop out of the
 * denominator and the visible ones are rescaled to a full 100.
 */
export function visibleSharePercents(
  layout: WorkspaceLayoutPreferences,
  visible: readonly LayoutShare[]
): Record<LayoutShare, number> {
  const shares = layoutShares(layout)
  const keys = SHARE_KEYS.filter((key) => visible.includes(key))
  const total = keys.reduce((sum, key) => sum + shares[key], 0)
  return roundToHundred(
    SHARE_KEYS.map((key) => ({
      key,
      value: keys.includes(key) && total > 0 ? (shares[key] / total) * 100 : 0
    }))
  )
}

/**
 * Applies a percentage edit inside the visible budget, leaving closed columns untouched.
 *
 * `withShare` assumes all four columns share one 100% budget and uses the preview as the buffer.
 * That buffer may be closed, so for a partial layout the edited column instead takes its slice of
 * the *visible* total and the other on-screen columns absorb the difference in their current
 * proportions. Closed columns keep their saved shares, which is what lets them restore their
 * previous width when switched back on.
 */
export function withVisibleShare(
  layout: WorkspaceLayoutPreferences,
  visible: readonly LayoutShare[],
  key: LayoutShare,
  percent: number
): WorkspaceLayoutPreferences {
  const keys = SHARE_KEYS.filter((entry) => visible.includes(entry))
  if (!keys.includes(key)) return layout
  const shares = layoutShares(layout)
  const total = keys.reduce((sum, entry) => sum + shares[entry], 0)
  if (!Number.isFinite(total) || total <= 1e-9) return layout
  const target = clamp(percent / 100, 0, 0, 1) * total
  const others = keys.filter((entry) => entry !== key)
  const othersTotal = others.reduce((sum, entry) => sum + shares[entry], 0)
  const remaining = total - target
  const next = { ...shares }
  next[key] = target
  if (others.length > 0) {
    if (othersTotal <= 1e-9) {
      for (const entry of others) next[entry] = remaining / others.length
    } else {
      for (const entry of others) next[entry] = (shares[entry] / othersTotal) * remaining
    }
  }
  return {
    ...layout,
    navigationRatio: next.navigation,
    chatRatio: next.chat,
    treeRatio: next.tree,
    previewRatio: next.preview
  }
}

/** Resolves a stored fraction to a pixel width bounded by the given min/max. */
export function resolveRatioToPixels(
  ratio: number,
  containerWidth: number,
  min: number,
  max: number
): number {
  const basis = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : min
  return Math.min(max, Math.max(min, Math.round(ratio * basis)))
}

export function loadWorkspaceLayout(storage: Storage = localStorage): WorkspaceLayoutPreferences {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return { ...workspaceLayoutDefaults }
    const value = JSON.parse(raw) as Partial<WorkspaceLayoutPreferences> | null
    if (typeof value !== "object" || value === null) return { ...workspaceLayoutDefaults }
    const fallback = readDefaults()
    const navigation = clampShare("navigation", value.navigationRatio, fallback.navigation)
    let chat = clampShare("chat", value.chatRatio, fallback.chat)
    let tree = clampShare("tree", value.treeRatio, fallback.tree)
    let preview: number
    // Records written before the 100% budget existed carried no preview share; their pixel
    // fields (`navigationWidth`, `treeWidth`, `previewWidth`) described the *old* column
    // model, where the preview column also contained the file tree. Those numbers are not
    // portable to the share model — a preview dragged to 2160px on a wide display would be
    // replayed verbatim on a narrow window and starve the chat column — so they are dropped
    // and the split is derived from the shares instead.
    const preBudget = typeof value.previewRatio !== "number" || !Number.isFinite(value.previewRatio)
    if (!preBudget) {
      preview = clampShare("preview", value.previewRatio, fallback.preview)
    } else {
      // Layouts saved before the 100% budget existed measured `chatRatio` against the workspace
      // budget (the window minus the sidebar) and `treeRatio` against the preview column, so
      // `preview` was implicitly `1 - chat` and the tree sat inside it. Reproduce that exactly —
      // treating the preview as a leftover would squeeze it to a sliver and collapse the column.
      const budget = 1 - navigation
      preview = budget * (1 - chat)
      tree = budget * (1 - chat) * tree
      chat = budget * chat
    }
    const shares = normalizeShares({ navigation, chat, tree, preview })
    return {
      navigationRatio: shares.navigation,
      chatRatio: shares.chat,
      treeRatio: shares.tree,
      previewRatio: shares.preview
    }
  } catch {
    return { ...workspaceLayoutDefaults }
  }
}

/**
 * Resolves the preview width to ask the split-view library for.
 *
 * The library only keeps two columns while the request stays inside a band: at least 400px of
 * preview, and at least 320px left for chat. Anything else — a share that grew past the band
 * on a narrow window, or a pixel width dragged on a wider one — makes it declare the panes
 * unfit and push chat onto its own screen, which the user reads as the configured columns
 * being torn apart. So both inputs are clamped into the band, and only when the band itself
 * cannot exist (a very narrow workspace) do we return 0 and let the library pick.
 */
export function requestedPreviewWidth(budget: number, previewShare: number, draggedWidth: number): number {
  const usable = Number.isFinite(budget) && budget > 0 ? budget : 0
  const room = usable - CHAT_PX_MIN
  if (draggedWidth > 0 && draggedWidth <= room) return draggedWidth
  const fromShare = Math.round(usable * previewShare)
  if (room >= 400) return Math.min(room, Math.max(400, fromShare))
  return usable >= 400 + CHAT_PX_MIN ? 400 : 0
}

/** Applies a percentage edit and redistributes the remaining shares to keep the total at 100%. */
export function saveLayoutShare(key: LayoutShare, percent: number, storage: Storage = localStorage): void {
  saveWorkspaceLayout(withShare(loadWorkspaceLayout(storage), key, percent), storage)
}

/**
 * Same as `saveLayoutShare`, but the percentage is read against the columns that are on.
 * Used by the appearance page whenever a column is hidden, so the slider value the user sees is
 * the value the workspace will render.
 */
export function saveVisibleLayoutShare(
  key: LayoutShare,
  percent: number,
  visible: readonly LayoutShare[],
  storage: Storage = localStorage
): void {
  const layout = loadWorkspaceLayout(storage)
  saveWorkspaceLayout(withVisibleShare(layout, visible, key, percent), storage)
}

// `useSyncExternalStore` needs a stable snapshot while the value is unchanged. Re-read storage
// on each snapshot call and only mint a new object when a field actually changed.
let cachedKey = ""
let cachedValue: WorkspaceLayoutPreferences = { ...workspaceLayoutDefaults }
const listeners = new Set<() => void>()

function current(): WorkspaceLayoutPreferences {
  const value = loadWorkspaceLayout()
  const key = `${value.navigationRatio}:${value.chatRatio}:${value.treeRatio}:${value.previewRatio}`
  if (key === cachedKey) return cachedValue
  cachedKey = key
  cachedValue = value
  return value
}

export function getWorkspaceLayout(): WorkspaceLayoutPreferences {
  return current()
}

export function subscribeWorkspaceLayout(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function saveWorkspaceLayout(
  patch: Partial<WorkspaceLayoutPreferences>,
  storage: Storage = localStorage
): void {
  // Read the persisted value (not the hook cache) so a cleared storage resets cleanly.
  const next = loadWorkspaceLayout(storage)
  const merged = { ...next, ...patch }
  // Any share edit re-normalizes the whole budget; a pure pixel drag leaves the shares alone.
  const touchesShares =
    patch.navigationRatio !== undefined ||
    patch.chatRatio !== undefined ||
    patch.treeRatio !== undefined ||
    patch.previewRatio !== undefined
  const normalized = touchesShares
    ? normalizeShares(layoutShares(merged))
    : layoutShares(merged)
  const value: WorkspaceLayoutPreferences = {
    ...merged,
    ...normalized
  }
  cachedKey = ""
  cachedValue = value
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Storage can be unavailable (private mode); the layout simply falls back to defaults.
  }
  for (const listener of listeners) listener()
}
