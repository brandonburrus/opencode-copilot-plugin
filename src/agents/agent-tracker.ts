/**
 * Tracks which Copilot agent is active within each session.
 *
 * When the LLM calls the `copilot_agent` tool, the loaded agent's name is recorded
 * here for the session. This enables agent-scoped hooks to be dispatched only when
 * the corresponding agent is active.
 *
 * Only one agent can be active per session at a time. Loading a new agent replaces
 * the previously active one.
 */
export class AgentTracker {
  private readonly sessions = new Map<string, string>()

  /** Records that `agentName` is now the active agent for `sessionID`. */
  setActiveAgent(sessionID: string, agentName: string): void {
    this.sessions.set(sessionID, agentName)
  }

  /**
   * Returns the name of the active agent for `sessionID`,
   * or `undefined` if no agent has been loaded in this session.
   */
  getActiveAgent(sessionID: string): string | undefined {
    return this.sessions.get(sessionID)
  }

  /** Removes the active agent record for `sessionID`. Call on `session.deleted`. */
  clearSession(sessionID: string): void {
    this.sessions.delete(sessionID)
  }
}
