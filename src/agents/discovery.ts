import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs/promises"
import matter from "gray-matter"
import type { HookCommandDef, HookRegistry } from "../hooks/types.ts"
import type { AgentHookCommandDef, CopilotAgent, CopilotAgentFrontmatter } from "./types.ts"
import { getVSCodeUserDataDirs } from "../vscode-paths.ts"
import { entryIsFile } from "../fs-utils.ts"

/** Subdirectory (relative to project root) for agent files. */
export const LOCAL_AGENTS_SUBDIR = path.join(".github", "agents")

/** Default directory for user-global agent files. */
export const GLOBAL_AGENTS_DIR = path.join(os.homedir(), ".copilot", "agents")

/**
 * Discovers all local agent files from `.github/agents/` under `rootDir`.
 * Returns an empty array if the directory does not exist.
 */
export async function discoverLocalAgents(rootDir: string): Promise<CopilotAgent[]> {
  return collectAgentFiles(path.join(rootDir, LOCAL_AGENTS_SUBDIR), "local")
}

/**
 * Discovers all user-global agent files from `~/.copilot/agents/`.
 * Returns an empty array if the directory does not exist.
 */
export async function discoverGlobalAgents(
  globalDir: string = GLOBAL_AGENTS_DIR,
): Promise<CopilotAgent[]> {
  return collectAgentFiles(globalDir, "global")
}

/**
 * Discovers agent files from the VS Code user data directories.
 *
 * Scans `<vsCodeUserDataDir>/agents/` for both the stable and Insiders variants
 * of VS Code on the current platform. Returns an empty array if none of those
 * directories exist.
 */
export async function discoverVSCodeAgents(): Promise<CopilotAgent[]> {
  const userDataDirs = await getVSCodeUserDataDirs()
  const results = await Promise.all(
    userDataDirs.map((base) => collectAgentFiles(path.join(base, "agents"), "global")),
  )
  return results.flat()
}

/**
 * Merges a local and global agent list, deduplicating by name.
 * When both lists contain an agent with the same name, the local one is kept
 * and the global one is dropped with a warning written to stderr.
 */
export function mergeAgents(primary: CopilotAgent[], secondary: CopilotAgent[]): CopilotAgent[] {
  const primaryNames = new Set(primary.map((a) => a.name))

  const filteredSecondary = secondary.filter((a) => {
    if (primaryNames.has(a.name)) {
      process.stderr.write(
        `[opencode-copilot-plugin] Skipping agent "${a.name}" from ${a.filePath}: overridden by an agent with the same name\n`,
      )
      return false
    }
    return true
  })

  return [...primary, ...filteredSecondary]
}

/**
 * Scans `dir` for agent markdown files and attempts to parse each one.
 * Detects both `*.agent.md` and `*.md` files.
 * Returns an empty array if the directory does not exist.
 */
async function collectAgentFiles(
  dir: string,
  scope: CopilotAgent["scope"],
): Promise<CopilotAgent[]> {
  const results: CopilotAgent[] = []

  let entries: import("node:fs").Dirent<string>[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" })
  } catch {
    return results
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue
    if (!(await entryIsFile(entry, dir))) continue
    const filePath = path.join(dir, entry.name)
    const agent = await parseAgentFile(filePath, dir, scope)
    if (agent) results.push(agent)
  }

  return results
}

/**
 * Reads and parses a single agent markdown file.
 *
 * The filename (without `.agent.md` or `.md` extension) is the canonical agent name.
 * If a `name` frontmatter field is present but doesn't match the filename-derived name,
 * a warning is emitted and the filename-derived name is used.
 *
 * Agents with `target: "github-copilot"` are skipped — they are cloud-only agents
 * that cannot run locally. Agents with `mcp-servers` emit a warning since that feature
 * is not supported (it is tied to cloud agents in Copilot).
 *
 * Returns `null` if the file is missing a `description` field or has `target: github-copilot`.
 */
async function parseAgentFile(
  filePath: string,
  dirPath: string,
  scope: CopilotAgent["scope"],
): Promise<CopilotAgent | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch {
    return null
  }

  const { data: frontmatter, content } = matter(raw)
  const fm = frontmatter as CopilotAgentFrontmatter

  if (!fm.description || typeof fm.description !== "string") {
    process.stderr.write(
      `[opencode-copilot-plugin] Skipping ${filePath}: missing or invalid "description" frontmatter field\n`,
    )
    return null
  }

  if (fm.target === "github-copilot") {
    process.stderr.write(
      `[opencode-copilot-plugin] Skipping ${filePath}: target "github-copilot" is a cloud-only agent and cannot run locally\n`,
    )
    return null
  }

  if (Array.isArray(fm["mcp-servers"]) && fm["mcp-servers"].length > 0) {
    process.stderr.write(
      `[opencode-copilot-plugin] Warning: ${filePath} defines "mcp-servers" which is not supported for local agents — field will be ignored\n`,
    )
  }

  const name = deriveAgentName(path.basename(filePath))
  const fmName = fm.name
  if (typeof fmName === "string" && fmName !== name) {
    process.stderr.write(
      `[opencode-copilot-plugin] Warning: "name" in ${filePath} is "${fmName}" but filename-derived name is "${name}". Using filename-derived name as canonical name.\n`,
    )
  }

  const userInvocable = resolveUserInvocable(fm)
  const hooks = normalizeAgentHooks(fm.hooks ?? {})

  return {
    name,
    description: fm.description,
    scope,
    dirPath,
    filePath,
    content: content.trim(),
    frontmatter: fm,
    hooks,
    userInvocable,
  }
}

/**
 * Derives the canonical agent name from a filename by stripping the `.agent.md`
 * or `.md` extension. `.agent.md` is stripped preferentially over `.md`.
 */
function deriveAgentName(filename: string): string {
  if (filename.endsWith(".agent.md")) return filename.slice(0, -".agent.md".length)
  if (filename.endsWith(".md")) return filename.slice(0, -".md".length)
  return filename
}

/**
 * Resolves the `userInvocable` flag from frontmatter.
 * Priority: `user-invocable` field > `infer` (deprecated) > default `true`.
 * When `infer: false`, the agent is treated as not user-invocable (hidden from listing).
 */
function resolveUserInvocable(fm: CopilotAgentFrontmatter): boolean {
  if (typeof fm["user-invocable"] === "boolean") return fm["user-invocable"]
  if (typeof fm.infer === "boolean") return fm.infer
  return true
}

/**
 * Maps Copilot PascalCase hook type keys to the camelCase keys used internally.
 * Only entries that differ are listed.
 */
const pascalToCamelHookType: Readonly<Record<string, string>> = {
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  UserPromptSubmitted: "userPromptSubmitted",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  AgentStop: "agentStop",
  SubagentStop: "subagentStop",
  ErrorOccurred: "errorOccurred",
}

/**
 * Normalizes agent-scoped hooks from the frontmatter `hooks` field into
 * the standard `HookRegistry` format used throughout the plugin.
 *
 * - PascalCase hook type keys are converted to camelCase.
 * - Hook `command` field (Copilot agent format) is mapped to `bash` (standard format).
 *   If both `command` and `bash` are present, `command` takes precedence.
 * - Unknown hook types are silently skipped.
 */
function normalizeAgentHooks(
  raw: Record<string, AgentHookCommandDef[]>,
): HookRegistry {
  const registry: HookRegistry = {}

  for (const [rawKey, defs] of Object.entries(raw)) {
    const hookType = pascalToCamelHookType[rawKey] ?? rawKey
    if (!isValidHookType(hookType)) continue

    const commands: HookCommandDef[] = defs
      .filter((d) => d.type === "command" && (d.command || d.bash))
      .map((d): HookCommandDef => ({
        type: "command",
        bash: d.command ?? d.bash,
        cwd: d.cwd,
        env: d.env,
        timeoutSec: d.timeoutSec,
      }))

    if (commands.length > 0) {
      registry[hookType as keyof HookRegistry] = commands
    }
  }

  return registry
}

const VALID_HOOK_TYPES = new Set([
  "sessionStart",
  "sessionEnd",
  "userPromptSubmitted",
  "preToolUse",
  "postToolUse",
  "agentStop",
  "subagentStop",
  "errorOccurred",
])

function isValidHookType(type: string): boolean {
  return VALID_HOOK_TYPES.has(type)
}
