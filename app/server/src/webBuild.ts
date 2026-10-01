import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Stable id for one Vite web build. `index.html` names the content-addressed
 * entry chunk, so hashing the shell changes whenever the browser application
 * changes while staying stable across server-only restarts.
 */
export function webBuildId(indexPath: string): string | undefined {
  try {
    return createHash("sha256")
      .update(readFileSync(indexPath))
      .digest("hex")
      .slice(0, 16);
  } catch {
    // Development and focused server tests may run before a web build exists.
    return undefined;
  }
}
