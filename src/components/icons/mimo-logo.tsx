import type { SVGProps } from "react"

/**
 * 小米 MiMo 的标记。
 *
 * Their site has no usable favicon (the API host answers 404 and the brand assets are a wide
 * wordmark that turns to mush at 20px), so this is a drawn mark in the same currentColor style as
 * the other built-in logos: a rounded badge with an "M" cut from a thinking dot — reads at any size
 * and inherits the settings accent through `currentColor`.
 */
export function MimoLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <title>MiMo</title>
      <rect x="3" y="3" width="18" height="18" rx="5.5" />
      <path d="M7.5 15.5v-6l4.5 4 4.5-4v6" />
      <circle cx="16.6" cy="7.4" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
}
