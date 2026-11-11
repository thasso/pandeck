/**
 * The vault's integration credentials (Task-1397): one opaque record per user
 * and integration at `<stateDir>/accounts/<int-…>/integration.json` (0600,
 * by temp file and rename), the directory named by `integrationDirId`. A
 * sealing vault seals it right after the write (`written`) and deletes its
 * record on clear (`discarded`); the sweep, unlock and reseal cover it like a
 * token file (`sealedStore.ts`). The vault parses nothing in the record, and
 * no log line holds it.
 */
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { INTEGRATION_FILE, integrationDirId } from "./vaultMethods.ts";
import type { VaultPort } from "./vaultPort.ts";

export interface VaultIntegrationOptions {
  /** Without one the vault keeps no integration credential. */
  stateDir: string | undefined;
  /** A sealing vault's seal-after-write and record deletion. */
  written?: ((file: string) => void) | undefined;
  discarded?: ((dirId: string) => void) | undefined;
}

export function createVaultIntegrations(
  options: VaultIntegrationOptions,
): Pick<VaultPort, "integrationPut" | "integrationGet" | "integrationClear"> {
  const { stateDir } = options;
  const locate = (userId: string, integration: string) => {
    const dirId = integrationDirId(userId, integration);
    const dir = join(stateDir!, "accounts", dirId);
    return { dirId, dir, file: join(dir, INTEGRATION_FILE) };
  };
  return {
    integrationPut(userId, integration, credential) {
      if (!stateDir) return Promise.resolve({ ok: false, unavailable: true });
      const { dir, file } = locate(userId, integration);
      const temp = join(
        dir,
        `.${INTEGRATION_FILE}.${randomBytes(6).toString("hex")}.tmp`,
      );
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(temp, credential, { mode: 0o600 });
        renameSync(temp, file);
      } catch {
        try {
          rmSync(temp, { force: true });
        } catch {
          // The directory itself is unusable; nothing was written.
        }
        return Promise.resolve({ ok: false, unavailable: true });
      }
      options.written?.(file);
      return Promise.resolve({ ok: true });
    },
    integrationGet(userId, integration, { signal } = {}) {
      if (!stateDir || signal?.aborted)
        return Promise.resolve({ ok: false, unavailable: true });
      try {
        const credential = readFileSync(
          locate(userId, integration).file,
          "utf8",
        );
        return Promise.resolve({ ok: true, credential });
      } catch (err) {
        return Promise.resolve(
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? { ok: false, absent: true }
            : { ok: false, unavailable: true },
        );
      }
    },
    integrationClear(userId, integration) {
      if (!stateDir) return Promise.resolve({ ok: false, unavailable: true });
      const { dirId, dir } = locate(userId, integration);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        return Promise.resolve({ ok: false, unavailable: true });
      }
      options.discarded?.(dirId);
      return Promise.resolve({ ok: true });
    },
  };
}
