import picomatch from "picomatch"

/**
 * Returns `true` if at least one path in `trackedFiles` matches at least one of
 * the `applyTo` glob patterns.
 *
 * Patterns follow the same glob syntax as GitHub Copilot's `applyTo` field:
 *
 * - `*`       — matches all files in the current directory
 * - `**`      — matches all files in all directories
 * - `**\/*.ts` — matches all `.ts` files recursively
 *
 * Matching is performed with `dot: true` so that dotfiles (e.g. `.env`) are
 * included when patterns like `**` are used.
 *
 * Each pattern is compiled once and the function short-circuits on the first hit
 * so it is safe to call on every LLM turn.
 */
export function matchesApplyTo(
  trackedFiles: ReadonlySet<string>,
  applyToPatterns: string[],
): boolean {
  if (trackedFiles.size === 0 || applyToPatterns.length === 0) return false

  const matchers = applyToPatterns.map((pattern) => picomatch(pattern, { dot: true }))

  for (const filePath of trackedFiles) {
    for (const isMatch of matchers) {
      if (isMatch(filePath)) return true
    }
  }

  return false
}
