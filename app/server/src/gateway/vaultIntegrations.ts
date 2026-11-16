/**
 * The vault's integration credentials (Task-1397, Task-1411): one record per
 * user and integration at `<stateDir>/accounts/<int-…>/integration.json`
 * (0600, by temp file and rename), the directory named by `integrationDirId`.
 * A sealing vault seals it right after each write (`written`) and deletes its
 * record on clear (`discarded`); the sweep, unlock and reseal cover it like a
 * token file (`sealedStore.ts`).
 *
 * A record is either an API token the edge put, kept opaque and answered
 * verbatim, or an Atlassian OAuth record this module wrote itself after a
 * code exchange: `{kind: "atlassian-oauth", v: 1, site, cloudId,
 * refreshToken, scope}`. Only those are parsed. A get of one answers the
 * access view `{kind, site, cloudId, accessToken, expiresAt}`; the access
 * token lives only in memory, so the first get after a restart refreshes.
 *
 * Every write to a record (put, clear, connect, refresh) runs in its lane,
 * one at a time and in order. A refresh is single-flight per record, re-reads
 * the record in the lane, and writes the rotated refresh token before it
 * caches or answers anything: Atlassian rotates it on every use. Neither a
 * refresh nor a connect follows a caller's signal; a caller that stops
 * waiting only stops its own wait.
 *
 * `close()` stops admission at once: every later put, clear, connect or
 * refresh answers unavailable, queued ones are refused unrun, and it resolves
 * once each lane's running item, write and seal included, has ended. Running
 * items are bounded by their own Atlassian deadlines, never aborted.
 *
 * No log line holds a record, token, code or the client secret.
 */
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { IntegrationClients } from "./integrationClients.ts";
import {
  atlassianResources,
  exchangeAtlassianCode,
  refreshAtlassian,
  selectAtlassianSite,
  type AtlassianEndpoint,
  type AtlassianTokens,
} from "./vaultAtlassian.ts";
import {
  INTEGRATION_FILE,
  integrationDirId,
  isAtlassianSite,
  isCloudId,
} from "./vaultMethods.ts";
import type {
  IntegrationConnect,
  IntegrationRecord,
  IntegrationWrite,
  VaultPort,
} from "./vaultPort.ts";

/** A cached access token this close to expiry is refreshed first. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const OAUTH_KIND = "atlassian-oauth";

export interface VaultIntegrationOptions {
  /** Without one the vault keeps no integration credential. */
  stateDir: string | undefined;
  /** A sealing vault's seal-after-write and record deletion. */
  written?: ((file: string) => void) | undefined;
  discarded?: ((dirId: string) => void) | undefined;
  /** The vault's OAuth clients; without Atlassian's a connect is refused. */
  clients?: IntegrationClients | undefined;
  /** Test seam: where Atlassian is reached (`vaultAtlassian.ts`). */
  atlassianEndpoint?: AtlassianEndpoint | undefined;
}

export interface VaultIntegrations extends Pick<
  VaultPort,
  | "integrationPut"
  | "integrationGet"
  | "integrationClear"
  | "integrationConnect"
> {
  /**
   * Admits nothing further, refuses what is queued, and resolves once each
   * running item has ended. Synchronous up to its first await.
   */
  close(): Promise<void>;
}

/** The record this module writes; never leaves the vault. */
interface OAuthRecord {
  kind: typeof OAUTH_KIND;
  v: 1;
  site: string;
  cloudId: string;
  refreshToken: string;
  scope: string;
}

/** The in-memory half of an OAuth record. */
interface AccessView {
  site: string;
  cloudId: string;
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

interface LaneItem {
  run(): Promise<void>;
  refuse(): void;
}

interface Lane {
  queue: LaneItem[];
  running: Promise<void> | undefined;
}

const UNAVAILABLE = { ok: false, unavailable: true } as const;

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The OAuth record in `text`; `undefined` when the text is not one (an API
 * token record), `"malformed"` when it says it is one but is not.
 */
function oauthRecordOf(text: string): OAuthRecord | "malformed" | undefined {
  let fields: Record<string, unknown> | undefined;
  try {
    fields = objectOf(JSON.parse(text));
  } catch {
    return undefined;
  }
  if (fields?.kind !== OAUTH_KIND) return undefined;
  const { v, site, cloudId, refreshToken, scope } = fields;
  return v === 1 &&
    isAtlassianSite(site) &&
    isCloudId(cloudId) &&
    typeof refreshToken === "string" &&
    refreshToken.length > 0 &&
    typeof scope === "string"
    ? { kind: OAUTH_KIND, v: 1, site, cloudId, refreshToken, scope }
    : "malformed";
}

/** The access view as the credential string the edge decodes. */
function viewCredential(view: AccessView): IntegrationRecord {
  return {
    ok: true,
    credential: JSON.stringify({
      kind: OAUTH_KIND,
      site: view.site,
      cloudId: view.cloudId,
      accessToken: view.accessToken,
      expiresAt: view.expiresAt,
    }),
  };
}

export function createVaultIntegrations(
  options: VaultIntegrationOptions,
  log: (line: string) => void = () => {},
  now: () => number = Date.now,
): VaultIntegrations {
  const { stateDir } = options;
  const locate = (userId: string, integration: string) => {
    const dirId = integrationDirId(userId, integration);
    const dir = join(stateDir!, "accounts", dirId);
    return { dirId, dir, file: join(dir, INTEGRATION_FILE) };
  };

  let closed = false;
  const lanes = new Map<string, Lane>();
  /** Access tokens by record directory; memory only. */
  const cache = new Map<string, AccessView>();
  /** Each record's refresh in flight, queued or running. */
  const refreshing = new Map<string, Promise<IntegrationRecord>>();

  const pump = (dirId: string, lane: Lane): void => {
    if (lane.running) return;
    const item = lane.queue.shift();
    if (!item) {
      lanes.delete(dirId);
      return;
    }
    lane.running = item.run().finally(() => {
      lane.running = undefined;
      pump(dirId, lane);
    });
  };

  /**
   * Runs `work` in the record's lane after everything queued before it, or
   * answers `refused` without running it once closed.
   */
  const enqueue = <T>(
    dirId: string,
    work: () => Promise<T>,
    refused: T,
  ): Promise<T> => {
    if (closed) return Promise.resolve(refused);
    return new Promise<T>((resolve) => {
      const lane = lanes.get(dirId) ?? { queue: [], running: undefined };
      lanes.set(dirId, lane);
      lane.queue.push({
        run: async () => {
          try {
            resolve(await work());
          } catch {
            // Hooks and filesystem work can throw before returning a promise.
            resolve(refused);
          }
        },
        refuse: () => resolve(refused),
      });
      pump(dirId, lane);
    });
  };

  /** Temp file and rename, then the seal; false when nothing was written. */
  const writeRecord = (dir: string, file: string, text: string): boolean => {
    const temp = join(
      dir,
      `.${INTEGRATION_FILE}.${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(temp, text, { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      try {
        rmSync(temp, { force: true });
      } catch {
        // The directory itself is unusable; nothing was written.
      }
      return false;
    }
    options.written?.(file);
    return true;
  };

  /** The record's text, or why there is none as the answer to give. */
  const readRecord = (
    file: string,
  ): { text: string } | { answer: IntegrationRecord } => {
    try {
      return { text: readFileSync(file, "utf8") };
    } catch (err) {
      return {
        answer:
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? { ok: false, absent: true }
            : UNAVAILABLE,
      };
    }
  };

  const viewOf = (
    stored: OAuthRecord,
    tokens: AtlassianTokens,
    issuedAt: number,
  ): AccessView => ({
    site: stored.site,
    cloudId: stored.cloudId,
    accessToken: tokens.accessToken,
    expiresAt: issuedAt + tokens.expiresInS * 1000,
  });

  const fresh = (view: AccessView | undefined): view is AccessView =>
    view !== undefined && view.expiresAt - now() > REFRESH_MARGIN_MS;

  /** In the lane: the record as it is now, refreshed when still due. */
  const refreshInLane = async (
    dirId: string,
    file: string,
  ): Promise<IntegrationRecord> => {
    const read = readRecord(file);
    if ("answer" in read) return read.answer;
    const stored = oauthRecordOf(read.text);
    // Replaced by an API token while queued: answered as it is now.
    if (stored === undefined) return { ok: true, credential: read.text };
    if (stored === "malformed") return UNAVAILABLE;
    const cached = cache.get(dirId);
    if (fresh(cached)) return viewCredential(cached);
    const client = options.clients?.atlassian;
    if (!client) {
      log(`integration ${dirId}: no Atlassian OAuth client to refresh with`);
      return UNAVAILABLE;
    }
    const issuedAt = now();
    const result = await refreshAtlassian(
      client,
      stored.refreshToken,
      options.atlassianEndpoint,
    );
    if (result.kind === "rejected") {
      log(`integration ${dirId}: Atlassian rejected the refresh`);
      return { ok: false, rejected: true };
    }
    if (result.kind === "unreachable") {
      log(`integration ${dirId}: refresh failed (${result.code})`);
      return UNAVAILABLE;
    }
    const rotated: OAuthRecord = {
      ...stored,
      refreshToken: result.tokens.refreshToken ?? stored.refreshToken,
      scope: result.tokens.scope ?? stored.scope,
    };
    // The rotation is on disk before anything is cached or answered.
    if (!writeRecord(dirname(file), file, JSON.stringify(rotated))) {
      log(`integration ${dirId}: the refreshed record was not saved`);
      return UNAVAILABLE;
    }
    const view = viewOf(stored, result.tokens, issuedAt);
    cache.set(dirId, view);
    return viewCredential(view);
  };

  /** Joins the record's refresh in flight, or queues one. */
  const refresh = (dirId: string, file: string): Promise<IntegrationRecord> => {
    let flight = refreshing.get(dirId);
    if (!flight) {
      flight = enqueue(dirId, () => refreshInLane(dirId, file), UNAVAILABLE);
      refreshing.set(dirId, flight);
      const settled = flight;
      void settled.finally(() => {
        if (refreshing.get(dirId) === settled) refreshing.delete(dirId);
      });
    }
    return flight;
  };

  /** `answer`, unless `signal` aborts first: then unavailable at once. */
  const untilAborted = (
    answer: Promise<IntegrationRecord>,
    signal: AbortSignal | undefined,
  ): Promise<IntegrationRecord> => {
    if (!signal) return answer;
    return new Promise((resolve) => {
      const onAbort = (): void => resolve(UNAVAILABLE);
      signal.addEventListener("abort", onAbort, { once: true });
      void answer.then((record) => {
        signal.removeEventListener("abort", onAbort);
        resolve(record);
      });
    });
  };

  return {
    integrationPut(userId, integration, credential) {
      if (!stateDir) return Promise.resolve(UNAVAILABLE);
      // Only a connect writes an OAuth record: an edge cannot plant one.
      if (oauthRecordOf(credential) !== undefined)
        return Promise.resolve(UNAVAILABLE);
      const { dirId, dir, file } = locate(userId, integration);
      return enqueue<IntegrationWrite>(
        dirId,
        () => {
          cache.delete(dirId);
          return Promise.resolve(
            writeRecord(dir, file, credential) ? { ok: true } : UNAVAILABLE,
          );
        },
        UNAVAILABLE,
      );
    },
    integrationGet(userId, integration, { signal } = {}) {
      if (!stateDir || signal?.aborted) return Promise.resolve(UNAVAILABLE);
      const { dirId, file } = locate(userId, integration);
      const read = readRecord(file);
      if ("answer" in read) return Promise.resolve(read.answer);
      const stored = oauthRecordOf(read.text);
      if (stored === undefined)
        return Promise.resolve({ ok: true, credential: read.text });
      if (stored === "malformed") return Promise.resolve(UNAVAILABLE);
      const cached = cache.get(dirId);
      if (fresh(cached)) return Promise.resolve(viewCredential(cached));
      return untilAborted(refresh(dirId, file), signal);
    },
    integrationClear(userId, integration) {
      if (!stateDir) return Promise.resolve(UNAVAILABLE);
      const { dirId, dir } = locate(userId, integration);
      return enqueue<IntegrationWrite>(
        dirId,
        () => {
          cache.delete(dirId);
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            return Promise.resolve(UNAVAILABLE);
          }
          options.discarded?.(dirId);
          return Promise.resolve({ ok: true });
        },
        UNAVAILABLE,
      );
    },
    integrationConnect(userId, integration, request) {
      if (!stateDir) return Promise.resolve(UNAVAILABLE);
      const client = options.clients?.atlassian;
      if (!client) return Promise.resolve({ ok: false, notConfigured: true });
      const { dirId, dir, file } = locate(userId, integration);
      const endpoint = options.atlassianEndpoint;
      return enqueue<IntegrationConnect>(
        dirId,
        async () => {
          cache.delete(dirId);
          const issuedAt = now();
          const exchanged = await exchangeAtlassianCode(
            client,
            request,
            endpoint,
          );
          if (exchanged.kind !== "ok") {
            log(
              `integration ${dirId}: code exchange ${exchanged.kind === "rejected" ? "rejected" : `failed (${exchanged.code})`}`,
            );
            return exchanged.kind === "rejected"
              ? { ok: false, rejected: true }
              : { ok: false, unreachable: true };
          }
          const { tokens } = exchanged;
          const listed = await atlassianResources(tokens.accessToken, endpoint);
          if (listed.kind !== "ok") {
            log(
              `integration ${dirId}: site list ${listed.kind === "rejected" ? "rejected" : `failed (${listed.code})`}`,
            );
            return listed.kind === "rejected"
              ? { ok: false, rejected: true }
              : { ok: false, unreachable: true };
          }
          const choice = selectAtlassianSite(listed.resources, request.site);
          if (!choice.ok) return choice;
          const stored: OAuthRecord = {
            kind: OAUTH_KIND,
            v: 1,
            site: choice.site,
            cloudId: choice.cloudId,
            // The exchange answers `rejected` without one.
            refreshToken: tokens.refreshToken!,
            scope: tokens.scope ?? "",
          };
          if (!writeRecord(dir, file, JSON.stringify(stored))) {
            log(`integration ${dirId}: the connected record was not saved`);
            return UNAVAILABLE;
          }
          cache.set(dirId, viewOf(stored, tokens, issuedAt));
          return { ok: true, site: choice.site, cloudId: choice.cloudId };
        },
        UNAVAILABLE,
      );
    },
    close() {
      closed = true;
      const running: Promise<void>[] = [];
      for (const lane of lanes.values()) {
        for (const item of lane.queue.splice(0)) item.refuse();
        if (lane.running) running.push(lane.running);
      }
      return Promise.allSettled(running).then(() => {});
    },
  };
}
