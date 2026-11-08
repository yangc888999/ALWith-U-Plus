import {
  type ChatModelOption,
  ModelSelect,
} from "@alwith/module-chat/model-select";
import { Zap } from "lucide-react";
import { useTranslation } from "react-i18next";

import { NATIVE_MODEL_GROUP } from "@/agent/client";
import type { ProviderSnapshot } from "@/lib/providers";
import {
  defaultModelFallback,
  gatewayModelId,
  nativeModelOverrides,
  providerGroups,
  resolveSessionModel,
} from "@/lib/providers";

import { modelTriggerLabel, presentModelCatalog } from "./model-catalog";
import { ModelSettingsAction } from "./model-settings-action";

const nativeModel: ChatModelOption = {
  api_id: "",
  label: NATIVE_MODEL_GROUP.name,
};

/**
 * The label 设置 → 可用模型 gave a model, so a draft can name the default before `session/new`
 * hands over the native catalog. Gateway ids keep their raw form; the trigger strips the prefix.
 */
function savedNativeLabel(model: string | null): string | null {
  if (model === null || model === "") return null;
  const row = (nativeModelOverrides() ?? []).find((entry) => entry.api_id === model);
  if (row === undefined) return null;
  return row.label.trim() !== "" ? row.label : row.api_id;
}

/** Native model details arrive with session/new; gateway models are already in the catalog. */
export function DraftModelSelect({
  snapshot,
  model,
  onChange,
}: {
  snapshot: ProviderSnapshot | null;
  model: string | null;
  onChange: (model: string | null) => void;
}) {
  const { t } = useTranslation();
  const groups: { id: string; name: string; models: ChatModelOption[] }[] = [
    {
      id: NATIVE_MODEL_GROUP.id,
      name: NATIVE_MODEL_GROUP.name,
      models: [nativeModel],
    },
    ...(snapshot === null ? [] : providerGroups(snapshot)).map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((item) => ({
        api_id: gatewayModelId(provider.id, item.id),
        label: item.label ?? item.id,
      })),
    })),
  ];
  const catalog = presentModelCatalog(groups);
  const models = catalog.flatMap((group) => group.models);
  // The chat that starts from this draft uses `client.resolveModel(null)`, which honours
  // 设置 → 默认会话模型. Reading only the built-in fallback here made the trigger show a
  // different model from the one the session actually ran with.
  const defaultModel =
    snapshot === null
      ? null
      : (defaultModelFallback(snapshot) ?? resolveSessionModel(null, snapshot));
  const selected =
    model === null
      ? (models.find((item) => item.api_id === defaultModel) ?? {
          api_id: defaultModel ?? "",
          label: savedNativeLabel(defaultModel) ?? defaultModel ?? NATIVE_MODEL_GROUP.name,
        })
      : (models.find((item) => item.api_id === model) ?? {
          api_id: model,
          label: savedNativeLabel(model) ?? model,
        });
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
          icon: <Zap className="size-4" aria-hidden="true" />,
        },
      ]}
      showModelList
      onChange={(item) => onChange(item.api_id === "" ? null : item.api_id)}
      t={(key) => t(key, { ns: "alwithChat" })}
    />
  );
}
