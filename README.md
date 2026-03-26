# opencode-copilot-plugin

[![npm version](https://img.shields.io/npm/v/opencode-copilot-plugin)](https://www.npmjs.com/package/opencode-copilot-plugin)
[![license](https://img.shields.io/npm/l/opencode-copilot-plugin)](./LICENSE)

An [OpenCode](https://opencode.ai) plugin that brings GitHub Copilot's custom instruction, skill, hook, and agent system into OpenCode. If you already have Copilot customization files set up, they work in OpenCode with no changes.

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

### Custom agents

Discovers Copilot `.agent.md` files and registers them as a `copilot_agent` tool, letting the LLM load any agent persona on demand. Agents bring their own instructions, tool lists, model preferences, and optionally agent-scoped hooks.

- **Project-local** — `.github/agents/*.agent.md` (or `*.md`)
- **User-global** — `~/.copilot/agents/*.agent.md` (or `*.md`)
- When at least one agent exists at startup, a `copilot_agent` tool is registered.
- Local agents shadow global agents of the same name.
- Agents with `target: github-copilot` are skipped — they are cloud-only and cannot run locally.

Agent files use the standard [Copilot custom agent format](https://code.visualstudio.com/docs/copilot/customization/custom-agents):

```markdown
---
description: Generate an implementation plan without making code edits.
tools: ['search/codebase', 'web/fetch']
model: Claude Sonnet 4.5
handoffs:
  - label: Start Implementation
    agent: implementer
    prompt: Now implement the plan outlined above.
---

You are in planning mode. Collect context and produce a detailed implementation
plan. Do not make any code edits.
```

Supported frontmatter fields:

| Field | Behaviour |
| --- | --- |
| `description` | Required. Shown in the agent listing. |
| `name` | Advisory. The filename (without extension) is always the canonical name. |
| `argument-hint` | Shown as a usage hint in the tool listing. |
| `tools` | Informational — listed in the loaded agent content. |
| `agents` | Informational — documents which subagents the agent expects to use. |
| `model` | Informational — noted in content with a reminder that OpenCode uses the model picker. |
| `user-invocable` | `false` marks an agent as subagent-only; it still appears in the listing annotated as such. |
| `infer` | Deprecated alias for `user-invocable`. |
| `handoffs` | Rendered as a "Suggested Next Steps" section in the loaded agent content. |
| `hooks` | Agent-scoped hooks — run after global hooks, only when this agent is active. |
| `mcp-servers` | Not supported for local agents — field is ignored with a warning. |
| `target: github-copilot` | Causes the agent to be skipped entirely. |

**Agent-scoped hooks:** An agent file can define hooks directly in its frontmatter using the same hook types as standalone hook files. These hooks only run while that agent is active in a session, and they run after any global hooks of the same type. Hook keys use `command` instead of `bash` (both are accepted):

```markdown
---
description: Strict formatter agent that auto-formats after every edit.
hooks:
  PostToolUse:
    - type: command
      command: ./scripts/format-changed-files.sh
---
```

### Hot-reload

Instruction files, skill directories, and agent files are re-parsed automatically when they change on disk — no OpenCode restart required. Hook files are the exception — they are loaded once at startup and require a restart to pick up changes.

## License

MIT © [Brandon Burrus](https://github.com/brandonburrus)
