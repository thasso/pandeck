import { mkdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DATA_DIR } from "./config.ts";

/** Dedicated scratch directory, created only when a new PA session needs it. */
export const DEFAULT_ASSISTANT_WORKING_DIRECTORY = join(
  DATA_DIR,
  "personal-assistant",
);

/** A configured cwd is never created implicitly or resolved relative to the app. */
export function validateAssistantWorkingDirectory(path: string): void {
  if (path === "") return;
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error(
      "Personal Assistant working directory must be an absolute path to an existing directory, or empty for the default.",
    );
  try {
    if (statSync(path).isDirectory()) return;
  } catch {
    // Missing and unreadable paths are both unusable as a session cwd.
  }
  throw new Error(
    `Personal Assistant working directory is not an existing directory: ${path}`,
  );
}

/** Resolve once at session start; a lost configured directory cannot block opening. */
export function resolveAssistantWorkingDirectory(configured: string): {
  cwd: string;
  notice?: string;
} {
  if (configured) {
    try {
      validateAssistantWorkingDirectory(configured);
      return { cwd: configured };
    } catch {
      mkdirSync(DEFAULT_ASSISTANT_WORKING_DIRECTORY, { recursive: true });
      return {
        cwd: DEFAULT_ASSISTANT_WORKING_DIRECTORY,
        notice: `The configured Personal Assistant working directory is unavailable: ${configured}. This conversation uses ${DEFAULT_ASSISTANT_WORKING_DIRECTORY} instead. Choose an existing directory in Settings to change it.`,
      };
    }
  }
  mkdirSync(DEFAULT_ASSISTANT_WORKING_DIRECTORY, { recursive: true });
  return { cwd: DEFAULT_ASSISTANT_WORKING_DIRECTORY };
}
