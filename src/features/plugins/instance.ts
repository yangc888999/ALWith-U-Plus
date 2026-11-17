// The app's one plugins store, bound to the app-wide client. It reads catalogs and reports
// failures; it never rebuilds the connection (see store.ts for why that loop killed the engine).
import { client } from "@/lib/client"

import { createPluginsStore } from "./store"

export const pluginsStore = createPluginsStore(client)
