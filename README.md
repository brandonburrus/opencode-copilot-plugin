# opencode-copilot-plugin

[![npm version](https://img.shields.io/npm/v/opencode-copilot-plugin)](https://www.npmjs.com/package/opencode-copilot-plugin)
[![license](https://img.shields.io/npm/l/opencode-copilot-plugin)](./LICENSE)

An [OpenCode](https://opencode.ai) plugin that brings [GitHub Copilot](https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot)'s custom instruction and skill system into OpenCode. If you already have Copilot instruction or skill files set up, they work in OpenCode with no changes.

## Install

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-copilot-plugin"]
}
```

OpenCode installs npm plugins automatically at startup — no separate install step needed.

## Supported features

### Custom instructions

- **Repo-wide** — `.github/copilot-instructions.md` is injected into every session automatically.
- **Path-specific** — `.github/instructions/**/*.instructions.md` files are injected when the LLM accesses files matching their `applyTo` glob frontmatter field.
- **Global path-specific** — `~/.copilot/instructions/**/*.instructions.md` works the same as project path-specific instructions but applies across all workspaces.

### Skills

- **Project-local** — `.github/skills/<name>/SKILL.md`
- **User-global** — `~/.copilot/skills/<name>/SKILL.md`
- When at least one skill exists at startup, a `copilot_skill` tool is registered so the LLM can load skills on demand.
- Local skills shadow global skills of the same name.

### Hot-reload

Instruction files and skill directories are re-parsed automatically when they change on disk — no OpenCode restart required.

## License

MIT © [Brandon Burrus](https://github.com/brandonburrus)
