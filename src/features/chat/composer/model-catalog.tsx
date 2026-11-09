import type { ModelMenuProps } from "@alwith/module-chat/conversation";
import type { ChatModelOption } from "@alwith/module-chat/model-select";
import { Bot } from "lucide-react";

import { NATIVE_MODEL_GROUP } from "@/agent/client";
import openaiLogo from "@/components/icons/openai-logo.svg";
import { ProviderMark } from "@/components/provider-mark";
import modelPresentation from "@/lib/model-presentation.json";
import {
  displayModelLabel,
  gatewayModelId,
  getProviderSnapshot,
  nativeCatalogStatus,
  nativeModelOverrides,
  servedNativeRows,
  providerGroups,
  PROVIDERS
} from "@/lib/providers";

import { ModelSettingsAction } from "./model-settings-action";

type ModelOption = ChatModelOption & { shortLabel?: string };
type ModelGroup = { id: string; name: string; models: ModelOption[] };

const presentation: Record<string, { shortLabel: string } | undefined> =
  modelPresentation;

/**
 * Gateway models are addressed as `gateway:<provider>:<model>`. That prefix is routing detail, not
 * something a reader needs: left in place, a long id collapses into truncated noise in the picker
 * and in the trigger once a conversation is reopened. Only the model part is displayed — sending
 * still uses the full id.
 */
function stripGatewayPrefix(label: string): string {
  const match = /^gateway:[^:]+:(.+)$/.exec(label);
  return match?.[1] ?? label;
}

/** Short labels affect only the selected trigger; catalog labels remain authoritative. */
export function modelTriggerLabel(model: ModelOption): string {
  return stripGatewayPrefix(model.shortLabel ?? model.label);
}

/**
 * Applies the user's OpenAI model list to the integrated group: the saved rows decide which models
 * exist, their order and their labels. A model removed from 可用模型 disappears here as well — the
 * engine keeps offering it until the provider config is re-applied, so trusting its catalog alone
 * left deleted models in the picker.
 *
 * Which rows survive is decided by `servedNativeRows`, the same call 设置 → 默认模型 and 分工 make.
 * Deciding it here a second way — this file used to drop tombstones on its own — is what left the
 * picker one model short of 设置.
 *
 * A row the user keeps but the engine has stopped serving is dropped from the picker, not greyed.
 * Greying kept the row in every list and demanded a live re-check on each menu open to know whether
 * it had come back; the check cost 0.1–8s and locked the picker while it ran. Hiding it means the
 * three surfaces agree with the engine without asking anything, and the row returns by itself the
 * moment the engine lists it again — the saved configuration is never rewritten.
 */
function trimNativeGroup(group: ModelGroup): ModelGroup {
  if (group.id !== NATIVE_MODEL_GROUP.id) return group;
  // A draft names the group before any catalog has arrived (`api_id: ""`). That placeholder is not
  // a model id, and leaving it in the list would read as "the catalog has one model, and it is not
  // any of yours".
  const listed = group.models.filter((model) => model.api_id !== "");
  const saved = nativeModelOverrides();
  if (listed.length === 0 && (saved === null || saved.length === 0)) return group;
  // One call decides the rows; this file only turns them into the menu's option shape. The catalog
  // row is merged back in so anything it carries beyond name and id — a `shortLabel` for the
  // trigger, an icon — survives.
  const byId = new Map(listed.map((model) => [model.api_id, model]));
  // A draft carries a single `api_id: ""` placeholder before `session/new`; that is "not loaded
  // yet", not a failed catalog. A live session that published an empty integrated group means the
  // engine's online list_models failed — do not replay the saved shortlist into it.
  const draft = group.models.some((model) => model.api_id === "");
  const catalog = listed.map((model) => ({ id: model.api_id, label: model.label }));
  const status = nativeCatalogStatus(draft ? undefined : catalog);
  const rows = servedNativeRows(saved, catalog, status);
  return {
    ...group,
    models: rows.map((row) => {
      const known = byId.get(row.id);
      return known === undefined
        ? { api_id: row.id, label: row.label }
        : { ...known, api_id: row.id, label: row.label };
    }),
  };
}

/**
 * The models 设置 → 可用模型 promises but this conversation's own catalog is missing.
 *
 * A thread's model list is written when the thread is prepared, so enabling a model afterwards
 * leaves every open conversation on the old list — the picker showed only DeepSeek-Flash while the
 * settings said two models were available. The provider snapshot is the list the user actually
 * maintains, so anything it offers is added to the matching group (and the group is created when
 * the thread has never heard of that vendor). Picking one writes the same `gateway:` id the rest of
 * the app uses, which the gateway resolves per request.
 */
function withSnapshotModels(groups: ModelGroup[]): ModelGroup[] {
  const snapshot = getProviderSnapshot()
  if (snapshot === null) return groups
  const next = groups.map((group) => ({ ...group, models: [...group.models] }))
  for (const provider of providerGroups(snapshot)) {
    let target = next.find((group) => group.id === provider.id)
    if (target === undefined) {
      target = { id: provider.id, name: provider.name, models: [] }
      next.push(target)
    }
    for (const model of provider.models) {
      const apiId = gatewayModelId(provider.id, model.id)
      // The session's own catalogue was written when the thread was prepared, so it still carries
      // the name the model had before the user renamed it. Refresh an existing row's label as well
      // as adding new ones: the old `if (!some(...)) push` meant only brand-new models ever showed
      // the new name, and every open conversation stayed on the stale one.
      const label = displayModelLabel(apiId, model.label ?? model.id) ?? model.label ?? model.id
      const existing = target.models.find((row) => row.api_id === apiId)
      if (existing === undefined) target.models.push({ api_id: apiId, label })
      else existing.label = label
    }
  }
  return next
}

/** Put the subscription provider first while preserving provider and model order. */
export function presentModelCatalog(groups: ModelGroup[]): ModelGroup[] {
  const trimmed = withSnapshotModels(groups).map(trimNativeGroup);
  const ordered = [
    ...trimmed.filter((group) => group.id === NATIVE_MODEL_GROUP.id),
    ...trimmed.filter((group) => group.id !== NATIVE_MODEL_GROUP.id),
  ];
  return ordered.map((group) => {
    const native = group.id === NATIVE_MODEL_GROUP.id;
    const provider = PROVIDERS.find((entry) => entry.id === group.id);
    // Keep the compact picker visually grouped: the first model carries its group's heading and
    // every model uses the same fixed icon box, independent of whether it is native or gateway.
    return {
      ...group,
      models: group.models.map((model, index) => {
        // A name the user set in 设置 → 大模型 wins over both the thread's stale catalogue label
        // and the bundled compact alias: the trigger used to keep showing "4.1-Flash" forever.
        const renamed = displayModelLabel(model.api_id)
        const label = stripGatewayPrefix(renamed ?? model.label)
        return {
          ...model,
          // Menu rows render the catalog label, so the routing prefix has to go there as well.
          label,
          shortLabel: renamed !== null ? label : (model.shortLabel ?? presentation[model.api_id]?.shortLabel),
          // Decorative: the row's accessible name remains the model label. The data attribute lets
          // host CSS restore provider headings even when the shared menu renders its compact catalog.
          icon: (
            <span
              aria-hidden="true"
              className="model-picker-icon"
              data-model-group-title={index === 0 ? group.name : undefined}
            >
              {native ? (
                <img src={openaiLogo} alt="" className="dark:invert" />
              ) : provider ? (
                // Keep each vendor's own mark: the picker's icon box already supplies the frame, and
                // the brand colour is how the user recognises the provider at a glance.
                <ProviderMark provider={provider} className="" />
              ) : (
                <Bot className="size-4" />
              )}
            </span>
          ),
        }
      }),
    };
  });
}

/** U's model menu policy: subscription models first, provider logos, short labels, settings action. */
export const chatModelMenu: Pick<
  ModelMenuProps,
  "catalog" | "defaultGroup" | "headerAction"
> = {
  defaultGroup: NATIVE_MODEL_GROUP,
  catalog: (groups) => presentModelCatalog(groups),
  headerAction: <ModelSettingsAction />,
};
