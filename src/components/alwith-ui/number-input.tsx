import * as React from "react"

import { Input } from "@/components/ui/input"

/**
 * Thin number field used by the Drive controls. Kept separate from `Input` so the drive styles
 * (compact height, right-aligned steppers-free value) stay stable across form redesigns.
 */
export function NumberInput({ onChange, ...props }: React.ComponentProps<typeof Input>): React.ReactElement {
  return (
    <Input
      {...props}
      type="number"
      onChange={(event) => {
        onChange?.(event)
      }}
      className={["tabular-nums", props.className].filter(Boolean).join(" ")}
    />
  )
}
