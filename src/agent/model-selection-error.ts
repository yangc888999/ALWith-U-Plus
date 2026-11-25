export class ModelSelectionError extends Error {}

export function isAccountModelRefusal(message: string): boolean {
  return /^The ['"`]([^'"`\r\n]+)['"`] model is not supported when using Codex with a ChatGPT account\.?$/i.test(
    message.trim()
  )
}
