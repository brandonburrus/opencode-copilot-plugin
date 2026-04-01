import { tool } from "@opencode-ai/plugin"
import { buildInspectReport } from "./inspect.ts"
import type { Instruction, PathSpecificInstruction } from "./instructions.ts"
import type { CopilotSkill } from "./skills.ts"
import type { CopilotAgent } from "./agents/types.ts"
import type { CopilotPrompt } from "./prompts/types.ts"
import type { HookRegistry } from "./hooks/types.ts"
import type { FileTracker } from "./file-tracker.ts"
import type { AgentTracker } from "./agents/agent-tracker.ts"

interface CopilotInspectToolOptions {
  getProjectInstructions: () => readonly Instruction[]
  getGlobalInstructions: () => readonly PathSpecificInstruction[]
  getSkills: () => readonly CopilotSkill[]
  getAgents: () => readonly CopilotAgent[]
  getPrompts: () => readonly CopilotPrompt[]
  getHookRegistry: () => HookRegistry
  tracker: FileTracker
  agentTracker: AgentTracker
}

/**
 * Creates the `copilot_inspect` tool definition.
 *
 * Returns a markdown report of all loaded plugin state for the current session:
 * instructions (with active/inactive status), skills, agents, prompts, hooks,
 * and session state (active agent + tracked file paths).
 */
export function createCopilotInspectTool(opts: CopilotInspectToolOptions) {
  return tool({
    description:
      "Generate a report of all loaded Copilot plugin state for the current session — instructions (active/inactive), skills, agents, prompts, hooks, and tracked files.",
    args: {
      sessionID: tool.schema
        .string()
        .optional()
        .describe("The current session ID, used to look up session-specific state (tracked files, active agent)"),
    },
    async execute({ sessionID }) {
      const trackedFiles = sessionID ? opts.tracker.getTrackedFiles(sessionID) : new Set<string>()
      const activeAgent = sessionID ? opts.agentTracker.getActiveAgent(sessionID) : undefined

      return buildInspectReport({
        projectInstructions: [...opts.getProjectInstructions()],
        globalInstructions: [...opts.getGlobalInstructions()],
        allSkills: [...opts.getSkills()],
        allAgents: [...opts.getAgents()],
        allPrompts: [...opts.getPrompts()],
        hookRegistry: opts.getHookRegistry(),
        trackedFiles,
        activeAgent,
      })
    },
  })
}
