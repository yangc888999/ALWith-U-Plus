// Groups: roles defined once, meetings that gather them. A role is a name, a model and the
// instructions that make that model behave like that role; the instructions can be written here,
// point at a markdown file, or name one of the Codex skills.
//
// This page owns the ROLE LIBRARY and the discussion defaults only. The meetings themselves live
// in the sidebar panel (create / edit / delete via the meeting dialog) — a second editable list
// here was the same data twice, and its old "attach folder" flow is what pinned a meeting onto
// `groups/` itself instead of its named subfolder.

import { invoke } from "@tauri-apps/api/core"
import {
  ChevronDownIcon,
  DownloadIcon,
  FileTextIcon,
  FolderOpenIcon,
  PenLineIcon,
  PlusIcon,
  Trash2Icon,
  UsersIcon
} from "lucide-react"
import { useEffect, useId, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  ensureDefaultGroupRoles,
  groupRoleFor,
  groupRoles,
  importBuiltinBots,
  newRoleId,
  removeGroupRole,
  roleBot,
  setGroupRole,
  type BuiltinBot,
  type GroupRole
} from "@/lib/group-roles"
import {
  DEFAULT_SUMMARY_TEMPLATE,
  groupPreferences,
  setGroupPreferences,
  subscribeGroupPreferences,
  SUMMARY_MODES,
  type SummaryMode
} from "@/lib/group-preferences"
import { NATIVE_MODEL_GROUP } from "@/agent/client"
import { useProviders } from "@/lib/use-providers"

import { SettingsCard, SettingsNote } from "./shared"
import { modelEntries } from "@/lib/model-catalog"
import { useSettingsNativeModels } from "@/lib/settings-bridge"

interface SkillEntry {
  id: string
  name: string
  path: string
}

export function GroupSection() {
  const { t } = useTranslation()
  const snapshot = useProviders()
  const native = useSettingsNativeModels()
  const models = modelEntries(snapshot, native)
  // A fresh install is seeded with the personas the app bundles into ~/.codex/rob_models;
  // afterwards the stored list is the only source of truth (deleting them all sticks).
  const [roles, setRoles] = useState<GroupRole[]>(() => ensureDefaultGroupRoles())
  const [skills, setSkills] = useState<SkillEntry[]>([])
  const [expandedRoles, setExpandedRoles] = useState<Set<string>>(() => new Set())
  const allExpanded = roles.length > 0 && roles.every((role) => expandedRoles.has(role.id))
  const toggleRole = (id: string): void => {
    setExpandedRoles((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  useEffect(() => {
    void invoke<SkillEntry[]>("skills_list")
      .then((entries) => setSkills(entries.filter((entry) => entry.id !== ".system")))
      .catch(() => setSkills([]))
  }, [])

  // 「导入内置机器人」: read the default role library and add every bot that is not in the roster
  // yet, persona + config together. One pass per click — no polling, and re-clicking is a no-op
  // because a bot already imported is skipped rather than duplicated.
  const [importing, setImporting] = useState(false)
  const importBots = (): void => {
    if (importing) return
    setImporting(true)
    void invoke<BuiltinBot[]>("rob_models_list")
      .then((bots) => {
        if (bots.length === 0) {
          toast.info(t("groups.importBotsEmpty"))
          return
        }
        const result = importBuiltinBots(bots, models[0]?.id ?? "")
        setRoles(groupRoles())
        if (result.added.length === 0) {
          toast.info(t("groups.importBotsNone", { count: result.skipped.length }))
          return
        }
        toast.success(
          t("groups.importBotsDone", { count: result.added.length, skipped: result.skipped.length })
        )
      })
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => setImporting(false))
  }

  const addRole = (): void => {
    const role: GroupRole = {
      id: newRoleId(),
      name: t("groups.roleDefaultName"),
      model: models[0]?.id ?? "",
      effort: null,
      persona: { kind: "inline", text: "" },
      skill: null,
      moderator: false
    }
    setGroupRole(role)
    setRoles(groupRoles())
  }

  // Each bundled bot keeps its model / effort / moderator next to its persona
  // (`rob_models/<bot>/config.json`), so the settings survive a clear of localStorage and are the
  // same file the folder shows. Read once on mount; a hand-edited or missing file just leaves the
  // stored role alone.
  useEffect(() => {
    let cancelled = false
    void Promise.all(
      roles.map(async (role) => {
        const bot = roleBot(role)
        if (bot === null) return
        try {
          const raw = await invoke<string | null>("rob_models_read_config", { bot })
          if (raw === null || raw === "" || cancelled) return
          const config = JSON.parse(raw) as { model?: unknown; effort?: unknown; moderator?: unknown }
          const current = groupRoleFor(role.id)
          if (current === null) return
          setGroupRole({
            ...current,
            model: typeof config.model === "string" && config.model !== "" ? config.model : current.model,
            effort: typeof config.effort === "string" ? config.effort : current.effort,
            moderator: config.moderator === true
          })
        } catch {
          // Ignore: a bad config must never block the roles list.
        }
      })
    ).then(() => {
      if (!cancelled) setRoles(groupRoles())
    })
    return () => {
      cancelled = true
    }
    // Mount only: configs seed a bot's settings; they are not a live mirror of the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (role: GroupRole, patch: Partial<GroupRole>): void => {
    const next = { ...role, ...patch }
    setGroupRole(next)
    setRoles(groupRoles())
    const bot = roleBot(next)
    if (bot !== null && ("model" in patch || "effort" in patch || "moderator" in patch)) {
      const config = JSON.stringify({ model: next.model, effort: next.effort, moderator: next.moderator }, null, 2)
      void invoke("rob_models_write_config", { bot, config }).catch(() => {
        // A read-only library folder must not break the editor; localStorage still has the change.
      })
    }
  }

  return (
    <div className="space-y-4">
      <SettingsCard
        title={t("groups.rolesTitle")}
        desc={t("groups.rolesDesc")}
        icon={<UsersIcon className="size-4" />}
        action={
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" disabled={importing} onClick={importBots}>
              <DownloadIcon className={cn("size-3.5", importing && "animate-pulse")} />
              {importing ? t("groups.importBotsRunning") : t("groups.importBots")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void invoke<string>("rob_models_open_folder").catch((error: unknown) =>
                  toast.error(error instanceof Error ? error.message : String(error))
                )
              }
            >
              <FolderOpenIcon className="size-3.5" />
              {t("groups.openRoleFolder")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setExpandedRoles(allExpanded ? new Set() : new Set(roles.map((role) => role.id)))
              }
            >
              <ChevronDownIcon className={cn("size-3.5 transition-transform", allExpanded && "rotate-180")} />
              {allExpanded ? t("groups.collapseAll") : t("groups.expandAll")}
            </Button>
            <Button variant="outline" size="sm" onClick={addRole}>
              <PlusIcon className="size-3.5" />
              {t("groups.addRole")}
            </Button>
          </div>
        }
      >
        {roles.length === 0 ? (
          <SettingsNote>{t("groups.noRoles")}</SettingsNote>
        ) : (
          <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <p className="text-[11px] text-muted-foreground sm:col-span-2 xl:col-span-3">{t("groups.roleExpandHint")}</p>
            {roles.map((role) => (
              <RoleCard
                key={role.id}
                role={role}
                models={models}
                skills={skills}
                expanded={expandedRoles.has(role.id)}
                onToggle={() => toggleRole(role.id)}
                onChange={(patch) => update(role, patch)}
                onRemove={() => {
                  removeGroupRole(role.id)
                  setRoles(groupRoles())
                }}
              />
            ))}
          </div>
        )}
      </SettingsCard>

      {/* Global defaults belong at the bottom: the role library above is what a user opens this
          page for; the template is a once-in-a-while tuning surface. Meetings themselves are
          created and edited from the sidebar panel, not here. */}
      <DiscussionDefaultsCard />
    </div>
  )
}

function DiscussionDefaultsCard() {
  const { t } = useTranslation()
  const roundsId = useId()
  const templateId = useId()
  const summaryModeId = useId()
  const preferences = useSyncExternalStore(subscribeGroupPreferences, groupPreferences, groupPreferences)
  const fieldClass = "h-8 min-w-0 rounded-md border border-border/70 bg-background px-2 text-xs"
  /** Maps each stored mode to its localized dropdown label. */
  const modeLabel = (mode: SummaryMode): string => {
    switch (mode) {
      case "perRole":
        return t("groups.modePerRole")
      case "decision":
        return t("groups.modeDecision")
      case "debate":
        return t("groups.modeDebate")
      case "brief":
        return t("groups.modeBrief")
    }
  }
  return (
    <SettingsCard
      title={t("groups.defaultsTitle")}
      desc={t("groups.defaultsDesc")}
      icon={<PenLineIcon className="size-4" />}
      action={
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setGroupPreferences({ rounds: 2, summaryTemplate: DEFAULT_SUMMARY_TEMPLATE, summaryMode: "perRole" })
          }
        >
          {t("groups.restoreDefaults")}
        </Button>
      }
    >
      {/* The template is the card's subject now; rounds is a secondary global default, kept at the
          foot so renaming the card does not silently drop the new-group round count. */}
      <div className="space-y-1.5">
        <label className="text-[11px] font-medium text-foreground/80" htmlFor={templateId}>
          {t("groups.summaryTemplate")}
        </label>
        <textarea
          id={templateId}
          className="h-32 w-full resize-y rounded-md border border-border/70 bg-background p-2 font-mono text-xs leading-relaxed"
          value={preferences.summaryTemplate}
          onChange={(event) => setGroupPreferences({ summaryTemplate: event.target.value })}
        />
        <SettingsNote>{t("groups.summaryTemplateHint")}</SettingsNote>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
        <label className="text-[11px] text-muted-foreground" htmlFor={roundsId}>
          {t("groups.defaultRounds")}
        </label>
        <select
          id={roundsId}
          className={`${fieldClass} w-28 shrink-0`}
          value={preferences.rounds}
          onChange={(event) => setGroupPreferences({ rounds: Number(event.target.value) })}
        >
          {[1, 2, 3, 4, 5].map((count) => (
            <option key={count} value={count}>
              {t("groups.rounds", { count })}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
        <label className="text-[11px] text-muted-foreground" htmlFor={summaryModeId}>
          {t("groups.summaryMode")}
        </label>
        <select
          id={summaryModeId}
          className={`${fieldClass} w-44 shrink-0`}
          value={preferences.summaryMode}
          onChange={(event) => setGroupPreferences({ summaryMode: event.target.value as SummaryMode })}
        >
          {SUMMARY_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {modeLabel(mode)}
            </option>
          ))}
        </select>
        <span className="text-[11px] leading-relaxed text-muted-foreground">{t("groups.summaryModeHint")}</span>
      </div>
    </SettingsCard>
  )
}

const AVATAR_TONES: readonly string[] = [
  "bg-rose-500/12 text-rose-700 dark:text-rose-300",
  "bg-amber-500/14 text-amber-700 dark:text-amber-300",
  "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
  "bg-sky-500/12 text-sky-700 dark:text-sky-300",
  "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  "bg-cyan-500/12 text-cyan-700 dark:text-cyan-300"
]

function avatarTone(seed: string): string {
  let hash = 0
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? ""
}

/**
 * A roster card. Eight roles each rendering six form rows used to make this page an endless stack
 * of identical boxes. Now the list is scannable: avatar + name + a one-line summary, with a single
 * expanded card at a time for editing. Only the outer card owns a border, so no nested boxes touch.
 */
function RoleCard({
  role,
  models,
  skills,
  expanded,
  onToggle,
  onChange,
  onRemove
}: {
  role: GroupRole
  models: ReturnType<typeof modelEntries>
  skills: SkillEntry[]
  expanded: boolean
  onToggle: () => void
  onChange: (patch: Partial<GroupRole>) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const nameId = useId()
  const modelLabel = models.find((model) => model.id === role.model)?.label ?? role.model
  const personaLabel =
    role.persona.kind === "file"
      ? (role.persona.path.split(/[\\/]/).pop() || role.persona.path)
      : t("groups.personaInline")

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card transition-colors",
        // Three per row; the card being edited spans the whole row so its two-column form
        // keeps a readable width instead of being squeezed into a third of the grid.
        expanded ? "border-primary/35 shadow-sm sm:col-span-2 xl:col-span-3" : "border-border/60"
      )}
    >
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span
          className={cn("grid size-9 shrink-0 place-items-center rounded-full text-sm font-semibold", avatarTone(role.id))}
          aria-hidden="true"
        >
          {role.name.trim().charAt(0).toUpperCase() || "?"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <input
              id={nameId}
              aria-label={t("groups.fieldName")}
              className="min-w-0 max-w-[14rem] flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium outline-none hover:border-border/60 focus:border-primary/50 focus:bg-background"
              value={role.name}
              onChange={(event) => onChange({ name: event.target.value })}
            />
            {role.fastMode === true && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {t("groups.fieldFastMode")}
              </span>
            )}
          </div>
          <p className="truncate px-1 text-[11px] text-muted-foreground" title={`${modelLabel} · ${personaLabel}`}>
            {modelLabel}
            {role.effort ? ` · ${role.effort}` : ""}
            {" · "}
            {personaLabel}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={t("groups.removeRole")}
          title={t("groups.removeRole")}
          onClick={onRemove}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-expanded={expanded}
          aria-label={expanded ? t("groups.collapseAll") : t("groups.expandAll")}
          title={expanded ? t("groups.collapseAll") : t("groups.expandAll")}
          onClick={onToggle}
        >
          <ChevronDownIcon className={cn("size-4 transition-transform", expanded && "rotate-180")} />
        </Button>
      </div>
      {expanded && (
        <div className="border-t border-border/50 bg-muted/10 px-3 py-3">
          <RoleEditor role={role} models={models} skills={skills} onChange={onChange} />
        </div>
      )}
    </div>
  )
}

function RoleEditor({
  role,
  models,
  skills,
  onChange
}: {
  role: GroupRole
  models: ReturnType<typeof modelEntries>
  skills: SkillEntry[]
  onChange: (patch: Partial<GroupRole>) => void
}) {
  const { t } = useTranslation()
  const modelId = useId()
  const effortId = useId()
  const personaId = useId()
  const skillId = useId()
  const [draftText, setDraftText] = useState(role.persona.kind === "inline" ? role.persona.text : "")
  const entry = models.find((model) => model.id === role.model)
  const efforts = entry?.efforts ?? []
  // Only the integrated (GPT) group publishes acceleration; a gateway model has none.
  const fastCapable = entry?.groupId === NATIVE_MODEL_GROUP.id
  const fieldClass = "h-8 w-full min-w-0 rounded-md border border-border/70 bg-background px-2 text-xs"
  const sectionClass = "text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/75"
  const titleId = useId()
  return (
    <div className="space-y-4">
      <section>
        <h4 className={`${sectionClass} mb-2`}>{t("groups.roleSectionIdentity")}</h4>
        <label className="block min-w-0" htmlFor={titleId}>
          <span className="mb-1 block text-[11px] text-muted-foreground">{t("groups.roleTitle")}</span>
          <input
            id={titleId}
            className={fieldClass}
            placeholder={t("groups.roleTitlePlaceholder")}
            value={role.title ?? ""}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </label>
      </section>

      <section>
        <h4 className={`${sectionClass} mb-2`}>{t("groups.roleSectionModel")}</h4>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block min-w-0" htmlFor={modelId}>
            <span className="mb-1 block text-[11px] text-muted-foreground">{t("groups.fieldModel")}</span>
            <select
              id={modelId}
              className={fieldClass}
              value={role.model}
              onChange={(event) => onChange({ model: event.target.value, effort: null })}
            >
              {models.length === 0 && <option value="">{t("groups.noModels")}</option>}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block min-w-0" htmlFor={effortId}>
            <span className="mb-1 block text-[11px] text-muted-foreground">{t("groups.fieldEffort")}</span>
            <select
              id={effortId}
              className={fieldClass}
              value={role.effort ?? ""}
              onChange={(event) => onChange({ effort: event.target.value === "" ? null : event.target.value })}
            >
              <option value="">{t("groups.effortDefault")}</option>
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </label>
        </div>
        {fastCapable && (
          <div className="mt-2.5 flex items-center gap-2">
            <Switch
              aria-label={t("groups.fieldFastMode")}
              checked={role.fastMode === true}
              onCheckedChange={(checked) => onChange({ fastMode: checked })}
            />
            <span className="text-[11px] text-muted-foreground">{t("groups.fieldFastMode")}</span>
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h4 className={sectionClass}>{t("groups.roleSectionPersona")}</h4>
          {/* One button flips the persona between written text and a markdown file; whichever mode
              is on shows only its own control — a selected md file must not leave a text box. */}
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={() => {
              if (role.persona.kind === "file") {
                onChange({ persona: { kind: "inline", text: draftText } })
                return
              }
              // The button's whole point is "pick the md file": open the native picker right away
              // and reference the chosen document, instead of asking for a path first.
              void invoke<string | null>("pick_role_document")
                .then((path) => {
                  if (path === null) return
                  onChange({ persona: { kind: "file", path } })
                })
                .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
            }}
          >
            {role.persona.kind === "inline" ? (
              <FileTextIcon className="size-3" />
            ) : (
              <PenLineIcon className="size-3" />
            )}
            {role.persona.kind === "inline" ? t("groups.personaFile") : t("groups.personaInline")}
          </Button>
        </div>
        {role.persona.kind === "inline" ? (
          <textarea
            id={personaId}
            className="h-24 w-full resize-y rounded-md border border-border/70 bg-background p-2 text-xs leading-relaxed"
            placeholder={t("groups.roleInstructionPlaceholder")}
            value={role.persona.text}
            onChange={(event) => {
              setDraftText(event.target.value)
              onChange({ persona: { kind: "inline", text: event.target.value } })
            }}
          />
        ) : (
          <div className="flex items-center gap-2">
            <input
              id={personaId}
              className={`${fieldClass} flex-1`}
              placeholder={t("groups.personaFilePlaceholder")}
              value={role.persona.path}
              onChange={(event) => onChange({ persona: { kind: "file", path: event.target.value } })}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void invoke<string | null>("pick_role_document")
                  .then((path) => {
                    if (path === null) return
                    onChange({ persona: { kind: "file", path } })
                  })
                  .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
              }}
            >
              {t("groups.pickFile")}
            </Button>
          </div>
        )}
        <label className="mt-2.5 block" htmlFor={skillId}>
          <span className="mb-1 block text-[11px] text-muted-foreground">{t("groups.fieldSkill")}</span>
          <select
            id={skillId}
            className={fieldClass}
            value={role.skill ?? ""}
            onChange={(event) => onChange({ skill: event.target.value === "" ? null : event.target.value })}
          >
            <option value="">{t("groups.skillNone")}</option>
            {skills.map((skill) => (
              <option key={skill.id} value={skill.id}>
                {skill.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      <p className="mt-3 border-t border-border/50 pt-3 text-[11px] text-muted-foreground">
        {t("groups.roleOrderHint")}
      </p>
    </div>
  )
}

// The roster editor lives in @/features/groups/roster-editor so the sidebar's meeting dialog
// is the single place a roster is arranged.
