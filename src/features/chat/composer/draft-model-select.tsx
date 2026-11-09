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
  displayModelLabel,
  gatewayModelId,
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
 * The label 设置 → 大模型 gave a model, so a draft can name the default before `session/new`
 * hands over the native catalog. Both native GPT and gateway rows resolve through the same
 * `displayModelLabel` the chat picker uses; reading only native overrides here left a renamed
 * gateway model showing its raw id on the trigger.
 */
function savedModelLabel(model: string | null): string | null {
  if (model === null || model === "") return null;
  return displayModelLabel(model, model);
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
          label: savedModelLabel(defaultModel) ?? defaultModel ?? NATIVE_MODEL_GROUP.name,
        })
      : (models.find((item) => item.api_id === model) ?? {
          api_id: model,
          label: savedModelLabel(model) ?? model,
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
