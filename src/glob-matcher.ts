import picomatch from "picomatch"

/**
 * Universal `applyTo` patterns that match every file unconditionally.
 * Instructions using these patterns are always injected without requiring any tracked files.
 */
const UNIVERSAL_PATTERNS = new Set(["**", "**/*"])

/**
 * Returns true if at least one path in trackedFiles matches at least one of
 * the applyTo glob patterns.
 *
 * Patterns follow the same glob syntax as GitHub Copilot's applyTo field.
 * "**" and "**\/*" are treated as universal: they return true immediately without
 * requiring any tracked files, making the instruction always-applied.
 *
 * Matching is performed with dot:true so that dotfiles (e.g. .env) are
 * included when patterns like "**" are used.
 *
 * Each pattern is compiled once and the function short-circuits on the first hit
 * so it is safe to call on every LLM turn.
 */
export function matchesApplyTo(
  trackedFiles: ReadonlySet<string>,
  applyToPatterns: string[],
): boolean {
  if (applyToPatterns.length === 0) return false

  if (applyToPatterns.some((p) => UNIVERSAL_PATTERNS.has(p))) return true

  if (trackedFiles.size === 0) return false

  const matchers = applyToPatterns.map((pattern) => picomatch(pattern, { dot: true }))

  for (const filePath of trackedFiles) {
    for (const isMatch of matchers) {
      if (isMatch(filePath)) return true
    }
  }

  return false
}
