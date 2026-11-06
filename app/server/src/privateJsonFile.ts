import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { fileReadErrorText } from "./errors.ts";

/** Private JSON persistence only. Callers own normalization and any cache. */
export function createPrivateJsonFile(
  path: string,
  label: string,
  options: {
    /** Create parents with 0700; enforce also tightens an existing parent. */
    privateDirectory?: "create" | "enforce";
    /** Keep compact stores' existing JSON representation. */
    compact?: boolean;
    /** Shared stores use unique temp names; callers still own write locking. */
    uniqueTemp?: boolean;
  } = {},
) {
  return {
    read<Stored, Value>(
      normalize: (value: Stored | undefined) => Value,
    ): Value {
      if (!existsSync(path)) return normalize(undefined);
      try {
        return normalize(JSON.parse(readFileSync(path, "utf8")) as Stored);
      } catch (err) {
        throw new Error(
          `Failed to read ${label} at ${path}: ${fileReadErrorText(err)}`,
        );
      }
    },
    write(value: unknown): void {
      const directory = dirname(path);
      mkdirSync(directory, {
        recursive: true,
        ...(options.privateDirectory ? { mode: 0o700 } : {}),
      });
      if (options.privateDirectory === "enforce") chmodSync(directory, 0o700);
      const tmp = options.uniqueTemp
        ? `${path}.${randomUUID()}.tmp`
        : `${path}.tmp`;
      const fd = openSync(tmp, options.uniqueTemp ? "wx" : "w", 0o600);
      try {
        try {
          fchmodSync(fd, 0o600);
          writeFileSync(
            fd,
            `${JSON.stringify(value, null, options.compact ? undefined : 2)}\n`,
            "utf8",
          );
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, path);
      } finally {
        if (options.uniqueTemp) rmSync(tmp, { force: true });
      }
    },
  };
}
