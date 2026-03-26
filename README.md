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

### Hooks

Executes Copilot hook scripts at key lifecycle points in each agent session. Hook scripts receive JSON on stdin and can approve, deny, or request confirmation for tool calls.

- **Project-local** — `.github/hooks/*.json`
- **User-global** — `~/.copilot/hooks/*.json`
- Project hooks run before global hooks for each hook type.

Supported hook types:

| Hook type | When it fires |
| --- | --- |
| `sessionStart` | When a new session is created |
| `sessionEnd` | When a session is deleted |
| `userPromptSubmitted` | When a new user message is received |
| `preToolUse` | Before each tool call — can block execution |
| `postToolUse` | After each successful tool call |
| `agentStop` | When the agent finishes responding (session goes idle) |
| `errorOccurred` | When a session error occurs |

Hook configuration files use the same format as [GitHub Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-configuration):

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "type": "command",
        "bash": "./scripts/security-check.sh",
        "cwd": ".",
        "timeoutSec": 15
      }
    ]
  }
}
```

**`preToolUse` permission decisions:** If a hook script outputs `{"permissionDecision":"deny","permissionDecisionReason":"..."}`, the tool call is blocked. If it outputs `{"permissionDecision":"ask","permissionDecisionReason":"..."}`, the agent is instructed to confirm with the user before retrying — on the next identical tool call (same tool and arguments), that specific hook is bypassed.

**Tool name mapping:** Hook scripts receive Copilot-equivalent tool names (`view` instead of `read`, `create` instead of `write`) so existing scripts work unmodified.

**Platform note:** Only `bash` commands are executed. `powershell` commands are silently skipped on macOS/Linux.

**No hot-reload:** Hook files are loaded once when the plugin initialises. Changes to hook files require an OpenCode restart to take effect.

### Hot-reload

Instruction files and skill directories are re-parsed automatically when they change on disk — no OpenCode restart required. Hook files are the exception — see note above.

## License

MIT © [Brandon Burrus](https://github.com/brandonburrus)
