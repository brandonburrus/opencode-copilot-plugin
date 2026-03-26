import * as os from "node:os"
import { tool } from "@opencode-ai/plugin"
import type { CopilotSkill } from "./skills.ts"

const home = os.homedir()

/**
 * Converts an absolute file path to a `~`-prefixed display path when it lives under
 * the user's home directory, for cleaner output in tool descriptions and responses.
 */
function toDisplayPath(filePath: string): string {
  return filePath.startsWith(home) ? filePath.replace(home, "~") : filePath
}

/**
 * Builds the XML-style `<available_copilot_skills>` block that is embedded in the
 * tool description. Mirrors the format OpenCode uses for its native `skill` tool so
 * the LLM can apply the same decision-making heuristics to both.
 *
 * Called at init and refreshed before each LLM call via the `tool.definition` hook,
 * so the listing stays accurate after hot-reloads.
 */
export function buildSkillToolDescription(skills: readonly CopilotSkill[]): string {
  if (skills.length === 0) {
    return "Load a Copilot skill by name. No Copilot skills are currently available."
  }

  const entries = skills
    .map((s) =>
      [
        `  <skill>`,
        `    <name>${s.name}</name>`,
        `    <description>${s.description}</description>`,
        `    <scope>${s.scope}</scope>`,
        `    <location>${toDisplayPath(s.filePath)}</location>`,
        `  </skill>`,
      ].join("\n"),
    )
    .join("\n")

  return [
    "Load a Copilot skill that provides domain-specific instructions and workflows.",
    "",
    "When you recognize that a task matches one of the available Copilot skills listed",
    "below, use this tool to load the full skill instructions into context.",
    "",
    "<available_copilot_skills>",
    entries,
    "</available_copilot_skills>",
  ].join("\n")
}

/**
 * Creates the `copilot_skill` tool definition.
 *
 * `getSkills` is a getter called on every invocation so that skill list hot-reloads
 * (triggered by file watcher events in `index.ts`) are always reflected at execution
 * time without needing to recreate the tool.
 *
 * The returned content is wrapped in a `<skill_content>` tag that mirrors the format
 * used by OpenCode's native `skill` tool, giving the LLM consistent context signals.
 */
export function createCopilotSkillTool(getSkills: () => readonly CopilotSkill[]) {
  return tool({
    description: buildSkillToolDescription(getSkills()),
    args: {
      name: tool.schema
        .string()
        .describe(
          'The name of the Copilot skill to load (e.g. "deploy-checklist", "coding-standards")',
        ),
    },
    async execute({ name }) {
      const skills = getSkills()
      const skill = skills.find((s) => s.name === name)

      if (!skill) {
        const available = skills.map((s) => `"${s.name}"`).join(", ")
        return `Copilot skill "${name}" not found. Available skills: ${available || "none"}.`
      }

      const location = toDisplayPath(skill.filePath)
      return [
        `<skill_content name="${skill.name}" scope="${skill.scope}" location="${location}">`,
        skill.content,
        `</skill_content>`,
      ].join("\n")
    },
  })
}
