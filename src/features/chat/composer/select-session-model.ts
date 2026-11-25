import { toast } from "sonner"

import { client } from "@/lib/client"
import { describeError } from "@/lib/error-text"
import i18n from "@/lib/i18n"

export async function selectSessionModel(sessionId: string, model: string): Promise<void> {
  try {
    await client.setConfig(sessionId, "model", model)
    toast.success(i18n.t("chat.modelSwitched"), { id: `model-choice:${sessionId}` })
  } catch (error) {
    toast.error(describeError(error), { id: `model-choice:${sessionId}` })
  }
}
