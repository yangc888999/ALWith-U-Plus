import { type ReactElement, type ReactNode, useState, useSyncExternalStore } from "react"

import { wallpaperController } from "./controller"

export function WallpaperBackground({
  children,
  onError
}: {
  children: ReactNode
  onError: (error: Error) => void
}): ReactElement {
  const value = useSyncExternalStore(wallpaperController.subscribe, wallpaperController.snapshot)
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const visible = value !== null && value.url !== failedUrl
  return (
    <div className="wallpaper-shell" data-wallpaper={visible ? "active" : undefined}>
      {visible && (
        <img
          key={value.url}
          className="wallpaper-background"
          src={value.url}
          alt=""
          aria-hidden="true"
          style={{ objectFit: value.fit, filter: `brightness(${value.brightness / 100}) blur(${value.blur}px)` }}
          onError={() => {
            setFailedUrl(value.url)
            onError(new Error("Wallpaper image could not be loaded / 壁纸图片加载失败"))
          }}
        />
      )}
      {children}
    </div>
  )
}
