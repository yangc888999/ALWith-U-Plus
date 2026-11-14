/**
 * U's composer: the package composer with U's dictation and realtime voice, native file drops,
 * model catalog and prediction preference.
 */
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { usePromptInputAttachments } from "@alwith/module-chat/composer-context"
import { Composer, type ComposerProps, setComposerDraft, useComposer } from "@alwith/module-chat/conversation"
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { useStore } from "zustand"

import { observeVoiceTurn } from "@/core/voice-turn"
import {
  ChatContextMenu,
  type ContextMenuTarget,
  contextMenuText,
  selectionRectOf
} from "@/features/chat/chat-context-menu"
import { RealtimeVoiceButton } from "@/features/voice/realtime-voice-button"
import type { VoiceResume } from "@/features/voice/use-voice-handoff"
import { VoiceButton } from "@/features/voice/voice-button"
import { ActivePreviewChip } from "@/features/workspace/active-preview-chip"
import { client } from "@/lib/client"
import { groupByDirectory } from "@/lib/groups"
import { isTemporaryChatDir } from "@/lib/quick-chat"
import { useHandoffBusy } from "@/lib/use-surface-operation"

import { AccountModelRecovery } from "./composer/account-model-recovery"
import { withoutWaitingForTurn } from "./composer/detach-submit"
import { chatModelMenu } from "./composer/model-catalog"
import { nativeAttachmentPolicy, NativeFileDrop } from "./composer/native-file-drop"
import { OrchestrationControl } from "./composer/orchestration-control"
import { PendingModelChip } from "./composer/pending-model-chip"
import { predictionPreference } from "./composer/prediction-preference"
import { QueuedPromptChip } from "./composer/queued-prompt-chip"
import { TurnProgressBar } from "./turn-progress"

/** Nothing to hand a receipt to: the surface already owns the conversation it is typing into. */
const noHandOff: NonNullable<ComposerProps["onHandOff"]> = () => {}

/** The input's height, dragged from the top edge of the card and remembered across launches. */
const INPUT_HEIGHT_KEY = "alwith:composer-input-height"
const INPUT_MIN = 40
const INPUT_MAX = 720

/**
 * A grab strip along the composer's top edge.
 *
 * The package composer grows its textarea with the text and caps nothing, so a long paste pushed
 * the toolbar off the bottom of the window. Dragging here writes `--composer-input-height` on the
 * wrapping `[data-composer]`, which `index.css` turns into the textarea's height: it keeps growing
 * up to the chosen size and then scrolls, so both "make it taller" and "make it shorter" work.
 */
function ComposerResizeHandle({ shellRef }: { shellRef: React.RefObject<HTMLDivElement | null> }) {
  const drag = useRef<{ startY: number; startHeight: number; shell: HTMLElement } | null>(null)
  useEffect(() => {
    const shell = shellRef.current
    if (shell === null) return
    const saved = Number(localStorage.getItem(INPUT_HEIGHT_KEY))
    if (Number.isFinite(saved) && saved >= INPUT_MIN) shell.style.setProperty("--composer-input-height", `${saved}px`)
  }, [shellRef])
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const shell = event.currentTarget.parentElement
    const area = shell?.querySelector<HTMLElement>(".alwith-composer-textarea")
    if (!shell || !area) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { startY: event.clientY, startHeight: area.getBoundingClientRect().height, shell }
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (state === null) return
    const next = Math.round(
      Math.min(INPUT_MAX, Math.max(INPUT_MIN, state.startHeight + (state.startY - event.clientY)))
    )
    state.shell.style.setProperty("--composer-input-height", `${next}px`)
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    drag.current = null
    if (state === null) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    const value = state.shell.style.getPropertyValue("--composer-input-height")
    if (value !== "") localStorage.setItem(INPUT_HEIGHT_KEY, String(Number.parseFloat(value)))
  }
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      className="group absolute inset-x-6 -top-2.5 z-20 flex h-2.5 cursor-ns-resize items-center justify-center"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span className="h-1 w-10 rounded-full bg-border opacity-0 transition-opacity group-hover:bg-muted-foreground/60 group-hover:opacity-100" />
    </div>
  )
}

function ComposerVoice({ voiceResume }: { voiceResume?: VoiceResume }) {
  const composer = useComposer()
  const { observeReceipts, session } = composer
  const [realtimeActive, setRealtimeActive] = useState(false)
  const observe = useCallback(
    (signal: AbortSignal) => {
      const observation = observeVoiceTurn(
        {
          read: () => client.store.getState().sessions[session.id],
          subscribe: (check) => client.store.subscribe(check)
        },
        signal
      )
      const release = observeReceipts({ accept: observation.accept, signal })
      void observation.completed.then(release, release)
      return observation
    },
    [observeReceipts, session.id]
  )
  const waitForTurn = useCallback((signal: AbortSignal) => observe(signal).completed, [observe])
  const resume =
    voiceResume === undefined
      ? undefined
      : (signal: AbortSignal): Promise<void> => {
          const observation = observe(signal)
          observation.accept(voiceResume.receipt)
          voiceResume.consume()
          return observation.completed
        }
  return (
    <>
      <VoiceButton
        draft={composer.draft}
        cwd={session.cwd}
        enabled={composer.ready && !realtimeActive}
        cancelRef={composer.interruptRef}
        waitForTurn={waitForTurn}
        supportsHandsfree={composer.handsFree}
        resume={resume}
      />
      <RealtimeVoiceButton
        key={session.id}
        sessionId={session.id}
        enabled={composer.ready}
        beforeStart={() => composer.interruptRef.current?.()}
        onActive={setRealtimeActive}
      />
    </>
  )
}

function ComposerFileDrop({ restoreRef }: { restoreRef: { current: ((content: acp.ContentBlock[]) => void) | null } }) {
  const composer = useComposer()
  const attachments = usePromptInputAttachments()
  const group = groupByDirectory(composer.session.cwd)
  useEffect(() => {
    // A dispatch refused before insertion never produced an error item; put the images back in the
    // tray from the content blocks the composer had already built.
    restoreRef.current = (content) => {
      for (const block of content) {
        if (block.type !== "image") continue
        const image = block as unknown as { data?: unknown; mimeType?: unknown }
        if (typeof image.data !== "string" || typeof image.mimeType !== "string") continue
        const binary = atob(image.data)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        attachments.add([new File([bytes], "restored-image", { type: image.mimeType })])
      }
    }
    return () => {
      restoreRef.current = null
    }
  }, [attachments, restoreRef])
  return (
    <NativeFileDrop
      sessionId={composer.session.id}
      enabled={composer.inputReady && !composer.sending}
      onMention={composer.addMention}
      // Images go to the ordinary attachment tray (the package's default): Codex takes them from
      // there, while an inline `〔图N〕` marker only ever reached the model as plain text.
      onImage={(file) => attachments.add([file])}
      materialsDirectory={group?.directory ?? null}
      onBusyChange={composer.setAdding}
    />
  )
}

export function ChatComposer({
  voiceResume,
  onSubmit,
  ...props
}: Omit<ComposerProps, "actions" | "children" | "attachmentPolicy" | "predictions"> & { voiceResume?: VoiceResume }) {
  const predictions = useStore(predictionPreference, (state) => state.enabled)
  // A window/draft handoff is about to replace what is typed here. Lock only for those operations —
  // sending a message uses the same lock but must leave the input usable while the turn streams.
  const handoffBusy = useHandoffBusy()
  const [menu, setMenu] = useState<ContextMenuTarget | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  // Registered by the in-composer bridge, which owns the attachment tray's `add` handle.
  const restoreAttachments = useRef<((content: acp.ContentBlock[]) => void) | null>(null)
  const sessionId = props.session.id
  // An account-owned model that was revoked parks the chat read-only until a new model resumes it.
  const accountRecovery = useStore(client.store, (state) => state.accountModelRecovery?.[props.session.id] ?? false)
  // The recovery card below IS the read-only explanation for this case. The package's generic
  // "open in another client" banner would sit above it claiming a different cause (another client
  // holds the session) with a 重试 button that cannot help — mark the surface so CSS hides that
  // banner while the recovery card is up. Other read-only causes keep the banner.
  const recoveryReadOnly = accountRecovery && props.session.readOnly
  // A chat lives in the quick-chat folder; anything else is a project. `groupByDirectory` looked
  // right but only matches directories the reader registered as a group, so a normal project
  // folder fell through and lost its 分工 entry (2026-11-08).
  const project = isTemporaryChatDir(props.session.cwd) ? null : props.session.cwd
  /**
   * Hands the send to the background instead of awaiting it.
   *
   * `prompt` only settles when the whole turn is over — that is how the engine answers it — and
   * the package composer uses the same promise to drive its `sending` state. Awaiting it therefore
   * kept the submit button spinning and disabled for the entire answer: the round arrow became a
   * spinner that never came back, and a second message could not be sent until the model finished.
   * The turn is already visible through the stop button beside it, so the wait belongs in the
   * background. Only a refusal raised before dispatch (no session, nothing to send) still fails the
   * submit, which is what puts the draft back into the input. A refusal that arrives *after* the
   * window — the engine rejecting before it inserted the message — is reported through
   * `onLateFailure`, which restores the draft and attachments instead of losing them silently.
   */
  const submit = useCallback<NonNullable<ComposerProps["onSubmit"]>>(
    (content, accept) => {
      let task: Promise<unknown>
      try {
        // Only pass the receipt sink when there is one: a caller that forwards its own submit
        // (the draft surface) is called with exactly the arguments it is given, and an explicit
        // `undefined` is a different call than none.
        task =
          onSubmit === undefined
            ? client.prompt(sessionId, content)
            : accept === undefined
              ? onSubmit(content)
              : onSubmit(content, accept)
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
      // Nothing left to wait for: release the composer and let the turn run in the background. The
      // receipt a voice handoff needs arrives with the answer, so it is handed over from inside the
      // window helper instead of holding the button for the whole turn.
      return withoutWaitingForTurn(task, accept, (error) => {
        // The engine refused the dispatch before inserting the message, so there is no error item
        // in the transcript. Put the typed text back (the package's guarded restore refuses to
        // clobber a draft the reader has already started) and re-add the attachments.
        const text = content
          .filter((block): block is Extract<acp.ContentBlock, { type: "text" }> => block.type === "text")
          .map((block) => block.text)
          .join("")
        try {
          if (text !== "") setComposerDraft(sessionId, text)
          restoreAttachments.current?.(content)
        } catch {
          // The composer cannot take the draft back (e.g. it is busy); the toast below still tells
          // the reader the send failed.
        }
        toast.error(error instanceof Error ? error.message : String(error))
      })
    },
    [onSubmit, sessionId]
  )
  /**
   * The package decides hands-free voice from "no submit callback, or one that also handles the
   * handoff" (`handsFree: onSubmit === undefined || onHandOff !== undefined`). Supplying our own
   * submit would quietly downgrade the voice button to push-to-talk on every surface that used the
   * default one, so keep the handoff slot filled when there is nothing to hand off to.
   */
  const handOff = props.onHandOff ?? noHandOff

  // Suggestions cost a round trip per keystroke. While a turn is running that request competes
  // with the stream for the main thread, which is exactly when typing starts to lag and drop
  // characters; keep the input local and instant instead.
  const suggestions = predictions && props.session.state === "idle"
  // The composer owns its own menu: the conversation's document-level handler scopes itself to
  // the transcript and the (ported) header, and the input must not be left without one.
  const openMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    event.preventDefault()
    event.stopPropagation()
    setMenu({
      x: event.clientX,
      y: event.clientY,
      text: contextMenuText(target),
      editable: true,
      selectionRect: selectionRectOf()
    })
  }
  // Nothing here asks the engine about the model list. A model the provider withdraws is dropped
  // from 设置 → 可用模型, this picker and 分工 by `servedNativeRows`, which reads the catalog the
  // session already carries; the row comes back when a later catalog lists it again. The old
  // hover check cost a `session/set_config_option` round trip (0.1–8s) on every menu open and left
  // the picker spinning for the duration, for an answer the session's own catalog already had.
  return (
    <div
      data-composer
      data-composer-mode={project === null ? "chat" : "project"}
      data-account-recovery={recoveryReadOnly ? "" : undefined}
      ref={shellRef}
      className="relative"
      onContextMenu={openMenu}
    >
      <ComposerResizeHandle shellRef={shellRef} />
      {accountRecovery && <AccountModelRecovery key={props.session.id} session={props.session} />}
      <Composer
        modelMenu={chatModelMenu}
        {...props}
        // `@alwith/module-chat`'s Composer exposes `modelSelector` and renders it *instead of* its
        // own `ModelMenu` (see conversation/composer/composer.d.ts). During account-model recovery
        // that built-in picker is disabled and shows "… Preview" in grey, so a second, disabled
        // "model" control sat next to the recovery card's picker and the reader clicked the dead
        // one. Rendering an empty fragment removes only that picker — the textarea, toolbar and
        // every other model selector on non-recovery surfaces are untouched. The recovery card
        // above is now the single, clearly clickable "选择模型" and still resumes through
        // `client.resumeAccountModel`.
        modelSelector={accountRecovery ? <></> : props.modelSelector}
        onSubmit={submit}
        onHandOff={handOff}
        disabled={props.disabled === true || handoffBusy}
        inputHeader={
          props.inputHeader ?? (
            // Chat merges the model-call notice into the chip row; a project keeps the two-row
            // arrangement it has always had, because its row also carries 分工 and the file chips.
            <div
              className={
                project === null
                  ? "flex w-full min-w-0 items-center justify-between gap-2"
                  : "flex w-full min-w-0 flex-col gap-1"
              }
            >
              {project === null ? null : <TurnProgressBar session={props.session} />}
              <div className={project === null ? "contents" : "flex w-full min-w-0 items-center justify-between gap-2"}>
                {/* A quoted document's name is a reference, not the subject: it never takes more
                    than a third of the row, and the rest goes to the model controls. */}
                <div className="flex max-w-[33%] min-w-0 shrink-0 items-center gap-2 overflow-hidden">
                  <ActivePreviewChip />
                  <QueuedPromptChip session={props.session} />
                </div>
                {project === null && (
                  <div className="min-w-0 flex-1">
                    <TurnProgressBar session={props.session} />
                  </div>
                )}
                {/* 分工 belongs to projects: a chat is a throwaway conversation with no plan/execute
                    flow. `groupByDirectory` is the same test the sidebar groups use. */}
                <div className="flex shrink-0 items-center gap-1">
                  <PendingModelChip session={props.session} />
                  {project === null ? null : <OrchestrationControl session={props.session} />}
                </div>
              </div>
            </div>
          )
        }
        predictions={suggestions}
        attachmentPolicy={nativeAttachmentPolicy}
        actions={<ComposerVoice voiceResume={voiceResume} />}
      >
        <ComposerFileDrop restoreRef={restoreAttachments} />
      </Composer>
      <ChatContextMenu target={menu} onClose={() => setMenu(null)} />
    </div>
  )
}
