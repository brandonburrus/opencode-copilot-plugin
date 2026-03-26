import * as path from 'node:path';
import type { Hooks, Plugin } from '@opencode-ai/plugin';
import { FileTracker } from './src/file-tracker.ts';
import { formatInstruction } from './src/format.ts';
import { matchesApplyTo } from './src/glob-matcher.ts';
import {
  discoverGlobalInstructions,
  discoverInstructions,
  GLOBAL_INSTRUCTIONS_DIR,
  type Instruction,
  type PathSpecificInstruction,
} from './src/instructions.ts';
import { buildSkillToolDescription, createCopilotSkillTool } from './src/skill-tool.ts';
import {
  type CopilotSkill,
  discoverGlobalSkills,
  discoverLocalSkills,
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

/**
 * Tool names whose args include a `filePath` field.
 * Used by the `tool.execute.after` hook to track which files enter context.
 */
const FILE_TOOLS = new Set(['read', 'edit', 'write', 'patch']);

/**
 * Mirrors GitHub Copilot's custom instruction, skill, and hooks system into OpenCode.
 *
 * **Custom instructions** — injected into the system prompt:
 * - `.github/copilot-instructions.md` — repo-wide, every session
 * - `.github/instructions/**\/*.instructions.md` — path-specific, injected when tracked
 *   files match the instruction's `applyTo` glob patterns
 * - `~/.copilot/instructions/**\/*.instructions.md` — user-global path-specific
 *
 * **Skills** — registered as the `copilot_skill` tool (only when skill dirs exist):
 * - `.github/skills/<name>/SKILL.md` — project-local skills
 * - `~/.copilot/skills/<name>/SKILL.md` — user-global skills
 *
 * **Hooks** — executes Copilot hook scripts at key agent lifecycle points:
 * - `.github/hooks/*.json` — project-local hooks
 * - `~/.copilot/hooks/*.json` — user-global hooks (run after project hooks)
 * Hook files are loaded once at plugin init; changes require an OpenCode restart.
 *
 * **How it works:**
 * 1. On init, all caches (instructions, skills, hooks) are discovered and stored.
 * 2. `tool.execute.after` tracks which files the LLM has accessed, feeding `applyTo` matching.
 * 3. `experimental.chat.system.transform` injects instructions before each LLM call.
 * 4. `tool.definition` keeps the `copilot_skill` tool description current after hot-reloads.
 * 5. `event` watches for instruction/skill file changes to hot-reload those caches independently,
 *    and frees per-session tracking data when sessions are deleted.
 * 6. `tool.execute.before` runs `preToolUse` hooks, blocking tool calls as needed.
 * 7. `chat.message` runs `userPromptSubmitted` hooks on each new user message.
 */
export const CopilotInstructionsPlugin: Plugin = async ({ directory, worktree, client, $ }) => {
  const rootDir = worktree || directory;
  const tracker = new FileTracker();
  const confirmationTracker = new HookConfirmationTracker();

  /** Project-level instruction cache — replaced on hot-reload. */
  let projectInstructions: Instruction[] = await discoverInstructions(rootDir);

  /** User-global instruction cache — replaced on hot-reload. */
  let globalInstructions: PathSpecificInstruction[] = await discoverGlobalInstructions();

  /** Project-local skill cache — replaced on hot-reload. */
  let localSkills: CopilotSkill[] = await discoverLocalSkills(rootDir);

  /** User-global skill cache — replaced on hot-reload. */
  let globalSkills: CopilotSkill[] = await discoverGlobalSkills();

  /** Merged, deduplicated skill list. Local skills take precedence over global. */
  let allSkills: CopilotSkill[] = mergeSkills(localSkills, globalSkills);

  /**
   * Hook registry loaded once at init — not hot-reloaded.
   * Project hooks run before global hooks for each hook type.
   */
  const hookRegistry: HookRegistry = await discoverHookRegistry(rootDir);

  /** Absolute path of the project-level skills directory — used for hot-reload path matching. */
  const localSkillsDir = path.join(rootDir, LOCAL_SKILLS_SUBDIR);

  await log(
    client,
    'info',
    `Loaded ${projectInstructions.length} project instruction(s), ` +
      `${globalInstructions.length} global instruction(s), ` +
      `${allSkills.length} skill(s) (${localSkills.length} local, ${globalSkills.length} global), ` +
      `${Object.keys(hookRegistry).length} hook type(s)`,
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
     * When a hook returns `"ask"`, the call is blocked and the agent is instructed
     * to confirm with the user. On the next identical call (same tool + same args),
     * only that specific hook is bypassed — other hooks still run. One-shot.
     */
    'tool.execute.before': async (input, output) => {
      const preToolHooks = hookRegistry.preToolUse;
      if (!preToolHooks?.length) return;

      const copilotToolName = toCopilotToolName(input.tool);
      const argsJson = JSON.stringify(output.args);
      const hookInput = JSON.stringify({
        timestamp: Date.now(),
        cwd: rootDir,
        toolName: copilotToolName,
        toolArgs: argsJson,
      });

      for (let i = 0; i < preToolHooks.length; i++) {
        if (confirmationTracker.consumeConfirmation(input.sessionID, i, copilotToolName, argsJson)) {
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
            confirmationTracker.markPendingConfirmation(input.sessionID, i, copilotToolName, argsJson);
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
          // JSON parse failure or unexpected shape — ignore and continue
        }
      }
    },

    /**
     * Tracks which files the LLM has read, written, or edited within a session.
     * This data feeds the `applyTo` matching logic in `experimental.chat.system.transform`.
     *
     * Also dispatches `postToolUse` Copilot hooks after each tool call completes.
     */
    'tool.execute.after': async (input, output) => {
      if (FILE_TOOLS.has(input.tool)) {
        const filePath: unknown = input.args?.filePath ?? input.args?.file;
        if (typeof filePath === 'string' && filePath.length > 0) {
          tracker.trackFile(input.sessionID, filePath, rootDir);
        }
      }

      if (hookRegistry.postToolUse?.length) {
        const inputJson = JSON.stringify({
          timestamp: Date.now(),
          cwd: rootDir,
          toolName: toCopilotToolName(input.tool),
          toolArgs: JSON.stringify(input.args),
          toolResult: {
            resultType: 'success',
            textResultForLlm: output.output ?? '',
          },
        });
        await runHooks('postToolUse', inputJson, hookRegistry, rootDir, $);
      }
    },

    /**
     * Dispatches `userPromptSubmitted` Copilot hooks when a new user message is received.
     * The prompt text is assembled from all text parts in the message.
     */
    'chat.message': async (_input, output) => {
      if (!hookRegistry.userPromptSubmitted?.length) return;

      const promptText = output.parts
        .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');

      const inputJson = JSON.stringify({
        timestamp: Date.now(),
        cwd: rootDir,
        prompt: promptText,
      });
      await runHooks('userPromptSubmitted', inputJson, hookRegistry, rootDir, $);
    },

    /**
     * Handles file watcher and session lifecycle events:
     *
     * - `file.watcher.updated` on a project instruction path: hot-reloads the project cache.
     * - `file.watcher.updated` on a global instruction path: hot-reloads the global cache.
     * - `file.watcher.updated` on the local skills dir: hot-reloads local skills.
     * - `file.watcher.updated` on the global skills dir: hot-reloads global skills.
     * - `session.created`: runs `sessionStart` Copilot hooks.
     * - `session.deleted`: frees per-session tracking data; runs `sessionEnd` Copilot hooks.
     * - `session.idle`: runs `agentStop` Copilot hooks.
     * - `session.error`: runs `errorOccurred` Copilot hooks.
     */
    event: async ({ event }) => {
      if (event.type === 'file.watcher.updated') {
        const changedPath: string = ((event.properties as Record<string, unknown>)?.['path'] as string) ?? '';

        const isProjectInstruction =
          changedPath.includes('.github/copilot-instructions.md') || changedPath.includes('.github/instructions/');

        const isGlobalInstruction = changedPath.startsWith(GLOBAL_INSTRUCTIONS_DIR);
        const isLocalSkill = changedPath.startsWith(localSkillsDir);
        const isGlobalSkill = changedPath.startsWith(GLOBAL_SKILLS_DIR);

        if (isProjectInstruction) {
          projectInstructions = await discoverInstructions(rootDir);
          await log(
            client,
            'info',
            `Hot-reloaded ${projectInstructions.length} project instruction(s) after change to ${changedPath}`,
          );
        }

        if (isGlobalInstruction) {
          globalInstructions = await discoverGlobalInstructions();
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
          globalSkills = await discoverGlobalSkills();
          allSkills = mergeSkills(localSkills, globalSkills);
          await log(client, 'info', `Hot-reloaded ${allSkills.length} skill(s) after change to ${changedPath}`);
        }
      }

      if (event.type === 'session.created') {
        const info = (event.properties as Record<string, unknown>)?.['info'] as Record<string, unknown> | undefined;
        const sessionID = info?.['id'] as string | undefined;
        await runHooks(
          'sessionStart',
          JSON.stringify({ timestamp: Date.now(), cwd: rootDir, source: 'new', initialPrompt: '' }),
          hookRegistry,
          rootDir,
          $,
        );
        await log(client, 'info', `Ran sessionStart hooks for session ${sessionID ?? 'unknown'}`);
      }

      if (event.type === 'session.deleted') {
        const deletedInfo = (event.properties as Record<string, unknown>)?.['info'] as Record<string, unknown> | undefined;
        const sessionID: string = (deletedInfo?.['id'] as string | undefined) ?? '';
        tracker.clearSession(sessionID);
        confirmationTracker.clearSession(sessionID);
        await runHooks(
          'sessionEnd',
          JSON.stringify({ timestamp: Date.now(), cwd: rootDir, reason: 'complete' }),
          hookRegistry,
          rootDir,
          $,
        );
      }

      if (event.type === 'session.idle') {
        await runHooks(
          'agentStop',
          JSON.stringify({ timestamp: Date.now(), cwd: rootDir }),
          hookRegistry,
          rootDir,
          $,
        );
      }

      if (event.type === 'session.error') {
        const error = (event.properties as Record<string, unknown>)?.['error'] as
          | Record<string, unknown>
          | undefined;
        const errorData = (error?.['data'] as Record<string, unknown> | undefined) ?? {};
        await runHooks(
          'errorOccurred',
          JSON.stringify({
            timestamp: Date.now(),
            cwd: rootDir,
            error: {
              message: (errorData['message'] as string | undefined) ?? 'Unknown error',
              name: (error?.['name'] as string | undefined) ?? 'Error',
              stack: '',
            },
          }),
          hookRegistry,
          rootDir,
          $,
        );
      }
    },
  };

  /**
   * Only register skill hooks if at least one skill was found at startup.
   * Skills added after plugin init require an OpenCode restart to appear.
   */
  if (allSkills.length > 0) {
    hooks.tool = {
      copilot_skill: createCopilotSkillTool(() => allSkills),
    };

    hooks['tool.definition'] = async (input, output) => {
      if (input.toolID === 'copilot_skill') {
        output.description = buildSkillToolDescription(allSkills);
      }
    };
  }

  return hooks;
};

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
