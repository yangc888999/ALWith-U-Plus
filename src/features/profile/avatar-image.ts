// Picking a photo must not put a 4 MB JPEG into the settings file: the avatar is centre-cropped
// to a square and re-encoded small enough to travel with every settings snapshot.

/** 256px covers a 96px avatar on a 2x display with room to spare. */
const AVATAR_SIZE = 256
const JPEG_QUALITY = 0.86
const MAX_SOURCE_BYTES = 20 * 1024 * 1024

export const AVATAR_ERROR_CODES = ["not-an-image", "too-large", "unreadable"] as const
export type AvatarErrorCode = (typeof AVATAR_ERROR_CODES)[number]

export class AvatarImageError extends Error {
  readonly code: AvatarErrorCode
  constructor(code: AvatarErrorCode) {
    super(code)
    this.name = "AvatarImageError"
    this.code = code
  }
}

async function decode(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally {
    // The bitmap is decoded by now; the blob URL has done its job.
    URL.revokeObjectURL(url)
  }
}

/** Centre-crops the picked file to a square data URL. */
export async function readAvatarFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new AvatarImageError("not-an-image")
  if (file.size > MAX_SOURCE_BYTES) throw new AvatarImageError("too-large")
  let image: HTMLImageElement
  try {
    image = await decode(file)
  } catch {
    throw new AvatarImageError("unreadable")
  }
  const side = Math.min(image.naturalWidth, image.naturalHeight)
  const canvas = document.createElement("canvas")
  canvas.width = AVATAR_SIZE
  canvas.height = AVATAR_SIZE
  const context = canvas.getContext("2d")
  if (!side || !context) throw new AvatarImageError("unreadable")
  // JPEG has no alpha channel, so a transparent PNG would otherwise come out black.
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE)
  context.drawImage(
    image,
    (image.naturalWidth - side) / 2,
    (image.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_SIZE,
    AVATAR_SIZE
  )
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY)
}
