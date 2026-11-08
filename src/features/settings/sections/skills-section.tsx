// Codex skills (~/.codex/skills): a compact one-line-per-skill list.
//
// The engine discovers skills by scanning that directory at startup, so a disabled skill is
// moved into ~/.codex/skills-disabled/ (the backend does the move). `.system/` skills are the
// engine's own and are read-only here.
import { invoke } from "@tauri-apps/api/core"
import {
  FolderOpenIcon,
  MoreHorizontalIcon,
  PlusIcon,
  PuzzleIcon,
  SearchIcon,
  Trash2Icon
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"

import { SettingsCard } from "./shared"

interface SkillEntry {
  id: string
  name: string
  description: string
  system: boolean
  enabled: boolean
  path: string
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Strips the markdown decoration skill descriptions carry (`**MUST**`, backticks, headings). */
export function cleanDescription(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function SkillsSection() {
  const { t } = useTranslation()
  const [skills, setSkills] = useState<SkillEntry[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // Two-step confirm: the first click arms the row, the second deletes.
  const [confirming, setConfirming] = useState<string | null>(null)
  const [query, setQuery] = useState("")

  const load = useCallback(async (): Promise<void> => {
    try {
      setSkills(await invoke<SkillEntry[]>("skills_list"))
    } catch (error) {
      toast.error(describe(error))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (skill: SkillEntry): Promise<void> => {
    setBusy(skill.id)
    try {
      await invoke("skills_set_enabled", { id: skill.id, enabled: !skill.enabled })
      await load()
    } catch (error) {
      toast.error(describe(error))
    } finally {
      setBusy(null)
    }
  }

  const install = async (): Promise<void> => {
    setBusy("install")
    try {
      const directory = await invoke<string | null>("skills_pick_directory")
      if (directory === null) return
      const entry = await invoke<SkillEntry>("skills_install", { source: directory })
      toast.success(t("skills.installed", { name: entry.name }))
      await load()
    } catch (error) {
      toast.error(describe(error))
    } finally {
      setBusy(null)
    }
  }

  const openFolder = async (): Promise<void> => {
    try {
      await invoke<string>("skills_open_folder")
    } catch (error) {
      toast.error(describe(error))
    }
  }

  const uninstall = async (skill: SkillEntry): Promise<void> => {
    setConfirming(null)
    setBusy(skill.id)
    try {
      await invoke("skills_uninstall", { id: skill.id })
      toast.success(t("skills.uninstalled", { name: skill.name }))
      await load()
    } catch (error) {
      toast.error(describe(error))
    } finally {
      setBusy(null)
    }
  }

  const copyPath = async (skill: SkillEntry): Promise<void> => {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager")
      await writeText(skill.path)
      toast.success(t("skills.pathCopied"))
    } catch (error) {
      toast.error(describe(error))
    }
  }

  const filtered = useMemo(() => {
    const all = skills ?? []
    const needle = query.trim().toLowerCase()
    if (needle === "") return all
    return all.filter(
      (skill) =>
        skill.name.toLowerCase().includes(needle) ||
        cleanDescription(skill.description).toLowerCase().includes(needle)
    )
  }, [skills, query])
  const userSkills = filtered.filter((skill) => !skill.system)
  const systemSkills = filtered.filter((skill) => skill.system)

  return (
    <>
      <SettingsCard
        title={t("settings.cardSkillsMine")}
        desc={t("skills.description")}
        action={
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => void openFolder()}>
              <FolderOpenIcon className="size-3.5" />
              {t("skills.openFolder")}
            </Button>
            <Button size="sm" className="h-7 px-2 text-xs" disabled={busy !== null} onClick={() => void install()}>
              {busy === "install" ? <Spinner data-icon="inline-start" /> : <PlusIcon className="size-3.5" />}
              {t("skills.install")}
            </Button>
          </div>
        }
      >
        <div className="relative py-2.5">
          <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("skills.search")}
            aria-label={t("skills.search")}
            className="h-8 ps-8 text-xs"
          />
        </div>

        {skills === null && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            <Spinner />
          </p>
        )}
        {skills !== null && userSkills.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {query.trim() === "" ? t("skills.empty") : t("skills.noResults")}
          </p>
        )}

        {userSkills.length > 0 && (
          <div className="divide-border mb-1 divide-y">
            {userSkills.map((skill) => (
              <div
                key={skill.id}
                className="group flex items-center gap-3 py-2.5 transition-colors"
              >
                <PuzzleIcon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{skill.name}</p>
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={cleanDescription(skill.description) || skill.path}
                  >
                    {cleanDescription(skill.description) || skill.path}
                  </p>
                </div>
                {confirming === skill.id ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => void uninstall(skill)}
                    >
                      {t("skills.confirmUninstall")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setConfirming(null)}
                    >
                      {t("skills.cancel")}
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex shrink-0 items-center gap-2">
                      {busy === skill.id && <Spinner />}
                      <Switch
                        aria-label={t("skills.enabled")}
                        title={t("skills.enabled")}
                        checked={skill.enabled}
                        disabled={busy !== null}
                        onCheckedChange={() => void toggle(skill)}
                      />
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("skills.actions")}
                            className="shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100"
                          >
                            <MoreHorizontalIcon className="size-4" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end" className="min-w-44">
                        <DropdownMenuItem onClick={() => void copyPath(skill)}>
                          {t("skills.copyPath")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void openFolder()}>
                          {t("skills.openFolder")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => setConfirming(skill.id)}>
                          <Trash2Icon className="size-3.5" />
                          {t("skills.uninstall")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </SettingsCard>

      {systemSkills.length > 0 && (
        <SettingsCard
          title={t("skills.systemGroup")}
          desc={t("settings.cardSkillsSystemDesc", { count: systemSkills.length })}
        >
          <div className="divide-border divide-y">
            {systemSkills.map((skill) => (
              <div key={skill.id} className="flex items-center gap-3 py-2.5">
                <PuzzleIcon className="size-4 shrink-0 text-muted-foreground/60" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-muted-foreground">{skill.name.replace(/^"|"$/g, "")}</p>
                  <p className="truncate text-xs text-muted-foreground/70" title={cleanDescription(skill.description)}>
                    {cleanDescription(skill.description)}
                  </p>
                </div>
                <Badge variant="secondary" className="shrink-0">
                  {t("skills.builtIn")}
                </Badge>
              </div>
            ))}
          </div>
        </SettingsCard>
      )}
    </>
  )
}
