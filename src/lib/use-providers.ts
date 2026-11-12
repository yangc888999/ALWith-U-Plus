import { useEffect, useState } from "react"
import { toast } from "sonner"

import { listenProviderSnapshots, type ProviderSnapshot } from "./providers"

export function useProviders() {
  const [snapshot, setSnapshot] = useState<ProviderSnapshot | null>(null)
  useEffect(() => {
    let active = true
    const stop = listenProviderSnapshots(
      (value) => {
        if (active) setSnapshot(value)
      },
      (error) => {
        if (active) toast.error(String(error))
      }
    )
    void stop.catch((error: unknown) => {
      if (active) toast.error(String(error))
    })
    return () => {
      active = false
      void stop.then((fn) => fn()).catch(() => {})
    }
  }, [])
  return snapshot
}
