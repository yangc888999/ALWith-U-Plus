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
    return () => {
      active = false
      void stop.then((fn) => fn())
    }
  }, [])
  return snapshot
}
