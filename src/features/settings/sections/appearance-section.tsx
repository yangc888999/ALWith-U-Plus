import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { useEffect, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useStore } from "zustand"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/alwith-ui/select"
import { type Theme, useTheme } from "@/components/theme-provider"
import { Slider } from "@base-ui/react/slider"

import {
  NAVIGATION_INSTRUMENT_GROUPS,
  NAVIGATION_SOUND_MODES,
  type NavigationInstrument,
  navigationInstrumentLabel
} from "@/features/chat/codex/navigation-instruments"
import {
  navigationSoundStore,
  setNavigationInstrument,
  setNavigationSoundMode
} from "@/features/chat/codex/navigation-sound-store"
import {
  type LayoutShare,
  saveLayoutShare,
  saveWorkspaceLayout,
  sharePercents,
  workspaceLayoutDefaults
} from "@/features/workspace/layout-preferences"
import { useWorkspaceLayout } from "@/features/workspace/use-workspace-layout"
import { useFourColumnsDefault } from "@/features/workspace/four-columns-preference"
import { useTreeVisiblePreference } from "@/features/workspace/tree-visible-preference"
import { usePreviewVisiblePreference } from "@/features/workspace/preview-visible-preference"
import { chatLayoutDefaults, saveChatLayout, useChatLayout } from "@/features/workspace/chat-layout"
import {
  getConversationDetail,
  getQueueSendMode,
  setConversationDetail,
  setQueueSendMode,
  subscribeChatDisplayPreferences
} from "@/lib/chat-display-preferences"
import { cn } from "@/lib/utils"
import { setZoomLevel, ZOOM_LEVELS, zoomStore } from "@/lib/zoom"

import { ACCENT_PRESETS, useAccentStore } from "../accent-store"
import { SettingRow, SettingsCard } from "./shared"
import { FourColumnsRow } from "./four-columns-row"
import { TreeVisibleRow } from "./tree-visible-row"
import { PreviewVisibleRow } from "./preview-visible-row"
import { SidebarAutoCollapseRow } from "./sidebar-auto-collapse-row"

/**
 * One row of the layout share table: column name on the left, its width share on the right.
 * Shares are whole percentages of the window; editing one redistributes the rest so the four
 * always total 100 (same store the divider drags write).
 */
function LayoutShareRow({
  name,
  desc,
  value,
  onCommit
}: {
  name: string
  /** Optional one-line hint; the table stays one line per row when omitted. */
  desc?: string
  value: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const read = (next: number | readonly number[]): number =>
    Array.isArray(next) ? Number(next[0] ?? value) : Number(next)
  return (
    <div className="flex items-center gap-3 border-b border-border/60 px-4 py-2 last:border-b-0">
      <div className="w-16 shrink-0">
        <p className="text-[13px] leading-5">{name}</p>
        {desc !== undefined && desc !== "" && (
          <p className="truncate text-[11px] text-muted-foreground">{desc}</p>
        )}
      </div>
      <Slider.Root
        value={[draft]}
        min={0}
        max={100}
        step={1}
        onValueChange={(next) => setDraft(Math.round(read(next)))}
        onValueCommitted={(next) => onCommit(Math.min(100, Math.max(0, Math.round(read(next)))))}
        className="flex-1"
      >
        <Slider.Control className="relative flex h-5 w-full items-center">
          <Slider.Track className="relative h-1 w-full rounded-full bg-muted">
            <Slider.Indicator className="absolute h-full rounded-full" style={{ background: "var(--settings-accent)" }} />
          </Slider.Track>
          <Slider.Thumb
            aria-label={name}
            className="size-3.5 rounded-full border border-border bg-background shadow-sm outline-none transition-shadow hover:shadow focus-visible:ring-2 focus-visible:ring-ring"
          />
        </Slider.Control>
      </Slider.Root>
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{draft}%</span>
    </div>
  )
}

function ThemeSegmented({
  value,
  options,
  onChange
}: {
  value: Theme
  options: Array<[Theme, string, typeof SunIcon]>
  onChange: (theme: Theme) => void
}) {
  return (
    <div
      role="group"
      aria-label="主题"
      className="grid w-[300px] grid-cols-3 gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5"
    >
      {options.map(([theme, label, Icon]) => (
        <button
          key={theme}
          type="button"
          aria-pressed={value === theme}
          onClick={() => onChange(theme)}
          className={cn(
            "flex h-7 items-center justify-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors",
            value === theme
              ? "border-border bg-background text-foreground shadow-sm"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  )
}

/** One coloured band of the layout-share bar. Colour comes from the --layout-seg-* tokens
 *  (defined per light/dark in index.css), so the bar and its legend always agree and dark
 *  mode keeps a fixed lightness ladder that stays clear of the muted track. */
function LayoutSegment({
  pct,
  seg
}: {
  pct: number
  seg: "navigation" | "chat" | "preview" | "tree"
}) {
  return <span style={{ width: `${pct}%`, background: `var(--layout-seg-${seg})` }} />
}

function LayoutLegend({
  seg,
  label
}: {
  seg: "navigation" | "chat" | "preview" | "tree"
  label: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5 justify-self-start whitespace-nowrap pe-2 text-[11px] leading-4 text-muted-foreground">
      <span className="size-2.5 rounded-[3px]" style={{ background: `var(--layout-seg-${seg})` }} />
      {label}
    </span>
  )
}

export function AppearanceSection() {
  const { t } = useTranslation()
  const layout = useWorkspaceLayout()
  // Whole percentages that always add up to 100, so the four rows read as one budget.
  const percents = sharePercents(layout)
  // Master "four columns" switch. On = every column is shown and the per-column visibility
  // toggles below are locked; off = the user picks which columns appear.
  const fourColumns = useFourColumnsDefault()
  const [treeVisible] = useTreeVisiblePreference()
  const [previewVisible] = usePreviewVisiblePreference()
  // A column is on when four columns forces it, or its own visibility preference is on.
  const previewShown = fourColumns || previewVisible
  const treeShown = fourColumns || treeVisible
  // The preview diagram only draws the columns that are actually on, and rescales them so the
  // visible set still fills the bar — turning a column off visibly shrinks the preview.
  const columnDefs: Array<{ key: LayoutShare; label: string; shown: boolean }> = [
    { key: "navigation", label: t("settings.layoutNavigation"), shown: true },
    { key: "chat", label: t("settings.layoutChat"), shown: true },
    { key: "preview", label: t("settings.layoutPreview"), shown: previewShown },
    { key: "tree", label: t("settings.layoutTree"), shown: treeShown }
  ]
  const shownColumns = columnDefs.filter((column) => column.shown)
  const shownTotal = shownColumns.reduce((sum, column) => sum + percents[column.key], 0) || 1
  const visibleSegments = shownColumns.map((column) => ({
    key: column.key,
    label: column.label,
    pct: Math.round((percents[column.key] / shownTotal) * 100)
  }))
  const chatLayout = useChatLayout()
  const chatPercents = {
    navigation: Math.round(chatLayout.navigationRatio * 100),
    chat: Math.round(chatLayout.chatRatio * 100)
  }
  const queueMode = useSyncExternalStore(subscribeChatDisplayPreferences, getQueueSendMode, getQueueSendMode)
  const detail = useSyncExternalStore(subscribeChatDisplayPreferences, getConversationDetail, getConversationDetail)
  const { theme, setTheme } = useTheme()
  const zoom = useStore(zoomStore, (state) => state.level)
  const accent = useAccentStore((state) => state.accent)
  const setAccent = useAccentStore((state) => state.setAccent)
  const navigationInstrument = useStore(navigationSoundStore, (state) => state.instrument)
  const navigationSoundMode = useStore(navigationSoundStore, (state) => state.soundMode)
  const navigationInstrumentGroup = NAVIGATION_INSTRUMENT_GROUPS.find((group) =>
    (group.instruments as readonly NavigationInstrument[]).includes(navigationInstrument)
  ) as (typeof NAVIGATION_INSTRUMENT_GROUPS)[number]
  const themeOptions: Array<[Theme, string, typeof SunIcon]> = [
    ["light", t("settings.themeLight"), SunIcon],
    ["system", t("settings.themeSystem"), MonitorIcon],
    ["dark", t("settings.themeDark"), MoonIcon]
  ]
  return (
    <>
      {/* 外观：把「主题色」与「主题与显示」合并为一个模块（用户要求），红框提示 accentHint 已删除。 */}
      <SettingsCard title={t("settings.appearance")}>
        <div className="px-4 pb-3">
          <div className="grid grid-cols-4 gap-1 sm:grid-cols-7 sm:gap-2">
            {ACCENT_PRESETS.map((preset) => {
              const active = accent === preset.id
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={active}
                  aria-label={t(preset.labelKey)}
                  onClick={() => setAccent(preset.id)}
                  className={cn(
                    "group flex flex-col items-center gap-2 rounded-2xl p-2 transition",
                    active ? "bg-card shadow-sm ring-1 ring-border" : "hover:bg-muted/50"
                  )}
                >
                  <span
                    className="grid size-9 place-items-center rounded-full transition-transform"
                    style={{
                      background: preset.swatch,
                      boxShadow: active
                        ? "0 0 0 2px var(--card), 0 0 0 4px var(--settings-accent-ink), inset 0 1px 2px rgba(255,255,255,.45)"
                        : "inset 0 1px 2px rgba(255,255,255,.4), 0 1px 2px rgba(0,0,0,.10)"
                    }}
                  >
                  {active && (
                    <CheckIcon
                      className="size-5"
                      style={{ color: "#fff", filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,.55))" }}
                      aria-hidden="true"
                    />
                  )}
                  </span>
                  <span
                    className={cn(
                      "text-[11px] leading-4",
                      active ? "font-semibold text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {t(preset.labelKey)}
                  </span>
                </button>
              )
            })}
          </div>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">{t("settings.accentDesc")}</p>
        </div>
        <SettingRow compact title={t("settings.theme")} desc={t("settings.themeDesc")}>
          <ThemeSegmented value={theme} options={themeOptions} onChange={setTheme} />
        </SettingRow>
        <SettingRow compact title={t("zoom.label")} desc={t("settings.zoomDesc")}>
          <Select
            value={String(zoom)}
            onValueChange={(value) => {
              if (value === null) throw new Error("Zoom level cannot be empty")
              void setZoomLevel(Number(value)).catch((error: unknown) =>
                toast.error(error instanceof Error ? error.message : String(error))
              )
            }}
          >
            <SelectTrigger className="w-[170px]" aria-label={t("zoom.label")}>
              <SelectValue>{Math.round(zoom * 100)}%</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {ZOOM_LEVELS.map((level) => (
                  <SelectItem key={level} value={String(level)}>
                    {Math.round(level * 100)}%
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsCard>

      <SettingsCard
        title={t("settings.layoutSection")}
        desc={t("settings.layoutSectionDesc")}
        action={
          <button
            type="button"
            className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => saveWorkspaceLayout(workspaceLayoutDefaults)}
          >
            {t("settings.resetLayout")}
          </button>
        }
      >
        {/* Master switch first: it decides whether the per-column toggles below are live. */}
        <div className="border-b border-border/60">
          <FourColumnsRow compact />
        </div>

        <div className="px-4 py-2">
          <p className="text-[11.5px] leading-[18px] text-muted-foreground">
            {fourColumns ? t("settings.layoutTogglesLockedHint") : t("settings.layoutCustomHint")}
          </p>
        </div>

        {/* Per-column visibility — only editable once four columns is off. */}
        <div className="border-t border-border/60">
          <SidebarAutoCollapseRow compact disabled={fourColumns} />
        </div>
        <div className="border-t border-border/60">
          <PreviewVisibleRow compact disabled={fourColumns} />
        </div>
        <div className="border-t border-border/60">
          <TreeVisibleRow compact disabled={fourColumns} />
        </div>
        <div className="border-t border-border/60">
          {/* The chat column can never be closed, so it is a locked row rather than a switch. */}
          <SettingRow compact title={t("settings.chatColumnLocked")} desc={t("settings.chatColumnLockedDesc")}>
            <span className="text-xs text-muted-foreground">{t("settings.alwaysOn")}</span>
          </SettingRow>
        </div>

        {/* Live preview of the resulting layout — only the on columns are drawn, rescaled to fill. */}
        <div className="px-4 pb-2 pt-3">
          <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            {visibleSegments.map((segment) => (
              <LayoutSegment key={segment.key} pct={segment.pct} seg={segment.key} />
            ))}
          </div>
          <div
            className="mt-2 grid"
            style={{ gridTemplateColumns: visibleSegments.map((segment) => `${segment.pct}fr`).join(" ") }}
          >
            {visibleSegments.map((segment) => (
              <LayoutLegend key={segment.key} seg={segment.key} label={segment.label} />
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
            {t("settings.layoutShareCaption")}
          </p>
        </div>

        {/* Width sliders for the columns that are actually on. */}
        <div className="border-t border-border/60">
          <LayoutShareRow
            name={t("settings.layoutNavigation")}
            value={percents.navigation}
            onCommit={(value) => saveLayoutShare("navigation", value)}
          />
          <LayoutShareRow
            name={t("settings.layoutChat")}
            value={percents.chat}
            onCommit={(value) => saveLayoutShare("chat", value)}
          />
          {previewShown && (
            <LayoutShareRow
              name={t("settings.layoutPreview")}
              value={percents.preview}
              onCommit={(value) => saveLayoutShare("preview", value)}
            />
          )}
          {/* 文件栏放最后（用户要求），与预览栏相邻便于对照。 */}
          {treeShown && (
            <LayoutShareRow
              name={t("settings.layoutTree")}
              value={percents.tree}
              onCommit={(value) => saveLayoutShare("tree", value)}
            />
          )}
        </div>
        <p className="px-4 pt-1 pb-2 text-[11.5px] leading-[18px] text-muted-foreground">
          {t("settings.layoutShareNote")}
        </p>
      </SettingsCard>

      <SettingsCard
        title={t("settings.chatLayoutSection")}
        desc={t("settings.chatLayoutSectionDesc")}
        action={
          <button
            type="button"
            className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => saveChatLayout(chatLayoutDefaults)}
          >
            {t("settings.resetLayout")}
          </button>
        }
      >
        <div className="px-4 pb-2">
          <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <LayoutSegment pct={chatPercents.navigation} seg="navigation" />
            <LayoutSegment pct={chatPercents.chat} seg="chat" />
          </div>
          <div
            className="mt-2 grid"
            style={{ gridTemplateColumns: `${chatPercents.navigation}fr ${chatPercents.chat}fr` }}
          >
            <LayoutLegend seg="navigation" label={t("settings.layoutNavigation")} />
            <LayoutLegend seg="chat" label={t("settings.layoutChat")} />
          </div>
        </div>
        <div className="border-t border-border/60">
          <LayoutShareRow
            name={t("settings.layoutNavigation")}
            value={chatPercents.navigation}
            onCommit={(value) => saveChatLayout({ navigationRatio: value / 100 })}
          />
          <LayoutShareRow
            name={t("settings.layoutChat")}
            value={chatPercents.chat}
            onCommit={(value) => saveChatLayout({ chatRatio: value / 100 })}
          />
        </div>
        <p className="px-4 pt-1 pb-2 text-[11.5px] leading-[18px] text-muted-foreground">
          {t("settings.chatLayoutShareNote")}
        </p>
      </SettingsCard>

      <SettingsCard title={t("settings.soundSection")}>
        <SettingRow compact title={t("settings.navigationSoundMode")} desc={t("settings.soundModeDesc")}>
          <Select
            value={navigationSoundMode}
            onValueChange={(value) => {
              if (value === null) throw new Error("导航旋律不能为空")
              void setNavigationSoundMode(value)
            }}
          >
            <SelectTrigger className="w-[170px]" aria-label={t("settings.navigationSoundMode")}>
              <SelectValue>{t(`settings.navigationSoundModes.${navigationSoundMode}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {NAVIGATION_SOUND_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`settings.navigationSoundModes.${mode}`)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow compact title={t("settings.navigationInstrument")} desc={t("settings.instrumentDesc")}>
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] leading-4 text-muted-foreground">{t("settings.instrumentGroup")}</span>
              <Select
                value={navigationInstrumentGroup.id}
                onValueChange={(value) => {
                  if (value === null) throw new Error("音色类别不能为空")
                  const group = NAVIGATION_INSTRUMENT_GROUPS.find(
                    (candidate) => candidate.id === value
                  ) as (typeof NAVIGATION_INSTRUMENT_GROUPS)[number]
                  void setNavigationInstrument(group.instruments[0])
                }}
              >
                <SelectTrigger
                  className="w-[168px]"
                  aria-label={t(`settings.navigationInstrumentGroups.${navigationInstrumentGroup.id}`)}
                >
                  <SelectValue>{t(`settings.navigationInstrumentGroups.${navigationInstrumentGroup.id}`)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {NAVIGATION_INSTRUMENT_GROUPS.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {t(`settings.navigationInstrumentGroups.${group.id}`)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] leading-4 text-muted-foreground">{t("settings.instrumentVoice")}</span>
              <Select
                value={navigationInstrument}
                onValueChange={(value) => {
                  if (value === null) throw new Error("导航音色不能为空")
                  void setNavigationInstrument(value)
                }}
              >
                <SelectTrigger className="w-[168px]" aria-label={t("settings.navigationInstrument")}>
                  <SelectValue>{navigationInstrumentLabel(navigationInstrument)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {navigationInstrumentGroup.instruments.map((instrument) => (
                      <SelectItem key={instrument} value={instrument}>
                        {navigationInstrumentLabel(instrument)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </label>
          </div>
        </SettingRow>
      </SettingsCard>

      <SettingsCard title={t("settings.chatDisplaySection")} desc={t("settings.chatDisplayDesc")}>
        <SettingRow compact title={t("settings.queueSendMode")} desc={t("settings.queueSendModeDesc")}>
          <Select
            value={queueMode}
            onValueChange={(value) => {
              if (value === "queued" || value === "immediate") setQueueSendMode(value)
            }}
            items={[
              { label: t("settings.queueSendQueued"), value: "queued" },
              { label: t("settings.queueSendImmediate"), value: "immediate" }
            ]}
          >
            <SelectTrigger className="w-[170px]" aria-label={t("settings.queueSendMode")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="queued">{t("settings.queueSendQueued")}</SelectItem>
                <SelectItem value="immediate">{t("settings.queueSendImmediate")}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow compact title={t("settings.conversationDetail")} desc={t("settings.conversationDetailDesc")}>
          <Select
            value={detail}
            onValueChange={(value) => {
              if (value === "compact" || value === "full") setConversationDetail(value)
            }}
            items={[
              { label: t("settings.conversationDetailCompact"), value: "compact" },
              { label: t("settings.conversationDetailFull"), value: "full" }
            ]}
          >
            <SelectTrigger className="w-[170px]" aria-label={t("settings.conversationDetail")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="compact">{t("settings.conversationDetailCompact")}</SelectItem>
                <SelectItem value="full">{t("settings.conversationDetailFull")}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsCard>
    </>
  )
}
