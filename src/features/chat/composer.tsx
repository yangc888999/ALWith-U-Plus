/**
 * U's composer: the package composer with U's dictation and realtime voice, native file drops,
 * model catalog and prediction preference.
 */
import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable"
import { usePromptInputAttachments } from "@alwith/module-chat/composer-context"
import { Composer, type ComposerProps, setComposerDraft, useComposer } from "@alwith/module-chat/conversation"
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from "react"
import { useTranslation } from "react-i18next"
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
import { describeError } from "@/lib/error-text"
import { groupByDirectory } from "@/lib/groups"
import { isTemporaryChatDir } from "@/lib/quick-chat"
import { isQueueCancelled } from "@/lib/queued-prompt"
import { orchestrationAllowedFor } from "@/lib/session-orchestration"
import { useHandoffBusy } from "@/lib/use-surface-operation"

import { withoutWaitingForTurn } from "./composer/detach-submit"
import { chatModelMenu } from "./composer/model-catalog"
import { nativeAttachmentPolicy, NativeFileDrop } from "./composer/native-file-drop"
import { OrchestrationControl } from "./composer/orchestration-control"
import { predictionPreference } from "./composer/prediction-preference"
import { QueuedPromptList } from "./composer/queued-prompt-list"
import { TurnProgressBar } from "./turn-progress"

/** Nothing to hand a receipt to: the surface already owns the conversation it is typing into. */
const noHandOff: NonNullable<ComposerProps["onHandOff"]> = () => {}

/**
 * Preserve a real caret position across stream-driven rerenders.
 *
 * The package textarea is controlled. WKWebView sometimes moves a focused textarea's selection to
 * the end when React commits a rerender even if the string did not change; during a running turn
 * that made typing into the middle of a supplement jump to the end. We only restore after a
 * transcript update and only when the text is unchanged, so ordinary typing, IME composition,
 * sends and programmatic draft replacement keep their natural selection.
 */
function ComposerCaretGuard({ sessionId }: { sessionId: string }) {
  const items = useStore(client.store, (state) => state.sessions[sessionId]?.items)
  const caret = useRef<{ value: string; start: number; end: number } | null>(null)
  const record = useCallback(() => {
    const field = document.activeElement
    if (!(field instanceof HTMLTextAreaElement) || field.closest("[data-composer]") === null) return
    caret.current = {
      value: field.value,
      start: field.selectionStart ?? field.value.length,
      end: field.selectionEnd ?? field.value.length
    }
  }, [])

  useEffect(() => {
    const events = ["focusin", "input", "keyup", "mouseup", "compositionend"] as const
    for (const event of events) document.addEventListener(event, record, true)
    return () => {
      for (const event of events) document.removeEventListener(event, record, true)
    }
  }, [record])

  useLayoutEffect(() => {
    // Reading the item list makes this effect run after every streamed token commit.
    if (items === undefined) return
    const field = document.activeElement
    if (!(field instanceof HTMLTextAreaElement) || field.closest("[data-composer]") === null) return
    const saved = caret.current
    if (saved === null) return
    if (saved.value !== field.value) {
      record()
      return
    }
    if (field.selectionStart !== saved.start || field.selectionEnd !== saved.end)
      field.setSelectionRange(saved.start, saved.end)
  }, [items, record])

  return null
}

/** The input's height, dragged from the top edge of the card and remembered across launches. */
const INPUT_HEIGHT_KEY = "alwith:composer-input-height"
const INPUT_HEIGHT_POLICY_KEY = "alwith:composer-input-height-policy"
const INPUT_HEIGHT_POLICY = 2
/** The post-1.5.9 default empty composer height. */
const DEFAULT_INPUT_MIN = 120
// The saved value is a ceiling, not a fixed height: an empty composer stays at its two-line floor.
// A smaller drag can still hide the placeholder and resize grip, so values below the floor are
// ignored on load; a hand-edited or malformed localStorage value cannot collapse the composer.
const INPUT_MIN = 44
const INPUT_MAX = 192
/** Restore a deliberately small drag on launch; larger historical values stay ceilings only. */
const INPUT_RESTORE_MAX = 128

/**
 * A grab strip along the composer's top edge.
 *
 * The package composer grows its textarea with the text and caps nothing, so a long paste pushed
 * the toolbar off the bottom of the window. Dragging here writes `--composer-input-height` on the
 * wrapping `[data-composer]`, which `index.css` uses as the textarea's maximum: it grows with the
 * text up to that ceiling and then scrolls. The empty composer always returns to its compact floor.
 */
function ComposerResizeHandle({ shellRef }: { shellRef: React.RefObject<HTMLDivElement | null> }) {
  const drag = useRef<{ startY: number; startHeight: number; shell: HTMLElement } | null>(null)
  useEffect(() => {
    const shell = shellRef.current
    if (shell === null) return
    // The welcome card is a fixed canvas in both tabs; the conversation's remembered height must
    // not resize it (that made Chat and Work differ by the header height). Welcome drags still
    // work for the current session, but they neither read nor overwrite the conversation height.
    if (shell.closest(".welcome-hero-composer") !== null) return
    const saved = Number(localStorage.getItem(INPUT_HEIGHT_KEY))
    const policy = Number(localStorage.getItem(INPUT_HEIGHT_POLICY_KEY) ?? 1)
    if (!Number.isFinite(policy) || policy < INPUT_HEIGHT_POLICY) {
      // The old policy treated 96px as the tallest remembered floor. That was the size readers
      // saw as the "default" composer; lift it to the new default once, while leaving deliberately
      // shorter custom drags alone. Future drags persist normally under the new policy.
      const next = Number.isFinite(saved) && saved === 96 ? DEFAULT_INPUT_MIN : saved
      if (Number.isFinite(next) && next >= INPUT_MIN && next <= INPUT_MAX) {
        shell.style.setProperty("--composer-input-height", `${next}px`)
        if (next <= INPUT_RESTORE_MAX) shell.style.setProperty("--composer-input-min", `${next}px`)
        localStorage.setItem(INPUT_HEIGHT_KEY, String(next))
      }
      localStorage.setItem(INPUT_HEIGHT_POLICY_KEY, String(INPUT_HEIGHT_POLICY))
      return
    }
    if (Number.isFinite(saved) && saved >= INPUT_MIN && saved <= INPUT_MAX) {
      shell.style.setProperty("--composer-input-height", `${saved}px`)
      if (saved <= INPUT_RESTORE_MAX) shell.style.setProperty("--composer-input-min", `${saved}px`)
    } else if (localStorage.getItem(INPUT_HEIGHT_KEY) !== null) {
      localStorage.removeItem(INPUT_HEIGHT_KEY)
    }
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
    // `min` grows with the pointer as well: with only `max-height`, an empty composer stays at
    // its content floor and the drag appears dead. The chosen height is session-pinned; on the
    // next mount the saved value is restored as a ceiling so an old 288px drag cannot make the
    // first screen huge again.
    state.shell.style.setProperty("--composer-input-min", `${next}px`)
    state.shell.style.setProperty("--composer-input-height", `${next}px`)
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    drag.current = null
    if (state === null) return
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    const value = state.shell.style.getPropertyValue("--composer-input-height")
    if (value !== "" && state.shell.closest(".welcome-hero-composer") === null)
      localStorage.setItem(INPUT_HEIGHT_KEY, String(Number.parseFloat(value)))
  }
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      className="group absolute inset-x-6 -top-3 z-20 flex h-3 cursor-ns-resize items-center justify-center"
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

/**
 * `modelSelector` is **required**: the package composer renders its own menu whenever the slot is
 * empty, and that menu is a different control (its own catalog, its own change handler) from the
 * one each surface needs. A surface that forgot the slot therefore did not lose a picker — it got
 * a second, differently-behaving one. Making it required turns that into a compile error instead
 * of something the reader discovers on screen (2026-11-17).
 */
function ChatComposerImpl({
  voiceResume,
  onSubmit,
  ...props
}: Omit<ComposerProps, "actions" | "children" | "attachmentPolicy" | "predictions" | "modelSelector"> & {
  modelSelector: ComposerProps["modelSelector"]
  voiceResume?: VoiceResume
}) {
  const predictions = useStore(predictionPreference, (state) => state.enabled)
  // A window/draft handoff is about to replace what is typed here. Lock only for those operations —
  // sending a message uses the same lock but must leave the input usable while the turn streams.
  const handoffBusy = useHandoffBusy()
  const [menu, setMenu] = useState<ContextMenuTarget | null>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  // Registered by the in-composer bridge, which owns the attachment tray's `add` handle.
  const restoreAttachments = useRef<((content: acp.ContentBlock[]) => void) | null>(null)
  const sessionId = props.session.id
  const { t } = useTranslation()
  // An account-owned model that was revoked. This is a *notice*, not a lock: the composer, the
  // textarea and the ordinary model picker stay exactly as they are, and the reader fixes it by
  // choosing another model from that picker — the one control they already know. The old surface
  // parked the session read-only, replaced the picker with a second one and pinned the input to a
  // single dead row, which is what made a model problem look like a broken input box.
  const accountRecovery = useStore(client.store, (state) => state.accountModelRecovery?.[props.session.id] ?? false)
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
      // Sending on a revoked account model is refused by the engine. Say what to do in the reader's
      // own words *before* dispatching, and still dispatch: the answer is what proves whether the
      // model in the picker works now, and blocking would have made the box refuse input again.
      if (accountRecovery) toast.info(t("provider.managed.reselect"))
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
        // Editing a queued row removes it from the queue and deliberately rejects its submit so
        // the composer can take the content back. That is a requested move, not a failed send.
        if (!isQueueCancelled(error)) toast.error(describeError(error))
      })
    },
    [accountRecovery, onSubmit, sessionId, t]
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
  // Nothing here asks the engine about the model list. 四处选择器统一由 `model-options.ts` 从
  // 「供应商与可用模型」的 enabled shortlist 取候选；引擎目录只是推荐子集，不再用来裁剪或
  // 标注「可能不可用 / 未验证」。旧的 hover 重查会为每次开菜单发一次
  // `session/set_config_option`（0.1–8s）并让选择器一直转圈，早已移除。
  return (
    <div
      data-composer
      data-composer-dock
      data-composer-shell
      data-composer-mode={project === null ? "chat" : "project"}
      ref={shellRef}
      className="relative"
      onContextMenu={openMenu}
    >
      <ComposerCaretGuard sessionId={sessionId} />
      <ComposerResizeHandle shellRef={shellRef} />
      {/* One line, no buttons, no slot taken: it explains the refusals the reader is about to see
          and points at the picker that already sits in the toolbar below. */}
      {accountRecovery && (
        <p role="status" data-model-reselect-notice="" className="px-4 pb-1 text-xs text-muted-foreground">
          {t("provider.managed.reselect")}
        </p>
      )}
      <Composer
        modelMenu={chatModelMenu}
        {...props}
        // The picker is whatever the surface passed, recovery or not: a model problem must not
        // replace the control the reader uses to fix it. `props.modelSelector` arrives through the
        // spread above; nothing here overrides it.
        onSubmit={submit}
        onHandOff={handOff}
        disabled={props.disabled === true || handoffBusy}
        inputHeader={
          props.inputHeader ?? (
            // Two stable rows inside the composer card: the running turn gets the first row, the
            // document reference and project controls get the second. Keeping them apart means a
            // long progress line, a queued message and 分工 cannot all compete for one strip.
            <div className="flex w-full min-w-0 flex-col gap-1">
              <QueuedPromptList session={props.session} embedded />
              <div className="flex w-full min-w-0 items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <TurnProgressBar session={props.session} />
                </div>
              </div>
              <div className="flex w-full min-w-0 items-center justify-between gap-2">
                {/* A quoted document's name is a reference, not the subject. The second row holds
                    no progress text, so the chip can take almost half of the composer before the
                    filename starts truncating. */}
                <div className="flex max-w-[48%] min-w-0 shrink-0 items-center gap-2 overflow-hidden">
                  <ActivePreviewChip />
                </div>
                {/* 分工 belongs to a project conversation with a working plan → execute flow. A
                    chat is a throwaway conversation, and a group discussion is driven by its own
                    roster; `orchestrationAllowedFor` is the same test the client's runtime gate
                    applies, so the control can never appear where the runtime would ignore it. */}
                <div className="flex shrink-0 items-center gap-1">
                  {orchestrationAllowedFor(props.session.cwd) ? <OrchestrationControl session={props.session} /> : null}
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

/**
 * The composer sits in the same tree as the streaming transcript. Memoizing it keeps a new
 * assistant token from re-rendering the textarea, attachment tray, model picker and voice controls;
 * callers that need live item data pass a stable composer projection instead.
 */
export const ChatComposer = memo(ChatComposerImpl)
