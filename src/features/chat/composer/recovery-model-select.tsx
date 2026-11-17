import { client } from "@/lib/client"
import { getProviderSnapshot } from "@/lib/providers"

import { DraftModelSelect } from "./draft-model-select"

/**
 * The model picker for a chat whose own config options no longer carry a model option.
 *
 * The shared `ModelMenu` renders **nothing at all** when the session's option list has no `model`
 * entry (`if (!model && !thoughtLevel && …) return null`), which is precisely the state a revoked
 * account model leaves behind. The composer then says 「请在下方模型选择器中选择模型」 while the
 * selector it points at has been removed — a dead end, which is what the 拉会 screen showed
 * (2026-11-17).
 *
 * Picking a model has to go through `resumeAccountModel`, not `setConfig`. A session whose model was
 * revoked has no `model` option left, so writing one fails with
 * `ConfigOptionError: session … offers no config option …` — the same wall the automatic fallback
 * hit. `resumeAccountModel` instead replays the thread with the choice named in `meta.alwith.model`,
 * which rebuilds the option list and re-attaches the session in one step.
 */
export function RecoveryModelSelect({
  sessionId,
  cwd,
  currentModel,
  recovering
}: {
  sessionId: string
  cwd: string
  /** Already resolved by the caller from `selectedModelId(configOptions)`. */
  currentModel: string | null
  /** `state.accountModelRecovery[sessionId]`: the engine refused the account model. */
  recovering: boolean
}) {
  return (
    <div data-recovery-model-select="" className="contents">
      <DraftModelSelect
        snapshot={getProviderSnapshot()}
        model={currentModel}
        onChange={(model) => {
          if (model === null || model === "") return
          void (async () => {
            if (recovering) {
              // Rebuilds the session's options around this model and re-attaches it.
              await client.resumeAccountModel(sessionId, model).catch(() => undefined)
              return
            }
            // An ordinary chat that simply has no model option: write the choice, and attach the
            // session if its replay never landed.
            await client.setConfig(sessionId, "model", model).catch(() => undefined)
            if (!client.state.sessions[sessionId]?.attached) {
              await client.open(sessionId, cwd).catch(() => undefined)
            }
          })()
        }}
      />
    </div>
  )
}
