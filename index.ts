import * as path from 'node:path';
import type { Hooks, Plugin } from '@opencode-ai/plugin';
import type { Part } from '@opencode-ai/sdk';
import { FileTracker } from './src/file-tracker.ts';
import { formatInstruction } from './src/format.ts';
import { matchesApplyTo } from './src/glob-matcher.ts';
import {
  discoverGlobalInstructions,
  discoverInstructions,
  discoverVSCodeInstructions,
  GLOBAL_INSTRUCTIONS_DIR,
  type Instruction,
  type PathSpecificInstruction,
} from './src/instructions.ts';
import { buildInspectReport } from './src/inspect.ts';
import { buildSkillToolDescription, createCopilotSkillTool } from './src/skill-tool.ts';
import {
  type CopilotSkill,
  discoverGlobalSkills,
  discoverLocalSkills,
  discoverVSCodeSkills,
  GLOBAL_SKILLS_DIR,
  LOCAL_SKILLS_SUBDIR,
  mergeSkills,
} from './src/skills.ts';
import {
  executeHookCommand,
  HookConfirmationTracker,
  discoverHookRegistry,
  type HookRegistry,
  runHooks,
  toCopilotToolName,
} from './src/hooks/index.ts';
import {
  AgentTracker,
  discoverGlobalAgents,
  discoverLocalAgents,
  discoverVSCodeAgents,
  type CopilotAgent,
  GLOBAL_AGENTS_DIR,
  LOCAL_AGENTS_SUBDIR,
  mergeAgents,
} from './src/agents/index.ts';
import { buildAgentToolDescription, createCopilotAgentTool } from './src/agent-tool.ts';
import {
  type CopilotPrompt,
  discoverGlobalPrompts,
  discoverLocalPrompts,
  discoverVSCodePrompts,
  formatPromptHeader,
  GLOBAL_PROMPTS_DIR,
  LOCAL_PROMPTS_SUBDIR,
  mergePrompts,
  parseCommandArguments,
  resolveFileReferences,
  substituteArguments,
} from './src/prompts/index.ts';
import { getVSCodeUserDataDirs } from './src/vscode-paths.ts';

/**
 * Tool names whose args include a `filePath` field.
 * Used by the `tool.execute.after` hook to track which files enter context.
 */
const FILE_TOOLS = new Set(['read', 'edit', 'write', 'patch']);

/**
 * Mirrors GitHub Copilot's custom instruction, prompt, skill, agent, and hook
 * file system into OpenCode.
 *
 * **Custom instructions** — injected into the system prompt:
 * - `.github/copilot-instructions.md` — repo-wide, every session
 * - `.github/instructions/**\/*.instructions.md` — path-specific, injected when tracked
 *   files match the instruction's `applyTo` glob patterns
 * - `~/.copilot/instructions/**\/*.instructions.md` — user-global path-specific
 * - `<vsCodeUserData>/instructions/**\/*.instructions.md` — VS Code user data (secondary)
 *
 * **Prompt files** — surfaced as slash commands via `command.execute.before`:
 * - `.github/prompts/*.prompt.md` — project-local prompt files
 * - `~/.copilot/prompts/*.prompt.md` — user-global prompt files
 * - `<vsCodeUserData>/prompts/*.prompt.md` — VS Code user data (secondary)
 * When a command matching a prompt file name is invoked, its content is
 * resolved (including file references) and substituted with any provided
 * arguments before being sent to the LLM.
 *
 * **Skills** — registered as the `copilot_skill` tool (only when skill dirs exist):
 * - `.github/skills/<name>/SKILL.md` — project-local skills
 * - `~/.copilot/skills/<name>/SKILL.md` — user-global skills
 * - `<vsCodeUserData>/skills/<name>/SKILL.md` — VS Code user data (secondary)
 *
 * **Agents** — registered as the `copilot_agent` tool (only when agent files exist):
 * - `.github/agents/*.agent.md` or `*.md` — project-local agents
 * - `~/.copilot/agents/*.agent.md` or `*.md` — user-global agents
 * - `<vsCodeUserData>/agents/*.agent.md` or `*.md` — VS Code user data (secondary)
 * Agents can also define scoped hooks that run only when the agent is active.
 *
 * **Hooks** — executes Copilot hook scripts at key agent lifecycle points:
 * - `.github/hooks/*.json` — project-local hooks
 * - `~/.copilot/hooks/*.json` — user-global hooks (run after project hooks)
 * - `<vsCodeUserData>/hooks/*.json` — VS Code user data (run last)
 * Hook files are loaded once at plugin init; changes require an OpenCode restart.
 *
 * **How it works:**
 * 1. On init, all caches (instructions, prompts, skills, agents, hooks) are discovered and stored.
 * 2. `tool.execute.after` tracks which files the LLM has accessed, feeding `applyTo` matching.
 * 3. `experimental.chat.system.transform` injects instructions before each LLM call.
 * 4. `tool.definition` keeps the `copilot_skill` and `copilot_agent` tool descriptions current.
 * 5. `event` watches for instruction/prompt/skill/agent file changes to hot-reload caches
 *    independently, and frees per-session tracking data when sessions are deleted.
 * 6. `tool.execute.before` runs global `preToolUse` hooks, then agent-scoped ones if active.
 * 7. `chat.message` runs `userPromptSubmitted` hooks (global then agent-scoped).
 * 8. `command.execute.before` intercepts commands matching prompt file names, resolves their
 *    content (file references + argument substitution), and injects the result as the message.
 */
export const CopilotInstructionsPlugin: Plugin = async ({ directory, worktree, client, $ }) => {
  const rootDir = worktree || directory;
  const tracker = new FileTracker();
  const confirmationTracker = new HookConfirmationTracker();
  const agentTracker = new AgentTracker();

  /** Project-level instruction cache — replaced on hot-reload. */
  let projectInstructions: Instruction[] = await discoverInstructions(rootDir);

  /**
   * User-global instruction cache — combines `~/.copilot/instructions/` (primary)
   * with VS Code user data instructions (secondary). Replaced on hot-reload.
   */
  let globalInstructions: PathSpecificInstruction[] = [
    ...await discoverGlobalInstructions(),
    ...await discoverVSCodeInstructions(),
  ];

  /** Project-local skill cache — replaced on hot-reload. */
  let localSkills: CopilotSkill[] = await discoverLocalSkills(rootDir);

  /**
   * User-global skill cache — `~/.copilot/skills/` merged with VS Code user data skills
   * (`~/.copilot/` takes precedence). Replaced on hot-reload.
   */
  let globalSkills: CopilotSkill[] = mergeSkills(
    await discoverGlobalSkills(),
    await discoverVSCodeSkills(),
  );

  /** Merged, deduplicated skill list. Local skills take precedence over global. */
  let allSkills: CopilotSkill[] = mergeSkills(localSkills, globalSkills);

  /**
   * Hook registry loaded once at init — not hot-reloaded.
   * Project hooks run before global hooks for each hook type.
   */
  const hookRegistry: HookRegistry = await discoverHookRegistry(rootDir);

  /** Project-local agent cache — replaced on hot-reload. */
  let localAgents: CopilotAgent[] = await discoverLocalAgents(rootDir);

  /**
   * User-global agent cache — `~/.copilot/agents/` merged with VS Code user data agents
   * (`~/.copilot/` takes precedence). Replaced on hot-reload.
   */
  let globalAgents: CopilotAgent[] = mergeAgents(
    await discoverGlobalAgents(),
    await discoverVSCodeAgents(),
  );

  /** Merged, deduplicated agent list. Local agents take precedence over global. */
  let allAgents: CopilotAgent[] = mergeAgents(localAgents, globalAgents);

  /** Project-local prompt cache — replaced on hot-reload. */
  let localPrompts: CopilotPrompt[] = await discoverLocalPrompts(rootDir);

  /**
   * User-global prompt cache — `~/.copilot/prompts/` merged with VS Code user data prompts
   * (`~/.copilot/` takes precedence). Replaced on hot-reload.
   */
  let globalPrompts: CopilotPrompt[] = mergePrompts(
    await discoverGlobalPrompts(),
    await discoverVSCodePrompts(),
  );

  /** Merged, deduplicated prompt list. Local prompts take precedence over global. */
  let allPrompts: CopilotPrompt[] = mergePrompts(localPrompts, globalPrompts);

  /** Absolute path of the project agents directory — used for agent hot-reload path matching. */
  const localAgentsDir = path.join(rootDir, LOCAL_AGENTS_SUBDIR);

  /** Absolute path of the project-level skills directory — used for hot-reload path matching. */
  const localSkillsDir = path.join(rootDir, LOCAL_SKILLS_SUBDIR);

  /** Absolute path of the project-level prompts directory — used for hot-reload path matching. */
  const localPromptsDir = path.join(rootDir, LOCAL_PROMPTS_SUBDIR);

  /**
   * VS Code user data base directories — used for hot-reload path matching.
   * Resolved once at init; changes to the VS Code installation require an OpenCode restart.
   */
  const vsCodeUserDataDirs = await getVSCodeUserDataDirs();

  await log(
    client,
    'info',
    `Loaded ${projectInstructions.length} project instruction(s), ` +
      `${globalInstructions.length} global instruction(s), ` +
      `${allSkills.length} skill(s) (${localSkills.length} local, ${globalSkills.length} global), ` +
      `${Object.keys(hookRegistry).length} hook type(s), ` +
      `${allAgents.length} agent(s) (${localAgents.length} local, ${globalAgents.length} global), ` +
      `${allPrompts.length} prompt(s) (${localPrompts.length} local, ${globalPrompts.length} global)`,
  );

  /** Base hooks — always registered. */
  const hooks: Hooks = {
    /**
     * Injects Copilot custom instructions into the LLM system prompt.
     *
     * Repo-wide instructions are always appended. Path-specific instructions are
     * appended only when the session has accessed at least one file matching the
     * instruction's `applyTo` glob patterns.
     */
    'experimental.chat.system.transform': async (input, output) => {
      const { sessionID } = input;
      if (!sessionID) return;

      const trackedFiles = tracker.getTrackedFiles(sessionID);
      const allInstructions: Instruction[] = [...projectInstructions, ...globalInstructions];

      for (const instruction of allInstructions) {
        if (instruction.type === 'repo-wide') {
          output.system.push(formatInstruction(instruction));
          continue;
        }

        if (matchesApplyTo(trackedFiles, instruction.applyTo)) {
          output.system.push(formatInstruction(instruction));
        }
      }
    },

    /**
     * Runs `preToolUse` Copilot hooks before each tool call, blocking execution
     * when a hook returns `"deny"` or `"ask"`.
     *
     * Global hooks run first, then agent-scoped hooks (if an agent is active in the session).
     * When a hook returns `"ask"`, the call is blocked and the agent is instructed to
     * confirm with the user. On the next identical call (same tool + same args),
     * only that specific hook is bypassed — other hooks still run. One-shot.
     */
    'tool.execute.before': async (input, output) => {
      const copilotToolName = toCopilotToolName(input.tool);
      const argsJson = JSON.stringify(output.args);
      const hookInput = JSON.stringify({
        timestamp: Date.now(),
        cwd: rootDir,
        toolName: copilotToolName,
        toolArgs: argsJson,
      });

      const preToolHooks = hookRegistry.preToolUse;
      if (preToolHooks?.length) {
        for (let i = 0; i < preToolHooks.length; i++) {
          const hookKey = `global:${i}`;
          if (confirmationTracker.consumeConfirmation(input.sessionID, hookKey, copilotToolName, argsJson)) {
            continue;
          }

          const hook = preToolHooks[i]!;
          const result = await executeHookCommand(hook, hookInput, rootDir, $);

          if (!result.stdout.trim()) continue;

          try {
            const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
            if (parsed['permissionDecision'] === 'deny') {
              throw new Error(
                typeof parsed['permissionDecisionReason'] === 'string'
                  ? parsed['permissionDecisionReason']
                  : 'Denied by Copilot hook',
              );
            }
            if (parsed['permissionDecision'] === 'ask') {
              confirmationTracker.markPendingConfirmation(input.sessionID, hookKey, copilotToolName, argsJson);
              throw new Error(
                `A Copilot hook requires confirmation before allowing "${copilotToolName}": ` +
                  `${typeof parsed['permissionDecisionReason'] === 'string' ? parsed['permissionDecisionReason'] : 'no reason given'}. ` +
                  `Ask the user to confirm this action, then retry the exact same tool call.`,
              );
            }
          } catch (e) {
            if (
              e instanceof Error &&
              (e.message.includes('Denied by') || e.message.includes('requires confirmation'))
            ) {
              throw e;
            }
          }
        }
      }

      const activeAgentName = agentTracker.getActiveAgent(input.sessionID);
      if (activeAgentName) {
        const activeAgent = allAgents.find((a) => a.name === activeAgentName);
        const agentPreToolHooks = activeAgent?.hooks.preToolUse;
        if (agentPreToolHooks?.length) {
          for (let i = 0; i < agentPreToolHooks.length; i++) {
            const hookKey = `agent:${activeAgentName}:${i}`;
            if (confirmationTracker.consumeConfirmation(input.sessionID, hookKey, copilotToolName, argsJson)) {
              continue;
            }

            const hook = agentPreToolHooks[i]!;
            const result = await executeHookCommand(hook, hookInput, rootDir, $);

            if (!result.stdout.trim()) continue;

            try {
              const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
              if (parsed['permissionDecision'] === 'deny') {
                throw new Error(
                  typeof parsed['permissionDecisionReason'] === 'string'
                    ? parsed['permissionDecisionReason']
                    : `Denied by agent-scoped Copilot hook (agent: ${activeAgentName})`,
                );
              }
              if (parsed['permissionDecision'] === 'ask') {
                confirmationTracker.markPendingConfirmation(input.sessionID, hookKey, copilotToolName, argsJson);
                throw new Error(
                  `An agent-scoped Copilot hook (agent: ${activeAgentName}) requires confirmation before allowing "${copilotToolName}": ` +
                    `${typeof parsed['permissionDecisionReason'] === 'string' ? parsed['permissionDecisionReason'] : 'no reason given'}. ` +
                    `Ask the user to confirm this action, then retry the exact same tool call.`,
                );
              }
            } catch (e) {
              if (
                e instanceof Error &&
                (e.message.includes('Denied by') || e.message.includes('requires confirmation'))
              ) {
                throw e;
              }
            }
          }
        }
      }
    },

    /**
     * Tracks which files the LLM has read, written, or edited within a session.
     * This data feeds the `applyTo` matching logic in `experimental.chat.system.transform`.
     *
     * Also dispatches `postToolUse` Copilot hooks (global then agent-scoped) after each
     * tool call completes.
     */
    'tool.execute.after': async (input, output) => {
      if (FILE_TOOLS.has(input.tool)) {
        const filePath: unknown = input.args?.filePath ?? input.args?.file;
        if (typeof filePath === 'string' && filePath.length > 0) {
          tracker.trackFile(input.sessionID, filePath, rootDir);
        }
      }

      const postToolInputJson = JSON.stringify({
        timestamp: Date.now(),
        cwd: rootDir,
        toolName: toCopilotToolName(input.tool),
        toolArgs: JSON.stringify(input.args),
        toolResult: {
          resultType: 'success',
          textResultForLlm: output.output ?? '',
        },
      });

      if (hookRegistry.postToolUse?.length) {
        await runHooks('postToolUse', postToolInputJson, hookRegistry, rootDir, $);
      }

      const activeAgentName = agentTracker.getActiveAgent(input.sessionID);
      if (activeAgentName) {
        const activeAgent = allAgents.find((a) => a.name === activeAgentName);
        if (activeAgent?.hooks.postToolUse?.length) {
          await runHooks('postToolUse', postToolInputJson, activeAgent.hooks, rootDir, $);
        }
      }
    },

    /**
     * Dispatches `userPromptSubmitted` Copilot hooks when a new user message is received.
     * Global hooks run first, then agent-scoped hooks if an agent is active in the session.
     */
    'chat.message': async (input, output) => {
      const promptText = output.parts
        .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');

      const inputJson = JSON.stringify({
        timestamp: Date.now(),
        cwd: rootDir,
        prompt: promptText,
      });

      if (hookRegistry.userPromptSubmitted?.length) {
        await runHooks('userPromptSubmitted', inputJson, hookRegistry, rootDir, $);
      }

      const activeAgentName = agentTracker.getActiveAgent(input.sessionID);
      if (activeAgentName) {
        const activeAgent = allAgents.find((a) => a.name === activeAgentName);
        if (activeAgent?.hooks.userPromptSubmitted?.length) {
          await runHooks('userPromptSubmitted', inputJson, activeAgent.hooks, rootDir, $);
        }
      }
    },

    /**
     * Intercepts command invocations and replaces the message parts with fully
     * resolved prompt file content when the command name matches a discovered
     * `.prompt.md` file.
     *
     * Command names in OpenCode are prefixed by their source scope:
     * - `user:<name>` — from the user-level commands directory
     * - `project:<name>` — from the project-level commands directory
     *
     * The prompt is matched by stripping those prefixes and comparing against
     * each prompt's canonical name. Both local and global prompts are checked.
     *
     * On a match:
     * 1. Markdown file references in the prompt body are resolved and inlined.
     * 2. Argument placeholders are substituted with values parsed from `input.arguments`.
     * 3. An informational header is prepended identifying the prompt source and
     *    surfacing any unsupported frontmatter fields (agent, model, tools).
     * 4. `output.parts` is replaced with a single text part containing the
     *    fully resolved prompt content.
     */
    'command.execute.before': async (input, output) => {
      const commandBaseName = extractCommandBaseName(input.command);

      if (commandBaseName === 'copilot-inspect') {
        const trackedFiles = tracker.getTrackedFiles(input.sessionID);
        const activeAgent = agentTracker.getActiveAgent(input.sessionID);
        output.parts = [{ type: 'text', text: buildInspectReport({
          projectInstructions,
          globalInstructions,
          allSkills,
          allAgents,
          allPrompts,
          hookRegistry,
          trackedFiles,
          activeAgent,
        }) } as unknown as Part];
        return;
      }

      const prompt = allPrompts.find((p) => p.name === commandBaseName);
      if (!prompt) return;

      const resolvedContent = await resolveFileReferences(prompt.content, prompt.dirPath);
      const argValues = parseCommandArguments(input.arguments, prompt.arguments);
      const finalContent = substituteArguments(resolvedContent, prompt.arguments, argValues);
      const header = formatPromptHeader(prompt);

      output.parts = [{ type: 'text', text: header + finalContent } as unknown as Part];
    },

    /**
     * Handles file watcher and session lifecycle events:
     *
     * - `file.watcher.updated` on a project instruction path: hot-reloads the project cache.
     * - `file.watcher.updated` on a global instruction path: hot-reloads the global cache.
     * - `file.watcher.updated` on the local skills dir: hot-reloads local skills.
     * - `file.watcher.updated` on the global skills dir: hot-reloads global skills.
     * - `file.watcher.updated` on a local agents dir: hot-reloads local agents.
     * - `file.watcher.updated` on the global agents dir: hot-reloads global agents.
     * - `file.watcher.updated` on the local prompts dir: hot-reloads local prompts.
     * - `file.watcher.updated` on the global prompts dir: hot-reloads global prompts.
     * - `session.created`: runs `sessionStart` Copilot hooks (global then agent-scoped).
     * - `session.deleted`: frees per-session tracking data; runs `sessionEnd` hooks.
     * - `session.idle`: runs `agentStop` hooks (global then agent-scoped).
     * - `session.error`: runs `errorOccurred` hooks (global then agent-scoped).
     */
    event: async ({ event }) => {
      if (event.type === 'file.watcher.updated') {
        const changedPath: string = ((event.properties as Record<string, unknown>)?.['path'] as string) ?? '';

        const isProjectInstruction =
          changedPath.includes('.github/copilot-instructions.md') || changedPath.includes('.github/instructions/');

        const isGlobalInstruction =
          changedPath.startsWith(GLOBAL_INSTRUCTIONS_DIR) ||
          vsCodeUserDataDirs.some((d) => changedPath.startsWith(path.join(d, 'instructions')));

        const isLocalSkill = changedPath.startsWith(localSkillsDir);
        const isGlobalSkill =
          changedPath.startsWith(GLOBAL_SKILLS_DIR) ||
          vsCodeUserDataDirs.some((d) => changedPath.startsWith(path.join(d, 'skills')));

        const isLocalAgent = changedPath.startsWith(localAgentsDir);
        const isGlobalAgent =
          changedPath.startsWith(GLOBAL_AGENTS_DIR) ||
          vsCodeUserDataDirs.some((d) => changedPath.startsWith(path.join(d, 'agents')));

        const isLocalPrompt = changedPath.startsWith(localPromptsDir);
        const isGlobalPrompt =
          changedPath.startsWith(GLOBAL_PROMPTS_DIR) ||
          vsCodeUserDataDirs.some((d) => changedPath.startsWith(path.join(d, 'prompts')));

        if (isProjectInstruction) {
          projectInstructions = await discoverInstructions(rootDir);
          await log(
            client,
            'info',
            `Hot-reloaded ${projectInstructions.length} project instruction(s) after change to ${changedPath}`,
          );
        }

        if (isGlobalInstruction) {
          globalInstructions = [
            ...await discoverGlobalInstructions(),
            ...await discoverVSCodeInstructions(),
          ];
          await log(
            client,
            'info',
            `Hot-reloaded ${globalInstructions.length} global instruction(s) after change to ${changedPath}`,
          );
        }

        if (isLocalSkill) {
          localSkills = await discoverLocalSkills(rootDir);
          allSkills = mergeSkills(localSkills, globalSkills);
          await log(client, 'info', `Hot-reloaded ${allSkills.length} skill(s) after change to ${changedPath}`);
        }

        if (isGlobalSkill) {
          globalSkills = mergeSkills(await discoverGlobalSkills(), await discoverVSCodeSkills());
          allSkills = mergeSkills(localSkills, globalSkills);
          await log(client, 'info', `Hot-reloaded ${allSkills.length} skill(s) after change to ${changedPath}`);
        }

        if (isLocalAgent) {
          localAgents = await discoverLocalAgents(rootDir);
          allAgents = mergeAgents(localAgents, globalAgents);
          await log(
            client,
            'info',
            `Hot-reloaded ${allAgents.length} agent(s) after change to ${changedPath}`,
          );
        }

        if (isGlobalAgent) {
          globalAgents = mergeAgents(await discoverGlobalAgents(), await discoverVSCodeAgents());
          allAgents = mergeAgents(localAgents, globalAgents);
          await log(
            client,
            'info',
            `Hot-reloaded ${allAgents.length} agent(s) after change to ${changedPath}`,
          );
        }

        if (isLocalPrompt) {
          localPrompts = await discoverLocalPrompts(rootDir);
          allPrompts = mergePrompts(localPrompts, globalPrompts);
          await log(
            client,
            'info',
            `Hot-reloaded ${allPrompts.length} prompt(s) after change to ${changedPath}`,
          );
        }

        if (isGlobalPrompt) {
          globalPrompts = mergePrompts(await discoverGlobalPrompts(), await discoverVSCodePrompts());
          allPrompts = mergePrompts(localPrompts, globalPrompts);
          await log(
            client,
            'info',
            `Hot-reloaded ${allPrompts.length} prompt(s) after change to ${changedPath}`,
          );
        }
      }

      if (event.type === 'session.created') {
        const info = (event.properties as Record<string, unknown>)?.['info'] as Record<string, unknown> | undefined;
        const sessionID = info?.['id'] as string | undefined;
        const sessionStartJson = JSON.stringify({ timestamp: Date.now(), cwd: rootDir, source: 'new', initialPrompt: '' });
        await runHooks('sessionStart', sessionStartJson, hookRegistry, rootDir, $);
        await log(client, 'info', `Ran sessionStart hooks for session ${sessionID ?? 'unknown'}`);
      }

      if (event.type === 'session.deleted') {
        const deletedInfo = (event.properties as Record<string, unknown>)?.['info'] as Record<string, unknown> | undefined;
        const sessionID: string = (deletedInfo?.['id'] as string | undefined) ?? '';
        const activeAgentName = agentTracker.getActiveAgent(sessionID);

        tracker.clearSession(sessionID);
        confirmationTracker.clearSession(sessionID);
        agentTracker.clearSession(sessionID);

        const sessionEndJson = JSON.stringify({ timestamp: Date.now(), cwd: rootDir, reason: 'complete' });
        await runHooks('sessionEnd', sessionEndJson, hookRegistry, rootDir, $);

        if (activeAgentName) {
          const activeAgent = allAgents.find((a) => a.name === activeAgentName);
          if (activeAgent?.hooks.sessionEnd?.length) {
            await runHooks('sessionEnd', sessionEndJson, activeAgent.hooks, rootDir, $);
          }
        }
      }

      if (event.type === 'session.idle') {
        const idleInfo = (event.properties as Record<string, unknown>)?.['info'] as Record<string, unknown> | undefined;
        const sessionID: string = (idleInfo?.['id'] as string | undefined) ?? '';
        const agentStopJson = JSON.stringify({ timestamp: Date.now(), cwd: rootDir });
        await runHooks('agentStop', agentStopJson, hookRegistry, rootDir, $);

        const activeAgentName = agentTracker.getActiveAgent(sessionID);
        if (activeAgentName) {
          const activeAgent = allAgents.find((a) => a.name === activeAgentName);
          if (activeAgent?.hooks.agentStop?.length) {
            await runHooks('agentStop', agentStopJson, activeAgent.hooks, rootDir, $);
          }
        }
      }

      if (event.type === 'session.error') {
        const error = (event.properties as Record<string, unknown>)?.['error'] as
          | Record<string, unknown>
          | undefined;
        const errorData = (error?.['data'] as Record<string, unknown> | undefined) ?? {};
        const errorOccurredJson = JSON.stringify({
          timestamp: Date.now(),
          cwd: rootDir,
          error: {
            message: (errorData['message'] as string | undefined) ?? 'Unknown error',
            name: (error?.['name'] as string | undefined) ?? 'Error',
            stack: '',
          },
        });
        await runHooks('errorOccurred', errorOccurredJson, hookRegistry, rootDir, $);
      }
    },
  };

  /**
   * Only register skill hooks if at least one skill was found at startup.
   * Skills added after plugin init require an OpenCode restart to appear.
   */
  if (allSkills.length > 0) {
    hooks.tool = {
      ...hooks.tool,
      copilot_skill: createCopilotSkillTool(() => allSkills),
    };
  }

  /**
   * Only register agent hooks if at least one agent was found at startup.
   * Agents added after plugin init require an OpenCode restart to appear.
   */
  if (allAgents.length > 0) {
    hooks.tool = {
      ...hooks.tool,
      copilot_agent: createCopilotAgentTool(() => allAgents, agentTracker),
    };
  }

  if (allSkills.length > 0 || allAgents.length > 0) {
    hooks['tool.definition'] = async (input, output) => {
      if (input.toolID === 'copilot_skill') {
        output.description = buildSkillToolDescription(allSkills);
      }
      if (input.toolID === 'copilot_agent') {
        output.description = buildAgentToolDescription(allAgents);
      }
    };
  }

  return hooks;
};

/**
 * Extracts the base command name by stripping OpenCode's scope prefixes.
 *
 * OpenCode prefixes commands with their source:
 * - `user:<name>` — from the user-level commands directory
 * - `project:<name>` — from the project-level commands directory
 *
 * Nested command paths (e.g., `user:subdir:name`) have all segments after
 * the scope prefix joined with `/` to form a path-like name. This allows
 * prompt files in subdirectories to be addressed by their relative path.
 */
function extractCommandBaseName(command: string): string {
  const colonIndex = command.indexOf(':');
  if (colonIndex === -1) return command;

  const afterPrefix = command.slice(colonIndex + 1);
  // Replace remaining colons (subdirectory separators) with slashes
  return afterPrefix.replace(/:/g, '/');
}

/**
 * Writes a structured log entry via the OpenCode SDK client.
 * Falls back to `console.error` if the SDK call fails.
 */
async function log(
  client: Parameters<Plugin>[0]['client'],
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
): Promise<void> {
  try {
    await client.app.log({
      body: { service: 'opencode-copilot-plugin', level, message },
    });
  } catch {
    console.error(`[opencode-copilot-plugin] ${level.toUpperCase()}: ${message}`);
  }
}

export default CopilotInstructionsPlugin;
