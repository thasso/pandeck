/**
 * The vault's integration credentials (Task-1397, Task-1411, Task-1452,
 * Task-1444): one record per user and integration at
 * `<stateDir>/accounts/<int-…>/integration.json` (0600, by temp file and
 * rename), the directory named by `integrationDirId`.
 * A sealing vault seals it right after each write (`written`) and deletes its
 * record on clear (`discarded`); the sweep, unlock and reseal cover it like a
 * token file (`sealedStore.ts`).
 *
 * A record is an OAuth record this module wrote itself after a code
 * exchange, or, for Atlassian only, an API token the edge put, kept opaque
 * and answered verbatim. One entry per OAuth provider (`PROVIDERS`) names
 * its record kind and whether token records exist beside it; the lane,
 * cache, single-flight refresh and `close()` are shared.
 *
 * - Atlassian (Task-1411): `{kind: "atlassian-oauth", v: 1, site, cloudId,
 *   refreshToken, scope}`, access view `{kind, site, cloudId, accessToken,
 *   expiresAt}`. A refresh that answers no new refresh token keeps the stored
 *   one.
 * - Slack (Task-1452): `{kind: "slack-oauth", v: 1, teamId, teamName?,
 *   workspaceHost, userId, refreshToken, scope}`, access view `{kind, teamId,
 *   teamName?, workspaceHost, userId, scope, accessToken, expiresAt}`. A
 *   connect checks the workspace preset and `auth.test`; a refresh must hand
 *   back a new refresh token (`vaultSlack.ts`), else nothing is written or
 *   cached and the get answers unavailable. A put for Slack is refused.
 * - GitHub (Task-1444): `{kind: "github-oauth", v: 1, login, githubUserId,
 *   refreshToken, refreshExpiresAt}`, access view `{kind, login,
 *   accessToken, expiresAt}`. A connect reads the identity from `GET /user`;
 *   a refresh must hand back a new refresh token (`vaultGithub.ts`), as for
 *   Slack. A put for GitHub is refused.
 *
 * Only these records are parsed; a record of another provider's kind, or a
 * non-record under Slack, is malformed. The access token lives only in
 * memory, so the first get after a restart refreshes.
 *
 * Each record has a generation, in memory only, which a connect, a clear and
 * a refused refresh bump: whatever was checked against one identity is void
 * once it moved (`github.token`, `vaultGithubTokens.ts`).
 *
 * Every write to a record (put, clear, connect, refresh) runs in its lane,
 * one at a time and in order. A refresh is single-flight per record, re-reads
 * the record in the lane, and writes the rotated refresh token before it
 * caches or answers anything: both providers rotate it on every use. Neither
 * a refresh nor a connect follows a caller's signal; a caller that stops
 * waiting only stops its own wait.
 *
 * `close()` stops admission at once: every later put, clear, connect or
 * refresh answers unavailable, queued ones are refused unrun, and it resolves
 * once each lane's running item, write and seal included, has ended. Running
 * items are bounded by their own provider deadlines, never aborted. A
 * `github.token` in flight answers unavailable at once and drops its token.
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
} from "./vaultAtlassian.ts";
import {
  exchangeGithubCode,
  githubUser,
  isGithubId,
  refreshGithub,
  type GithubEndpoint,
} from "./vaultGithub.ts";
import { createGithubTokens, type GithubAccess } from "./vaultGithubTokens.ts";
import {
  INTEGRATION_FILE,
  integrationDirId,
  isAtlassianSite,
  isCloudId,
  isGithubLogin,
  isSlackTeamId,
} from "./vaultMethods.ts";
import type {
  Integration,
  IntegrationConnect,
  IntegrationConnectRequests,
  IntegrationRecord,
  IntegrationWrite,
  VaultPort,
} from "./vaultPort.ts";
import {
  exchangeSlackCode,
  isSlackUserId,
  isSlackWorkspaceHost,
  refreshSlack,
  slackAuthTest,
  type SlackEndpoint,
} from "./vaultSlack.ts";

/** A cached access token this close to expiry is refreshed first. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const ATLASSIAN_KIND = "atlassian-oauth";
const SLACK_KIND = "slack-oauth";
const GITHUB_KIND = "github-oauth";
const OAUTH_KINDS: ReadonlySet<unknown> = new Set([
  ATLASSIAN_KIND,
  SLACK_KIND,
  GITHUB_KIND,
]);

export interface VaultIntegrationOptions {
  /** Without one the vault keeps no integration credential. */
  stateDir: string | undefined;
  /** A sealing vault's seal-after-write and record deletion. */
  written?: ((file: string) => void) | undefined;
  discarded?: ((dirId: string) => void) | undefined;
  /** The vault's OAuth clients; without a provider's its connect is refused. */
  clients?: IntegrationClients | undefined;
  /** Test seam: where Atlassian is reached (`vaultAtlassian.ts`). */
  atlassianEndpoint?: AtlassianEndpoint | undefined;
  /** Test seam: where Slack is reached (`vaultSlack.ts`). */
  slackEndpoint?: SlackEndpoint | undefined;
  /** Test seam: where GitHub is reached (`vaultGithub.ts`). */
  githubEndpoint?: GithubEndpoint | undefined;
  /** Test seam: `github.token`'s whole budget (`vaultGithubTokens.ts`). */
  githubTokenBudgetMs?: number | undefined;
}

export interface VaultIntegrations extends Pick<
  VaultPort,
  | "integrationPut"
  | "integrationGet"
  | "integrationClear"
  | "integrationConnect"
  | "githubToken"
> {
  /**
   * Admits nothing further, refuses what is queued, and resolves once each
   * running item has ended. Synchronous up to its first await.
   */
  close(): Promise<void>;
}

/** The records this module writes; never leave the vault. */
interface AtlassianRecord {
  kind: typeof ATLASSIAN_KIND;
  v: 1;
  site: string;
  cloudId: string;
  refreshToken: string;
  scope: string;
}

interface SlackRecord {
  kind: typeof SLACK_KIND;
  v: 1;
  teamId: string;
  teamName?: string;
  workspaceHost: string;
  userId: string;
  refreshToken: string;
  scope: string;
}

interface GithubRecord {
  kind: typeof GITHUB_KIND;
  v: 1;
  login: string;
  githubUserId: number;
  refreshToken: string;
  /** Epoch milliseconds. */
  refreshExpiresAt: number;
}

type OAuthRecord = AtlassianRecord | SlackRecord | GithubRecord;

/**
 * Each integration's OAuth record kind, and whether an edge's API token
 * record may stand in its place.
 */
const PROVIDERS: Record<
  Integration,
  { kind: OAuthRecord["kind"]; tokenRecords: boolean }
> = {
  atlassian: { kind: ATLASSIAN_KIND, tokenRecords: true },
  slack: { kind: SLACK_KIND, tokenRecords: false },
  github: { kind: GITHUB_KIND, tokenRecords: false },
};

/** The in-memory half of an OAuth record. */
interface AccessView {
  record: OAuthRecord;
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** A provider's refresh, as the lane takes it. */
type Refreshed =
  | { kind: "ok"; record: OAuthRecord; accessToken: string; expiresInS: number }
  | { kind: "rejected" }
  | { kind: "unavailable" };

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

function atlassianRecordOf(
  fields: Record<string, unknown>,
): AtlassianRecord | undefined {
  const { v, site, cloudId, refreshToken, scope } = fields;
  return v === 1 &&
    isAtlassianSite(site) &&
    isCloudId(cloudId) &&
    typeof refreshToken === "string" &&
    refreshToken.length > 0 &&
    typeof scope === "string"
    ? { kind: ATLASSIAN_KIND, v: 1, site, cloudId, refreshToken, scope }
    : undefined;
}

function slackRecordOf(
  fields: Record<string, unknown>,
): SlackRecord | undefined {
  const { v, teamId, teamName, workspaceHost, userId, refreshToken, scope } =
    fields;
  return v === 1 &&
    isSlackTeamId(teamId) &&
    (teamName === undefined || typeof teamName === "string") &&
    isSlackWorkspaceHost(workspaceHost) &&
    isSlackUserId(userId) &&
    typeof refreshToken === "string" &&
    refreshToken.length > 0 &&
    typeof scope === "string"
    ? {
        kind: SLACK_KIND,
        v: 1,
        teamId,
        ...(teamName !== undefined ? { teamName } : {}),
        workspaceHost,
        userId,
        refreshToken,
        scope,
      }
    : undefined;
}

function githubRecordOf(
  fields: Record<string, unknown>,
): GithubRecord | undefined {
  const { v, login, githubUserId, refreshToken, refreshExpiresAt } = fields;
  return v === 1 &&
    isGithubLogin(login) &&
    isGithubId(githubUserId) &&
    typeof refreshToken === "string" &&
    refreshToken.length > 0 &&
    typeof refreshExpiresAt === "number" &&
    Number.isFinite(refreshExpiresAt)
    ? {
        kind: GITHUB_KIND,
        v: 1,
        login,
        githubUserId,
        refreshToken,
        refreshExpiresAt,
      }
    : undefined;
}

/** `text`'s JSON object, if it is one. */
function fieldsOf(text: string): Record<string, unknown> | undefined {
  try {
    return objectOf(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Whether `text` says it is an OAuth record of any provider. */
function claimsOAuth(text: string): boolean {
  return OAUTH_KINDS.has(fieldsOf(text)?.kind);
}

/**
 * The integration's OAuth record in `text`; `undefined` when the text is an
 * API token record (Atlassian only), `"malformed"` when it is neither: it
 * says it is an OAuth record but is not a valid one of this integration's
 * kind, or a Slack record is no OAuth record at all.
 */
function oauthRecordOf(
  text: string,
  integration: Integration,
): OAuthRecord | "malformed" | undefined {
  const provider = PROVIDERS[integration];
  const fields = fieldsOf(text);
  if (!OAUTH_KINDS.has(fields?.kind))
    return provider.tokenRecords ? undefined : "malformed";
  if (fields!.kind !== provider.kind) return "malformed";
  const record =
    provider.kind === ATLASSIAN_KIND
      ? atlassianRecordOf(fields!)
      : provider.kind === SLACK_KIND
        ? slackRecordOf(fields!)
        : githubRecordOf(fields!);
  return record ?? "malformed";
}

/** The access view as the credential string the edge decodes. */
function viewCredential(view: AccessView): IntegrationRecord {
  const { record } = view;
  const fields =
    record.kind === ATLASSIAN_KIND
      ? { kind: record.kind, site: record.site, cloudId: record.cloudId }
      : record.kind === GITHUB_KIND
        ? { kind: record.kind, login: record.login }
        : {
            kind: record.kind,
            teamId: record.teamId,
            ...(record.teamName !== undefined
              ? { teamName: record.teamName }
              : {}),
            workspaceHost: record.workspaceHost,
            userId: record.userId,
            scope: record.scope,
          };
  return {
    ok: true,
    credential: JSON.stringify({
      ...fields,
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
  /** Each GitHub record's forced refresh in flight, by the refused token. */
  const forced = new Map<
    string,
    { stale: string; flight: Promise<IntegrationRecord> }
  >();
  /** Each record's generation; never reused, so a dropped entry is safe. */
  const generations = new Map<string, number>();
  let lastGeneration = 0;
  const bump = (dirId: string): void => {
    generations.set(dirId, ++lastGeneration);
  };

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

  const fresh = (view: AccessView | undefined): view is AccessView =>
    view !== undefined && view.expiresAt - now() > REFRESH_MARGIN_MS;

  const refreshAtlassianRecord = async (
    dirId: string,
    stored: AtlassianRecord,
  ): Promise<Refreshed> => {
    const client = options.clients?.atlassian;
    if (!client) {
      log(`integration ${dirId}: no Atlassian OAuth client to refresh with`);
      return { kind: "unavailable" };
    }
    const result = await refreshAtlassian(
      client,
      stored.refreshToken,
      options.atlassianEndpoint,
    );
    if (result.kind === "rejected") {
      log(`integration ${dirId}: Atlassian rejected the refresh`);
      return { kind: "rejected" };
    }
    if (result.kind === "unreachable") {
      log(`integration ${dirId}: refresh failed (${result.code})`);
      return { kind: "unavailable" };
    }
    return {
      kind: "ok",
      record: {
        ...stored,
        refreshToken: result.tokens.refreshToken ?? stored.refreshToken,
        scope: result.tokens.scope ?? stored.scope,
      },
      accessToken: result.tokens.accessToken,
      expiresInS: result.tokens.expiresInS,
    };
  };

  const refreshSlackRecord = async (
    dirId: string,
    stored: SlackRecord,
  ): Promise<Refreshed> => {
    const client = options.clients?.slack;
    if (!client) {
      log(`integration ${dirId}: no Slack OAuth client to refresh with`);
      return { kind: "unavailable" };
    }
    const result = await refreshSlack(
      client,
      stored.refreshToken,
      options.slackEndpoint,
    );
    if (result.kind === "rejected") {
      log(`integration ${dirId}: Slack rejected the refresh`);
      return { kind: "rejected" };
    }
    if (result.kind === "unreachable") {
      log(`integration ${dirId}: refresh failed (${result.code})`);
      return { kind: "unavailable" };
    }
    if (result.kind === "unusable") {
      // Slack has likely consumed the stored token; never kept as a success.
      log(`integration ${dirId}: Slack refresh answer unusable`);
      return { kind: "unavailable" };
    }
    return {
      kind: "ok",
      record: {
        ...stored,
        refreshToken: result.tokens.refreshToken,
        scope: result.tokens.scope ?? stored.scope,
      },
      accessToken: result.tokens.accessToken,
      expiresInS: result.tokens.expiresInS,
    };
  };

  const refreshGithubRecord = async (
    dirId: string,
    stored: GithubRecord,
  ): Promise<Refreshed> => {
    const client = options.clients?.github;
    if (!client) {
      log(`integration ${dirId}: no GitHub OAuth client to refresh with`);
      return { kind: "unavailable" };
    }
    const issuedAt = now();
    const result = await refreshGithub(
      client,
      stored.refreshToken,
      options.githubEndpoint,
    );
    if (result.kind === "rejected") {
      log(`integration ${dirId}: GitHub rejected the refresh`);
      return { kind: "rejected" };
    }
    if (result.kind === "unreachable") {
      log(`integration ${dirId}: refresh failed (${result.code})`);
      return { kind: "unavailable" };
    }
    if (result.kind === "unusable") {
      // GitHub has likely consumed the stored token; never kept as a success.
      log(`integration ${dirId}: GitHub refresh answer unusable`);
      return { kind: "unavailable" };
    }
    return {
      kind: "ok",
      record: {
        ...stored,
        refreshToken: result.tokens.refreshToken,
        refreshExpiresAt: issuedAt + result.tokens.refreshExpiresInS * 1000,
      },
      accessToken: result.tokens.accessToken,
      expiresInS: result.tokens.expiresInS,
    };
  };

  /**
   * In the lane: the record as it is now, refreshed when still due. A forced
   * refresh (`stale`, the access token GitHub refused) skips the "still fresh"
   * shortcut unless the cached view already holds another token, which means
   * someone refreshed since; else it drops the view first, so a refused
   * refresh leaves nothing cached to serve the revoked token from.
   */
  const refreshInLane = async (
    dirId: string,
    file: string,
    integration: Integration,
    stale?: string,
  ): Promise<IntegrationRecord> => {
    const read = readRecord(file);
    if ("answer" in read) return read.answer;
    const stored = oauthRecordOf(read.text, integration);
    // Replaced by an API token while queued: answered as it is now.
    if (stored === undefined) return { ok: true, credential: read.text };
    if (stored === "malformed") return UNAVAILABLE;
    const cached = cache.get(dirId);
    if (stale === undefined) {
      if (fresh(cached)) return viewCredential(cached);
    } else if (cached?.accessToken !== stale && fresh(cached)) {
      return viewCredential(cached);
    } else {
      cache.delete(dirId);
    }
    const issuedAt = now();
    const result =
      stored.kind === ATLASSIAN_KIND
        ? await refreshAtlassianRecord(dirId, stored)
        : stored.kind === SLACK_KIND
          ? await refreshSlackRecord(dirId, stored)
          : await refreshGithubRecord(dirId, stored);
    if (result.kind === "rejected") {
      bump(dirId);
      return { ok: false, rejected: true };
    }
    if (result.kind === "unavailable") return UNAVAILABLE;
    // The rotation is on disk before anything is cached or answered.
    if (!writeRecord(dirname(file), file, JSON.stringify(result.record))) {
      log(`integration ${dirId}: the refreshed record was not saved`);
      return UNAVAILABLE;
    }
    const view: AccessView = {
      record: result.record,
      accessToken: result.accessToken,
      expiresAt: issuedAt + result.expiresInS * 1000,
    };
    cache.set(dirId, view);
    return viewCredential(view);
  };

  /** Joins the record's refresh in flight, or queues one. */
  const refresh = (
    dirId: string,
    file: string,
    integration: Integration,
  ): Promise<IntegrationRecord> => {
    let flight = refreshing.get(dirId);
    if (!flight) {
      flight = enqueue(
        dirId,
        () => refreshInLane(dirId, file, integration),
        UNAVAILABLE,
      );
      refreshing.set(dirId, flight);
      const settled = flight;
      void settled.finally(() => {
        if (refreshing.get(dirId) === settled) refreshing.delete(dirId);
      });
    }
    return flight;
  };

  /**
   * A refresh because GitHub refused `stale` (Task-1508 O1): one flight per
   * stale token, joined by every caller that saw the same token refused, run
   * in the record's lane after whatever is queued there.
   */
  const forceRefresh = (
    dirId: string,
    file: string,
    stale: string,
  ): Promise<IntegrationRecord> => {
    const joined = forced.get(dirId);
    if (joined?.stale === stale) return joined.flight;
    const flight = enqueue(
      dirId,
      () => refreshInLane(dirId, file, "github", stale),
      UNAVAILABLE,
    );
    const entry = { stale, flight };
    forced.set(dirId, entry);
    void flight.finally(() => {
      if (forced.get(dirId) === entry) forced.delete(dirId);
    });
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

  /** The connect's write and cache, in its lane. */
  const store = (
    dirId: string,
    dir: string,
    file: string,
    view: AccessView,
  ): boolean => {
    // Whatever was checked against the record before is void from here.
    bump(dirId);
    if (!writeRecord(dir, file, JSON.stringify(view.record))) {
      log(`integration ${dirId}: the connected record was not saved`);
      return false;
    }
    cache.set(dirId, view);
    return true;
  };

  /** Each integration's connect, run in the record's lane. */
  const connects: {
    [I in Integration]: (
      userId: string,
      request: IntegrationConnectRequests[I],
    ) => Promise<IntegrationConnect<I>>;
  } = {
    atlassian(userId, request) {
      const client = options.clients?.atlassian;
      if (!client) return Promise.resolve({ ok: false, notConfigured: true });
      const { dirId, dir, file } = locate(userId, "atlassian");
      const endpoint = options.atlassianEndpoint;
      return enqueue<IntegrationConnect<"atlassian">>(
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
          const record: AtlassianRecord = {
            kind: ATLASSIAN_KIND,
            v: 1,
            site: choice.site,
            cloudId: choice.cloudId,
            // The exchange answers `rejected` without one.
            refreshToken: tokens.refreshToken!,
            scope: tokens.scope ?? "",
          };
          const view: AccessView = {
            record,
            accessToken: tokens.accessToken,
            expiresAt: issuedAt + tokens.expiresInS * 1000,
          };
          if (!store(dirId, dir, file, view)) return UNAVAILABLE;
          return { ok: true, site: choice.site, cloudId: choice.cloudId };
        },
        UNAVAILABLE,
      );
    },

    slack(userId, request) {
      const client = options.clients?.slack;
      if (!client) return Promise.resolve({ ok: false, notConfigured: true });
      const { dirId, dir, file } = locate(userId, "slack");
      const endpoint = options.slackEndpoint;
      return enqueue<IntegrationConnect<"slack">>(
        dirId,
        async () => {
          cache.delete(dirId);
          const issuedAt = now();
          const exchanged = await exchangeSlackCode(client, request, endpoint);
          if (exchanged.kind === "unreachable") {
            log(
              `integration ${dirId}: code exchange failed (${exchanged.code})`,
            );
            return { ok: false, unreachable: true };
          }
          if (exchanged.kind !== "ok") {
            log(
              exchanged.kind === "noRefreshToken"
                ? `integration ${dirId}: Slack granted no refresh token`
                : exchanged.kind === "unusable"
                  ? `integration ${dirId}: Slack exchange answer unusable`
                  : `integration ${dirId}: code exchange rejected`,
            );
            return { ok: false, rejected: true };
          }
          const { grant } = exchanged;
          if (request.team !== undefined && grant.teamId !== request.team) {
            log(`integration ${dirId}: Slack granted another workspace`);
            return { ok: false, team: "mismatch" };
          }
          const identity = await slackAuthTest(
            grant.tokens.accessToken,
            endpoint,
          );
          if (identity.kind === "unreachable") {
            log(
              `integration ${dirId}: identity check failed (${identity.code})`,
            );
            return { ok: false, unreachable: true };
          }
          if (
            identity.kind !== "ok" ||
            identity.teamId !== grant.teamId ||
            identity.userId !== grant.userId
          ) {
            log(
              identity.kind === "rejected"
                ? `integration ${dirId}: identity check rejected`
                : `integration ${dirId}: Slack identity answer unusable`,
            );
            return { ok: false, rejected: true };
          }
          const record: SlackRecord = {
            kind: SLACK_KIND,
            v: 1,
            teamId: grant.teamId,
            ...(grant.teamName !== undefined
              ? { teamName: grant.teamName }
              : {}),
            workspaceHost: identity.workspaceHost,
            userId: grant.userId,
            refreshToken: grant.tokens.refreshToken,
            scope: grant.tokens.scope ?? "",
          };
          const view: AccessView = {
            record,
            accessToken: grant.tokens.accessToken,
            expiresAt: issuedAt + grant.tokens.expiresInS * 1000,
          };
          if (!store(dirId, dir, file, view)) return UNAVAILABLE;
          return {
            ok: true,
            teamId: grant.teamId,
            ...(grant.teamName !== undefined
              ? { teamName: grant.teamName }
              : {}),
          };
        },
        UNAVAILABLE,
      );
    },

    github(userId, request) {
      const client = options.clients?.github;
      if (!client) return Promise.resolve({ ok: false, notConfigured: true });
      const { dirId, dir, file } = locate(userId, "github");
      const endpoint = options.githubEndpoint;
      return enqueue<IntegrationConnect<"github">>(
        dirId,
        async () => {
          cache.delete(dirId);
          const issuedAt = now();
          const exchanged = await exchangeGithubCode(client, request, endpoint);
          if (exchanged.kind !== "ok") {
            log(
              `integration ${dirId}: code exchange ${exchanged.kind === "rejected" ? "rejected" : `failed (${exchanged.code})`}`,
            );
            return exchanged.kind === "rejected"
              ? { ok: false, rejected: true }
              : { ok: false, unreachable: true };
          }
          const { tokens } = exchanged;
          const identity = await githubUser(tokens.accessToken, endpoint);
          if (identity.kind === "unreachable") {
            log(
              `integration ${dirId}: identity check failed (${identity.code})`,
            );
            return { ok: false, unreachable: true };
          }
          if (identity.kind !== "ok") {
            log(
              identity.kind === "rejected"
                ? `integration ${dirId}: identity check rejected`
                : `integration ${dirId}: GitHub identity answer unusable`,
            );
            return { ok: false, rejected: true };
          }
          const record: GithubRecord = {
            kind: GITHUB_KIND,
            v: 1,
            login: identity.login,
            githubUserId: identity.githubUserId,
            refreshToken: tokens.refreshToken,
            refreshExpiresAt: issuedAt + tokens.refreshExpiresInS * 1000,
          };
          const view: AccessView = {
            record,
            accessToken: tokens.accessToken,
            expiresAt: issuedAt + tokens.expiresInS * 1000,
          };
          if (!store(dirId, dir, file, view)) return UNAVAILABLE;
          return { ok: true, login: identity.login };
        },
        UNAVAILABLE,
      );
    },
  };

  const api: Omit<VaultIntegrations, "githubToken" | "close"> = {
    integrationPut(userId, integration, credential) {
      if (!stateDir) return Promise.resolve(UNAVAILABLE);
      // Only a connect writes an OAuth record: an edge cannot plant one, and
      // a Slack credential is never anything else.
      if (!PROVIDERS[integration].tokenRecords || claimsOAuth(credential))
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
      const stored = oauthRecordOf(read.text, integration);
      if (stored === undefined)
        return Promise.resolve({ ok: true, credential: read.text });
      if (stored === "malformed") return Promise.resolve(UNAVAILABLE);
      const cached = cache.get(dirId);
      if (fresh(cached)) return Promise.resolve(viewCredential(cached));
      return untilAborted(refresh(dirId, file, integration), signal);
    },
    integrationClear(userId, integration) {
      if (!stateDir) return Promise.resolve(UNAVAILABLE);
      const { dirId, dir } = locate(userId, integration);
      return enqueue<IntegrationWrite>(
        dirId,
        () => {
          cache.delete(dirId);
          bump(dirId);
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
      return connects[integration](userId, request);
    },
  };

  /**
   * The access view `record` answered, fenced by `generation`. `renew` forces
   * one refresh keyed to this view's token; the renewed view keeps the same
   * baseline, and its own `renew` answers unavailable: one refresh per call.
   */
  const githubAccessOf = (
    record: IntegrationRecord,
    located: { dirId: string; file: string },
    generation: number,
    renewable: boolean,
  ): GithubAccess => {
    if (!record.ok) return record;
    const accessToken = fieldsOf(record.credential)?.accessToken;
    if (typeof accessToken !== "string") return UNAVAILABLE;
    const { dirId, file } = located;
    return {
      ok: true,
      dirId,
      accessToken,
      current: () => !closed && (generations.get(dirId) ?? 0) === generation,
      renew: async (signal) => {
        if (!renewable || signal.aborted) return UNAVAILABLE;
        const renewed = await untilAborted(
          forceRefresh(dirId, file, accessToken),
          signal,
        );
        return githubAccessOf(renewed, located, generation, false);
      },
    };
  };

  /**
   * `github.token`'s step 2: the generation noted before the access view is
   * read, so a clear, connect or refused refresh from here on voids the call.
   */
  const githubAccess = async (
    userId: string,
    signal: AbortSignal,
  ): Promise<GithubAccess> => {
    if (!stateDir) return UNAVAILABLE;
    const located = locate(userId, "github");
    const generation = generations.get(located.dirId) ?? 0;
    const record = await api.integrationGet(userId, "github", { signal });
    return githubAccessOf(record, located, generation, true);
  };
  const githubTokens = createGithubTokens({
    client: options.clients?.github,
    endpoint: options.githubEndpoint,
    access: githubAccess,
    log,
    now,
    budgetMs: options.githubTokenBudgetMs,
  });

  return {
    ...api,
    githubToken: githubTokens.token,
    close() {
      closed = true;
      // Calls in flight answer unavailable now; their tokens are dropped.
      githubTokens.close();
      const running: Promise<void>[] = [];
      for (const lane of lanes.values()) {
        for (const item of lane.queue.splice(0)) item.refuse();
        if (lane.running) running.push(lane.running);
      }
      return Promise.allSettled(running).then(() => {});
    },
  };
}
