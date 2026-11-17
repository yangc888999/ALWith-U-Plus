import {
  type ConversationHost,
  ConversationProvider,
  type ReportedError,
  type TimelineSlots
} from "@alwith/module-chat/conversation"
import type { NavigationRailAudio, TimelineViewportProps } from "@alwith/module-chat/session-timeline"
import { codexTurnId } from "@nyssance/codex-acp-v2/client"
import { invoke } from "@tauri-apps/api/core"
import { type ReactNode, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Bot } from "lucide-react"
import { toast } from "sonner"
import { useStore } from "zustand"

import { commands } from "@/bindings"
import { Pane } from "@/components/alwith-ui/pane"
import { CodexFileIcon } from "@/components/icons/codex/file-icon"
import { useTheme } from "@/components/theme-provider"
import { computerActionKey, privateComputerAction } from "@/features/computer/action-label"
import { client } from "@/lib/client"
import { describeError } from "@/lib/error-text"
import { isQueueCancelled } from "@/lib/queued-prompt"

import { ForkOriginDivider, ForkTurnButton } from "./chat-branches"
import { useChatActivityHost } from "./codex/activity-host"
import {
  installTimelineUserMessageNavigationAudioUnlock,
  playTimelineUserMessageNavigationSequence,
  preloadTimelineUserMessageNavigationInstrument
} from "./codex/navigation-audio"
import { navigationSoundStore } from "./codex/navigation-sound-store"

let lastReported: { message: string; at: number } | null = null

function reportError(error: unknown) {
  // Cancelling a queued message is a user action, not a failure: the composer has already put
  // the text back, and a red toast would read as an error.
  if (isQueueCancelled(error)) return
  const description = (error as ReportedError | null)?.description
  const message = describeError(error)
  // A revoked account model already has a permanent one-line notice above the composer, worded in
  // the reader's language and pointing at the picker that fixes it. Toasting the same sentence on
  // top of it showed two boxes saying the same thing at once (2026-11-17 screenshot), so this code
  // is deliberately silent here — the notice is the only surface for it.
  if (/account_model_required/i.test(error instanceof Error ? error.message : String(error))) return
  // One engine failure reaches both the chat package's inline card and this toast. The formatter
  // is idempotent now, so they read the same — collapse the pair anyway, or two identical cards
  // still look like two separate interruptions.
  const now = Date.now()
  if (lastReported !== null && lastReported.message === message && now - lastReported.at < 2_000) return
  lastReported = { message, at: now }
  if (description) toast.error(message, { description })
  else toast.error(message)
}

/** Flattened model catalog → label, keyed by the catalog array so a refresh rebuilds it. */
const labelCache = new WeakMap<object, Map<string, string>>()

/** Reads a friendly name for a model id from whichever live session still lists it. */
function modelLabelFor(modelId: string): string {
  const sessions = client.store.getState().sessions
  for (const session of Object.values(sessions)) {
    const option = session.configOptions.find((entry) => entry.category === "model" && entry.type === "select")
    if (option === undefined || option.type !== "select") continue
    // One badge per turn re-reads this on every render, and a replayed transcript re-renders once
    // per streamed item: flattening the catalog each time made opening a big thread quadratic.
    // Key the flattened map on the catalog array itself, so a new catalog invalidates it.
    const raw: unknown[] = Array.isArray(option.options) ? option.options : []
    let labels = labelCache.get(raw)
    if (labels === undefined) {
      labels = new Map()
      for (const entry of raw.flatMap((item) => {
        const nested = (item as { options?: unknown }).options
        return Array.isArray(nested) ? nested : [item]
      })) {
        const choice = entry as { value?: unknown; name?: unknown }
        if (typeof choice.value === "string" && typeof choice.name === "string" && choice.name !== "")
          labels.set(choice.value, choice.name)
      }
      labelCache.set(raw, labels)
    }
    const hit = labels.get(modelId)
    if (hit !== undefined) return hit
  }
  // No catalog carries it: present the raw id readably ("claude-sonnet-5-5" → "Claude sonnet 5 5").
  return modelId
}

/** The 🤖 label under each answer, WorkBuddy style: which model generated this turn. */
function TurnModelBadge({ turn }: { turn: { final: Array<{ _meta?: unknown }> } }): ReactNode {
  const last = turn.final.at(-1)
  const meta = last?._meta as { codex?: { modelId?: string } } | undefined
  const modelId = typeof meta?.codex?.modelId === "string" ? meta.codex.modelId : null
  if (modelId === null) return null
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs" title={modelId}>
      <Bot className="size-3.5" />
      {modelLabelFor(modelId)}
    </span>
  )
}

/** U's host for the package conversation: activity host, theme, tool labels, files and errors. */
export function useChatHost(): ConversationHost {
  const activity = useChatActivityHost()
  const { t } = useTranslation()
  const { resolvedTheme } = useTheme()
  return useMemo(
    () => ({
      ...activity,
      theme: resolvedTheme,
      // Computer-use tools are private actions; show what they did, not the tool name.
      toolBlock: (block) => {
        const action = privateComputerAction(block.name) ?? privateComputerAction(block.title)
        return action ? { ...block, kind: "other" as const, title: t(computerActionKey(action)) } : block
      },
      saveFile: async (name, data) => {
        await invoke<boolean>("chat_save_file", { name, data })
      },
      FileIcon: CodexFileIcon,
      reportError,
      writeTextAttachment: (name, text) => commands.chatWriteTextAttachment({ name, text })
    }),
    [activity, resolvedTheme, t]
  )
}

/** Package conversation parts outside a conversation view (the draft surface, global requests). */
export function ChatHostProvider({ children }: { children: ReactNode }) {
  const host = useChatHost()
  return (
    <ConversationProvider host={host} client={client}>
      {children}
    </ConversationProvider>
  )
}

function PaneViewport({ viewportRef, viewportProps, children }: TimelineViewportProps) {
  return (
    <Pane
      nativeScroll
      viewportRef={viewportRef}
      viewportClassName="me-[var(--app-scrollbar-edge-gap)] overflow-x-hidden overscroll-none"
      viewportProps={viewportProps}
    >
      {children}
    </Pane>
  )
}

function useNavigationAudio(): NavigationRailAudio {
  const instrument = useStore(navigationSoundStore, (state) => state.instrument)
  const soundMode = useStore(navigationSoundStore, (state) => state.soundMode)
  return useMemo(
    () => ({
      // With sounds off, never create an audio context, not even on a user gesture.
      installUnlock: soundMode === "none" ? () => () => {} : installTimelineUserMessageNavigationAudioUnlock,
      preload: () => {
        if (soundMode !== "none") preloadTimelineUserMessageNavigationInstrument(instrument)
      },
      playSequence: (from, to, tokens) =>
        playTimelineUserMessageNavigationSequence(from, to, tokens, instrument, soundMode)
    }),
    [instrument, soundMode]
  )
}

/** U's timeline slots: fork lineage and actions, the Pane scroller and navigation sounds. */
export function useTimelineSlots(): TimelineSlots {
  const audio = useNavigationAudio()
  return useMemo(
    () => ({
      leading: <ForkOriginDivider />,
      afterTurn: (turn) => <ForkOriginDivider turn={turn} />,
      answerActions: (turn) => (
        <>
          <TurnModelBadge turn={turn} />
          <ForkTurnButton turnId={codexTurnId(turn.final.at(-1)?._meta)} />
        </>
      ),
      navigation: { audio },
      Viewport: PaneViewport
    }),
    [audio]
  )
}
