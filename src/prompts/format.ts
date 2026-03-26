import * as os from "node:os"
import * as path from "node:path"
import type { CopilotPrompt } from "./types.ts"

const home = os.homedir()

function toDisplayPath(filePath: string): string {
  return filePath.startsWith(home) ? filePath.replace(home, "~") : filePath
}

/**
 * Formats the source header prepended to resolved prompt content before it is
 * sent to the LLM as a user message.
 *
 * The header identifies the prompt file, its scope, and surfaces any
 * frontmatter fields that cannot be directly enforced in OpenCode (`agent`,
 * `model`, `tools`) as informational notes so the LLM is aware of the
 * original intent.
 */
export function formatPromptHeader(prompt: CopilotPrompt): string {
  const displayPath = toDisplayPath(prompt.filePath)
  const scopeLabel = prompt.scope === "local" ? ".github/prompts" : "~/.copilot/prompts"
  const fileName = path.basename(prompt.filePath)

  const lines: string[] = [
    `## Copilot Prompt: ${prompt.name} (from \`${scopeLabel}/${fileName}\`)`,
  ]

  if (prompt.description && prompt.description !== prompt.name) {
    lines.push(`> ${prompt.description}`)
  }

  const notes = buildInformationalNotes(prompt)
  if (notes.length > 0) {
    lines.push("", ...notes)
  }

  lines.push("")
  return lines.join("\n")
}

function buildInformationalNotes(prompt: CopilotPrompt): string[] {
  const notes: string[] = []
  const fm = prompt.frontmatter

  if (fm.agent) {
    notes.push(
      `> **Note:** This prompt specifies agent \`${fm.agent}\` — informational only in OpenCode.`,
    )
  }

  if (fm.model) {
    notes.push(
      `> **Note:** This prompt prefers model \`${fm.model}\` — informational only in OpenCode.`,
    )
  }

  if (fm.tools && fm.tools.length > 0) {
    const toolList = fm.tools.map((t) => `\`${t}\``).join(", ")
    notes.push(
      `> **Note:** This prompt specifies tools [${toolList}] — informational only in OpenCode.`,
    )
  }

  return notes
}

/**
 * Parses a raw argument string from `command.execute.before` into a key/value map.
 *
 * The arguments string can be in one of two forms:
 * - `key=value key2=value2` — space-separated key=value pairs
 * - A bare string — treated as positional input, mapped to the first argument's id
 *
 * If the string is empty or contains no `=` signs and the prompt has no
 * arguments, returns an empty map.
 */
export function parseCommandArguments(
  rawArguments: string,
  promptArgs: CopilotPrompt["arguments"],
): Record<string, string> {
  const result: Record<string, string> = {}

  if (!rawArguments.trim()) return result

  const hasKeyValue = rawArguments.includes("=")

  if (hasKeyValue) {
    // Parse space-separated key=value pairs, supporting quoted values
    const kvPattern = /([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/g
    let match: RegExpExecArray | null
    while ((match = kvPattern.exec(rawArguments)) !== null) {
      const key = match[1]!
      let value = match[2]!
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1).replace(/\\(.)/g, "$1")
      }
      result[key] = value
    }
  } else if (promptArgs.length > 0) {
    // Treat the whole string as the first positional argument
    const firstArg = promptArgs[0]
    if (firstArg) {
      result[firstArg.id] = rawArguments.trim()
    }
  }

  return result
}
