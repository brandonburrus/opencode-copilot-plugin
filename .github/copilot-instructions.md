This is **opencode-copilot-plugin** — a TypeScript/Bun OpenCode plugin that mirrors GitHub Copilot's custom instruction and skill system into OpenCode sessions.

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
dist/                 Build output (Bun bundler, node target)
```

## Runtime model

The plugin is a single async factory (`CopilotInstructionsPlugin`) that returns an OpenCode `Hooks` object. Four hooks are registered:

- `experimental.chat.system.transform` — injects instructions into the system prompt before each LLM call. Repo-wide instructions are always appended; path-specific instructions only when the session's tracked files match their `applyTo` patterns.
- `tool.execute.after` — tracks every file path accessed via `read`, `edit`, `write`, or `patch` tools for the current session.
- `tool.definition` — keeps the `copilot_skill` tool description current (skill list can hot-reload).
- `event` — handles `file.watcher.updated` for hot-reloading instruction/skill caches independently, and `session.deleted` to free per-session tracker memory.

The `copilot_skill` tool is only registered when at least one skill exists at startup. Skills added after init require an OpenCode restart.

## File conventions

| What | Path |
|---|---|
| Repo-wide instructions | `.github/copilot-instructions.md` |
| Project path-specific instructions | `.github/instructions/**/*.instructions.md` |
| Global path-specific instructions | `~/.copilot/instructions/**/*.instructions.md` |
| Project-local skills | `.github/skills/<name>/SKILL.md` |
| User-global skills | `~/.copilot/skills/<name>/SKILL.md` |

Path-specific instruction files require an `applyTo` frontmatter field (comma-separated glob patterns). Skill `SKILL.md` files require a `description` frontmatter field. The directory name is always the canonical skill name — the optional `name` frontmatter field is advisory only.

## Key invariants

- Local skills shadow global skills of the same name (warning written to stderr).
- `FileTracker` stores paths relative to the project root so they can be matched directly against `applyTo` patterns without prefix stripping.
- All caches (`projectInstructions`, `globalInstructions`, `localSkills`, `globalSkills`) are module-level `let` bindings in the plugin factory — replaced atomically on hot-reload.
- The plugin never throws; missing directories and unreadable files are silently skipped.

## Dev workflow

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run build       # bundle to dist/
bun run link        # symlink into ~/.config/opencode/plugins/
bun run unlink      # remove symlink
```

Always use strict TypeScript. Prefer self-documenting code over comments; only add comments to explain non-obvious reasoning.
