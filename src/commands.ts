import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pluginLog } from "./log.ts";

/**
 * Symlinks `.md` stub files from the plugin's `commands/` directory into
 * `~/.config/opencode/commands/` so OpenCode's command picker discovers them
 * at startup.
 *
 * Stale symlinks (pointing to a different source path) are replaced. Regular
 * files at the target path are skipped with a warning to avoid clobbering
 * user-created commands.
 */
export async function registerCommandSymlinks(pluginDir: string): Promise<void> {
  try {
    const sourceDir = path.join(pluginDir, "commands");
    const targetDir = path.join(os.homedir(), ".config", "opencode", "commands");

    await fs.mkdir(targetDir, { recursive: true });

    const entries = await fs.readdir(sourceDir, { withFileTypes: true });

    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map(async (entry) => {
          const sourcePath = path.join(sourceDir, entry.name);
          const targetPath = path.join(targetDir, entry.name);

          try {
            const stat = await fs.lstat(targetPath);

            if (stat.isSymbolicLink()) {
              const existingTarget = await fs.readlink(targetPath);
              if (existingTarget === sourcePath) return;
              await fs.unlink(targetPath);
              await fs.symlink(sourcePath, targetPath);
            } else {
              pluginLog("warn", `Skipping command registration for ${entry.name}: a non-symlink file already exists at ${targetPath}`);
            }
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              await fs.symlink(sourcePath, targetPath);
            } else {
              throw err;
            }
          }
        })
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pluginLog("error", `Failed to register command symlinks: ${message}`);
  }
}
