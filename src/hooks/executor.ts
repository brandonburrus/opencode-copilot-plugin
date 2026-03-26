import * as path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { CopilotHookType, HookCommandDef, HookRegistry } from "./types.ts"

type BunShell = PluginInput["$"]

const DEFAULT_TIMEOUT_SEC = 30

interface HookResult {
  stdout: string
  exitCode: number
}

/**
 * Executes a single Copilot hook command, piping `inputJson` to its stdin.
 *
 * Only `bash` commands are supported. If `def.bash` is undefined (e.g. PowerShell-only
 * hook on macOS/Linux), this is a no-op returning a zero-exit success result.
 *
 * The hook's working directory defaults to `projectRoot` and can be overridden via
 * `def.cwd` (resolved relative to `projectRoot`). Additional environment variables
 * from `def.env` are merged on top of the current process environment.
 *
 * Execution is bounded by `def.timeoutSec` (default 30 seconds). Timeouts and
 * unexpected errors are logged to stderr and return a non-zero exit code so that
 * the calling `runHooks` loop can continue with remaining hooks.
 */
export async function executeHookCommand(
  def: HookCommandDef,
  inputJson: string,
  projectRoot: string,
  $: BunShell,
): Promise<HookResult> {
  if (!def.bash) return { stdout: "", exitCode: 0 }

  const cwd = def.cwd ? path.resolve(projectRoot, def.cwd) : projectRoot
  const timeoutMs = (def.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000
  const env = def.env ? { ...process.env, ...def.env } : (process.env as Record<string, string>)

  const shell = $.cwd(cwd).env(env).nothrow()

  try {
    const proc = shell`bash -c ${def.bash}`.quiet()

    const stdinWriter = proc.stdin.getWriter()
    await stdinWriter.write(new TextEncoder().encode(inputJson))
    await stdinWriter.close()

    const result = await Promise.race([
      proc,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Hook timed out after ${def.timeoutSec ?? DEFAULT_TIMEOUT_SEC}s`)), timeoutMs),
      ),
    ])

    if (result.stderr.length > 0) {
      process.stderr.write(
        `[opencode-copilot-plugin] Hook stderr: ${result.stderr.toString("utf8").trimEnd()}\n`,
      )
    }

    return { stdout: result.stdout.toString("utf8"), exitCode: result.exitCode }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[opencode-copilot-plugin] Hook execution error: ${message}\n`)
    return { stdout: "", exitCode: 1 }
  }
}

/**
 * Runs all hook commands registered for `type` sequentially.
 *
 * Each hook in the registry receives the same `inputJson`. Results are collected
 * even if individual hooks fail — a failure in one hook does not prevent subsequent
 * hooks from running.
 */
export async function runHooks(
  type: CopilotHookType,
  inputJson: string,
  registry: HookRegistry,
  projectRoot: string,
  $: BunShell,
): Promise<HookResult[]> {
  const hooks = registry[type]
  if (!hooks?.length) return []

  const results: HookResult[] = []
  for (const hook of hooks) {
    const result = await executeHookCommand(hook, inputJson, projectRoot, $)
    results.push(result)
  }
  return results
}
