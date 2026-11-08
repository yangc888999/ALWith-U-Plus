import { toast } from "sonner"
import { expect, test, vi } from "vitest"

import { initI18n } from "@/lib/i18n"
import { installToastErrorLocalization } from "@/lib/toast-error"

test("localizes a raw English abort message passed to toast.error", async () => {
  await initI18n("zh-CN")
  const original = vi.spyOn(toast, "error")
  installToastErrorLocalization()

  toast.error("The operation was aborted.")

  expect(original).toHaveBeenCalledWith("操作已取消。", undefined)
})
