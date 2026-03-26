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

/**
 * Tool names whose args include a `filePath` field.
 * Used by the `tool.execute.after` hook to track which files enter context.
 */
const FILE_TOOLS = new Set(['read', 'edit', 'write', 'patch']);

/**
 * Mirrors GitHub Copilot's custom instruction and skill system into OpenCode.
 *
 * **Custom instructions** — injected into the system prompt:
 * - `.github/copilot-instructions.md` — repo-wide, every session
 * - `.github/instructions/**\/*.instructions.md` — path-specific, injected when tracked
 *   files match the instruction's `applyTo` glob patterns
 * - `~/.copilot/instructions/**\/*.instructions.md` — user-global path-specific
 *
 * **Skills** — registered as the `copilot_skill` tool (only when skill dirs exist):
 * - `.copilot/skills/<name>/SKILL.md` — project-local skills
 * - `~/.copilot/skills/<name>/SKILL.md` — user-global skills
 *
 * **How it works:**
 * 1. On init, both caches (instructions + skills) are discovered and stored.
 * 2. `tool.execute.after` tracks which files the LLM has accessed, feeding `applyTo` matching.
 * 3. `experimental.chat.system.transform` injects instructions before each LLM call.
 * 4. `tool.definition` keeps the `copilot_skill` tool description current after hot-reloads.
 * 5. `event` watches for file changes to hot-reload each cache independently, and frees
 *    per-session tracking data when sessions are deleted.
 */
export const CopilotInstructionsPlugin: Plugin = async ({ directory, worktree, client }) => {
  const rootDir = worktree || directory;
  const tracker = new FileTracker();

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

  /** Absolute path of the project-level skills directory — used for hot-reload path matching. */
  const localSkillsDir = path.join(rootDir, LOCAL_SKILLS_SUBDIR);

  await log(
    client,
    'info',
    `Loaded ${projectInstructions.length} project instruction(s), ` +
      `${globalInstructions.length} global instruction(s), ` +
      `${allSkills.length} skill(s) (${localSkills.length} local, ${globalSkills.length} global)`,
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
      const { sessionID } = input as { sessionID?: string };
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
     * Tracks which files the LLM has read, written, or edited within a session.
     * This data feeds the `applyTo` matching logic in `experimental.chat.system.transform`.
     */
    'tool.execute.after': async (input) => {
      if (!FILE_TOOLS.has(input.tool)) return;

      const filePath: unknown = input.args?.filePath ?? input.args?.file;
      if (typeof filePath !== 'string' || filePath.length === 0) return;

      tracker.trackFile(input.sessionID, filePath, rootDir);
    },

    /**
     * Handles file watcher and session lifecycle events:
     *
     * - `file.watcher.updated` on a project instruction path: hot-reloads the project cache.
     * - `file.watcher.updated` on a global instruction path: hot-reloads the global cache.
     * - `file.watcher.updated` on the local skills dir: hot-reloads local skills.
     * - `file.watcher.updated` on the global skills dir: hot-reloads global skills.
     * - `session.deleted`: frees per-session file tracking data to prevent memory growth.
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

      if (event.type === 'session.deleted') {
        const sessionID: string = ((event.properties as Record<string, unknown>)?.['id'] as string) ?? '';
        if (sessionID) tracker.clearSession(sessionID);
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
