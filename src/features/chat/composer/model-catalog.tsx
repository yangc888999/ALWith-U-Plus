import type { ModelMenuProps } from "@alwith/module-chat/conversation";
import type { ChatModelOption } from "@alwith/module-chat/model-select";
import { Bot } from "lucide-react";

import { NATIVE_MODEL_GROUP } from "@/agent/client";
import openaiLogo from "@/components/icons/openai-logo.svg";
import { ProviderMark } from "@/components/provider-mark";
import i18n from "@/lib/i18n"
import modelPresentation from "@/lib/model-presentation.json"
import { resolveModelConfig } from "@/lib/model-config"
import {
  displayModelLabel,
  gatewayModelId,
  getProviderSnapshot,
  isAccountModel,
  nativeModelOverrides,
  pickerProviderGroups,
  PROVIDERS
} from "@/lib/providers";

import alwithLogo from "../../../../src-tauri/icons/32x32.png";

import { ModelSettingsAction } from "./model-settings-action";

type ModelOption = ChatModelOption & { shortLabel?: string; unverified?: boolean };
type ModelGroup = { id: string; name: string; models: ModelOption[] };

const presentation: Record<string, { shortLabel: string } | undefined> =
  modelPresentation

/** English text the hint falls back to when no translation is loaded (unit tests, failed init). */
const UNAVAILABLE_HINT = "may be unavailable"

/**
 * The "this catalog did not list it" suffix, resolved per call rather than at module load: the menu
 * renders in the current language, and a module-level constant would freeze whichever language
 * booted first. `i18n.t` can hand back the key itself (missing resource) or nothing at all (an
 * instance that was never initialised, as in unit tests); both mean "use the literal".
 */
function unavailableHint(): string {
  const key = "composer.modelMayBeUnavailable"
  const translated = i18n.t(key) as string | undefined
  return translated === undefined || translated === "" || translated === key ? UNAVAILABLE_HINT : translated
};

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
 * Which rows exist is decided by `resolveModelConfig`, the same call 设置 → 默认模型 and 分工 make.
 * Deciding it here a second way — this file used to drop tombstones on its own — is what left the
 * picker one model short of 设置.
 *
 * A row the user keeps but the engine has stopped listing stays in the picker with a "may be
 * unavailable" suffix. Dropping it made the picker silently disagree with 设置 → 大模型 (which
 * still shows the row, with a badge) and read as data loss. Nothing is re-checked on menu open:
 * the suffix states what this catalog did or did not include, and it disappears by itself the
 * moment the engine lists the model again — the saved configuration is never rewritten.
 */
function trimNativeGroup(group: ModelGroup, sessionIds?: ReadonlySet<string>): ModelGroup {
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
  // This group IS the live session's own picker, so it is the one config that may call itself
  // authoritative — and only when it really carries rows (a draft placeholder is "not loaded yet").
  const config = resolveModelConfig({
    providerSnapshot: null,
    native: draft
      ? undefined
      : {
          sourceKind: "session",
          name: group.name,
          models: listed.map((model) => ({ id: model.api_id, label: model.label }))
        },
    savedOverrides: saved
  });
  const rows = config.entries;
  // A saved row the engine did not list stays in the menu with a hint instead of disappearing.
  // Hiding it made the picker silently disagree with 设置 → 大模型, where the same row is still
  // there with a badge — and "a model I saved is gone" reads as data loss, not as a status. No
  // extra request is involved: the hint says the list did not include it, which is exactly what we
  // know, and the row goes back to normal the moment the engine lists it again.
  // `group.models` has already been augmented with the saved rows, so it cannot answer "did the
  // session list this id?". The caller passes the session's own ids, captured before that merge.
  const listedIds = sessionIds ?? new Set(listed.map((model) => model.api_id))
  const known = new Set(rows.map((row) => row.id))
  const missing = (saved ?? [])
    .map((row) => ({ id: row.api_id, label: row.label ?? row.api_id }))
    .filter((row) => row.id !== "" && !listedIds.has(row.id) && !known.has(row.id))
  return {
    ...group,
    models: [
      ...rows.map((row) => {
        const knownRow = byId.get(row.id)
        const base =
          knownRow === undefined
            ? { api_id: row.id, label: row.label }
            : { ...knownRow, api_id: row.id, label: row.label }
        // The suffix is added by the caller's final label pass: this function only records the
        // fact, because the presenter below rewrites `label` from the saved override. A draft has
        // published no catalog yet, so "not listed" there means "not loaded", not "gone": every
        // saved row would otherwise open the picker already wearing the hint.
        return { ...base, unverified: draft ? false : !listedIds.has(row.id) }
      }),
      ...missing.map((row) => ({ api_id: row.id, label: row.label, unverified: true })),
    ],
  }
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
  const next = groups.map((group) => ({ ...group, models: group.models.map((model) => ({ ...model })) }))
  for (const provider of pickerProviderGroups(snapshot)) {
    // The snapshot keeps the public ID; session catalogs use the gateway's encoded runtime ID.
    // Derive that alias through the routing helper without rewriting either persisted identity.
    const runtimeId = decodeURIComponent(gatewayModelId(provider.id, "").split(":")[1])
    const matches = next.filter((group) => group.id === provider.id || group.id === runtimeId)
    let target = matches[0]
    if (target === undefined) {
      target = { id: provider.id, name: provider.name, models: [] }
      next.push(target)
    } else {
      // Keep the first session group's ID and row metadata, including when both aliases exist.
      const byId = new Map<string, ModelOption>()
      for (const group of matches) {
        for (const model of group.models) {
          const existing = byId.get(model.api_id)
          byId.set(model.api_id, existing === undefined ? model : { ...model, ...existing })
        }
        if (group !== target) next.splice(next.indexOf(group), 1)
      }
      target.models = [...byId.values()]
    }
    // OpenRouter only: the snapshot list is the user's explicit enabled shortlist, so a session row
    // the snapshot no longer offers is a disabled/removed model and must leave the picker. Other
    // providers (enterprise included) can publish partial snapshots mid-refresh; pruning against
    // those would wipe a healthy group, so their session-only rows are kept.
    if (provider.id === "openrouter") {
      const offered = new Set(provider.models.map((model) => gatewayModelId(provider.id, model.id)));
      target.models = target.models.filter(
        (model) => !model.api_id.startsWith(`gateway:${encodeURIComponent(runtimeId)}:`) || offered.has(model.api_id)
      );
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
  // Filter identity, not presentation: old sessions can retain LiteLLM rows in other groups,
  // and snapshot augmentation must not add the retired account entry back afterwards.
  // Captured before `withSnapshotModels` folds the saved rows in: only this set says which ids the
  // session itself listed, and only those may render without the "may be unavailable" hint.
  const sessionIds = new Map(
    groups.map((group) => [group.id, new Set(group.models.map((model) => model.api_id))])
  )
  const trimmed = withSnapshotModels(groups)
    .filter((group) => group.id !== "litellm")
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => !model.api_id.startsWith("gateway:litellm:")),
    }))
    .map((group) => trimNativeGroup(group, sessionIds.get(group.id)));
  // Resolved once per call: every marked row in this render shares the same suffix.
  const hint = unavailableHint()
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
        const base = stripGatewayPrefix(renamed ?? model.label)
        // Marked rows stay visible with a hint instead of being dropped: "not in this catalog" is a
        // status, not a deletion, and the same row is still listed in 设置 → 大模型.
        const label = model.unverified === true ? `${base} · ${hint}` : base
        const account = group.id === "litellm" || group.id === "finture-enterprise" || isAccountModel(model.api_id)
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
              ) : account ? (
                // Account-owned models (Finture account-managed, Finture enterprise) carry the app mark:
                // they have no vendor entry in PROVIDERS and are not the user's own keys.
                <img src={alwithLogo} alt="" className="size-4" />
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
