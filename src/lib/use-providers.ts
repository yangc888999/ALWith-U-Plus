import { listen } from "@tauri-apps/api/event"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { events } from "@/bindings"

import {
  loadProviders,
  rememberNativeOverrides,
  setProviderSnapshot,
  type ProviderSnapshot
} from "./providers"

export function useProviders() {
  const [snapshot, setSnapshot] = useState<ProviderSnapshot | null>(null)
  useEffect(() => {
    let active = true
    const stop = events["providers:changed"].listen((event) => {
      if (active) {
        rememberNativeOverrides(event.payload.builtInModels?.["openai"] ?? null)
        setProviderSnapshot(event.payload)
        setSnapshot((current) => (current && current.revision > event.payload.revision ? current : event.payload))
      }
    })
    void stop
      .then(() => loadProviders())
      .then((value) => {
        if (active) {
          rememberNativeOverrides(value.builtInModels?.["openai"] ?? null)
          setProviderSnapshot(value)
          setSnapshot((current) => (current && current.revision >= value.revision ? current : value))
        }
      })
      .catch((error: unknown) => {
        if (active) toast.error(String(error))
      })
    // Enterprise login/logout changes the catalog without bumping the native provider revision,
    // so the revision guard above must not filter these refreshes out. Outside Tauri (tests,
    // Storybook) there is no event runtime; the catalog still loads, only live refresh is absent.
    const stopEnterprise = listen("enterprise:models-changed", () => {
      void loadProviders()
        .then((value) => {
          if (active) {
            rememberNativeOverrides(value.builtInModels?.["openai"] ?? null)
            setProviderSnapshot(value)
            setSnapshot(value)
          }
        })
        .catch((error: unknown) => {
          if (active) toast.error(String(error))
        })
    }).catch(() => null)
    return () => {
      active = false
      void stop.then((fn) => fn())
      void stopEnterprise.then((fn) => fn?.())
    }
  }, [])
  return snapshot
}
