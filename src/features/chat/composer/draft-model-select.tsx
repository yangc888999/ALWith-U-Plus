import { type ChatModelOption, ModelSelect } from "@alwith/module-chat/model-select"
import { Zap } from "lucide-react"
import { useTranslation } from "react-i18next"

import { NATIVE_MODEL_GROUP } from "@/agent/client"
import type { ProviderSnapshot } from "@/lib/providers"
import { defaultModelFallback, displayModelLabel, resolveSessionModel } from "@/lib/providers"

import { modelTriggerLabel, presentModelCatalog } from "./model-catalog"
import { ModelSettingsAction } from "./model-settings-action"

/**
 * 草稿期的「跟随引擎内置默认」哨兵行：`api_id: ""` 不是模型，发送时按引擎自己的默认模型处理。
 * 它属于「自动（内置默认）」能力，必须保留；但候选模型本身仍全部由统一出口给出。
 */
const nativePlaceholder: ChatModelOption = { api_id: "", label: NATIVE_MODEL_GROUP.name }

/**
 * The label 设置 → 大模型 gave a model, so a draft can name the default before `session/new`
 * hands over the native catalog. Both native GPT and gateway rows resolve through the same
 * `displayModelLabel` the chat picker uses; reading only native overrides here left a renamed
 * gateway model showing its raw id on the trigger.
 */
function savedModelLabel(model: string | null): string | null {
  if (model === null || model === "") return null
  return displayModelLabel(model, model)
}

/**
 * 草稿选择器不再自己拼一份 `pickerProviderGroups` 清单：候选由 `presentModelCatalog` →
 * `resolveModelOptions` 统一给出。这里只保留一个「跟随内置默认」占位行（不是模型清单），
 * 并把该窗口持有的 provider 配置交给同一个出口。
 */
export function DraftModelSelect({
  snapshot,
  model,
  onChange,
  placeholder
}: {
  snapshot: ProviderSnapshot | null
  model: string | null
  onChange: (model: string | null) => void
  /**
   * When set and nothing has been picked yet, the trigger shows this text instead of the default
   * model's name. The account-model recovery card uses it: naming a default there read as "a model
   * is already selected", so the reader kept clicking the greyed-out main picker instead. Other
   * callers (draft chat) omit it and keep showing the configured default.
   */
  placeholder?: string
}) {
  const { t } = useTranslation()
  const catalog = presentModelCatalog(
    [{ id: NATIVE_MODEL_GROUP.id, name: NATIVE_MODEL_GROUP.name, models: [nativePlaceholder] }],
    snapshot
  )
  const models: ChatModelOption[] = catalog.flatMap((group) => group.models)
  // The chat that starts from this draft uses `client.resolveModel(null)`, which honours
  // 设置 → 默认会话模型. Reading only the built-in fallback here made the trigger show a
  // different model from the one the session actually ran with.
  const defaultModel =
    snapshot === null ? null : (defaultModelFallback(snapshot) ?? resolveSessionModel(null, snapshot))
  // Nothing picked + a caller-supplied placeholder: say "选择模型", never the default model's
  // name. `model` stays null, so the recovery button remains disabled until an actual pick.
  const selected =
    model === null
      ? placeholder !== undefined
        ? { api_id: "", label: placeholder }
        : (models.find((item) => item.api_id === defaultModel) ?? {
            api_id: defaultModel ?? "",
            label: savedModelLabel(defaultModel) ?? defaultModel ?? NATIVE_MODEL_GROUP.name
          })
      : (models.find((item) => item.api_id === model) ?? {
          api_id: model,
          label: savedModelLabel(model) ?? model
        })
  return (
    <ModelSelect
      value={{ ...selected, label: modelTriggerLabel(selected) }}
      models={models}
      modelGroups={catalog}
      header={{ name: t("chat.model.model"), action: <ModelSettingsAction /> }}
      className="model-picker-trigger"
      compactCatalog
      unavailableEffort={{ name: "Effort", label: t("chat.model.unsupported") }}
      booleanOptions={[
        {
          id: "fast-mode",
          name: t("chat.model.fastMode"),
          currentValue: false,
          disabled: true,
          title: t("chat.model.unsupportedHint"),
          icon: <Zap className="size-4" aria-hidden="true" />
        }
      ]}
      showModelList
      onChange={(item) => onChange(item.api_id)}
      t={(key) => t(key, { ns: "alwithChat" })}
    />
  )
}
