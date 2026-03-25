import * as path from "node:path"

/** Maximum number of unique file paths tracked per session before oldest entries are evicted. */
const MAX_FILES_PER_SESSION = 500

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
  /** Map of sessionID → ordered list of relative file paths. */
  private readonly sessions = new Map<string, string[]>()

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

    let files = this.sessions.get(sessionID)
    if (!files) {
      files = []
      this.sessions.set(sessionID, files)
    }

    if (files.includes(normalised)) return

    if (files.length >= MAX_FILES_PER_SESSION) {
      files.shift() // FIFO eviction
    }

    files.push(normalised)
  }

  /**
   * Returns the set of relative file paths tracked for the given session.
   * Returns an empty `Set` if the session has no tracked files.
   */
  getTrackedFiles(sessionID: string): ReadonlySet<string> {
    const files = this.sessions.get(sessionID)
    return files ? new Set(files) : new Set()
  }

  /**
   * Removes all tracked file data for `sessionID`.
   * Call this when a session is deleted to free memory.
   */
  clearSession(sessionID: string): void {
    this.sessions.delete(sessionID)
  }
}
