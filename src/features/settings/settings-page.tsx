// The settings window (ALwith Desktop's SettingsPage): section list in the sidebar, one
// section on the right. The initial section comes from `?tab=`, later switches from the
// `settings-change-tab` event; closing the window hides it so reopening is instant.

import { MENU_HIGHLIGHT, NavigationItemButton, NavigationStack } from "@alwith/module-chat/session-list"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  BlocksIcon,
  CalendarClockIcon,
  ChartColumnIcon,
  CloudIcon,
  Code2Icon,
  ContrastIcon,
  CpuIcon,
  InfoIcon,
  MicIcon,
  MonitorIcon,
  PuzzleIcon,
  UsersIcon,
  SlidersHorizontalIcon,
  SmartphoneIcon,
  TouchpadIcon,
  UserIcon
} from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { AuxWindowShell } from "@/components/alwith-ui/aux-window-shell"
import { Pane } from "@/components/alwith-ui/pane"
import { AutomationSection } from "@/features/automation/automation-section"
import { DriveSettings } from "@/features/drive/drive"
import { useDriveVisible } from "@/features/drive/use-drive-visible"
import { ExtensionSettingsContent, ExtensionSettingsNavigation } from "@/features/extensions/extension-outlets"
import { ExtensionMount } from "@/features/extensions/extension-view"
import { ExtensionsSection } from "@/features/extensions/extensions-section"
import { useExtensions } from "@/features/extensions/use-extensions"
import { MobileSection } from "@/features/mobile/mobile-section"
import { EditorSettingsSection } from "@/features/workspace/editor-settings-dialog"
import { SETTINGS_CHANGE_TAB, SETTINGS_RESET_SCROLL, type SettingsNavigation, type SettingsSection } from "@/lib/window-manager"

import { AboutSection } from "./sections/about-section"
import { GroupSection } from "./sections/group-section"
import { SkillsSection } from "./sections/skills-section"
import { AccountSection } from "./sections/account-section"
import { AppearanceSection } from "./sections/appearance-section"
import { ComputerSection } from "./sections/computer-section"
import { GeneralSection } from "./sections/general-section"
import { ProviderSection } from "./sections/provider-section"
import { SettingsPageHeader } from "./sections/shared"
import { TrackpadRow } from "./sections/trackpad-row"
import { UsageSection } from "./sections/usage-section"
import { VoiceSection } from "./sections/voice-section"
import { useAccentDataAttribute } from "./accent-store"
import "./settings.css"

const ICONS: Record<SettingsSection, typeof InfoIcon> = {
  mobile: SmartphoneIcon,
  account: UserIcon,
  computer: MonitorIcon,
  drive: CloudIcon,
  general: SlidersHorizontalIcon,
  trackpad: TouchpadIcon,
  editor: Code2Icon,
  appearance: ContrastIcon,
  provider: CpuIcon,
  voice: MicIcon,
  extensions: BlocksIcon,
  skills: PuzzleIcon,
  groups: UsersIcon,
  usage: ChartColumnIcon,
  automation: CalendarClockIcon,
  about: InfoIcon
}

/** Sidebar order, grouped by the question each page answers: who am I, how do I work,
 *  what can ALWith do, and what am I running. */
const SECTION_GROUPS: Array<{ label: string; sections: SettingsSection[] }> = [
  { label: "settings.groupAccount", sections: ["account", "mobile"] },
  { label: "settings.groupPreferences", sections: ["general", "appearance", "editor", "voice", "trackpad", "computer"] },
  { label: "settings.groupCapabilities", sections: ["provider", "drive", "extensions", "skills", "automation", "groups"] },
  { label: "settings.groupSystem", sections: ["usage", "about"] }
]

const KNOWN_SECTIONS = SECTION_GROUPS.flatMap((group) => group.sections)

function isSection(value: string | null): value is SettingsSection {
  return value !== null && (KNOWN_SECTIONS as string[]).includes(value)
}

/** 旧「支持组件」页已并入应用扩展：老的 ?tab=support / 切页通知要落到新位置，
 *  否则 reopen 会掉回「通用」或渲染出空白页。 */
function normalizeSection(value: string | null): SettingsSection | null {
  if (value === "support") return "extensions"
  return isSection(value) ? value : null
}

export function SettingsPage() {
  const driveVisible = useDriveVisible()
  const { host, state } = useExtensions()
  const [extensionSection, setExtensionSection] = useState<string | null>(null)
  const { t } = useTranslation()
  useAccentDataAttribute()
  const [section, setSection] = useState<SettingsSection>(() => {
    const tab = new URLSearchParams(window.location.search).get("tab")
    return normalizeSection(tab) ?? "general"
  })

  const [providerTarget, setProviderTarget] = useState(() => ({
    id: new URLSearchParams(window.location.search).get("provider") ?? undefined,
    revision: 0
  }))

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const scrollToTop = useCallback(() => {
    viewportRef.current?.scrollTo({ top: 0 })
  }, [])

  // Switching sections must land on the page header, not on the previous page's scroll offset.
  useEffect(() => {
    scrollToTop()
  }, [section, extensionSection, scrollToTop])

  // Close hides this window instead of destroying it, so the DOM (and its scrollTop) survives.
  // Every reopen explicitly returns to the top so the first card — the usage overview — is whole.
  useEffect(() => {
    const stop = listen<null>(SETTINGS_RESET_SCROLL, scrollToTop)
    return () => void stop.then((fn) => fn())
  }, [scrollToTop])

  useEffect(() => {
    const stop = listen<string | SettingsNavigation>(SETTINGS_CHANGE_TAB, (event) => {
      const payload = event.payload
      const next = normalizeSection(typeof payload === "string" ? payload : payload.section)
      if (next !== null) {
        setSection(next)
        setExtensionSection(null)
        setProviderTarget((previous) => ({
          id: typeof payload === "string" ? undefined : payload.providerId,
          revision: previous.revision + 1
        }))
      }
    })
    return () => void stop.then((fn) => fn())
  }, [])

  // Close = hide: the window keeps its state and the next open is instant (VS Code and
  // Obsidian do the same).
  useEffect(() => {
    const win = getCurrentWindow()
    const stop = win.onCloseRequested((event) => {
      event.preventDefault()
      void win.hide().catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
    })
    return () =>
      void stop
        .then((fn) => fn())
        .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
  }, [])

  const content =
    extensionSection !== null ? (
      <ExtensionSettingsContent
        id={extensionSection}
        views={host.views}
        renderView={(view) => <ExtensionMount key={view.id} id={view.id} />}
      />
    ) : (
      (() => {
        switch (section) {
          case "drive":
            return driveVisible ? <DriveSettings /> : <AccountSection />
          case "account":
            return <AccountSection />
          case "editor":
            return <EditorSettingsSection />
          case "mobile":
            return <MobileSection />
          case "computer":
            return <ComputerSection />
          case "trackpad":
            return <TrackpadRow />
          case "general":
            return <GeneralSection />
          case "appearance":
            return <AppearanceSection />
          case "voice":
            return <VoiceSection />
          case "provider":
            return <ProviderSection key={providerTarget.revision} initialProviderId={providerTarget.id} />
          case "usage":
            return <UsageSection />
          case "about":
            return <AboutSection />
          case "extensions":
            return <ExtensionsSection />
          case "skills":
            return <SkillsSection />
          case "automation":
            return <AutomationSection />
          case "groups":
            return <GroupSection />
        }
      })()
    )

  const extensionView =
    extensionSection === null
      ? undefined
      : host.views.find((view) => view.id === extensionSection && view.kind === "settingsPages")
  const pageTitle = extensionSection === null ? t(`settings.${section}`) : (extensionView?.title ?? t("extensions.unavailable"))
  // Extension pages ship their own copy; only the built-in sections have a written purpose line.
  const pageDesc = extensionSection === null ? t(`settings.${section}Desc`) : undefined

  const sidebar = (
    <>
      <NavigationStack
        role="navigation"
        aria-label={t("settings.title")}
        className="min-h-0 overflow-y-auto px-3 pt-5 pb-4 [&>*]:shrink-0"
      >
        {SECTION_GROUPS.map((group) => {
          const sections = group.sections.filter((id) => id !== "drive" || driveVisible)
          if (sections.length === 0) return null
          return (
            <div key={group.label} className="settings-nav-group">
              <div className="settings-nav-label">{t(group.label)}</div>
              {sections.map((id) => {
                const Icon = ICONS[id]
                return (
                  <NavigationItemButton
                    key={id}
                    className={MENU_HIGHLIGHT}
                    active={extensionSection === null && id === section}
                    aria-current={extensionSection === null && id === section ? "page" : undefined}
                    onClick={() => {
                      setSection(id)
                      setExtensionSection(null)
                    }}
                  >
                    <Icon />
                    <span>{t(`settings.${id}`)}</span>
                  </NavigationItemButton>
                )
              })}
            </div>
          )
        })}
        <ExtensionSettingsNavigation
          views={host.views}
          manifests={state.native?.installations.map((item) => item.manifest) ?? []}
          activeId={extensionSection}
          onSelect={setExtensionSection}
        />
      </NavigationStack>
    </>
  )

  return (
    <AuxWindowShell
      sidebar={sidebar}
      sidebarClassName="settings-sidebar w-60 [--navigation-row-height:42px]"
      className="settings-window"
    >
      <Pane viewportRef={viewportRef} viewportClassName="px-6 pt-5 pb-10">
        <section
          className="settings-content mx-auto w-full max-w-4xl"
          aria-label={
            extensionSection === null
              ? t(`settings.${section}`)
              : (host.views.find((view) => view.id === extensionSection && view.kind === "settingsPages")?.title ??
                t("extensions.unavailable"))
          }
        >
          <SettingsPageHeader
            icon={(() => {
              const Icon = ICONS[section]
              return <Icon className="size-4" aria-hidden="true" />
            })()}
            title={pageTitle}
            desc={pageDesc}
          />
          <div className="settings-page-body">{content}</div>
        </section>
      </Pane>
    </AuxWindowShell>
  )
}
