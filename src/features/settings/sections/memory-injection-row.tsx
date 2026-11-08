import { useState, useSyncExternalStore } from "react"
import { FileTextIcon } from "lucide-react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { commands } from "@/bindings"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { settingsStore, updateSettings } from "@/lib/settings-store"

const subscribe = (notify: () => void) => settingsStore.subscribe(notify)
// Absent means enabled: the feature is on by default and only an explicit false opts out.
const read = () => settingsStore.get<boolean>("memory.injectOnNewSession") !== false

export function MemoryInjectionRow() {
  const { t } = useTranslation()
  const enabled = useSyncExternalStore(subscribe, read)
  const [pending, setPending] = useState(false)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const openPrompt = (): void => {
    setDraft("")
    setOpen(true)
    setLoading(true)
    void commands
      .globalPromptRead()
      .then((text) => setDraft(text))
      .catch((error: unknown) => toast.error(String(error)))
      .finally(() => setLoading(false))
  }

  const savePrompt = (): void => {
    setSaving(true)
    void commands
      .globalPromptWrite({ content: draft })
      .then(() => {
        setOpen(false)
        toast.success(t("settings.memoryPromptSaved"))
      })
      .catch((error: unknown) => toast.error(String(error)))
      .finally(() => setSaving(false))
  }

  return (
    <>
      <div className="settings-row" role="group" aria-labelledby="memory-injection-title">
        <div className="min-w-0">
          <div id="memory-injection-title" className="text-sm leading-5 font-medium">
            {t("settings.memoryInjection")}
          </div>
          <div className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("settings.memoryInjectionDesc")}
          </div>
          <button
            type="button"
            onClick={openPrompt}
            className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <FileTextIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {t("settings.memoryPromptEditFile")}
          </button>
        </div>
        <div className="settings-row-control">
          <Switch
            aria-label={t("settings.memoryInjection")}
            checked={enabled}
            disabled={pending}
            onCheckedChange={(value) => {
              setPending(true)
              void updateSettings({ "memory.injectOnNewSession": value })
                .catch((error: unknown) => toast.error(String(error)))
                .finally(() => setPending(false))
            }}
          />
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("settings.memoryPromptTitle")}</DialogTitle>
            <DialogDescription>{t("settings.memoryPromptDesc")}</DialogDescription>
          </DialogHeader>
          <textarea
            className="min-h-72 w-full resize-y rounded-lg border bg-background px-3 py-2 font-mono text-[13px] leading-6 outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              loading ? t("settings.memoryPromptLoading") : t("settings.memoryPromptPlaceholder")
            }
            maxLength={64 * 1024}
            spellCheck={false}
            disabled={loading || saving}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("actions.cancel")}
            </Button>
            <Button disabled={loading || saving} onClick={savePrompt}>
              {t("settings.memoryPromptSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
