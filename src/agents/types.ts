import type { HookRegistry } from "../hooks/types.ts"

/**
 * Raw frontmatter fields from a Copilot `.agent.md` file.
 * All fields are optional except `description`, which is required for a valid agent.
 */
export interface CopilotAgentFrontmatter {
  description?: string
  name?: string
  "argument-hint"?: string
  tools?: string[]
  agents?: string[] | "*" | "[]"
  model?: string | string[]
  "user-invocable"?: boolean
  "disable-model-invocation"?: boolean
  /** Deprecated. Use `user-invocable` and `disable-model-invocation` instead. */
  infer?: boolean
  target?: string
  "mcp-servers"?: unknown[]
  handoffs?: CopilotHandoffDef[]
  hooks?: Record<string, AgentHookCommandDef[]>
}

/** A single handoff button definition in the agent frontmatter. */
export interface CopilotHandoffDef {
  label: string
  agent: string
  prompt?: string
  send?: boolean
  model?: string
}

/**
 * A hook command in agent-scoped frontmatter hooks.
 * Accepts both `command` (Copilot agent format) and `bash` (standard hook format).
 */
export interface AgentHookCommandDef {
  type: "command"
  /** Copilot agent-scoped hook field. Takes precedence over `bash` if both are present. */
  command?: string
  /** Standard hook file field. Used when `command` is absent. */
  bash?: string
  cwd?: string
  env?: Record<string, string>
  timeoutSec?: number
}

/**
 * A fully parsed and validated Copilot custom agent.
 *
 * - `scope: "local"`  — from `<rootDir>/.github/agents/`
 * - `scope: "global"` — from `~/.copilot/agents/`
 */
export interface CopilotAgent {
  /** Canonical name — derived from the filename (without `.agent.md` or `.md` extension). */
  name: string
  /** Short description from the `description` frontmatter field. Shown in the tool listing. */
  description: string
  /** Whether the agent came from the project root or the user-global directory. */
  scope: "local" | "global"
  /** Absolute path to the agent file's parent directory. */
  dirPath: string
  /** Absolute path to the agent file. */
  filePath: string
  /** Body content of the agent file (everything after frontmatter), trimmed. */
  content: string
  /** The raw parsed frontmatter. */
  frontmatter: CopilotAgentFrontmatter
  /**
   * Normalized hook registry from agent-scoped `hooks` frontmatter.
   * PascalCase keys are converted to camelCase; `command` field is mapped to `bash`.
   */
  hooks: HookRegistry
  /**
   * Whether this agent should appear in the `copilot_agent` tool listing.
   * Resolved from `user-invocable` (or deprecated `infer`) frontmatter, defaulting to `true`.
   */
  userInvocable: boolean
}
