// The only action the progress row offers: say something to the turn that is already running.
//
// Model switching used to live there, and it was the wrong shape for three reasons. It wrote the
// session's *default* model from a status line — a config change nobody expects from a timer; it
// cancelled the running turn to do it, throwing away whatever the model had already worked out;
// and it duplicated the model picker that already sits under the composer, so "switch model" had
// two entrances with two different side effects.
//
// A model that has gone quiet for a few minutes usually needs a nudge, not a replacement. That is
// also exactly what typing into the composer does mid-turn (its placeholder reads 给当前回合补充
// 指令), so this goes through the same `client.prompt` path: one action, one code path, and the
// nudge shows up in the transcript as the message it is.

import type { Session } from "@alwith/api"
import { info } from "@tauri-apps/plugin-log"
import { toast } from "sonner"

import { client } from "@/lib/client"
import i18n from "@/lib/i18n"

export async function nudgeTurn(session: Session): Promise<void> {
  const text = i18n.t("chat.turnProgress.nudgeText")
  void info(`[nudge] session=${session.id} text=${text}`)
  try {
    // Deliberately not awaited to completion: `prompt` settles when the whole turn ends, and this
    // turn is already running. A refusal raised before dispatch still surfaces as a toast.
    void client.prompt(session.id, [{ type: "text", text }]).catch((error: unknown) => {
      void info(`[nudge] failed session=${session.id} error=${String(error)}`)
      toast.error(i18n.t("chat.turnProgress.nudgeFailed"))
    })
  } catch (error) {
    void info(`[nudge] threw session=${session.id} error=${String(error)}`)
    toast.error(i18n.t("chat.turnProgress.nudgeFailed"))
  }
}
