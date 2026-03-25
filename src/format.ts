import * as path from "node:path"
import type { Instruction } from "./instructions.ts"

/**
 * Formats a single instruction for injection into the system prompt.
 *
 * The header identifies the source file and its scope so the LLM understands
 * where the rules come from and which files they apply to.
 *
 * - Repo-wide instructions show the `.github/` path.
 * - Project path-specific instructions show their `.github/instructions/` path.
 * - Global path-specific instructions show a home-dir-relative `~/.copilot/instructions/` path.
 */
export function formatInstruction(instruction: Instruction): string {
  const fileName = path.basename(instruction.filePath)

  if (instruction.type === "repo-wide") {
    return `## Repository Custom Instructions (from \`.github/${fileName}\`)\n\n${instruction.content}`
  }

  const displayPath =
    instruction.scope === "global"
      ? `~/.copilot/instructions/${fileName}`
      : `.github/instructions/${fileName}`

  const header = `## Custom Instructions (from \`${displayPath}\`, applies to: \`${instruction.applyTo.join(", ")}\`)`
  return `${header}\n\n${instruction.content}`
}

