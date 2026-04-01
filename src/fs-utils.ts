import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Dirent } from "node:fs"

/**
 * Returns true if the dirent represents a regular file or a symlink that resolves to one.
 * `Dirent.isFile()` returns false for symlinks, so we follow them via `fs.stat`.
 */
export async function entryIsFile(entry: Dirent, dir: string): Promise<boolean> {
  if (entry.isFile()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    const stat = await fs.stat(path.join(dir, entry.name))
    return stat.isFile()
  } catch {
    return false
  }
}

/**
 * Returns true if the dirent represents a directory or a symlink that resolves to one.
 * `Dirent.isDirectory()` returns false for symlinks, so we follow them via `fs.stat`.
 */
export async function entryIsDirectory(entry: Dirent, dir: string): Promise<boolean> {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false
  try {
    const stat = await fs.stat(path.join(dir, entry.name))
    return stat.isDirectory()
  } catch {
    return false
  }
}
