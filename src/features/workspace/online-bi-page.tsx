import { LinkIcon, PencilIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { commands } from "@/bindings"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { OnlineBiGlyph } from "@/features/layout/components/feature-glyphs"
import { cn } from "@/lib/utils"

import { OnlineBiNativeView, type OnlineBiPageState } from "./online-bi-embed"
import {
  getOnlineBiEmbedSrcFor,
  normalizeOnlineBiReportUrl,
  onlineBiEmbedUrl,
  saveOnlineBiPath
} from "./online-bi"
import {
  createOnlineBiTab,
  loadOnlineBiTabs,
  type OnlineBiTab,
  type OnlineBiTabsState,
  saveOnlineBiTabs
} from "./online-bi-tabs"

type TabEditor = {
  mode: "add" | "edit"
  id: string | null
  label: string
  url: string
}

function reportTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const tab = parsed.searchParams.get("tab")?.trim()
    if (tab !== undefined && tab !== "") return tab.replace(/^\d+\s*/, "").slice(0, 40)
    const segment = parsed.pathname.split("/").filter(Boolean).at(-1)
    return segment === undefined ? parsed.hostname : decodeURIComponent(segment)
  } catch {
    return url
  }
}

function OnlineBiLoadingSkeleton({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col gap-3 bg-background p-4" role="status" aria-label={label}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="size-3 animate-spin rounded-full border-2 border-current border-r-transparent" />
        {label}
      </div>
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="hidden w-40 shrink-0 flex-col gap-2 rounded-lg border border-border/50 bg-muted/20 p-3 sm:flex">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="h-2.5 animate-pulse rounded bg-muted" />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 rounded-lg border border-border/50 bg-muted/10 p-4">
          <div className="h-3 w-24 animate-pulse rounded bg-muted" />
          <div className="h-3 w-48 max-w-full animate-pulse rounded bg-muted" />
          <div className="min-h-24 flex-1 animate-pulse rounded-lg bg-muted/70" />
        </div>
      </div>
    </div>
  )
}

/** Full-page 在线 BI surface on the workbench screen, with persistent report tabs. */
export function OnlineBiPage() {
  const { t } = useTranslation()
  const { resolvedTheme } = useTheme()
  const [tabsState, setTabsState] = useState<OnlineBiTabsState>(() =>
    loadOnlineBiTabs(t("onlineBi.defaultTab"))
  )
  const activeTab = tabsState.tabs.find((tab) => tab.id === tabsState.activeId)
  const initialUrl = activeTab?.url ?? tabsState.tabs[0]?.url ?? onlineBiEmbedUrl("")
  const [currentUrl, setCurrentUrl] = useState(initialUrl)
  const [draft, setDraft] = useState(initialUrl)
  const [src, setSrc] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [editor, setEditor] = useState<TabEditor | null>(null)
  const [pageReady, setPageReady] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const navigation = useRef(0)
  const loading = src === null || !pageReady
  const signedOut = !loading && !signedIn

  useEffect(() => {
    saveOnlineBiTabs(tabsState)
  }, [tabsState])

  const navigate = useCallback(
    async (reportUrl: string): Promise<void> => {
      const normalized = normalizeOnlineBiReportUrl(reportUrl)
      if (normalized === null) {
        toast.error(t("onlineBi.invalidAddress"))
        return
      }
      const request = ++navigation.current
      setPageReady(false)
      setCurrentUrl(normalized)
      setDraft(normalized)
      try {
        saveOnlineBiPath(new URL(normalized).pathname)
      } catch {
        // The address is still valid locally even if the legacy single-path cache rejects it.
      }
      const embedded = await getOnlineBiEmbedSrcFor(normalized).catch(() => onlineBiEmbedUrl(normalized))
      if (request !== navigation.current) return
      setSrc(embedded)
      setReload((value) => value + 1)
    },
    [t]
  )

  useEffect(() => {
    void navigate(initialUrl)
    // Initial tab only; later navigation is user-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handlePageState = useCallback((state: OnlineBiPageState): void => {
    setPageReady(state.ready)
    setSignedIn(state.signedIn)
  }, [])

  useEffect(() => {
    // The BI login form can finish without a full document load. Poll the native cookie jar only
    // while the signed-out page is visible, so the host status flips to 已登录 as soon as the
    // password/OAuth flow completes. Stop immediately once signed in.
    if (loading || signedIn) return
    const timer = window.setInterval(() => {
      void commands
        .onlineBiEmbedPageState()
        .then((state) => {
          if (state.signedIn) setSignedIn(true)
        })
        .catch(() => {})
    }, 2_500)
    return () => window.clearInterval(timer)
  }, [loading, signedIn])

  const collapseBiSidebar = (): void => {
    void commands
      .onlineBiEmbedCollapseSidebar()
      .catch((error: unknown) => console.error("[online-bi] collapse sidebar", error))
  }

  const openTab = (tab: OnlineBiTab): void => {
    setTabsState((state) => ({ ...state, activeId: tab.id }))
    void navigate(tab.url)
    collapseBiSidebar()
  }

  const openAddTab = (): void => {
    setEditor({ mode: "add", id: null, label: reportTitleFromUrl(currentUrl), url: currentUrl })
  }

  const openEditTab = (tab: OnlineBiTab): void => {
    setEditor({ mode: "edit", id: tab.id, label: tab.label, url: tab.url })
  }

  const captureCurrentAddress = async (): Promise<void> => {
    try {
      const raw = await commands.onlineBiEmbedCurrentUrl()
      const normalized = raw === null ? null : normalizeOnlineBiReportUrl(raw)
      if (normalized === null) {
        toast.error(t("onlineBi.captureFailed"))
        return
      }
      setEditor((current) =>
        current === null
          ? current
          : {
              ...current,
              url: normalized,
              label:
                current.mode === "add" &&
                (current.label.trim() === "" || current.label === reportTitleFromUrl(current.url))
                  ? reportTitleFromUrl(normalized)
                  : current.label
            }
      )
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  const saveEditor = (event: FormEvent): void => {
    event.preventDefault()
    if (editor === null) return
    const normalized = normalizeOnlineBiReportUrl(editor.url)
    const label = editor.label.trim()
    if (normalized === null) {
      toast.error(t("onlineBi.invalidAddress"))
      return
    }
    if (label === "") return
    if (editor.mode === "add") {
      const tab = createOnlineBiTab(label, normalized)
      if (tab === null) return
      setTabsState((state) => ({ tabs: [...state.tabs, tab], activeId: tab.id }))
      setEditor(null)
      void navigate(tab.url)
      collapseBiSidebar()
      return
    }
    const id = editor.id
    if (id === null) return
    const wasActive = tabsState.activeId === id
    setTabsState((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, label: label.slice(0, 40), url: normalized } : tab)),
      activeId: wasActive ? id : state.activeId
    }))
    setEditor(null)
    if (wasActive) {
      void navigate(normalized)
      collapseBiSidebar()
    }
  }

  const removeEditedTab = (): void => {
    const id = editor?.id
    if (id === null || id === undefined) return
    const wasActive = tabsState.activeId === id
    const remaining = tabsState.tabs.filter((tab) => tab.id !== id)
    const fallback = remaining.length > 0
      ? remaining
      : [createOnlineBiTab(t("onlineBi.defaultTab"), onlineBiEmbedUrl(""))].filter((tab): tab is OnlineBiTab => tab !== null)
    const next = fallback[0]
    if (next === undefined) return
    setTabsState({
      tabs: fallback,
      activeId: wasActive ? next.id : tabsState.activeId
    })
    setEditor(null)
    if (wasActive) void navigate(next.url)
  }

  return (
    <div data-online-bi-page="" className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background">
      <header className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <span className="grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground">
            <OnlineBiGlyph className="size-[18px]" />
          </span>
          <span className="text-sm font-semibold text-foreground">{t("workbench.onlineBi")}</span>
        </div>
        <form
          className="flex min-w-[14rem] flex-[1_1_26rem] items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            void navigate(draft)
          }}
        >
          <Input
            aria-label={t("onlineBi.address")}
            title={draft}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            placeholder={t("onlineBi.addressPlaceholder")}
            spellCheck={false}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
          />
          <Button type="submit" size="sm" className="h-8 shrink-0">
            {t("onlineBi.open")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="size-8 shrink-0"
            disabled={src === null}
            aria-label={t("onlineBi.refresh")}
            title={t("onlineBi.refresh")}
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCwIcon />
          </Button>
        </form>
      </header>

      <div className="flex min-w-0 shrink-0 items-center border-b border-border/60 bg-muted/15 px-2 py-1.5">
        <div
          role="tablist"
          aria-label={t("onlineBi.pinnedTabs")}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {tabsState.tabs.map((tab) => {
            const active = tab.id === tabsState.activeId && tab.url === currentUrl
            return (
              <div
                key={tab.id}
                className={cn(
                  "group/tab flex h-8 min-w-0 max-w-56 shrink-0 items-center rounded-md border text-xs transition-colors",
                  active
                    ? "border-border bg-background text-foreground shadow-xs"
                    : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-background/55 hover:text-foreground"
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title={tab.url}
                  className="min-w-0 flex-1 truncate px-2.5 text-start"
                  onClick={() => openTab(tab)}
                >
                  {tab.label}
                </button>
                {active && (
                  <button
                    type="button"
                    aria-label={t("onlineBi.editTab", { name: tab.label })}
                    title={t("onlineBi.editTab", { name: tab.label })}
                    className="me-1 grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
                    onClick={() => openEditTab(tab)}
                  >
                    <PencilIcon className="size-3" />
                  </button>
                )}
              </div>
            )
          })}
        </div>
        <span
          className={cn(
            "me-1 inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[10px]",
            loading
              ? "border-amber-500/25 bg-amber-500/8 text-amber-600"
              : signedOut
                ? "border-amber-500/25 bg-amber-500/8 text-amber-600"
                : "border-emerald-500/25 bg-emerald-500/8 text-emerald-600"
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              loading ? "animate-pulse bg-amber-500" : signedOut ? "bg-amber-500" : "bg-emerald-500"
            )}
          />
          {t(
            loading
              ? "onlineBi.statusLoading"
              : signedOut
                ? "onlineBi.statusSignedOut"
                : "onlineBi.statusSignedIn"
          )}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ms-1 size-7 shrink-0"
          aria-label={t("onlineBi.pinCurrent")}
          title={t("onlineBi.pinCurrent")}
          onClick={openAddTab}
        >
          <PlusIcon />
        </Button>
      </div>

      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {loading && <OnlineBiLoadingSkeleton label={t("settings.onlineBiLoading")} />}
        {src !== null && (
          <OnlineBiNativeView
            src={src}
            reload={reload}
            hidden={editor !== null}
            theme={resolvedTheme}
            onPageState={handlePageState}
          />
        )}
      </div>

      <Dialog open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogContent className="sm:max-w-[32rem]">
          <form className="grid min-w-0 gap-4" onSubmit={saveEditor}>
            <DialogHeader>
              <DialogTitle>{editor?.mode === "edit" ? t("onlineBi.editTitle") : t("onlineBi.addTitle")}</DialogTitle>
              <DialogDescription>{t("onlineBi.dialogDescription")}</DialogDescription>
            </DialogHeader>
            <label className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground/80">
              {t("onlineBi.label")}
              <Input
                value={editor?.label ?? ""}
                onChange={(event) => setEditor((current) => (current === null ? current : { ...current, label: event.target.value }))}
                maxLength={40}
                placeholder={t("onlineBi.labelPlaceholder")}
              />
            </label>
            <label className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground/80">
              {t("onlineBi.reportAddress")}
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                <Input
                  aria-label={t("onlineBi.reportAddress")}
                  value={editor?.url ?? ""}
                  onChange={(event) => setEditor((current) => (current === null ? current : { ...current, url: event.target.value }))}
                  spellCheck={false}
                  className="min-w-0 flex-1 font-mono text-xs"
                />
                <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => void captureCurrentAddress()}>
                  <LinkIcon />
                  {t("onlineBi.captureCurrent")}
                </Button>
              </div>
            </label>
            <p className="text-[11px] leading-4 text-muted-foreground">{t("onlineBi.addressHint")}</p>
            <DialogFooter className="gap-2 sm:justify-between">
              {editor?.mode === "edit" ? (
                <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={removeEditedTab}>
                  <Trash2Icon />
                  {t("onlineBi.removeTab")}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setEditor(null)}>
                  {t("actions.cancel")}
                </Button>
                <Button type="submit" disabled={(editor?.label.trim() ?? "") === ""}>
                  {t("actions.confirm")}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
