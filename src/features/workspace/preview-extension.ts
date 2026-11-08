// Which extension surface currently occupies the preview pane.
//
// Promoted out of `FileWorkspace` so the sidebar can drive it: 资料库-style entries (BI 指标)
// open the preview column without the file workspace having to lift half its state up.
import { create } from "zustand"

type PreviewExtensionState = {
  id: string | null
  open: (id: string) => void
  close: () => void
}

export const usePreviewExtension = create<PreviewExtensionState>((set) => ({
  id: null,
  open: (id) => set({ id }),
  close: () => set({ id: null })
}))
