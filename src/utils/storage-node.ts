/**
 * Node.js Storage Provider
 * Implements StorageProvider using Node.js fs/promises
 */

import * as fs from "fs/promises";
import * as nodePath from "path";
import * as os from "os";
import glob from "fast-glob";
import type { StorageProvider } from "./storage.js";

/**
 * Node.js implementation of StorageProvider
 * Uses fs/promises for file operations
 */
export class NodeStorageProvider implements StorageProvider {
  /**
   * Filters out matched paths whose parent directories cannot be read by
   * the current process. fast-glob's `suppressErrors` does not prevent
   * per-entry permission warnings from being surfaced as log lines by the
   * embedding host (e.g. OpenCode), so we drop unreadable entries here.
   */
  private static async filterReadable(paths: readonly string[]): Promise<string[]> {
    const results = await Promise.all(
      paths.map(async (entry) => {
        try {
          // Stat the parent directory rather than the file itself: the
          // file may be readable while its directory was the failing
          // scandir, which is the exact case fast-glob warned about.
          await fs.access(nodePath.dirname(entry));
          return entry;
        } catch {
          return undefined;
        }
      }),
    );
    return results.filter((entry): entry is string => entry !== undefined);
  }
  /**
   * Reads a file as binary data
   */
  async readFile(path: string): Promise<Uint8Array> {
    const buffer = await fs.readFile(path);
    return new Uint8Array(buffer);
  }

  /**
   * Reads a file as text
   */
  async readTextFile(path: string, encoding?: string): Promise<string> {
    // Handle latin1 encoding (used by nam_dict.txt)
    const nodeEncoding = encoding === "latin1" ? "latin1" : "utf-8";
    return fs.readFile(path, { encoding: nodeEncoding as BufferEncoding });
  }

  async resolveFiles(patterns: string[], baseDirectory?: string): Promise<string[]> {
    const cwd = baseDirectory ?? process.cwd();
    // Preserve existing literal paths containing glob metacharacters.
    const inputs = await Promise.all(patterns.map(async (pattern) => {
      if (await this.exists(nodePath.resolve(cwd, pattern))) {
        return glob.convertPathToPattern(pattern);
      }
      return pattern;
    }));
    if (inputs.length === 0) return [];
    try {
      const matched = (await glob(inputs, {
        cwd,
        absolute: true,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        unique: true,
        ignore: ["**/node_modules/**", "**/.git/**"],
      })).sort();
      // fast-glob's `suppressErrors` still prints per-entry EACCES/EPERM
      // warnings through the Taskgraph / internal warning channel that the
      // OpenCode host surfaces as WARN log lines on every periodic reload.
      // Filter the results ourselves to drop entries that point at
      // subtrees we cannot stat, which prevents those WARN logs without
      // changing the happy-path behavior.
      return await NodeStorageProvider.filterReadable(matched);
    } catch (error) {
      // Defensive fallback: if fast-glob still throws for a reason that
      // escapes `suppressErrors` (e.g. cwd missing), degrade to an empty
      // result rather than breaking callers like plugin setup.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /**
   * Writes data to a file
   */
  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    // Ensure parent directory exists
    const dir = nodePath.dirname(path);
    await fs.mkdir(dir, { recursive: true });

    if (typeof data === "string") {
      await fs.writeFile(path, data, "utf-8");
    } else {
      await fs.writeFile(path, data);
    }
  }

  /**
   * Checks if a file or directory exists
   */
  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates a directory
   */
  async mkdir(path: string): Promise<void> {
    await fs.mkdir(path, { recursive: true });
  }

  /**
   * Removes a file or directory
   */
  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean }
  ): Promise<void> {
    await fs.rm(path, {
      recursive: options?.recursive ?? false,
      force: options?.force ?? false,
    });
  }

  /**
   * Gets the platform-specific cache directory
   */
  getCacheDir(subdir: string): string {
    const homeDir = os.homedir();

    let baseDir: string;
    switch (process.platform) {
      case "darwin":
        baseDir = nodePath.join(homeDir, "Library", "Caches");
        break;
      case "win32":
        baseDir =
          process.env["LOCALAPPDATA"] ??
          nodePath.join(homeDir, "AppData", "Local");
        break;
      default:
        // Linux and others - use XDG_CACHE_HOME or ~/.cache
        baseDir =
          process.env["XDG_CACHE_HOME"] ?? nodePath.join(homeDir, ".cache");
        break;
    }

    return nodePath.join(baseDir, "rehydra", subdir);
  }
}

