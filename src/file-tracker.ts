import * as path from "node:path"

/** Maximum number of unique file paths tracked per session before oldest entries are evicted. */
const MAX_FILES_PER_SESSION = 500

interface SessionState {
  files: Set<string>
  insertionOrder: string[]
}

/**
 * Tracks which file paths have been accessed (read, edited, written) within each session.
 *
 * Paths are normalised to be relative to the project root before storage so that they
 * can be directly compared against `applyTo` glob patterns without any prefix stripping.
 *
 * Memory is bounded: once a session reaches `MAX_FILES_PER_SESSION` entries the oldest
 * tracked path is dropped before the new one is added (FIFO eviction).
 */
export class FileTracker {
  /** Map of sessionID → per-session state holding a Set for O(1) lookup and an insertion-order queue for FIFO eviction. */
  private readonly sessions = new Map<string, SessionState>()

  /**
   * Records that `filePath` was accessed during `sessionID`.
   *
   * Absolute paths are made relative to `rootDir` before storage.
   * Relative paths are stored as-is (already normalised by the caller or the tool args).
   * Duplicate entries within the same session are silently ignored.
   */
  trackFile(sessionID: string, filePath: string, rootDir: string): void {
    const relative = path.isAbsolute(filePath) ? path.relative(rootDir, filePath) : filePath

    // Normalise to forward slashes so picomatch patterns work cross-platform.
    const normalised = relative.split(path.sep).join("/")

    let state = this.sessions.get(sessionID)
    if (!state) {
      state = { files: new Set(), insertionOrder: [] }
      this.sessions.set(sessionID, state)
    }

    if (state.files.has(normalised)) return

    if (state.insertionOrder.length >= MAX_FILES_PER_SESSION) {
      const oldest = state.insertionOrder.shift()!
      state.files.delete(oldest)
    }

    state.files.add(normalised)
    state.insertionOrder.push(normalised)
  }

  /**
   * Returns the set of relative file paths tracked for the given session.
   * Returns an empty `Set` if the session has no tracked files.
   */
  getTrackedFiles(sessionID: string): ReadonlySet<string> {
    return this.sessions.get(sessionID)?.files ?? new Set<string>()
  }

  /**
   * Removes all tracked file data for `sessionID`.
   * Call this when a session is deleted to free memory.
   */
  clearSession(sessionID: string): void {
    this.sessions.delete(sessionID)
  }
}
