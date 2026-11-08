import { ChatWindow } from "@/features/chat-window/chat-window"
import { bootstrapAuxWindow } from "@/lib/aux-window-bootstrap"
import { armStartupWindow } from "@/lib/startup-window"

// 浮窗也是启动面：引擎没 ready 之前不许把"对话服务未运行"画在顶部。窗口入口开一次静默窗，
// ChatWindow 在 connection === "ready" 时关闭它（见 chat-window.tsx）。
armStartupWindow()

bootstrapAuxWindow({
  component: ChatWindow,
  logTag: "chat",
  zoomControls: "feedback",
  toaster: true,
  // The window itself is created transparent; the page must not paint over that, or the chat
  // surface's rounded corners are squared off by an opaque body background.
  transparent: true
})
