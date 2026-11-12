/**
 * The account-managed (company) model's default reasoning level.
 *
 * The company DeepSeek V4.1 Flash thinks at this level whenever a chat picks it without pinning an
 * effort. The 大模型 page lets the user choose 低 / 高 / Max; the choice is mirrored into the engine
 * catalog by the desktop backend (`set_company_model_reasoning`), which is what actually changes
 * how hard the model thinks. Kept in localStorage so the value survives restarts and can be pushed
 * into the backend on startup. The built-in default is Max — the user asked for the hardest
 * thinking by default.
 */
export type CompanyReasoningLevel = "low" | "high" | "max"

export interface CompanyModelConfig {
    reasoningLevel: CompanyReasoningLevel
}

const LEVELS: readonly CompanyReasoningLevel[] = ["low", "high", "max"]
const STORAGE_KEY = "alwith:company-model"
const listeners = new Set<() => void>()
let cache: CompanyModelConfig | null = null

function read(): CompanyModelConfig {
    if (cache !== null) return cache
    let config: CompanyModelConfig = { reasoningLevel: "max" }
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw !== null) {
            const parsed: unknown = JSON.parse(raw)
            if (
                typeof parsed === "object" &&
                parsed !== null &&
                LEVELS.includes((parsed as { reasoningLevel?: unknown }).reasoningLevel as CompanyReasoningLevel)
            ) {
                config = { reasoningLevel: (parsed as { reasoningLevel: CompanyReasoningLevel }).reasoningLevel }
            }
        }
    } catch {
        // A corrupt store must not block startup; the default (max) applies.
    }
    cache = config
    return config
}

/** The configured company-model default reasoning level (Max when never set). */
export function companyModelConfig(): CompanyModelConfig {
    return read()
}

/** Sets the company-model default reasoning level and notifies subscribers. */
export function setCompanyModelReasoning(level: CompanyReasoningLevel): void {
    const next: CompanyModelConfig = { reasoningLevel: level }
    if (cache !== null && cache.reasoningLevel === level) {
        cache = next
        return
    }
    cache = next
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
        // Storage can be unavailable; the in-memory value still works for this launch.
    }
    for (const listener of listeners) listener()
}

export function subscribeCompanyModelReasoning(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

/** `useSyncExternalStore` snapshot; the stored object identity is stable until it changes. */
export function companyModelReasoningSnapshot(): CompanyModelConfig {
    return read()
}
