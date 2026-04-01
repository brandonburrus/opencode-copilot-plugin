import * as os from "node:os"
import { tool } from "@opencode-ai/plugin"
import type { CopilotPrompt } from "./prompts/types.ts"
import {
  resolveFileReferences,
  substituteArguments,
  formatPromptHeader,
} from "./prompts/index.ts"

const home = os.homedir()

function toDisplayPath(filePath: string): string {
  return filePath.startsWith(home) ? filePath.replace(home, "~") : filePath
}

/**
 * Builds the XML-style `<available_copilot_prompts>` block embedded in the tool description.
 * Includes argument declarations when a prompt exposes placeholders.
 *
 * Called at init and refreshed via `tool.definition` after hot-reloads.
 */
export function buildPromptToolDescription(prompts: readonly CopilotPrompt[]): string {
  if (prompts.length === 0) {
    return "Load a Copilot prompt by name. No Copilot prompts are currently available."
  }

  const entries = prompts
    .map((p) => {
      const lines = [
        `  <prompt>`,
        `    <name>${p.name}</name>`,
        `    <description>${p.description}</description>`,
        `    <scope>${p.scope}</scope>`,
        `    <location>${toDisplayPath(p.filePath)}</location>`,
      ]

      if (p.arguments.length > 0) {
        lines.push(`    <arguments>`)
        for (const arg of p.arguments) {
          const placeholder = arg.placeholder ? ` placeholder="${arg.placeholder}"` : ""
          lines.push(`      <argument id="${arg.id}"${placeholder}/>`)
        }
        lines.push(`    </arguments>`)
      }

      lines.push(`  </prompt>`)
      return lines.join("\n")
    })
    .join("\n")

  return [
    "Load a Copilot prompt file by name, resolving file references and substituting arguments.",
    "",
    "When no name is provided, returns a list of all available prompts.",
    "When a name is provided, resolves and returns the fully prepared prompt content.",
    "",
    "<available_copilot_prompts>",
    entries,
    "</available_copilot_prompts>",
  ].join("\n")
}

/**
 * Creates the `copilot_prompt` tool definition.
 *
 * `getPrompts` is called on each execution so that hot-reloaded prompt lists are
 * always current. When a name is provided, file references are resolved and
 * argument placeholders are substituted before returning the content.
 */
export function createCopilotPromptTool(getPrompts: () => readonly CopilotPrompt[]) {
  return tool({
    description: buildPromptToolDescription(getPrompts()),
    args: {
      name: tool.schema
        .string()
        .optional()
        .describe(
          'The prompt name to load (e.g. "code-review", "write-tests"). Omit to list all available prompts.',
        ),
      arguments: tool.schema
        .record(tool.schema.string(), tool.schema.string())
        .optional()
        .describe(
          "Key/value pairs mapping argument IDs to their values. Only relevant when a name is provided.",
        ),
    },
    async execute({ name, arguments: argValues }) {
      const prompts = getPrompts()

      if (!name) {
        return buildPromptListing(prompts)
      }

      const prompt = prompts.find((p) => p.name === name)

      if (!prompt) {
        const available = prompts.map((p) => `"${p.name}"`).join(", ")
        return `Copilot prompt "${name}" not found. Available prompts: ${available || "none"}.`
      }

      const resolvedContent = await resolveFileReferences(prompt.content, prompt.dirPath)

      const substitutedArgs = buildArgValues(prompt, argValues)
      const substitutedContent = substituteArguments(resolvedContent, prompt.arguments, substitutedArgs)

      const header = formatPromptHeader(prompt)
      const location = toDisplayPath(prompt.filePath)

      return [
        `<prompt_content name="${prompt.name}" scope="${prompt.scope}" location="${location}">`,
        header + substitutedContent,
        `</prompt_content>`,
      ].join("\n")
    },
  })
}

function buildPromptListing(prompts: readonly CopilotPrompt[]): string {
  if (prompts.length === 0) {
    return "No Copilot prompts are currently available."
  }

  const lines = ["Available Copilot prompts:", ""]

  for (const p of prompts) {
    lines.push(`- ${p.name}: ${p.description} [scope: ${p.scope}]`)
    if (p.arguments.length > 0) {
      const argList = p.arguments
        .map((a) => (a.placeholder ? `${a.id} (${a.placeholder})` : a.id))
        .join(", ")
      lines.push(`  Arguments: ${argList}`)
    }
  }

  return lines.join("\n")
}

function buildArgValues(
  prompt: CopilotPrompt,
  provided: Record<string, string> | undefined,
): Record<string, string> {
  if (!provided || prompt.arguments.length === 0) return {}

  const result: Record<string, string> = {}
  for (const arg of prompt.arguments) {
    const value = provided[arg.id]
    if (value !== undefined) {
      result[arg.id] = value
    }
  }
  return result
}
