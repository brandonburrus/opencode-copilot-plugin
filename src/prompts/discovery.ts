import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs/promises"
import matter from "gray-matter"
import type { CopilotPrompt, CopilotPromptFrontmatter, PromptArgument } from "./types.ts"
import { getVSCodeUserDataDirs } from "../vscode-paths.ts"
import { entryIsFile } from "../fs-utils.ts"
import { pluginLog } from "../log.ts"

/**
 * The subdirectory path (relative to the project root) where project-level prompt files live.
 * Resolved to an absolute path in `discoverLocalPrompts`.
 */
export const LOCAL_PROMPTS_SUBDIR = path.join(".github", "prompts")

/**
 * The default directory where GitHub Copilot stores user-level prompt files.
 * These apply across all workspaces.
 */
export const GLOBAL_PROMPTS_DIR = path.join(os.homedir(), ".copilot", "prompts")

/**
 * Discovers prompt files from `<rootDir>/.github/prompts/`.
 * Returns an empty array if the directory does not exist.
 */
export async function discoverLocalPrompts(rootDir: string): Promise<CopilotPrompt[]> {
  return collectPromptFiles(path.join(rootDir, LOCAL_PROMPTS_SUBDIR), "local")
}

/**
 * Discovers prompt files from `globalDir` (defaults to `~/.copilot/prompts/`).
 * Returns an empty array if the directory does not exist.
 */
export async function discoverGlobalPrompts(
  globalDir: string = GLOBAL_PROMPTS_DIR,
): Promise<CopilotPrompt[]> {
  return collectPromptFiles(globalDir, "global")
}

/**
 * Discovers prompt files from the VS Code user data directories.
 *
 * Scans `<vsCodeUserDataDir>/prompts/` for both the stable and Insiders variants
 * of VS Code on the current platform. This is where VS Code stores user-level
 * prompt files created via the Chat Customizations editor or the
 * "Chat: New Prompt File" command.
 *
 * Returns an empty array if none of those directories exist.
 */
export async function discoverVSCodePrompts(): Promise<CopilotPrompt[]> {
  const userDataDirs = await getVSCodeUserDataDirs()
  const results = await Promise.all(
    userDataDirs.map((base) => collectPromptFiles(path.join(base, "prompts"), "global")),
  )
  return results.flat()
}

/**
 * Merges a local and global prompt list, deduplicating by name.
 * When both lists contain a prompt with the same name, the local one is kept
 * and the global one is dropped with a warning written to stderr.
 */
export function mergePrompts(local: CopilotPrompt[], global: CopilotPrompt[]): CopilotPrompt[] {
  const localNames = new Set(local.map((p) => p.name))

  const filteredGlobal = global.filter((p) => {
    if (localNames.has(p.name)) {
      pluginLog("warn", `Skipping global prompt "${p.name}": overridden by a local prompt with the same name`)
      return false
    }
    return true
  })

  return [...local, ...filteredGlobal]
}

/**
 * Scans `dir` for `*.prompt.md` files (non-recursive, flat directory) and attempts to parse each.
 * Returns an empty array if the directory does not exist.
 */
async function collectPromptFiles(
  dir: string,
  scope: CopilotPrompt["scope"],
): Promise<CopilotPrompt[]> {
  const results: CopilotPrompt[] = []

  let entries: import("node:fs").Dirent<string>[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" })
  } catch {
    return results
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".prompt.md")) continue
    if (!(await entryIsFile(entry, dir))) continue
    const filePath = path.join(dir, entry.name)
    const prompt = await parsePromptFile(filePath, dir, scope)
    if (prompt) results.push(prompt)
  }

  return results
}

/**
 * Reads and parses a single `.prompt.md` file.
 *
 * The filename (minus `.prompt.md`) is the canonical prompt name. If a `name`
 * frontmatter field is present but doesn't match the filename-derived name, a
 * warning is emitted and the filename-derived name is used — consistent with
 * how skills and agents resolve canonical names.
 *
 * Unsupported frontmatter fields (`agent`, `model`, `tools`) are preserved in
 * the parsed frontmatter and surfaced as informational notes via `formatPromptHeader`.
 *
 * Returns `null` if the file is missing or unreadable.
 */
async function parsePromptFile(
  filePath: string,
  dirPath: string,
  scope: CopilotPrompt["scope"],
): Promise<CopilotPrompt | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch {
    return null
  }

  const { data: frontmatter, content } = matter(raw)
  const fm = frontmatter as CopilotPromptFrontmatter

  const name = derivePromptName(path.basename(filePath))
  const fmName = fm.name
  if (typeof fmName === "string" && fmName !== name) {
    pluginLog("warn", `Warning: "name" in ${filePath} is "${fmName}" but filename-derived name is "${name}". Using filename-derived name as canonical name.`)
  }

  // description is optional for prompts — fall back to the canonical name
  const description =
    typeof fm.description === "string" && fm.description.trim()
      ? fm.description.trim()
      : name

  const trimmedContent = content.trim()
  const args = extractArguments(trimmedContent)

  return {
    name,
    description,
    scope,
    dirPath,
    filePath,
    content: trimmedContent,
    frontmatter: fm,
    arguments: args,
  }
}

/**
 * Derives the canonical prompt name from a filename by stripping `.prompt.md`.
 */
function derivePromptName(filename: string): string {
  if (filename.endsWith(".prompt.md")) return filename.slice(0, -".prompt.md".length)
  return filename
}

/**
 * Extracts argument placeholders from prompt body content.
 *
 * Supports two syntaxes:
 * - VS Code style: `${input:varName}` or `${input:varName:placeholder text}`
 * - Copilot/Crush style: `$VAR_NAME` (uppercase identifier with underscores, not followed by `{`)
 *
 * Returns deduplicated arguments in order of first appearance.
 */
export function extractArguments(content: string): PromptArgument[] {
  const seen = new Set<string>()
  const args: PromptArgument[] = []

  // VS Code style: ${input:varName} or ${input:varName:placeholder}
  const vscodePattern = /\$\{input:([^}:]+)(?::([^}]*))?\}/g
  let match: RegExpExecArray | null
  while ((match = vscodePattern.exec(content)) !== null) {
    const id = match[1]!.trim()
    const placeholder = match[2]?.trim()
    if (!seen.has(id)) {
      seen.add(id)
      args.push({ id, placeholder: placeholder || undefined })
    }
  }

  // Copilot/Crush style: $VAR_NAME (uppercase + underscores, not preceded by { and not followed by {)
  const crushPattern = /(?<!\{)\$([A-Z][A-Z0-9_]*)(?!\{)/g
  while ((match = crushPattern.exec(content)) !== null) {
    const id = match[1]!
    if (!seen.has(id)) {
      seen.add(id)
      args.push({ id })
    }
  }

  return args
}

/**
 * Substitutes argument values into prompt content.
 *
 * Replaces `${input:varName}`, `${input:varName:placeholder}`, and `$VAR_NAME`
 * occurrences with the corresponding value from `argValues`. Unmatched
 * placeholders are left as-is.
 */
export function substituteArguments(
  content: string,
  args: PromptArgument[],
  argValues: Record<string, string>,
): string {
  let result = content

  for (const arg of args) {
    const value = argValues[arg.id]
    if (value === undefined) continue

    // Replace VS Code style: ${input:varName} and ${input:varName:placeholder}
    result = result.replace(
      new RegExp(`\\$\\{input:${escapeRegex(arg.id)}(?::[^}]*)?\\}`, "g"),
      value,
    )

    // Replace Copilot/Crush style: $VAR_NAME
    result = result.replace(new RegExp(`(?<!\\{)\\$${escapeRegex(arg.id)}(?!\\{)`, "g"), value)
  }

  return result
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
