import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs/promises"

const VSCODE_VARIANTS = ["Code", "Code - Insiders"] as const

/**
 * Returns the base VS Code user data directories for the current platform.
 *
 * Checks both the stable ("Code") and Insiders ("Code - Insiders") variants.
 * Only directories that actually exist on disk are returned, so callers can
 * iterate the result without needing their own existence checks.
 *
 * Supported platforms:
 * - macOS (`darwin`): `~/Library/Application Support/<variant>/User`
 * - Linux: `~/.config/<variant>/User`
 *
 * Returns an empty array on unsupported platforms (e.g. Windows).
 */
export async function getVSCodeUserDataDirs(): Promise<string[]> {
  const candidates = resolveVSCodeUserDataCandidates()
  const existing: string[] = []

  await Promise.all(
    candidates.map(async (dir) => {
      try {
        await fs.access(dir)
        existing.push(dir)
      } catch {
        // Directory does not exist — silently skip
      }
    }),
  )

  return existing
}

function resolveVSCodeUserDataCandidates(): string[] {
  const home = os.homedir()

  if (process.platform === "darwin") {
    return VSCODE_VARIANTS.map((variant) =>
      path.join(home, "Library", "Application Support", variant, "User"),
    )
  }

  if (process.platform === "linux") {
    return VSCODE_VARIANTS.map((variant) => path.join(home, ".config", variant, "User"))
  }

  return []
}
