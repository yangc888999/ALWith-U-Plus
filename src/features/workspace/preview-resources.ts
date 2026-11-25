import type { PreviewResource } from "@alwith/module-editor/previews"
import { containsPath, dirname, type FileSystem, normalizePath } from "@alwith/module-fs"

const mimeTypes: Record<string, string> = {
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "audio/ogg"
}
/** Native FS remains the authority for canonical and symlink boundaries. */
export async function resolvePreviewResource(
  fs: FileSystem,
  root: string,
  documentPath: string,
  reference: string
): Promise<PreviewResource> {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) throw new Error("Preview resource must be a local project file")
  const decoded = decodeURIComponent(reference.split(/[?#]/, 1)[0])
  const path = normalizePath(decoded.startsWith("/") ? `${root}/${decoded}` : `${dirname(documentPath)}/${decoded}`)
  if (!containsPath(root, documentPath) || !containsPath(root, path))
    throw new Error("Preview resource is outside the project")
  const bytes = await fs.readFile(path)
  const extension = path.split(".").at(-1)?.toLowerCase() ?? ""
  return { bytes, path, mimeType: mimeTypes[extension] ?? "application/octet-stream" }
}

/**
 * Toggles the document comment column.
 *
 * That column belongs to the drive module (collapsed it renders `comment-rail`, expanded it renders
 * `comment-drawer`), and the module exposes no visibility prop — so the toggle drives its own DOM:
 * the rail's button expands, the drawer's header button collapses. Structural selectors are used on
 * purpose: the buttons' accessible labels are localized by the module.
 */
function collapseCommentColumn(root: ParentNode = document): boolean {
  const drawer = root.querySelector('[data-testid="comment-drawer"]')
  if (drawer === null) return false
  const collapse = drawer.querySelector(":scope > div:first-child > button:first-child")
  if (collapse instanceof HTMLElement) {
    collapse.click()
    return true
  }
  return false
}

/** Persisted switch for the whole comment column. */
const COMMENTS_HIDDEN_KEY = "alwith:comments-hidden"

export function commentsHidden(): boolean {
  return localStorage.getItem(COMMENTS_HIDDEN_KEY) === "1"
}

export function setCommentsHidden(hidden: boolean): void {
  localStorage.setItem(COMMENTS_HIDDEN_KEY, hidden ? "1" : "0")
  if (hidden) collapseCommentColumn()
  // The CSS rule keys off this attribute, so the column disappears even though the drive module
  // keeps it mounted.
  document.documentElement.dataset.commentsHidden = hidden ? "true" : "false"
}

/** Applies the stored switch on boot, before the first drive document renders. */
export function applyStoredCommentsVisibility(): void {
  document.documentElement.dataset.commentsHidden = commentsHidden() ? "true" : "false"
}
