import { useState } from "react"

import { createSurfaceOperation } from "./surface-operation"

export function useSurfaceOperation() {
  const [busy, setBusy] = useState(false)
  const [operation] = useState(() =>
    createSurfaceOperation((value) => {
      // Disable editing before the first asynchronous draft read or window request. A plain
      // setState is enough; the one-frame delay is imperceptible and avoids a forced sync render.
      setBusy(value)
    })
  )
  return { busy, operation }
}
