/**
 * Maps OpenCode tool names to their Copilot-equivalent names where they differ.
 * Only entries that differ are listed — everything else passes through unchanged.
 */
const opencodeToCopilot: Readonly<Record<string, string>> = {
  read: "view",
  write: "create",
}

/**
 * Returns the Copilot-equivalent tool name for a given OpenCode tool name.
 * Existing Copilot hook scripts use Copilot names, so this ensures they work unmodified.
 */
export function toCopilotToolName(name: string): string {
  return opencodeToCopilot[name] ?? name
}
