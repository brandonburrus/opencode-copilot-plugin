import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs/promises"
import matter from "gray-matter"
import { getVSCodeUserDataDirs } from "./vscode-paths.ts"
import { entryIsDirectory } from "./fs-utils.ts"
import { pluginLog } from "./log.ts"

/**
 * The default directory where GitHub Copilot stores user-level skill files.
 * Each immediate subdirectory is expected to contain a `SKILL.md` file.
 */
export const GLOBAL_SKILLS_DIR = path.join(os.homedir(), ".copilot", "skills")

/**
 * The subdirectory path (relative to the project root) where project-level skills live.
 * Resolved to an absolute path in `discoverLocalSkills`.
 */
export const LOCAL_SKILLS_SUBDIR = path.join(".github", "skills")

/**
 * A single Copilot skill loaded from a `<name>/SKILL.md` file.
 *
 * - `scope: "local"`  — from `<rootDir>/.github/skills/<name>/SKILL.md`
 * - `scope: "global"` — from `~/.copilot/skills/<name>/SKILL.md`
 */
export interface CopilotSkill {
  /** Canonical name — taken from the directory name, not the frontmatter `name` field. */
  name: string
  /** Short description from the `description` frontmatter field. Shown in the tool listing. */
  description: string
  /** Whether the skill came from the project root or the user-global directory. */
  scope: "local" | "global"
  /** Absolute path to the skill directory. */
  dirPath: string
  /** Absolute path to the `SKILL.md` file inside `dirPath`. */
  filePath: string
  /** Body content of `SKILL.md` (everything after the frontmatter block), trimmed. */
  content: string
}

/**
 * Discovers all available Copilot skills from both local (project) and global directories
 * and returns a merged, deduplicated list. Local skills take precedence over global skills
 * when both have the same directory name.
 */
export async function discoverSkills(rootDir: string): Promise<CopilotSkill[]> {
  const [local, global] = await Promise.all([discoverLocalSkills(rootDir), discoverGlobalSkills()])
  return mergeSkills(local, global)
}

/**
 * Discovers skills from `<rootDir>/.github/skills/`.
 * Returns an empty array if the directory does not exist.
 */
export async function discoverLocalSkills(rootDir: string): Promise<CopilotSkill[]> {
  return collectSkillDirs(path.join(rootDir, LOCAL_SKILLS_SUBDIR), "local")
}

/**
 * Discovers skills from `globalDir` (defaults to `~/.copilot/skills/`).
 * Returns an empty array if the directory does not exist.
 */
export async function discoverGlobalSkills(
  globalDir: string = GLOBAL_SKILLS_DIR,
): Promise<CopilotSkill[]> {
  return collectSkillDirs(globalDir, "global")
}

/**
 * Discovers skills from the VS Code user data directories.
 *
 * Scans `<vsCodeUserDataDir>/skills/` for both the stable and Insiders variants
 * of VS Code on the current platform. Returns an empty array if none of those
 * directories exist.
 */
export async function discoverVSCodeSkills(): Promise<CopilotSkill[]> {
  const userDataDirs = await getVSCodeUserDataDirs()
  const results = await Promise.all(
    userDataDirs.map((base) => collectSkillDirs(path.join(base, "skills"), "global")),
  )
  return results.flat()
}

/**
 * Merges a local and global skill list, deduplicating by name.
 * When both lists contain a skill with the same directory name, the local one is kept
 * and the global one is dropped with a warning written to stderr.
 */
export function mergeSkills(local: CopilotSkill[], global: CopilotSkill[]): CopilotSkill[] {
  const localNames = new Set(local.map((s) => s.name))

  const filteredGlobal = global.filter((s) => {
    if (localNames.has(s.name)) {
      pluginLog("warn", `Skipping global skill "${s.name}": overridden by a local skill with the same name`)
      return false
    }
    return true
  })

  return [...local, ...filteredGlobal]
}

/**
 * Reads each immediate subdirectory of `dir` and attempts to parse its `SKILL.md` file.
 * Subdirectories that lack a valid `SKILL.md` are skipped with a warning.
 * Returns an empty array if `dir` doesn't exist.
 */
async function collectSkillDirs(
  dir: string,
  scope: CopilotSkill["scope"],
): Promise<CopilotSkill[]> {
  let entries: import("node:fs").Dirent<string>[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" })
  } catch {
    return []
  }

  const skills = await Promise.all(
    entries.map(async (entry) => {
      if (!(await entryIsDirectory(entry, dir))) return null
      return parseSkillDir(path.join(dir, entry.name), scope)
    }),
  )
  return skills.filter((s): s is CopilotSkill => s !== null)
}

/**
 * Reads and parses the `SKILL.md` file inside `dirPath`.
 *
 * The directory name is used as the canonical skill name. If a `name` frontmatter
 * field is present but doesn't match the directory name, a warning is emitted and the
 * directory name is used anyway — consistent with how OpenCode resolves skill names.
 *
 * Returns `null` if the file is missing, unreadable, or lacks a `description` field.
 */
async function parseSkillDir(
  dirPath: string,
  scope: CopilotSkill["scope"],
): Promise<CopilotSkill | null> {
  const filePath = path.join(dirPath, "SKILL.md")

  let raw: string
  try {
    raw = await fs.readFile(filePath, "utf8")
  } catch {
    return null
  }

  const { data: frontmatter, content } = matter(raw)

  if (!frontmatter["description"] || typeof frontmatter["description"] !== "string") {
    pluginLog("warn", `Skipping ${filePath}: missing or invalid "description" frontmatter field`)
    return null
  }

  const dirName = path.basename(dirPath)
  const fmName = frontmatter["name"]
  if (typeof fmName === "string" && fmName !== dirName) {
    pluginLog("warn", `Warning: "name" in ${filePath} is "${fmName}" but directory is "${dirName}". Using directory name as canonical name.`)
  }

  return {
    name: dirName,
    description: frontmatter["description"] as string,
    scope,
    dirPath,
    filePath,
    content: content.trim(),
  }
}
