/**
 * Raw frontmatter fields from a Copilot `.prompt.md` file.
 * All fields are optional — a prompt file with no frontmatter is still valid.
 */
export interface CopilotPromptFrontmatter {
  description?: string
  name?: string
  "argument-hint"?: string
  /** The agent context to use: "ask", "agent", "plan", or a custom agent name. */
  agent?: string
  /** The preferred language model. Informational in OpenCode. */
  model?: string
  /** Tool names available for this prompt. Informational in OpenCode. */
  tools?: string[]
}

/**
 * A single argument placeholder extracted from a prompt file body.
 *
 * Supports two syntaxes:
 * - `${input:varName}` or `${input:varName:placeholder text}` — VS Code style
 * - `$VAR_NAME` — Copilot/Crush style (uppercase with underscores)
 */
export interface PromptArgument {
  /** The variable name used to identify and substitute this argument. */
  id: string
  /** Optional placeholder hint shown to the user when prompting for input. */
  placeholder?: string
}

/**
 * A fully parsed and validated Copilot prompt file.
 *
 * - `scope: "local"`  — from `<rootDir>/.github/prompts/`
 * - `scope: "global"` — from `~/.copilot/prompts/`
 */
export interface CopilotPrompt {
  /** Canonical name derived from filename (minus `.prompt.md`). Used as the command name. */
  name: string
  /**
   * Short description. Sourced from the `description` frontmatter field.
   * Falls back to the canonical name if no description is provided.
   */
  description: string
  /** Whether this prompt came from the project or the user-global directory. */
  scope: "local" | "global"
  /** Absolute path to the parent directory (`.github/prompts/` or `~/.copilot/prompts/`). */
  dirPath: string
  /** Absolute path to the `.prompt.md` file. */
  filePath: string
  /** Raw markdown body (everything after frontmatter), trimmed. File references are unresolved. */
  content: string
  /** Parsed frontmatter. */
  frontmatter: CopilotPromptFrontmatter
  /** Argument placeholders extracted from the prompt body, in order of first appearance. */
  arguments: PromptArgument[]
}
