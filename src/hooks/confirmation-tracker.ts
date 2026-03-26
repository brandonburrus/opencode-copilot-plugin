/**
 * Tracks which `preToolUse` hook commands have returned `"ask"` for a given tool+args
 * within a session, enabling one-shot bypass of that specific hook on retry.
 *
 * When a hook returns `"ask"`, the tool call is blocked and the agent is instructed to
 * confirm with the user before retrying. On the next identical call (same tool name +
 * same serialized args), `consumeConfirmation` returns true for that specific hook index,
 * allowing it to be skipped while all other hooks still run normally.
 */
export class HookConfirmationTracker {
  private readonly pending = new Map<string, Set<string>>()

  /**
   * Records that hook at `hookIndex` returned `"ask"` for this tool+args combination.
   * The composite key encodes the hook index, tool name, and exact args JSON.
   */
  markPendingConfirmation(sessionID: string, hookIndex: number, toolName: string, argsJson: string): void {
    let confirmations = this.pending.get(sessionID)
    if (!confirmations) {
      confirmations = new Set()
      this.pending.set(sessionID, confirmations)
    }
    confirmations.add(this.key(hookIndex, toolName, argsJson))
  }

  /**
   * Checks if a pending confirmation exists for this hook+tool+args combination.
   * If it does, removes it (one-shot) and returns `true` so the caller can skip
   * running that hook. Returns `false` if no pending confirmation exists.
   */
  consumeConfirmation(sessionID: string, hookIndex: number, toolName: string, argsJson: string): boolean {
    const confirmations = this.pending.get(sessionID)
    if (!confirmations) return false

    const k = this.key(hookIndex, toolName, argsJson)
    if (!confirmations.has(k)) return false

    confirmations.delete(k)
    if (confirmations.size === 0) this.pending.delete(sessionID)
    return true
  }

  /** Removes all pending confirmations for a session. Call on `session.deleted`. */
  clearSession(sessionID: string): void {
    this.pending.delete(sessionID)
  }

  private key(hookIndex: number, toolName: string, argsJson: string): string {
    return `${hookIndex}:${toolName}:${argsJson}`
  }
}
