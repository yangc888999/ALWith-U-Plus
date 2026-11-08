import { computerContext } from "@alwith/module-computer"
import { isTauri } from "@tauri-apps/api/core"

import type { ClientOptions } from "@/agent/client"
import { commands } from "@/bindings"
import { driveSessionContext } from "@/features/drive/session-context"
import i18n from "@/lib/i18n"
import { settingsStore } from "@/lib/settings-store"

/**
 * The user's `ALWith.md` prompt, stored next to the skills, appended to the system prompt when a
 * session is created. Default-on; only an explicit false disables it. A missing/unreadable file
 * is best-effort: it must never block a session from starting.
 */
async function globalPromptContext(): Promise<string | undefined> {
  if (settingsStore.get<boolean>("memory.injectOnNewSession") === false) return undefined
  try {
    const text = await commands.globalPromptRead()
    return text.trim().length > 0 ? text.trim() : undefined
  } catch {
    return undefined
  }
}

export async function computerContextRevision(): Promise<string> {
  if (!isTauri()) return "disabled"
  return commands.computerRevision()
}

export const hostSessionContext: NonNullable<ClientOptions["sessionContext"]> = async (cwd, operation) => {
  const drive = await driveSessionContext(cwd)
  if (!isTauri()) return { ...drive, revision: "disabled" }
  const descriptor = await commands.computerContext()
  const computer = await computerContext(() => Promise.resolve(descriptor?.connection ?? null))
  // A resumed session already carries the prompt from its creation; re-appending would duplicate it.
  const prompt = operation.kind === "resume" ? undefined : await globalPromptContext()
  const appendSystemPrompt = [drive.appendSystemPrompt, computer.appendSystemPrompt, prompt]
    .filter(Boolean)
    .join("\n\n")
  return {
    revision: computer.revision,
    bind: descriptor
      ? async (sessionId: string) => {
          await commands.computerBind({ token: descriptor.token, sessionId })
        }
      : undefined,
    mcpServers: [...drive.mcpServers, ...computer.mcpServers],
    ...(appendSystemPrompt ? { appendSystemPrompt } : {})
  }
}

/** A failed preflight keeps the message unsent; sending again retries the connection. */
export async function prepareComputerTools(sessionId: string): Promise<void> {
  if (!isTauri()) return
  try {
    await commands.computerReady({ sessionId })
  } catch (error) {
    throw new Error(i18n.t("computer.connectionError", { error: String(error) }), { cause: error })
  }
}
