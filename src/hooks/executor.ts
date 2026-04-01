import * as path from "node:path"
import { spawn } from "node:child_process"
import type { CopilotHookType, HookCommandDef, HookRegistry } from "./types.ts"

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
): Promise<HookResult> {
  if (!def.bash) return { stdout: "", exitCode: 0 }

  const cwd = def.cwd ? path.resolve(projectRoot, def.cwd) : projectRoot
  const timeoutMs = (def.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000
  const env = def.env ? { ...process.env, ...def.env } : process.env

  return new Promise((resolve) => {
    let settled = false

    const child = spawn("bash", ["-c", def.bash!], {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))

    child.stdin.write(inputJson, "utf8")
    child.stdin.end()

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      const message = `Hook timed out after ${def.timeoutSec ?? DEFAULT_TIMEOUT_SEC}s`
      process.stderr.write(`[opencode-copilot-plugin] Hook execution error: ${message}\n`)
      resolve({ stdout: "", exitCode: 1 })
    }, timeoutMs)

    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      const stderr = Buffer.concat(stderrChunks).toString("utf8")
      if (stderr.length > 0) {
        process.stderr.write(`[opencode-copilot-plugin] Hook stderr: ${stderr.trimEnd()}\n`)
      }

      resolve({ stdout: Buffer.concat(stdoutChunks).toString("utf8"), exitCode: code ?? 1 })
    })

    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stderr.write(`[opencode-copilot-plugin] Hook execution error: ${err.message}\n`)
      resolve({ stdout: "", exitCode: 1 })
    })
  })
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
): Promise<HookResult[]> {
  const hooks = registry[type]
  if (!hooks?.length) return []

  const results: HookResult[] = []
  for (const hook of hooks) {
    const result = await executeHookCommand(hook, inputJson, projectRoot)
    results.push(result)
  }
  return results
}
