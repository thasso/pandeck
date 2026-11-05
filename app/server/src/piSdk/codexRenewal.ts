/**
 * The credential gateway's Codex refresher (`docs/workers.md` "Renewal"):
 * pi's own `getAuth` refresh for one profile's `auth.json`, injected into the
 * gateway as its port (`gateway/renewal.ts` `CodexRenewPort`) through
 * `harnesses/boot.ts`.
 *
 * pi's store is replaced by {@link AtomicAuthFileStore}, which takes pi's own
 * `proper-lockfile` lock with pi's options, so pi's engines, the server's pi
 * runtimes and this refresher serialise on one lock and re-check under it.
 * It never commits after a known lock loss, writes only when the
 * `openai-codex` entry is still what the refresh started from, keeps every
 * other provider's entry, and replaces the file by an atomic rename. It never
 * creates the file or its directory: a deleted profile stays deleted.
 *
 * The port answers no token and no message. This module never imports
 * `models.ts`, whose load refreshes the model catalog.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { lock as properLock } from "proper-lockfile";

const PROVIDER = "openai-codex";
/** pi's lock options and wait (`auth-storage.js` `acquireLockAsync`). */
const LOCK_STALE_MS = 30_000;
const LOCK_MAX_DELAY_MS = 2_000;
const STALE_TEMP_MS = 60_000;

/** The auth file or its directory is gone. */
class StoreGoneError extends Error {}
/** Another writer changed the entry while this one refreshed. */
class StoreConflictError extends Error {}
/** The lock was lost (`proper-lockfile`'s compromise) before the commit. */
class LockLostError extends Error {}

type LockFunction = typeof properLock;

type AuthData = Record<string, unknown>;

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function parseAuth(text: string): AuthData {
  const parsed: unknown = JSON.parse(text.replace(/^﻿/, ""));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new SyntaxError("auth.json is not an object");
  return parsed as AuthData;
}

/** The file's data, or undefined when it does not exist. */
function readAuth(path: string): AuthData | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (errnoOf(err) === "ENOENT") return undefined;
    throw err;
  }
  return parseAuth(text);
}

function removeStaleTemps(dir: string, prefix: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TEMP_MS;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    try {
      const path = join(dir, name);
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
    } catch {
      // Gone already.
    }
  }
}

/**
 * A pi `CredentialStore` over one `auth.json`, for renewal only: `modify`
 * commits under pi's lock by atomic rename, `delete` refuses.
 */
export class AtomicAuthFileStore implements CredentialStore {
  constructor(
    private readonly authPath: string,
    /** Test seams: the lock, and the commit's rename. */
    private readonly seams: {
      lock?: LockFunction;
      rename?: (from: string, to: string) => void;
    } = {},
  ) {}

  read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return Promise.resolve(
      readAuth(this.authPath)?.[providerId] as Credential | undefined,
    );
  }

  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const data = readAuth(this.authPath) ?? {};
    const infos: CredentialInfo[] = [];
    for (const [providerId, value] of Object.entries(data)) {
      const type = (value as { type?: unknown } | null)?.type;
      if (type === "oauth" || type === "api_key")
        infos.push({ providerId, type });
    }
    return Promise.resolve(infos);
  }

  delete(): Promise<void> {
    return Promise.reject(new Error("Renewal never deletes a credential."));
  }

  /** pi's acquisition: no retries inside, its own backoff to a 30 s deadline. */
  private async acquire(
    signal: AbortSignal | undefined,
    onCompromised: (err: Error) => void,
  ): Promise<() => Promise<void>> {
    const lock = this.seams.lock ?? properLock;
    const deadline = Date.now() + LOCK_STALE_MS;
    for (let retry = 0; ; retry++) {
      signal?.throwIfAborted();
      try {
        const release = await lock(this.authPath, {
          realpath: false,
          retries: 0,
          stale: LOCK_STALE_MS,
          onCompromised,
        });
        if (signal?.aborted) {
          await release().catch(() => {});
          signal.throwIfAborted();
        }
        return release;
      } catch (err) {
        signal?.throwIfAborted();
        if (errnoOf(err) === "ENOENT")
          throw new StoreGoneError("auth.json's directory is gone");
        const remainingMs = deadline - Date.now();
        if (errnoOf(err) !== "ELOCKED" || remainingMs <= 0) throw err;
        const baseDelayMs = Math.min(10 * 2 ** retry, LOCK_MAX_DELAY_MS / 2);
        const delayMs = Math.min(
          Math.round(baseDelayMs * (1 + Math.random())),
          remainingMs,
        );
        await sleep(delayMs, undefined, signal ? { signal } : undefined);
      }
    }
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (!existsSync(this.authPath))
      throw new StoreGoneError("auth.json is gone");
    let compromised: Error | undefined;
    const throwIfCompromised = (): void => {
      if (compromised) throw new LockLostError("auth.json's lock was lost");
    };
    const release = await this.acquire(options?.signal, (err) => {
      compromised = err;
    });
    try {
      throwIfCompromised();
      const seen = readAuth(this.authPath);
      if (!seen) throw new StoreGoneError("auth.json is gone");
      const seenEntry = seen[providerId] as Credential | undefined;
      const next = await fn(seenEntry);
      throwIfCompromised();
      if (next === undefined) return seenEntry;
      // Synchronous from here to the rename: no other writer's turn between.
      const target = realpathSync(this.authPath);
      let fresh: AuthData | undefined;
      try {
        fresh = readAuth(target);
      } catch {
        throw new StoreConflictError("auth.json changed while refreshing");
      }
      if (!fresh) throw new StoreGoneError("auth.json is gone");
      if (!isDeepStrictEqual(fresh[providerId], seenEntry))
        throw new StoreConflictError("the entry changed while refreshing");
      const text = JSON.stringify({ ...fresh, [providerId]: next }, null, 2);
      const dir = dirname(target);
      const prefix = `${basename(target)}.pandeck-`;
      removeStaleTemps(dir, prefix);
      const temp = join(dir, `${prefix}${randomBytes(8).toString("hex")}.tmp`);
      try {
        const fd = openSync(temp, "wx", 0o600);
        try {
          fchmodSync(fd, 0o600);
          writeSync(fd, text);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        throwIfCompromised();
        (this.seams.rename ?? renameSync)(temp, target);
      } catch (err) {
        try {
          unlinkSync(temp);
        } catch {
          // Never created, or renamed already.
        }
        if (errnoOf(err) === "ENOENT")
          throw new StoreGoneError("auth.json's directory is gone");
        throw err;
      }
      return next;
    } finally {
      // A compromised lock is already released and another holder's kept.
      await release().catch(() => {});
    }
  }
}

export type CodexRenewResult =
  { ok: true } | { ok: false; kind: "rejected" | "failed"; code: string };

/** The first known class or code on `error`'s cause chain (four levels). */
function classify(error: unknown): CodexRenewResult {
  let oauth = false;
  let status: string | undefined;
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined; depth++) {
    if (current instanceof StoreGoneError)
      return { ok: false, kind: "failed", code: "gone" };
    if (current instanceof StoreConflictError)
      return { ok: false, kind: "failed", code: "conflict" };
    if (current instanceof LockLostError)
      return { ok: false, kind: "failed", code: "lock_lost" };
    if (errnoOf(current) === "ELOCKED")
      return { ok: false, kind: "failed", code: "lock_busy" };
    if ((current as { name?: unknown } | null)?.name === "AbortError")
      return { ok: false, kind: "failed", code: "aborted" };
    const named = current as { name?: unknown; code?: unknown } | null;
    if (named?.name === "ModelsError" && named.code === "oauth") oauth = true;
    const message = current instanceof Error ? current.message : "";
    status ??= /\((40[01])\)/.exec(message)?.[1];
    current = (current as { cause?: unknown } | null)?.cause;
  }
  if (oauth && status) return { ok: false, kind: "rejected", code: status };
  const top = error as { name?: unknown; code?: unknown } | null;
  const code =
    top?.name === "ModelsError" && (top.code === "oauth" || top.code === "auth")
      ? top.code
      : "error";
  return { ok: false, kind: "failed", code };
}

let flowsRegistered = false;

/**
 * Renews `authFile`'s Codex login unless it stays valid for `minValidityMs`
 * (`remaining + 1` forces it). Answers no token: the gateway reads the file.
 */
export async function renewCodexCredential(
  authFile: string,
  minValidityMs: number,
  signal: AbortSignal,
  /** Test seams of the store. */
  seams?: ConstructorParameters<typeof AtomicAuthFileStore>[1],
): Promise<CodexRenewResult> {
  if (!flowsRegistered) {
    // The Bun bundle has no sibling flow files to import (`models.ts`).
    registerBunOAuthFlows();
    flowsRegistered = true;
  }
  try {
    const runtime = await ModelRuntime.create({
      credentials: new AtomicAuthFileStore(authFile, seams),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const auth = await runtime.getAuth(PROVIDER, {
      minOAuthValidityMs: minValidityMs,
      signal,
    });
    return auth
      ? { ok: true }
      : { ok: false, kind: "failed", code: "no_credential" };
  } catch (error) {
    return classify(error);
  }
}
