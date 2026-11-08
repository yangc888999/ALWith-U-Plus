import { openUrl } from "@tauri-apps/plugin-opener"


import { authClient } from "./store"

/** The existing account SSO route opens in the system browser. */
async function openPlatformPage(path: "/account" | "/pricing"): Promise<void> {
  const url = new URL(path, import.meta.env.DEV ? "https://www-dev.alwith.ai" : "https://www.alwith.ai")
  let otp: string | null = null
  try {
    otp = (await authClient.getSsoOtp()).otp
  } catch {
    /* The account page can also sign in interactively. */
  }
  if (otp !== null) {
    url.pathname = "/sso"
    url.searchParams.set("otp", otp)
    url.searchParams.set("redirect", path)
  }
  await openUrl(url.href)
}

export async function openPlatformAccount(): Promise<void> {
  await openPlatformPage("/account")
}

export async function openPlatformTopUp(): Promise<void> {
  await openPlatformPage("/pricing")
}
