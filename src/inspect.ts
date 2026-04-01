import * as os from "node:os"
import type { Instruction, PathSpecificInstruction } from "./instructions.ts"
import type { CopilotSkill } from "./skills.ts"
import type { CopilotAgent } from "./agents/types.ts"
import type { CopilotPrompt } from "./prompts/types.ts"
import type { HookRegistry, HookCommandDef } from "./hooks/types.ts"
import { matchesApplyTo } from "./glob-matcher.ts"

const HOME_DIR = os.homedir()

function toDisplayPath(filePath: string): string {
  return filePath.startsWith(HOME_DIR) ? `~${filePath.slice(HOME_DIR.length)}` : filePath
}

function buildInstructionsSection(
  projectInstructions: Instruction[],
  globalInstructions: PathSpecificInstruction[],
  trackedFiles: ReadonlySet<string>,
): string {
  const lines: string[] = ["## Instructions\n"]
  const all: Instruction[] = [...projectInstructions, ...globalInstructions]

  if (all.length === 0) {
    lines.push("(none)")
    return lines.join("\n")
  }

  for (const instruction of all) {
    const displayPath = toDisplayPath(instruction.filePath)
    const scope = instruction.type === "repo-wide" ? "project" : instruction.scope

    const isActive =
      instruction.type === "repo-wide" || matchesApplyTo(trackedFiles, instruction.applyTo)
    const status = isActive ? "**Active**" : "**Inactive**"

    lines.push(`### ${displayPath}`)
    lines.push(`- Type: ${instruction.type}`)
    lines.push(`- Scope: ${scope}`)

    if (instruction.type === "path-specific") {
      lines.push(`- Apply To: ${instruction.applyTo.join(", ")}`)
    }

    lines.push(`- Status: ${status}`)
    lines.push("")
  }

  return lines.join("\n")
}

function buildSkillsSection(allSkills: CopilotSkill[]): string {
  const lines: string[] = ["## Skills\n"]

  if (allSkills.length === 0) {
    lines.push("(none)")
    return lines.join("\n")
  }

  for (const skill of allSkills) {
    lines.push(`### ${skill.name}`)
    lines.push(`- Scope: ${skill.scope}`)
    lines.push(`- Path: ${toDisplayPath(skill.filePath)}`)
    lines.push(`- Description: ${skill.description}`)
    lines.push("")
  }

  return lines.join("\n")
}

function buildAgentsSection(allAgents: CopilotAgent[], activeAgent: string | undefined): string {
  const lines: string[] = ["## Agents\n"]

  if (allAgents.length === 0) {
    lines.push("(none)")
    return lines.join("\n")
  }

  for (const agent of allAgents) {
    const activeMarker = agent.name === activeAgent ? " (active)" : ""
    lines.push(`### ${agent.name}${activeMarker}`)
    lines.push(`- Scope: ${agent.scope}`)
    lines.push(`- Path: ${toDisplayPath(agent.filePath)}`)
    lines.push(`- Description: ${agent.description}`)
    lines.push(`- User Invocable: ${agent.userInvocable}`)
    lines.push("")
  }

  return lines.join("\n")
}

function buildPromptsSection(allPrompts: CopilotPrompt[]): string {
  const lines: string[] = ["## Prompts\n"]

  if (allPrompts.length === 0) {
    lines.push("(none)")
    return lines.join("\n")
  }

  for (const prompt of allPrompts) {
    lines.push(`### ${prompt.name}`)
    lines.push(`- Scope: ${prompt.scope}`)
    lines.push(`- Path: ${toDisplayPath(prompt.filePath)}`)
    lines.push(`- Description: ${prompt.description}`)
    lines.push("")
  }

  return lines.join("\n")
}

function formatHookCommand(cmd: HookCommandDef): string {
  const command = cmd.bash ?? cmd.powershell ?? "(no command)"
  const parts: string[] = [`  - \`${command}\``]
  if (cmd.timeoutSec !== undefined) {
    parts.push(`(timeout: ${cmd.timeoutSec}s)`)
  }
  if (cmd.comment) {
    parts.push(`— ${cmd.comment}`)
  }
  return parts.join(" ")
}

function buildHooksSection(hookRegistry: HookRegistry): string {
  const lines: string[] = ["## Hooks\n"]
  const hookTypes = Object.keys(hookRegistry) as Array<keyof HookRegistry>

  if (hookTypes.length === 0) {
    lines.push("(none)")
    return lines.join("\n")
  }

  for (const hookType of hookTypes) {
    const commands = hookRegistry[hookType]
    if (!commands?.length) continue

    lines.push(`### ${hookType}`)
    for (const cmd of commands) {
      lines.push(formatHookCommand(cmd))
    }
    lines.push("")
  }

  return lines.join("\n")
}

const TRACKED_FILES_DISPLAY_LIMIT = 20

function buildSessionStateSection(
  trackedFiles: ReadonlySet<string>,
  activeAgent: string | undefined,
): string {
  const lines: string[] = ["## Session State\n"]
  lines.push(`- Active Agent: ${activeAgent ?? "(none)"}`)
  lines.push(`- Tracked Files: ${trackedFiles.size}`)

  if (trackedFiles.size > 0) {
    const paths = Array.from(trackedFiles)
    const shown = paths.slice(0, TRACKED_FILES_DISPLAY_LIMIT)
    for (const p of shown) {
      lines.push(`  - ${p}`)
    }
    if (paths.length > TRACKED_FILES_DISPLAY_LIMIT) {
      lines.push(`  - ... and ${paths.length - TRACKED_FILES_DISPLAY_LIMIT} more`)
    }
  }

  return lines.join("\n")
}

/**
 * Builds a markdown report of everything the plugin has loaded for the current session.
 *
 * Includes: active/inactive instructions, skills, agents, prompts, hooks, and session state
 * (active agent + tracked file paths). Intended for use by a /copilot-inspect command.
 */
export function buildInspectReport(opts: {
  projectInstructions: Instruction[]
  globalInstructions: PathSpecificInstruction[]
  allSkills: CopilotSkill[]
  allAgents: CopilotAgent[]
  allPrompts: CopilotPrompt[]
  hookRegistry: HookRegistry
  trackedFiles: ReadonlySet<string>
  activeAgent: string | undefined
}): string {
  const sections = [
    `# Copilot Plugin Inspect Report\n`,
    buildInstructionsSection(opts.projectInstructions, opts.globalInstructions, opts.trackedFiles),
    buildSkillsSection(opts.allSkills),
    buildAgentsSection(opts.allAgents, opts.activeAgent),
    buildPromptsSection(opts.allPrompts),
    buildHooksSection(opts.hookRegistry),
    buildSessionStateSection(opts.trackedFiles, opts.activeAgent),
  ]

  return sections.join("\n")
}
