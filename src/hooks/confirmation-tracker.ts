/**
 * Tracks which `preToolUse` hook commands have returned `"ask"` for a given tool+args
 * within a session, enabling one-shot bypass of that specific hook on retry.
 *
 * When a hook returns `"ask"`, the tool call is blocked and the agent is instructed to
 * confirm with the user before retrying. On the next identical call (same tool name +
 * same serialized args), `consumeConfirmation` returns true for that specific hook key,
 * allowing it to be skipped while all other hooks still run normally.
 *
 * Hook keys are namespaced to avoid collisions between global and agent-scoped hooks:
 * - Global hooks use the key format `"global:<index>"`
 * - Agent-scoped hooks use the key format `"agent:<agentName>:<index>"`
 */
export class HookConfirmationTracker {
  private readonly pending = new Map<string, Set<string>>()

  /**
   * Records that the hook identified by `hookKey` returned `"ask"` for this tool+args combination.
   * The composite key encodes the hook key, tool name, and exact args JSON.
   */
  markPendingConfirmation(sessionID: string, hookKey: string, toolName: string, argsJson: string): void {
    let confirmations = this.pending.get(sessionID)
    if (!confirmations) {
      confirmations = new Set()
      this.pending.set(sessionID, confirmations)
    }
    confirmations.add(this.key(hookKey, toolName, argsJson))
  }

  /**
   * Checks if a pending confirmation exists for this hook+tool+args combination.
   * If it does, removes it (one-shot) and returns `true` so the caller can skip
   * running that hook. Returns `false` if no pending confirmation exists.
   */
  consumeConfirmation(sessionID: string, hookKey: string, toolName: string, argsJson: string): boolean {
    const confirmations = this.pending.get(sessionID)
    if (!confirmations) return false

    const k = this.key(hookKey, toolName, argsJson)
    if (!confirmations.has(k)) return false

    confirmations.delete(k)
    if (confirmations.size === 0) this.pending.delete(sessionID)
    return true
  }

  /** Removes all pending confirmations for a session. Call on `session.deleted`. */
  clearSession(sessionID: string): void {
    this.pending.delete(sessionID)
  }

  private key(hookKey: string, toolName: string, argsJson: string): string {
    return `${hookKey}:${toolName}:${argsJson}`
  }
}
