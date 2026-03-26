export type CopilotHookType =
  | "sessionStart"
  | "sessionEnd"
  | "userPromptSubmitted"
  | "preToolUse"
  | "postToolUse"
  | "agentStop"
  | "subagentStop"
  | "errorOccurred"

export interface HookCommandDef {
  type: "command"
  bash?: string
  powershell?: string
  cwd?: string
  env?: Record<string, string>
  timeoutSec?: number
  comment?: string
}

export interface HookConfigFile {
  version: number
  hooks: Partial<Record<CopilotHookType, HookCommandDef[]>>
}

/** Merged registry of all discovered hooks. Arrays contain project hooks first, then global. */
export type HookRegistry = Partial<Record<CopilotHookType, HookCommandDef[]>>
