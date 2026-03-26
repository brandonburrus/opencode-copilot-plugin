# opencode-copilot-plugin

[![npm version](https://img.shields.io/npm/v/opencode-copilot-plugin)](https://www.npmjs.com/package/opencode-copilot-plugin)
[![license](https://img.shields.io/npm/l/opencode-copilot-plugin)](./LICENSE)

An [OpenCode](https://opencode.ai) plugin that emulates [GitHub Copilot](https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot)'s custom instruction and skill system inside OpenCode.

If you already have `.github/copilot-instructions.md`, `.github/instructions/` files, or `~/.copilot/skills/` directories set up for GitHub Copilot, this plugin makes those same files work in OpenCode with no duplication or changes to your existing configuration.

## Features

### Custom instructions

- **Repo-wide instructions** — `.github/copilot-instructions.md` is injected into every OpenCode session automatically, just as Copilot does in VS Code.
- **Project path-specific instructions** — `.github/instructions/**/*.instructions.md` files are injected only when the LLM has accessed files matching the instruction's `applyTo` glob patterns.
- **Global path-specific instructions** — `~/.copilot/instructions/**/*.instructions.md` files work exactly like project path-specific instructions but apply across every workspace on your machine.

### Skills

- **Project-local skills** — any `<name>/SKILL.md` under `.copilot/skills/` in the project root is registered as a Copilot skill.
- **User-global skills** — any `<name>/SKILL.md` under `~/.copilot/skills/` is registered as a global Copilot skill.
- When at least one skill exists at startup, the plugin registers a `copilot_skill` tool. The LLM sees all available skills in the tool description and can load any of them on demand, exactly like OpenCode's native `skill` tool.
- **Local overrides global** — if a local and global skill share the same directory name, the local one takes precedence.

### Hot-reload & lifecycle

- **Hot-reload** — instruction files and skill directories are re-parsed whenever they change on disk; no OpenCode restart required. Each cache reloads independently.
- **Session cleanup** — per-session file tracking is freed when sessions are deleted, preventing unbounded memory growth.

## Installation

### From npm (recommended)

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-copilot-plugin"]
}
```

OpenCode installs npm plugins automatically at startup using Bun — no separate install step needed.

### As a global plugin

Clone or download this repository and symlink it into your global OpenCode plugins directory:

```bash
git clone https://github.com/brandonburrus/opencode-copilot-plugin.git
cd opencode-copilot-plugin
bun install
bun run link   # symlinks into ~/.config/opencode/plugins/
```

Then add a `package.json` to `~/.config/opencode/` listing the runtime dependencies:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "*",
    "gray-matter": "^4.0.3",
    "picomatch": "^4.0.4"
  }
}
```

### As a project-local plugin

Place the plugin under `.opencode/plugins/opencode-copilot-plugin/` and add a `package.json` to `.opencode/` with the same dependencies as above.

## File locations

### Instructions

| Scope | Path | Behaviour |
|---|---|---|
| Repo-wide | `.github/copilot-instructions.md` | Always injected |
| Project path-specific | `.github/instructions/**/*.instructions.md` | Injected when tracked files match `applyTo` |
| Global path-specific | `~/.copilot/instructions/**/*.instructions.md` | Injected when tracked files match `applyTo` |

> There is no user-global equivalent of `copilot-instructions.md` — personal instructions in GitHub Copilot are either set via the GitHub.com UI (not file-based) or stored as path-specific `.instructions.md` files under `~/.copilot/instructions/`.

### Skills

| Scope | Path |
|---|---|
| Project-local | `.copilot/skills/<name>/SKILL.md` |
| User-global | `~/.copilot/skills/<name>/SKILL.md` |

The directory name is used as the canonical skill name.

## Instruction file format

### Repo-wide instructions

Create `.github/copilot-instructions.md` in the root of your repository. No frontmatter is needed — the entire file is treated as instructions.

```markdown
Always use TypeScript strict mode.
Prefer functional components over class components in React.
```

### Path-specific instructions

Create one or more `*.instructions.md` files under `.github/instructions/` or `~/.copilot/instructions/`. Each file must include an `applyTo` frontmatter field with one or more comma-separated glob patterns.

`.github/instructions/typescript.instructions.md`

```markdown
---
applyTo: "**/*.ts,**/*.tsx"
---

Always add JSDoc comments to exported functions.
Use `const` assertions where possible.
```

`.github/instructions/python.instructions.md`

```markdown
---
applyTo: "**/*.py"
---

Follow PEP 8. Use type hints on all function signatures.
```

Path-specific instructions are injected only after the LLM reads or edits a file matching the `applyTo` patterns in the same session.

## Skill file format

Each skill is a directory containing a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: my-skill
description: Short description of what this skill does and when to use it.
---

## Skill body

Full instructions for the LLM go here.
```

The `description` field is required — it appears in the `copilot_skill` tool listing and is what the LLM reads to decide whether to load the skill.

The `name` field is optional metadata; the **directory name** is always used as the canonical skill identifier.

### Example: project-local skill

`.copilot/skills/deploy-checklist/SKILL.md`

```markdown
---
name: deploy-checklist
description: Step-by-step deployment checklist for this project. Load before deploying to any environment.
---

## Pre-deploy

1. Run `bun test` and confirm all tests pass.
2. Bump the version in `package.json`.
3. Tag the commit with `git tag vX.Y.Z`.
```

## How `applyTo` matching works

Once the LLM uses a file tool (`read`, `edit`, `write`, `patch`) on a file, its path is recorded for the current session. Before each LLM call, the plugin checks whether any of those paths match the `applyTo` glob patterns using [picomatch](https://github.com/micromatch/picomatch).

Supported glob syntax:

| Pattern | Matches |
|---|---|
| `*` | All files in the current directory |
| `**` or `**/*` | All files in all directories |
| `**/*.ts` | All `.ts` files recursively |
| `src/**/*.py` | All `.py` files under `src/` |

## How the `copilot_skill` tool works

At startup the plugin discovers all `SKILL.md` files under `.copilot/skills/` and `~/.copilot/skills/`. If at least one skill is found, a `copilot_skill` tool is registered. The tool description contains an `<available_copilot_skills>` block listing every skill's name and description — identical in structure to OpenCode's native `skill` tool — so the LLM applies the same decision-making heuristics to both.

When the LLM calls `copilot_skill` with a skill name, the plugin returns the full body of that skill's `SKILL.md` wrapped in a `<skill_content>` tag.

Skills added after OpenCode starts require a restart to appear. Skills modified in place are hot-reloaded automatically.

## Development

```bash
bun install
bun run typecheck   # type-check without emitting
bun run build       # compile to dist/
bun run link        # symlink into ~/.config/opencode/plugins/
bun run unlink      # remove the symlink
```

## License

MIT © [Brandon Burrus](https://github.com/brandonburrus)
