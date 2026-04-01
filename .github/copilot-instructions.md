This is **opencode-copilot-plugin** — a TypeScript/Bun OpenCode plugin that mirrors GitHub Copilot's custom instruction, prompt, skill, agent, and hook file system into OpenCode sessions.

## Project layout

```
index.ts              Plugin entry point — wires hooks, manages caches, registers tools
src/
  vscode-paths.ts     Resolves VS Code user data directories (macOS + Linux, stable + Insiders)
  instructions.ts     Discovers & parses .github/copilot-instructions.md and *.instructions.md files
  format.ts           Formats a parsed Instruction into a system-prompt string
  glob-matcher.ts     applyTo glob matching via picomatch
  file-tracker.ts     Per-session file access tracker with FIFO eviction (max 500 paths)
  inspect.ts          Builds the /copilot-inspect report (loaded items + session state)
  prompts/
    index.ts              Barrel re-export for the prompts subsystem
    types.ts              CopilotPrompt, CopilotPromptFrontmatter, PromptArgument types
    discovery.ts          Discovers & parses *.prompt.md from .github/prompts/, ~/.copilot/prompts/, and VS Code user data prompts/; extractArguments, substituteArguments
    resolve-references.ts Resolves markdown file references ([file.md](../path)) and inlines them as <referenced_file> XML blocks
    format.ts             formatPromptHeader (informational header with unsupported-field notes), parseCommandArguments
  skills.ts           Discovers & parses SKILL.md files from .github/skills/ and ~/.copilot/skills/
  skill-tool.ts       Builds the copilot_skill tool definition and its XML description block
  agents/
    index.ts              Barrel re-export for the agents subsystem
    types.ts              CopilotAgent, CopilotAgentFrontmatter, CopilotHandoffDef, AgentHookCommandDef types
    discovery.ts          Discovers & parses *.agent.md / *.md from .github/agents/, ~/.copilot/agents/, and VS Code user data agents/
    agent-tracker.ts      Per-session tracker: active agent name
  agent-tool.ts       Builds the copilot_agent tool definition and its XML description block
  hooks/
    index.ts              Barrel re-export for the hooks subsystem
    types.ts              CopilotHookType, HookCommandDef, HookConfigFile, HookRegistry types
    discovery.ts          Discovers & parses *.json hook configs from .github/hooks/, ~/.copilot/hooks/, and VS Code user data hooks/
    executor.ts           Executes hook commands by piping JSON to stdin; handles timeouts
    confirmation-tracker.ts  Tracks "ask" decisions from preToolUse hooks for one-shot bypass
    tool-names.ts         Maps OpenCode tool names to Copilot-equivalent names
dist/                 Build output (Bun bundler, node target)
```

## Runtime model

The plugin is a single async factory (`CopilotInstructionsPlugin`) that returns an OpenCode `Hooks` object. Seven hooks are registered:

- `experimental.chat.system.transform` — injects instructions into the system prompt before each LLM call. Repo-wide instructions are always appended; path-specific instructions only when the session's tracked files match their `applyTo` patterns.
- `tool.execute.before` — runs global `preToolUse` Copilot hooks before each tool call, blocking execution when a hook returns `"deny"` or `"ask"`. If a session has an active agent, agent-scoped `preToolUse` hooks run afterward.
- `tool.execute.after` — tracks every file path accessed via `read`, `edit`, `write`, or `patch` tools for the current session. Also dispatches `postToolUse` hooks (global then agent-scoped).
- `tool.definition` — keeps the `copilot_skill` and `copilot_agent` tool descriptions current (lists can hot-reload).
- `chat.message` — dispatches `userPromptSubmitted` hooks (global then agent-scoped) when a new user message is received.
- `command.execute.before` — intercepts slash command execution; `/copilot-inspect` is a built-in command that returns a report of all loaded items and current session state (see below). For all other commands, when the name matches a known prompt, resolves markdown file references, substitutes argument placeholders, prepends an informational header, and replaces `output.parts` with the fully resolved prompt content.
- `event` — handles `file.watcher.updated` for hot-reloading instruction/prompt/skill/agent caches independently; dispatches session lifecycle hooks (`sessionStart`, `sessionEnd`, `agentStop`, `errorOccurred`); frees per-session tracker memory on `session.deleted`.

The `copilot_skill` tool is only registered when at least one skill exists at startup. The `copilot_agent` tool is only registered when at least one agent exists at startup. Items added after init require an OpenCode restart.

Hook files are loaded once at plugin init and are not hot-reloaded. Changes to hook files require an OpenCode restart.

## File conventions

| What | Path |
|---|---|
| Repo-wide instructions | `.github/copilot-instructions.md` |
| Project path-specific instructions | `.github/instructions/**/*.instructions.md` |
| Global path-specific instructions (primary) | `~/.copilot/instructions/**/*.instructions.md` |
| Global path-specific instructions (secondary) | `<vsCodeUserData>/instructions/**/*.instructions.md` |
| Project-local prompts | `.github/prompts/*.prompt.md` |
| User-global prompts (primary) | `~/.copilot/prompts/*.prompt.md` |
| User-global prompts (secondary) | `<vsCodeUserData>/prompts/*.prompt.md` |
| Project-local skills | `.github/skills/<name>/SKILL.md` |
| User-global skills (primary) | `~/.copilot/skills/<name>/SKILL.md` |
| User-global skills (secondary) | `<vsCodeUserData>/skills/<name>/SKILL.md` |
| Project-local agents | `.github/agents/*.agent.md` or `*.md` |
| User-global agents (primary) | `~/.copilot/agents/*.agent.md` or `*.md` |
| User-global agents (secondary) | `<vsCodeUserData>/agents/*.agent.md` or `*.md` |
| Project-local hooks | `.github/hooks/*.json` |
| User-global hooks (primary) | `~/.copilot/hooks/*.json` |
| User-global hooks (secondary) | `<vsCodeUserData>/hooks/*.json` |

`<vsCodeUserData>` resolves to the VS Code user data directory for the current platform:
- macOS: `~/Library/Application Support/Code/User` and `~/Library/Application Support/Code - Insiders/User`
- Linux: `~/.config/Code/User` and `~/.config/Code - Insiders/User`

Both VS Code stable and Insiders are checked. Only directories that exist on disk are scanned.

Path-specific instruction files require an `applyTo` frontmatter field (comma-separated glob patterns). Skill `SKILL.md` files require a `description` frontmatter field. Agent files require a `description` frontmatter field.

Hook config files must have `"version": 1` at the root and a `"hooks"` object mapping hook type names to arrays of command definitions. Each command definition must have `"type": "command"` and at least one of `"bash"` or `"powershell"`.

Agent files use `.agent.md` extension (or plain `.md` in the agents directory). The canonical agent name is derived from the filename (minus `.agent.md` or `.md` extension). Agents with `target: "github-copilot"` are skipped — they are cloud-only agents.

Prompt files use the `.prompt.md` extension. The canonical prompt name is derived from the filename (minus `.prompt.md`). All frontmatter fields are optional — a prompt file with no frontmatter is valid. The `description` field falls back to the canonical name when absent.

## Key invariants

- Local skills shadow global skills of the same name (warning written to stderr).
- Local agents shadow global agents of the same name (warning written to stderr).
- Local prompts shadow global prompts of the same name (warning written to stderr).
- For skills, agents, and prompts: `~/.copilot/` items shadow same-named VS Code user data items (warning written to stderr). The full precedence order is: project-local > `~/.copilot/` > VS Code user data.
- For hooks: execution order per hook type is project hooks → `~/.copilot/` hooks → VS Code user data hooks.
- `getVSCodeUserDataDirs()` in `src/vscode-paths.ts` resolves VS Code user data base directories. Only directories that exist on disk are returned. Unsupported platforms (Windows) return an empty array.
- `FileTracker` stores paths relative to the project root so they can be matched directly against `applyTo` patterns without prefix stripping.
- All caches (`projectInstructions`, `globalInstructions`, `localSkills`, `globalSkills`, `localAgents`, `globalAgents`, `localPrompts`, `globalPrompts`) are module-level `let` bindings in the plugin factory — replaced atomically on hot-reload.
- The plugin never throws; missing directories and unreadable files are silently skipped.
- Project hooks run before global hooks for each hook type.
- Agent-scoped hooks run after global hooks of the same type.
- `HookConfirmationTracker` enables one-shot bypass of a specific `preToolUse` hook that returned `"ask"`. Hook keys are namespaced: `"global:<index>"` for global hooks, `"agent:<name>:<index>"` for agent-scoped hooks.
- Only `bash` commands are supported for hooks on macOS/Linux. PowerShell-only hook definitions are silently skipped.
- Hook execution is bounded by `timeoutSec` (default 30 seconds). A timeout in one hook does not prevent subsequent hooks from running.
- OpenCode tool names are mapped to Copilot-equivalent names before being passed to hooks (`read` → `view`, `write` → `create`) so existing Copilot hook scripts work unmodified.
- Agent canonical name is derived from the filename (minus `.agent.md` or `.md` extension), not a directory name.
- Agent-scoped hooks in frontmatter use PascalCase keys (`PostToolUse`) which are normalized to camelCase (`postToolUse`) internally. The `command` field (Copilot agent format) is mapped to `bash`; both are accepted with `command` taking precedence.
- `AgentTracker` stores the active agent name per session. Only one agent can be active per session at a time; loading a new agent replaces the previous one.
- The `copilot_agent` tool returns agent content wrapped in `<agent_content>` XML tags, including the markdown body plus informational sections for tools, model, subagents, and handoffs.
- Agents with `user-invocable: false` (or deprecated `infer: false`) are excluded from the `copilot_agent` tool listing but can still be loaded by name if explicitly requested.
- Prompt canonical name is derived from the filename (minus `.prompt.md`). If a `name` frontmatter field is present but differs from the filename-derived name, a warning is emitted and the filename-derived name is used.
- Prompt discovery is flat (non-recursive) — only files directly inside the prompts directory are scanned.
- `resolveFileReferences` resolves markdown link syntax (`[label](./relative/path.md)`) by reading the referenced file and inlining it as a `<referenced_file path="...">` XML block. Resolution is capped at 100 KB total and 5 levels deep; circular references are detected and skipped.
- Prompt argument substitution supports two syntaxes: VS Code style `${input:varName}` / `${input:varName:placeholder}` and Copilot/Crush style `$VAR_NAME` (uppercase with underscores). Unmatched placeholders are left as-is.
- `parseCommandArguments` handles both `key=value` pairs (with quoted-value support) and positional strings (mapped to the first declared argument).
- The `command.execute.before` hook matches commands by their base name (scope prefix and `:` path separators stripped). Unsupported frontmatter fields (`agent`, `model`, `tools`) are surfaced as informational notes in the prepended header but are not enforced.
- Instructions with `applyTo` pattern `**` or `**/*` are treated as universally applicable and injected on every LLM turn regardless of whether any files have been tracked in the session.
- `/copilot-inspect` is a built-in slash command that requires no `.prompt.md` file. When invoked, `command.execute.before` intercepts it (before prompt-matching) and returns a markdown report via `buildInspectReport` in `src/inspect.ts`. The report covers: all loaded instructions with active/inactive status per session, skills, agents (with active marker), prompts, hooks, and session state (active agent + tracked files).

## Dev workflow

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run build       # bundle to dist/
bun run link        # symlink into ~/.config/opencode/plugins/
bun run unlink      # remove symlink
```

Always use strict TypeScript. Prefer self-documenting code over comments; only add comments to explain non-obvious reasoning.

## Maintaining this document

This file is a living document. It should be updated whenever the project's structure, runtime model, file conventions, or key invariants change — including when new source files are added, hooks are registered or removed, file path conventions shift, or behavioral guarantees are added or relaxed.
