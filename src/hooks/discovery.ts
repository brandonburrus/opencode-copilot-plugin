import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs/promises"
import type { CopilotHookType, HookCommandDef, HookConfigFile, HookRegistry } from "./types.ts"
import { getVSCodeUserDataDirs } from "../vscode-paths.ts"

export const LOCAL_HOOKS_SUBDIR = path.join(".github", "hooks")
export const GLOBAL_HOOKS_DIR = path.join(os.homedir(), ".copilot", "hooks")

/**
 * Discovers all Copilot hook configuration files and merges them into a single registry.
 *
 * Scans three locations in priority order:
 * - `<projectRoot>/.github/hooks/*.json` — project-local hooks (highest priority)
 * - `~/.copilot/hooks/*.json` — user-global hooks
 * - `<vsCodeUserDataDir>/hooks/*.json` — VS Code user data hooks (lowest priority)
 *
 * For each hook type, arrays are concatenated in that priority order so that
 * project hooks always run before global hooks, and `~/.copilot` hooks run
 * before VS Code user data hooks.
 *
 * Hook files are loaded once at plugin init and not hot-reloaded. An OpenCode restart
 * is required to pick up changes to hook files.
 */
export async function discoverHookRegistry(projectRoot: string): Promise<HookRegistry> {
  const vsCodeUserDataDirs = await getVSCodeUserDataDirs()

  const [projectHooks, globalHooks, ...vsCodeHooksPerDir] = await Promise.all([
    collectHookFiles(path.join(projectRoot, LOCAL_HOOKS_SUBDIR)),
    collectHookFiles(GLOBAL_HOOKS_DIR),
    ...vsCodeUserDataDirs.map((base) => collectHookFiles(path.join(base, "hooks"))),
  ])

  const vsCodeHooks = (vsCodeHooksPerDir as HookRegistry[]).reduce(mergeRegistries, {})
  return mergeRegistries(mergeRegistries(projectHooks!, globalHooks!), vsCodeHooks)
}

async function collectHookFiles(dir: string): Promise<HookRegistry> {
  let entries: import("node:fs").Dirent<string>[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" })
  } catch {
    return {}
  }

  const registries: HookRegistry[] = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const filePath = path.join(dir, entry.name)
    const registry = await parseHookFile(filePath)
    if (registry) registries.push(registry)
  }

  return registries.reduce(mergeRegistries, {})
}

async function parseHookFile(filePath: string): Promise<HookRegistry | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    process.stderr.write(`[opencode-copilot-plugin] Skipping ${filePath}: invalid JSON\n`)
    return null
  }

  if (typeof parsed !== "object" || parsed === null) {
    process.stderr.write(`[opencode-copilot-plugin] Skipping ${filePath}: root value must be an object\n`)
    return null
  }

  const config = parsed as Record<string, unknown>

  if (config["version"] !== 1) {
    process.stderr.write(
      `[opencode-copilot-plugin] Skipping ${filePath}: unsupported version (expected 1, got ${config["version"]})\n`,
    )
    return null
  }

  if (typeof config["hooks"] !== "object" || config["hooks"] === null || Array.isArray(config["hooks"])) {
    process.stderr.write(`[opencode-copilot-plugin] Skipping ${filePath}: "hooks" must be an object\n`)
    return null
  }

  return extractRegistry(config["hooks"] as Record<string, unknown>, filePath)
}

const VALID_HOOK_TYPES = new Set<string>([
  "sessionStart",
  "sessionEnd",
  "userPromptSubmitted",
  "preToolUse",
  "postToolUse",
  "agentStop",
  "subagentStop",
  "errorOccurred",
])

function extractRegistry(hooks: Record<string, unknown>, filePath: string): HookRegistry {
  const registry: HookRegistry = {}

  for (const [key, value] of Object.entries(hooks)) {
    if (!VALID_HOOK_TYPES.has(key)) continue

    if (!Array.isArray(value)) {
      process.stderr.write(
        `[opencode-copilot-plugin] Warning: ${filePath}: hook "${key}" must be an array, skipping\n`,
      )
      continue
    }

    const hookType = key as CopilotHookType
    const commands = value.filter((item): item is HookCommandDef => {
      if (typeof item !== "object" || item === null) return false
      if ((item as Record<string, unknown>)["type"] !== "command") return false
      return true
    })

    if (commands.length > 0) {
      registry[hookType] = commands
    }
  }

  return registry
}

function mergeRegistries(base: HookRegistry, overlay: HookRegistry): HookRegistry {
  const merged: HookRegistry = { ...base }

  for (const [key, commands] of Object.entries(overlay) as [CopilotHookType, HookCommandDef[]][]) {
    const existing = merged[key]
    merged[key] = existing ? [...existing, ...commands] : [...commands]
  }

  return merged
}
