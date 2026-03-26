import * as os from "node:os"
import { tool } from "@opencode-ai/plugin"
import type { AgentTracker } from "./agents/agent-tracker.ts"
import type { CopilotAgent, CopilotHandoffDef } from "./agents/types.ts"

const home = os.homedir()

function toDisplayPath(filePath: string): string {
  return filePath.startsWith(home) ? filePath.replace(home, "~") : filePath
}

/**
 * Builds the XML-style `<available_copilot_agents>` block embedded in the tool description.
 * Lists all agents; non-user-invocable agents are annotated with `<role>subagent-only</role>`.
 *
 * Called at init and refreshed via `tool.definition` after hot-reloads.
 */
export function buildAgentToolDescription(agents: readonly CopilotAgent[]): string {
  if (agents.length === 0) {
    return "Load a Copilot custom agent by name. No Copilot agents are currently available."
  }

  const entries = agents
    .map((a) => {
      const hint = a.frontmatter["argument-hint"]
      const lines = [
        `  <agent>`,
        `    <name>${a.name}</name>`,
        `    <description>${a.description}</description>`,
        `    <scope>${a.scope}</scope>`,
        `    <location>${toDisplayPath(a.filePath)}</location>`,
      ]
      if (hint) lines.push(`    <argument-hint>${hint}</argument-hint>`)
      if (!a.userInvocable) lines.push(`    <role>subagent-only</role>`)
      lines.push(`  </agent>`)
      return lines.join("\n")
    })
    .join("\n")

  return [
    "Load a Copilot custom agent that adopts a specialized persona, tool set, and instructions.",
    "",
    "When the user's task matches one of the available agents listed below, use this tool",
    "to load the agent's instructions and configuration into the current session.",
    "",
    "<available_copilot_agents>",
    entries,
    "</available_copilot_agents>",
  ].join("\n")
}

/**
 * Builds the body content returned when an agent is loaded.
 * Wraps the markdown body in `<agent_content>` and appends informational sections
 * for tools, model, subagents, and handoffs sourced from the frontmatter.
 */
function buildAgentContent(agent: CopilotAgent): string {
  const location = toDisplayPath(agent.filePath)
  const fm = agent.frontmatter

  const sections: string[] = []

  if (agent.content) {
    sections.push(agent.content)
  }

  const configLines: string[] = []

  const toolList = resolveToolList(fm.tools)
  if (toolList.length > 0) {
    configLines.push(`- **Available tools**: ${toolList.join(", ")}`)
  }

  const modelList = resolveModelList(fm.model)
  if (modelList.length > 0) {
    configLines.push(
      `- **Model preference**: ${modelList.join(", ")} ` +
        `(note: OpenCode uses the model from the model picker, not agent-specified models)`,
    )
  }

  const subagentList = resolveSubagentList(fm.agents)
  if (subagentList !== null) {
    configLines.push(`- **Subagents allowed**: ${subagentList}`)
  }

  if (!agent.userInvocable) {
    configLines.push(`- **User-invocable**: false (this agent is intended as a subagent only)`)
  }

  if (configLines.length > 0) {
    sections.push(`## Agent Configuration\n\n${configLines.join("\n")}`)
  }

  const handoffText = buildHandoffsSection(fm.handoffs)
  if (handoffText) {
    sections.push(handoffText)
  }

  const body = sections.join("\n\n")

  return [
    `<agent_content name="${agent.name}" scope="${agent.scope}" location="${location}">`,
    body,
    `</agent_content>`,
  ].join("\n")
}

function resolveToolList(tools: CopilotAgent["frontmatter"]["tools"]): string[] {
  if (!tools) return []
  return tools
}

function resolveModelList(model: CopilotAgent["frontmatter"]["model"]): string[] {
  if (!model) return []
  if (typeof model === "string") return [model]
  return model
}

function resolveSubagentList(agents: CopilotAgent["frontmatter"]["agents"]): string | null {
  if (agents === undefined) return null
  if (agents === "*") return "all agents"
  if (agents === "[]" || (Array.isArray(agents) && agents.length === 0)) return "none"
  if (Array.isArray(agents)) return agents.join(", ")
  return null
}

function buildHandoffsSection(handoffs: CopilotHandoffDef[] | undefined): string | null {
  if (!handoffs?.length) return null

  const items = handoffs
    .map((h) => {
      const parts = [`**${h.label}** → Switch to \`${h.agent}\` agent`]
      if (h.prompt) parts.push(`: "${h.prompt}"`)
      if (h.model) parts.push(` (model: ${h.model})`)
      if (h.send) parts.push(` *(auto-submits)*`)
      return `- ${parts.join("")}`
    })
    .join("\n")

  return `## Suggested Next Steps\n\n${items}`
}

/**
 * Creates the `copilot_agent` tool definition.
 *
 * `getAgents` is called on each execution so that hot-reloaded agent lists are
 * always current. The `agentTracker` is updated when an agent is loaded so that
 * agent-scoped hooks can be dispatched for the right session.
 */
export function createCopilotAgentTool(
  getAgents: () => readonly CopilotAgent[],
  agentTracker: AgentTracker,
) {
  return tool({
    description: buildAgentToolDescription(getAgents()),
    args: {
      name: tool.schema
        .string()
        .describe('The name of the Copilot agent to load (e.g. "planner", "security-reviewer")'),
      sessionID: tool.schema
        .string()
        .optional()
        .describe("The current session ID, used to track the active agent for scoped hooks"),
    },
    async execute({ name, sessionID }) {
      const agents = getAgents()
      const agent = agents.find((a) => a.name === name)

      if (!agent) {
        const available = agents
          .filter((a) => a.userInvocable)
          .map((a) => `"${a.name}"`)
          .join(", ")
        return `Copilot agent "${name}" not found. Available agents: ${available || "none"}.`
      }

      if (sessionID) {
        agentTracker.setActiveAgent(sessionID, agent.name)
      }

      return buildAgentContent(agent)
    },
  })
}
