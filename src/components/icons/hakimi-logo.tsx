import type { SVGProps } from "react"

/** Hakimi's built-in gateway mark, drawn in currentColor. */
export function HakimiLogo(props: SVGProps<SVGSVGElement>) {
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
      <title>Hakimi</title>
      <path d="M4.5 9.5 5 4l4 3.2h6L19 4l.5 5.5v6A4.5 4.5 0 0 1 15 20H9a4.5 4.5 0 0 1-4.5-4.5z" />
      <path d="M9 11v5m6-5v5m-6-2.5h6" />
    </svg>
  )
}
