import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          // Sonner defaults to a stacking level above every overlay, which buried the text
          // selection pill (z-70) under a toast and made "复制" unclickable. Toasts still sit
          // above dialogs (z-50); the pill stays reachable.
          // Above the window's accent overlay (z-60): a toast must never sit under the wash or
          // lose its close button to it.
          zIndex: 80,
        } as React.CSSProperties
      }
      // Every toast gets a real close button. The circled cross on the left is the status icon,
      // and clicking it never dismissed anything — that is the "点了 X 没反应" report.
      closeButton
      toastOptions={{
        classNames: {
          toast: "cn-toast",
          closeButton: "cn-toast-close",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
