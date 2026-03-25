import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs/promises"
import matter from "gray-matter"

/**
 * The default directory where VS Code Copilot stores user-level instruction files.
 * These apply across all workspaces, unlike project-level instructions in `.github/`.
 */
export const GLOBAL_INSTRUCTIONS_DIR = path.join(os.homedir(), ".copilot", "instructions")

/** A repo-wide instruction from `.github/copilot-instructions.md`. Always injected. */
export interface RepoWideInstruction {
  type: "repo-wide"
  /** Absolute path to the instruction file. */
  filePath: string
  /** Markdown content (no frontmatter). */
  content: string
}

/**
 * A path-specific instruction from a `*.instructions.md` file.
 * Only injected when tracked files match at least one `applyTo` pattern.
 *
 * - `scope: "project"` — from `<rootDir>/.github/instructions/**`
 * - `scope: "global"`  — from `~/.copilot/instructions/**`
 */
export interface PathSpecificInstruction {
  type: "path-specific"
  /**
   * Whether this instruction came from the project's `.github/instructions/` directory
   * or from the user-global `~/.copilot/instructions/` directory.
   */
  scope: "project" | "global"
  /** Absolute path to the instruction file. */
  filePath: string
  /**
   * One or more glob patterns from the frontmatter `applyTo` field.
   * A comma-separated value like `"**\/*.ts,**\/*.tsx"` is split into individual patterns.
   */
  applyTo: string[]
  /**
   * Optional frontmatter field to exclude this instruction from a specific Copilot agent.
   * Accepted values: `"code-review"` | `"coding-agent"`. Stored for future use.
   */
  excludeAgent?: string
  /** Markdown content (everything after the frontmatter block). */
  content: string
}

export type Instruction = RepoWideInstruction | PathSpecificInstruction

/**
 * Parses a raw `applyTo` frontmatter string into an array of individual glob patterns.
 * Handles comma-separated values and trims surrounding whitespace from each pattern.
 */
export function parseApplyTo(raw: string): string[] {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
}

/**
 * Discovers and parses all Copilot custom instruction files under `rootDir`.
 *
 * Looks for:
 * - `<rootDir>/.github/copilot-instructions.md` — repo-wide instructions (always applied)
 * - `<rootDir>/.github/instructions/**\/*.instructions.md` — path-specific instructions
 *
 * Files with a missing or empty `applyTo` frontmatter field are skipped with a warning
 * written to stderr.
 */
export async function discoverInstructions(rootDir: string): Promise<Instruction[]> {
  const instructions: Instruction[] = []

  // Repo-wide: .github/copilot-instructions.md
  const repoWidePath = path.join(rootDir, ".github", "copilot-instructions.md")
  try {
    const raw = await fs.readFile(repoWidePath, "utf8")
    instructions.push({
      type: "repo-wide",
      filePath: repoWidePath,
      content: raw.trim(),
    })
  } catch {
    // File doesn't exist — not an error
  }

  // Path-specific: .github/instructions/**/*.instructions.md
  const instructionsDir = path.join(rootDir, ".github", "instructions")
  const pathSpecific = await collectInstructionFiles(instructionsDir, "project")
  instructions.push(...pathSpecific)

  return instructions
}

/**
 * Discovers and parses user-level Copilot instruction files from `globalDir`
 * (defaults to `~/.copilot/instructions/`).
 *
 * These are path-specific only — there is no user-level equivalent of
 * `copilot-instructions.md`. They use the same `applyTo` frontmatter format and
 * are injected across all workspaces when the session's tracked files match.
 */
export async function discoverGlobalInstructions(
  globalDir: string = GLOBAL_INSTRUCTIONS_DIR,
): Promise<PathSpecificInstruction[]> {
  return collectInstructionFiles(globalDir, "global")
}

/**
 * Recursively walks `dir` and parses every `*.instructions.md` file found.
 * Returns an empty array if `dir` doesn't exist.
 */
async function collectInstructionFiles(
  dir: string,
  scope: PathSpecificInstruction["scope"],
): Promise<PathSpecificInstruction[]> {
  const results: PathSpecificInstruction[] = []

  let entries: import("node:fs").Dirent<string>[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" })
  } catch {
    // Directory doesn't exist
    return results
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await collectInstructionFiles(fullPath, scope)
      results.push(...nested)
    } else if (entry.isFile() && entry.name.endsWith(".instructions.md")) {
      const parsed = await parseInstructionFile(fullPath, scope)
      if (parsed) results.push(parsed)
    }
  }

  return results
}

/**
 * Reads and parses a single `*.instructions.md` file.
 * Returns `null` if the file is missing a valid `applyTo` frontmatter field.
 */
async function parseInstructionFile(
  filePath: string,
  scope: PathSpecificInstruction["scope"],
): Promise<PathSpecificInstruction | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch {
    return null
  }

  const { data: frontmatter, content } = matter(raw)

  if (!frontmatter["applyTo"] || typeof frontmatter["applyTo"] !== "string") {
    process.stderr.write(
      `[opencode-copilot-plugin] Skipping ${filePath}: missing or invalid "applyTo" frontmatter field\n`,
    )
    return null
  }

  const applyTo = parseApplyTo(frontmatter["applyTo"] as string)
  if (applyTo.length === 0) {
    process.stderr.write(
      `[opencode-copilot-plugin] Skipping ${filePath}: "applyTo" resolved to zero patterns\n`,
    )
    return null
  }

  return {
    type: "path-specific",
    scope,
    filePath,
    applyTo,
    excludeAgent:
      typeof frontmatter["excludeAgent"] === "string" ? frontmatter["excludeAgent"] : undefined,
    content: content.trim(),
  }
}
