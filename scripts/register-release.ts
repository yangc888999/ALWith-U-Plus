import { registerRelease } from "./lib/release-artifacts"

// Let registration errors propagate: a caught message alone hides the failure (and its stack) and
// makes the release job look recoverable. An uncaught error fails the step with a nonzero exit.
const [directory, tag] = process.argv.slice(2)
if (!directory || !tag || process.argv.length !== 4) {
  throw new Error("Usage: bun scripts/register-release.ts <directory> <tag>")
}
const apiBase = process.env.API_BASE
if (!apiBase) throw new Error("Missing API_BASE")
const count = await registerRelease(directory, tag, apiBase, process.env.CI_RELEASE_TOKEN ?? "")
console.log(`Registered ${count} artifacts for ${tag}. Review release notes and publish in the admin console.`)
