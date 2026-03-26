This is **opencode-copilot-plugin** — a TypeScript/Bun OpenCode plugin that mirrors GitHub Copilot's custom instruction, skill, and hooks system into OpenCode sessions.

## Project layout

```
index.ts              Plugin entry point — wires hooks, manages caches, registers tools
src/
  instructions.ts     Discovers & parses .github/copilot-instructions.md and *.instructions.md files
  skills.ts           Discovers & parses SKILL.md files from .github/skills/ and ~/.copilot/skills/
  skill-tool.ts       Builds the copilot_skill tool definition and its XML description block
  format.ts           Formats a parsed Instruction into a system-prompt string
  glob-matcher.ts     applyTo glob matching via picomatch
  file-tracker.ts     Per-session file access tracker with FIFO eviction (max 500 paths)
  hooks/
    index.ts              Barrel re-export for the hooks subsystem
    types.ts              CopilotHookType, HookCommandDef, HookConfigFile, HookRegistry types
    discovery.ts          Discovers & parses *.json hook configs from .github/hooks/ and ~/.copilot/hooks/
    executor.ts           Executes hook commands by piping JSON to stdin; handles timeouts
    confirmation-tracker.ts  Tracks "ask" decisions from preToolUse hooks for one-shot bypass
    tool-names.ts         Maps OpenCode tool names to Copilot-equivalent names
dist/                 Build output (Bun bundler, node target)
```

## Runtime model

The plugin is a single async factory (`CopilotInstructionsPlugin`) that returns an OpenCode `Hooks` object. Six hooks are registered:

- `experimental.chat.system.transform` — injects instructions into the system prompt before each LLM call. Repo-wide instructions are always appended; path-specific instructions only when the session's tracked files match their `applyTo` patterns.
- `tool.execute.before` — runs `preToolUse` Copilot hooks before each tool call, blocking execution when a hook returns `"deny"` or `"ask"`.
- `tool.execute.after` — tracks every file path accessed via `read`, `edit`, `write`, or `patch` tools for the current session. Also dispatches `postToolUse` Copilot hooks after each tool call completes.
- `tool.definition` — keeps the `copilot_skill` tool description current (skill list can hot-reload).
- `chat.message` — dispatches `userPromptSubmitted` Copilot hooks when a new user message is received.
- `event` — handles `file.watcher.updated` for hot-reloading instruction/skill caches independently, and `session.deleted` to free per-session tracker memory. Also dispatches `sessionStart`, `sessionEnd`, `agentStop`, and `errorOccurred` hooks on the corresponding session lifecycle events.

The `copilot_skill` tool is only registered when at least one skill exists at startup. Skills added after init require an OpenCode restart.

Hook files are loaded once at plugin init and are not hot-reloaded. Changes to hook files require an OpenCode restart.

## File conventions

| What | Path |
|---|---|
| Repo-wide instructions | `.github/copilot-instructions.md` |
| Project path-specific instructions | `.github/instructions/**/*.instructions.md` |
| Global path-specific instructions | `~/.copilot/instructions/**/*.instructions.md` |
| Project-local skills | `.github/skills/<name>/SKILL.md` |
| User-global skills | `~/.copilot/skills/<name>/SKILL.md` |
| Project-local hooks | `.github/hooks/*.json` |
| User-global hooks | `~/.copilot/hooks/*.json` |

Path-specific instruction files require an `applyTo` frontmatter field (comma-separated glob patterns). Skill `SKILL.md` files require a `description` frontmatter field. The directory name is always the canonical skill name — the optional `name` frontmatter field is advisory only.

Hook config files must have `"version": 1` at the root and a `"hooks"` object mapping hook type names to arrays of command definitions. Each command definition must have `"type": "command"` and at least one of `"bash"` or `"powershell"`.

## Key invariants

- Local skills shadow global skills of the same name (warning written to stderr).
- `FileTracker` stores paths relative to the project root so they can be matched directly against `applyTo` patterns without prefix stripping.
- All caches (`projectInstructions`, `globalInstructions`, `localSkills`, `globalSkills`) are module-level `let` bindings in the plugin factory — replaced atomically on hot-reload.
- The plugin never throws; missing directories and unreadable files are silently skipped.
- Project hooks run before global hooks for each hook type.
- `HookConfirmationTracker` enables one-shot bypass of a specific `preToolUse` hook that returned `"ask"` — only the exact hook index, tool name, and args combination is bypassed, and only once per confirmation.
- Only `bash` commands are supported for hooks on macOS/Linux. PowerShell-only hook definitions are silently skipped.
- Hook execution is bounded by `timeoutSec` (default 30 seconds). A timeout in one hook does not prevent subsequent hooks from running.
- OpenCode tool names are mapped to Copilot-equivalent names before being passed to hooks (`read` → `view`, `write` → `create`) so existing Copilot hook scripts work unmodified.

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
