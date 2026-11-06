/**
 * The server's link to the credential gateway (`docs/workers.md`
 * "Credentials"), behind `ASSISTANT_GATEWAY=1`. It runs the gateway in this
 * process with its state in `DATA_DIR/gateway/`, or dials `socketPath` for a
 * standalone gateway. Both speak gateway control 1.4. Socket mode reconnects
 * with backoff; in-process mode retains its one-shot boot.
 *
 * Before it is ready the link says hello as this server boot, syncs every
 * credential profile (an OpenAI-compatible account without a token file),
 * reconciles the in-process Worker with no live lease (an engine of an
 * earlier boot died with it) and pushes each OpenAI-compatible account's
 * endpoint and key. Account changes follow, in order: every request takes one
 * queue, and a compatible account's upsert is followed by its push.
 *
 * The link is the only reader of those keys on the engine path: engines get a
 * key-less configuration (`piSdk/compatProviderFeed.ts`) and spend their
 * lease at the gateway's `/compat`, which forwards to the lease's own
 * account. An account that is not ready to run, or whose endpoint cannot be
 * read, has its pair cleared. A failed push is logged by its method, profile
 * and code alone, never the URL or key, and leaves the link ready: `/compat`
 * answers 503 for that account until its next change or a restart, with no
 * retry. Disabling an account keeps its pair; the server refuses it at the
 * next turn.
 *
 * The engine seam (`workers/engineClient.ts`) grants an engine lease before
 * each profiled open and revokes it at the engine's end. A grant the link
 * cannot get fails the open with {@link GATEWAY_UNAVAILABLE_TEXT}. Binding a
 * session and revoking are best-effort and only logged: a revocation whose
 * save failed holds in the gateway's memory until a later save or the next
 * boot's reconcile.
 *
 * The server's own model and usage requests (one-shots, Codex usage) spend a
 * server lease: one per profile for this boot, granted on first use and kept
 * in memory only. The gateway ends it with the boot (the next hello) or the
 * profile (its removal); the server never revokes one itself.
 *
 * The login flows take their holds through `loginHolds.ts`. A hold waiting
 * for its profile's writer lane is ordered after the queue but never holds it
 * up. The link records each profile's latest `profiles.status` for the
 * login-stuck state, tells `onLoginStatus` listeners of it, and its latest
 * `profiles.credential` for the needs-login state the gateway's renewal
 * found, which `onCredentialStatus` listeners hear: account health takes
 * needs-login only from them (`gatewayHealth.ts`). Each connection starts that
 * record afresh, since the gateway's hello resends every needs-login it holds
 * and a change sent while no connection was up is lost. The gateway renews
 * Codex logins through `renewCodex`, pi's refresh that `index.ts` passes in
 * from `harnesses/`.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  ACCOUNT_KINDS,
  type CredentialProfileProvider,
} from "@assistant/shared";
import {
  claudeConfigDir,
  credentialProfileById,
  credentialProfilesOfKind,
  ensureDefaultPiProfile,
  piAgentDir,
  subscribeCredentialProfileChanges,
  type CredentialProfile,
} from "./credentialProfiles.ts";
import { errorText } from "./errors.ts";
import {
  openAiCompatibleProviderConfig,
  readOpenAiCompatibleEndpoint,
} from "./openAiCompatibleAccounts.ts";
import {
  CONTROL_METHODS,
  GATEWAY_CONTROL_PROTOCOL,
  UNKNOWN_HOLD,
  type CompatConfig,
  decodeHoldReleased,
  decodeCredentialStatus,
  decodeHoldStatus,
  decodeLeaseGranted,
  decodeLeaseRevoked,
  decodeLeasesRevoked,
  decodeLoginHeld,
  encodeControlDone,
  encodeControlRequest,
  type ControlHello,
  type LeaseGranted,
} from "./gateway/controlMethods.ts";
import type { UpstreamOverrides } from "./gateway/forward.ts";
import {
  startGateway,
  type GatewayOptions,
  type RunningGateway,
} from "./gateway/gateway.ts";
import { processStartTime } from "./gateway/processIdentity.ts";
import { parseProfile, type GatewayProfile } from "./gateway/profiles.ts";
import type { RevokeReason } from "./gateway/refusals.ts";
import type { Payload } from "./workerProtocol/codec.ts";
import type { EngineGatewayAccess } from "./workerProtocol/engineMethods.ts";
import {
  WorkerConnection,
  WorkerRequestError,
} from "./workerProtocol/connection.ts";
import { createInProcessTransport } from "./workerProtocol/inProcessTransport.ts";
import { dialUnixSocket } from "./workerProtocol/unixSocketTransport.ts";

/** U7's text for an engine open that got no lease. */
export const GATEWAY_UNAVAILABLE_TEXT =
  "Pandeck's credential gateway isn't reachable, so this session can't start a model request. It restarts automatically; try again shortly.";

/** No lease could be granted: the engine must not open. */
export class GatewayUnavailableError extends Error {
  constructor() {
    super(GATEWAY_UNAVAILABLE_TEXT);
  }
}

/** U7's text for a login the gateway cannot hold for. */
export const GATEWAY_LOGIN_UNAVAILABLE_TEXT =
  "Pandeck can't start this login while the credential gateway is unreachable; try again shortly.";

/** The login must not start or go on: the link has no hold for it. */
class GatewayLoginUnavailableError extends Error {
  constructor() {
    super(GATEWAY_LOGIN_UNAVAILABLE_TEXT);
  }
}

/**
 * The profile is held already: `login_stuck` for a stuck or fence hold or
 * another boot's, which the Clear action force-releases by `holdId`;
 * `hold_exists` for this boot's own (`docs/workers.md` "Credentials").
 */
export class LoginHeldError extends Error {
  constructor(
    readonly refusal: "hold_exists" | "login_stuck",
    /** Absent only while an unreadable `holds.json` waits for the registry. */
    readonly holdId: string | undefined,
  ) {
    super(`The account's login is held (${refusal}).`);
  }
}

/** A profile's latest `profiles.status`. */
export interface LoginStatus {
  loginStuck: boolean;
  holdId: string;
}

/** How long a grant waits for the link to become ready. */
const READY_TIMEOUT_MS = 10_000;

/**
 * The in-process Worker's id (`workers/placement.ts`), the only Worker until
 * Workers run out of process: the boot reconciles it, and it owns a lease
 * whose connection has not finished its handshake yet.
 */
const IN_PROCESS_WORKER_ID = "local";

export interface GatewayLinkOptions {
  stateDir: string;
  /** The gateway's model listener; 0 picks a free one. */
  port: number;
  /** Dial a standalone gateway; this link never starts or stops it. */
  socketPath?: string;
  /** Socket reconnect backoff, repeating the last delay. */
  retryDelays?: readonly number[];
  /** Socket outage threshold; 10 s by default. */
  unreachableMs?: number;
  /** Test-only barrier hook, after the snapshot and before its sync. */
  beforeSync?: (pass: number) => Promise<void>;
  log?: (line: string) => void;
  /** Test and probe seam, passed to the gateway; the server never sets it. */
  upstreams?: UpstreamOverrides;
  /** Test seam: what starts the gateway. */
  start?: (options: GatewayOptions) => Promise<RunningGateway>;
  /** pi's Codex refresh, passed to the gateway. */
  renewCodex?: GatewayOptions["renewCodex"];
  /** The login drivers an enrolled client's logins run (Task-1385). */
  loginDrivers?: GatewayOptions["loginDrivers"];
  /** Test and probe seam, passed to the gateway; the server never sets it. */
  claudeTokenEndpoint?: GatewayOptions["claudeTokenEndpoint"];
}

interface EngineLeaseGrant {
  /** The engine's Worker; the in-process Worker when unknown. */
  workerId: string | undefined;
  /** Absent until the open names it; see `bindLeaseSession`. */
  sessionId?: string;
  profileId: string;
}

/**
 * The link's connection: `unreachable` once a standalone gateway has had no
 * ready connection for 10 s, `incompatible` when its handshake was refused or
 * it speaks another control major.
 */
export type GatewayConnectionState =
  "connected" | "connecting" | "unreachable" | "incompatible";

export interface GatewayLink {
  /** True once hello, sync and reconcile are done; false if the link failed. */
  readonly ready: Promise<boolean>;
  /** The connection now (`gatewayStatus.ts`). */
  connectionState(): GatewayConnectionState;
  /** Calls `listener` on each change of the connection; answers the unsubscribe. */
  onConnectionState(
    listener: (state: GatewayConnectionState) => void,
  ): () => void;
  /** The gateway this link started, once it has. Tests and the probe read it. */
  readonly gateway: RunningGateway | undefined;
  /**
   * Where engines spend their leases: the started gateway's loopback port, or
   * in client mode the relay's. Undefined until known.
   */
  readonly baseUrl: string | undefined;
  /**
   * Waits for ready (at most 10 s), then grants. Rejects with a
   * {@link GatewayUnavailableError} when no lease could be had.
   */
  grantEngineLease(grant: EngineLeaseGrant): Promise<LeaseGranted>;
  /**
   * The profile's server lease for this boot and where to spend it, granted
   * once and shared by every caller until the profile is removed. Rejects with
   * a {@link GatewayUnavailableError} when no lease could be had; the next call
   * tries again.
   */
  serverAccess(profileId: string): Promise<EngineGatewayAccess>;
  /** Best-effort: a failure is logged, never thrown. */
  bindLeaseSession(leaseId: string, sessionId: string): Promise<void>;
  /** Best-effort: a failure is logged, never thrown. */
  revokeLease(leaseId: string, reason: RevokeReason): Promise<void>;
  /**
   * Waits for ready (at most 10 s), then for the profile's writer lane, and
   * resolves the hold's id once the gateway saved it. Rejects with
   * {@link LoginHeldError} when the profile is held, and with U7's login text
   * when the gateway cannot hold.
   */
  acquireLoginHold(profileId: string): Promise<string>;
  /** Names a Claude hold's writer; rejects with U7's login text on any failure. */
  registerLoginWriter(holdId: string, pid: number): Promise<void>;
  /** Best-effort: a failure is logged, never thrown. */
  releaseLoginHold(holdId: string): Promise<void>;
  /**
   * The operator's Clear. A hold the gateway no longer knows is already gone,
   * so it resolves; any other failure rejects with U7's login text.
   */
  forceReleaseLoginHold(holdId: string): Promise<void>;
  /** The profile's latest login status from the gateway, if any. */
  loginStatus(profileId: string): LoginStatus | undefined;
  /**
   * Calls `listener` after each `profiles.status` is recorded; answers the
   * unsubscribe. A listener's failure is logged, never thrown.
   */
  onLoginStatus(
    listener: (profileId: string, status: LoginStatus) => void,
  ): () => void;
  /** The profile's latest needs-login from the gateway's renewal, if any. */
  credentialStatus(profileId: string): { needsLogin: boolean } | undefined;
  /**
   * Whether `onCredentialStatus` hears the gateway's renewal: then health takes
   * a served login's needs-login only from it. False in client mode, whose
   * accounts keep the error classifier.
   */
  readonly reportsCredentialStatus: boolean;
  /**
   * Calls `listener` after each `profiles.credential` is recorded; answers the
   * unsubscribe. A listener's failure is logged, never thrown. A profile's
   * removal, or a new connection, drops its record with no call.
   */
  onCredentialStatus(
    listener: (profileId: string, needsLogin: boolean) => void,
  ): () => void;
  /** The profiles whose latest record on this connection needs a login. */
  needsLoginProfiles(): string[];
  /** Uninstalls the link and closes its gateway (tests and the probe only); once. */
  close(): Promise<void>;
}

let installed: GatewayLink | undefined;

/**
 * Installs a link another module made (client mode's remote link); answers
 * the uninstall. Throws when one is installed.
 */
export function installGatewayLink(link: GatewayLink): () => void {
  if (installed) throw new Error("A gateway link is already installed.");
  installed = link;
  return () => {
    if (installed === link) installed = undefined;
  };
}

/** The process's link while one runs; without it no open grants a lease. */
export function installedGatewayLink(): GatewayLink | undefined {
  return installed;
}

/**
 * Whether the gateway renews this account's login and reports when it needs a
 * new one: a Claude or Codex login while a link that reports it is installed,
 * whether or not it is ready. Health and the switch-on-failure rules then read
 * only the gateway's needs-login, never a 401 (`providerErrors.ts`
 * `loginEnded`).
 */
export function gatewayServesProfile(profile: {
  provider: CredentialProfileProvider;
}): boolean {
  return (
    installed?.reportsCredentialStatus === true &&
    (profile.provider === "claude" || profile.provider === "openai-codex")
  );
}

/**
 * The profile's server lease while a link runs, else undefined: the server's
 * own requests read the switch only here.
 */
export async function serverGatewayAccess(
  profileId: string,
): Promise<EngineGatewayAccess | undefined> {
  if (!installed) return undefined;
  return installed.serverAccess(profileId);
}

/** A request failure as a log line may name it: its code, or the error's text. */
function failure(err: unknown): string {
  return err instanceof WorkerRequestError ? err.code : errorText(err);
}

/** A failed push as a log line names it: never a text that could hold the URL or key. */
function pushFailure(err: unknown): string {
  return err instanceof WorkerRequestError ? err.code : "failed";
}

/**
 * The gateway's view of `profile`, or undefined when it cannot hold it. An
 * OpenAI-compatible account holds no login and names no token file: its
 * endpoint and key reach the gateway only by push.
 */
function gatewayProfile(
  profile: CredentialProfile,
): GatewayProfile | undefined {
  if (profile.provider === "openai-compatible")
    return parseProfile({
      id: profile.id,
      provider: profile.provider,
      name: profile.name,
      enabled: profile.enabled,
    });
  return parseProfile({
    id: profile.id,
    provider: profile.provider,
    name: profile.name,
    enabled: profile.enabled,
    tokenFile:
      profile.provider === "claude"
        ? join(claudeConfigDir(profile.id), ".credentials.json")
        : join(piAgentDir(profile.id), "auth.json"),
  });
}

/**
 * Every account as the registry has it, oldest first, the defaults ensured.
 * Not the summaries: they read each account's files, and one unreadable
 * endpoint would fail the boot instead of only its own push.
 */
function registeredProfiles(): CredentialProfile[] {
  ensureDefaultPiProfile();
  return (Object.keys(ACCOUNT_KINDS) as CredentialProfileProvider[])
    .flatMap((provider) => credentialProfilesOfKind(provider))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Start the gateway in this process, link to it and install the link. A start
 * or boot failure is logged and leaves the link unavailable; it never throws.
 */
export function startGatewayLink(options: GatewayLinkOptions): GatewayLink {
  if (installed) throw new Error("A gateway link is already installed.");
  const log =
    options.log ?? ((line: string) => console.log(`[gateway-link] ${line}`));
  const hello: ControlHello = {
    serverBootId: randomBytes(16).toString("base64url"),
    pid: process.pid,
    startTime: processStartTime(process.pid),
  };
  let gateway: RunningGateway | undefined;
  let connection: WorkerConnection | undefined;
  let closing: Promise<void> | undefined;
  let stopped = false;
  let profileGeneration = 0;
  let leaseGeneration = 0;
  const liveLocalLeases = new Set<string>();
  const pendingReleases = new Set<string>();
  const readyWaiters = new Set<(ok: boolean) => void>();
  let resolveBoot!: (ok: boolean) => void;
  const boot = new Promise<boolean>((resolve) => {
    resolveBoot = resolve;
  });
  let wakeRetry: (() => void) | undefined;
  let outageTimer: ReturnType<typeof setTimeout> | undefined;
  let outageSince = Date.now();
  let bootFailed = false;
  const loginStatuses = new Map<string, LoginStatus>();
  const loginStatusListeners = new Set<
    (profileId: string, status: LoginStatus) => void
  >();
  const credentialStatuses = new Map<string, boolean>();
  const credentialListeners = new Set<
    (profileId: string, needsLogin: boolean) => void
  >();
  let state: GatewayConnectionState = "connecting";
  const stateListeners = new Set<(state: GatewayConnectionState) => void>();
  const setState = (next: GatewayConnectionState): void => {
    if (state === next) return;
    if (state === "connected") outageSince = Date.now();
    state = next;
    if (next === "connected") {
      clearTimeout(outageTimer);
      outageTimer = undefined;
      resolveBoot(true);
      for (const resolve of readyWaiters) resolve(true);
      readyWaiters.clear();
    } else if (next === "unreachable" || next === "incompatible") {
      log(GATEWAY_UNAVAILABLE_TEXT);
      log(GATEWAY_LOGIN_UNAVAILABLE_TEXT);
    }
    for (const listener of [...stateListeners])
      try {
        listener(next);
      } catch (err) {
        log(`connection state listener: ${errorText(err)}`);
      }
  };
  /**
   * This boot's server leases by profile, from the first call on. A removal
   * drops its entry, so a grant still in flight then is never kept: the
   * removal, queued after it, revokes it.
   */
  const serverLeases = new Map<string, Promise<EngineGatewayAccess>>();

  /**
   * Sends a compatible account's endpoint and key as its settings hold them
   * now, or clears its pair when it is not ready to run or cannot be read: a
   * pair the server cannot confirm is not kept. Logs a failure, never throws.
   */
  const pushCompat = async (
    send: (method: string, payload: Payload) => Promise<Payload>,
    profile: Pick<CredentialProfile, "id" | "name">,
  ): Promise<void> => {
    const profileId = profile.id;
    let method: string = CONTROL_METHODS.compatClear;
    try {
      let pair: CompatConfig | undefined;
      try {
        const config = openAiCompatibleProviderConfig(
          readOpenAiCompatibleEndpoint(profileId),
          profile.name,
        );
        if (config)
          pair = { profileId, baseUrl: config.baseUrl, apiKey: config.apiKey };
      } catch {
        log(`${CONTROL_METHODS.compatSet} (profile ${profileId}): failed`);
      }
      method = pair ? CONTROL_METHODS.compatSet : CONTROL_METHODS.compatClear;
      await send(method, encodeControlRequest(pair ?? { profileId }));
    } catch (err) {
      log(`${method} (profile ${profileId}): ${pushFailure(err)}`);
    }
  };

  const startOutage = (): void => {
    if (
      !options.socketPath ||
      outageTimer ||
      stopped ||
      state === "incompatible"
    )
      return;
    outageTimer = setTimeout(
      () => {
        outageTimer = undefined;
        if (state !== "connected" && state !== "incompatible" && !stopped)
          setState("unreachable");
      },
      Math.max(
        0,
        (options.unreachableMs ?? READY_TIMEOUT_MS) -
          (Date.now() - outageSince),
      ),
    );
    outageTimer.unref();
  };
  startOutage();

  const attempts = (async (): Promise<void> => {
    let failures = 0;
    const delays = options.retryDelays?.length
      ? options.retryDelays
      : [500, 1000, 2000, 4000, 8000, 10_000];
    while (!stopped) {
      let control: WorkerConnection | undefined;
      try {
        let serverEnd;
        if (options.socketPath) {
          serverEnd = await dialUnixSocket(options.socketPath);
        } else {
          gateway = await (options.start ?? startGateway)({
            stateDir: options.stateDir,
            port: options.port,
            ...(options.log ? { log: options.log } : {}),
            ...(options.upstreams ? { upstreams: options.upstreams } : {}),
            ...(options.renewCodex ? { renewCodex: options.renewCodex } : {}),
            ...(options.loginDrivers
              ? { loginDrivers: options.loginDrivers }
              : {}),
            ...(options.claudeTokenEndpoint
              ? { claudeTokenEndpoint: options.claudeTokenEndpoint }
              : {}),
          });
          const pair = createInProcessTransport();
          serverEnd = pair[0];
          gateway.attachControl(pair[1]);
        }
        if (stopped) {
          serverEnd.close();
          break;
        }
        // This connection's hello resends every needs-login the gateway holds;
        // a change sent while none was up never arrived.
        credentialStatuses.clear();
        control = new WorkerConnection(serverEnd, {
          handshake: { role: "worker", workerId: "pandeck-server" },
          protocol: GATEWAY_CONTROL_PROTOCOL,
          handlers: {
            [CONTROL_METHODS.status]: (payload) => {
              const { profileId, ...status } = decodeHoldStatus(payload);
              loginStatuses.set(profileId, status);
              for (const listener of [...loginStatusListeners])
                try {
                  listener(profileId, { ...status });
                } catch (err) {
                  log(`${CONTROL_METHODS.status} listener: ${errorText(err)}`);
                }
              return Promise.resolve(encodeControlDone());
            },
            [CONTROL_METHODS.credential]: (payload) => {
              const { profileId, needsLogin } = decodeCredentialStatus(payload);
              credentialStatuses.set(profileId, needsLogin);
              for (const listener of [...credentialListeners])
                try {
                  listener(profileId, needsLogin);
                } catch (err) {
                  log(
                    `${CONTROL_METHODS.credential} listener: ${errorText(err)}`,
                  );
                }
              return Promise.resolve(encodeControlDone());
            },
          },
          onEnd: (reason, { incompatible }) => {
            if (stopped) return;
            log(`control connection ended: ${reason}`);
            setState(incompatible ? "incompatible" : "connecting");
            startOutage();
          },
        });
        connection = control;
        const ofOtherBoots = decodeLeasesRevoked(
          await control.request(
            CONTROL_METHODS.hello,
            encodeControlRequest(hello),
          ),
        ).revoked;
        let pass = 0;
        for (;;) {
          const generation = profileGeneration;
          const liveGeneration = leaseGeneration;
          const profiles: GatewayProfile[] = [];
          const compatible: CredentialProfile[] = [];
          for (const profile of registeredProfiles()) {
            const known = gatewayProfile(profile);
            if (!known) {
              log(`profile ${profile.id} skipped: the gateway cannot hold it`);
              continue;
            }
            profiles.push(known);
            if (known.provider === "openai-compatible")
              compatible.push(profile);
          }
          await options.beforeSync?.(++pass);
          decodeLeasesRevoked(
            await control.request(
              CONTROL_METHODS.syncProfiles,
              encodeControlRequest({ profiles }),
            ),
          );
          // The first pass of a new boot has no live local engines.
          const ofDeadEngines = decodeLeasesRevoked(
            await control.request(
              CONTROL_METHODS.reconcileWorker,
              encodeControlRequest({
                workerId: IN_PROCESS_WORKER_ID,
                live: [...liveLocalLeases],
              }),
            ),
          ).revoked;
          for (const holdId of pendingReleases) {
            try {
              decodeHoldReleased(
                await control.request(
                  CONTROL_METHODS.loginRelease,
                  encodeControlRequest({ holdId }),
                ),
              );
              pendingReleases.delete(holdId);
            } catch (err) {
              if (
                err instanceof WorkerRequestError &&
                err.code === UNKNOWN_HOLD
              )
                pendingReleases.delete(holdId);
              else throw err;
            }
          }
          // Before ready, so no engine's first compatible request beats it; one
          // account's failure does not stop the next.
          for (const profile of compatible)
            await pushCompat(
              (method, payload) => control!.request(method, payload),
              profile,
            );
          // No await between the final generation checks and ready. A change
          // during any awaited pass is covered by another complete snapshot.
          if (
            generation !== profileGeneration ||
            liveGeneration !== leaseGeneration
          )
            continue;
          if (stopped || connection !== control || control.isEnded) break;
          setState("connected");
          failures = 0;
          log(
            `ready: ${profiles.length} profiles; revoked ${ofOtherBoots.length} server and ${ofDeadEngines.length} engine leases of earlier boots`,
          );
          break;
        }
        if (!stopped) await control.ended;
      } catch (err) {
        if (!stopped) log(`unavailable: ${failure(err)}`);
      } finally {
        control?.end("the gateway attempt ended");
        if (connection === control) connection = undefined;
      }
      // Preserve today's one-shot in-process boot. Only socket mode retries.
      if (!options.socketPath) {
        bootFailed = true;
        resolveBoot(false);
        for (const resolve of readyWaiters) resolve(false);
        readyWaiters.clear();
        break;
      }
      if (stopped) break;
      startOutage();
      const delay = delays[Math.min(failures++, delays.length - 1)]!;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wakeRetry = undefined;
          resolve();
        }, delay);
        wakeRetry = () => {
          clearTimeout(timer);
          wakeRetry = undefined;
          resolve();
        };
      });
    }
  })();

  /** The tail of the one queue, so requests reach the gateway in call order. */
  let tail: Promise<unknown> = Promise.resolve();
  const request = (method: string, payload: Payload): Promise<Payload> => {
    const current = state === "connected" ? connection : undefined;
    const sent = tail.then(() => {
      if (!current || current !== connection || state !== "connected")
        throw new Error("the gateway is not ready");
      return current.request(method, payload);
    });
    tail = sent.catch(() => {});
    return sent;
  };

  /** After the queue's tail like `request`, without becoming it. */
  const requestAside = (method: string, payload: Payload): Promise<Payload> => {
    const current = state === "connected" ? connection : undefined;
    return tail.then(() => {
      if (!current || current !== connection || state !== "connected")
        throw new Error("the gateway is not ready");
      return current.request(method, payload);
    });
  };

  const readyWithin = (ms: number): Promise<boolean> => {
    if (state === "connected" && !stopped) return Promise.resolve(true);
    if (stopped || bootFailed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        readyWaiters.delete(done);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), ms);
      readyWaiters.add(done);
    });
  };

  const unsubscribe = subscribeCredentialProfileChanges((id) => {
    profileGeneration += 1;
    // Read now, so quick changes are sent in the order they happened.
    const current = credentialProfileById(id);
    const profile = current && gatewayProfile(current);
    const method = profile
      ? CONTROL_METHODS.upsertProfile
      : CONTROL_METHODS.removeProfile;
    if (!profile) {
      serverLeases.delete(id);
      credentialStatuses.delete(id);
    }
    if (state !== "connected") return;
    request(
      method,
      encodeControlRequest(profile ? { profile } : { profileId: id }),
    ).then(
      (answer) => {
        const { revoked } = decodeLeasesRevoked(answer);
        if (revoked.length)
          log(`${method} (profile ${id}): revoked ${revoked.length} leases`);
      },
      (err: unknown) => log(`${method} (profile ${id}): ${failure(err)}`),
    );
    // After its upsert, so the gateway knows the profile the pair is for.
    if (profile?.provider === "openai-compatible" && current)
      void pushCompat(request, current);
  });

  const grantServerLease = async (
    profileId: string,
  ): Promise<EngineGatewayAccess> => {
    // Ready implies a started gateway, the lease's only destination.
    const baseUrl = (await readyWithin(READY_TIMEOUT_MS))
      ? options.socketPath
        ? `http://127.0.0.1:${options.port}`
        : gateway?.url
      : undefined;
    if (baseUrl === undefined) {
      log(`${CONTROL_METHODS.grant} (server, profile ${profileId}): not ready`);
      throw new GatewayUnavailableError();
    }
    try {
      const granted = decodeLeaseGranted(
        await request(
          CONTROL_METHODS.grant,
          encodeControlRequest({ kind: "server", profileId }),
        ),
      );
      return { baseUrl, leaseToken: granted.token };
    } catch (err) {
      log(
        `${CONTROL_METHODS.grant} (server, profile ${profileId}): ${failure(err)}`,
      );
      throw new GatewayUnavailableError();
    }
  };

  const link: GatewayLink = {
    ready: boot,
    connectionState: () => state,
    onConnectionState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    get gateway() {
      return gateway;
    },
    get baseUrl() {
      return options.socketPath
        ? `http://127.0.0.1:${options.port}`
        : gateway?.url;
    },
    async grantEngineLease({ workerId, sessionId, profileId }) {
      if (!(await readyWithin(READY_TIMEOUT_MS))) {
        log(`${CONTROL_METHODS.grant} (profile ${profileId}): not ready`);
        throw new GatewayUnavailableError();
      }
      try {
        const granted = decodeLeaseGranted(
          await request(
            CONTROL_METHODS.grant,
            encodeControlRequest({
              kind: "engine",
              workerId: workerId ?? IN_PROCESS_WORKER_ID,
              ...(sessionId !== undefined ? { sessionId } : {}),
              profileId,
            }),
          ),
        );
        if (workerId === undefined || workerId === IN_PROCESS_WORKER_ID) {
          liveLocalLeases.add(granted.leaseId);
          leaseGeneration += 1;
        }
        return granted;
      } catch (err) {
        log(`${CONTROL_METHODS.grant} (profile ${profileId}): ${failure(err)}`);
        throw new GatewayUnavailableError();
      }
    },
    serverAccess(profileId) {
      const known = serverLeases.get(profileId);
      if (known) return known;
      const granting = grantServerLease(profileId);
      serverLeases.set(profileId, granting);
      // A failed grant is forgotten, so the next call tries again.
      granting.catch(() => {
        if (serverLeases.get(profileId) === granting)
          serverLeases.delete(profileId);
      });
      return granting;
    },
    async bindLeaseSession(leaseId, sessionId) {
      try {
        await request(
          CONTROL_METHODS.bindSession,
          encodeControlRequest({ leaseId, sessionId }),
        );
      } catch (err) {
        log(
          `${CONTROL_METHODS.bindSession} (lease ${leaseId}): ${failure(err)}`,
        );
      }
    },
    async revokeLease(leaseId, reason) {
      if (liveLocalLeases.delete(leaseId)) leaseGeneration += 1;
      try {
        decodeLeaseRevoked(
          await request(
            CONTROL_METHODS.revoke,
            encodeControlRequest({ leaseId, reason }),
          ),
        );
      } catch (err) {
        log(`${CONTROL_METHODS.revoke} (lease ${leaseId}): ${failure(err)}`);
      }
    },
    async acquireLoginHold(profileId) {
      const holdId = randomBytes(16).toString("base64url");
      if (!(await readyWithin(READY_TIMEOUT_MS))) {
        log(`${CONTROL_METHODS.loginHold} (profile ${profileId}): not ready`);
        throw new GatewayLoginUnavailableError();
      }
      let acquired;
      try {
        acquired = decodeLoginHeld(
          await requestAside(
            CONTROL_METHODS.loginHold,
            encodeControlRequest({ profileId, holdId }),
          ),
        );
      } catch (err) {
        log(
          `${CONTROL_METHODS.loginHold} (profile ${profileId}): ${failure(err)}`,
        );
        // The hold may have been saved before its answer was lost. Its id
        // never reached the caller, so no login writer can have started.
        // Use the owning boot's ordinary release, replayed before ready if
        // the connection is down, just like an already settled login.
        await link.releaseLoginHold(holdId);
        throw new GatewayLoginUnavailableError();
      }
      if (!acquired.held)
        throw new LoginHeldError(acquired.refusal, acquired.holdId);
      return holdId;
    },
    async registerLoginWriter(holdId, pid) {
      try {
        await request(
          CONTROL_METHODS.loginWriter,
          encodeControlRequest({
            holdId,
            pid,
            startTime: processStartTime(pid),
          }),
        );
      } catch (err) {
        log(`${CONTROL_METHODS.loginWriter} (hold ${holdId}): ${failure(err)}`);
        throw new GatewayLoginUnavailableError();
      }
    },
    async releaseLoginHold(holdId) {
      // Record before awaiting: a release settled during a reconnect's last
      // pass must be replayed before it can become ready.
      pendingReleases.add(holdId);
      profileGeneration += 1;
      try {
        decodeHoldReleased(
          await request(
            CONTROL_METHODS.loginRelease,
            encodeControlRequest({ holdId }),
          ),
        );
      } catch (err) {
        log(
          `${CONTROL_METHODS.loginRelease} (hold ${holdId}): ${failure(err)}`,
        );
        if (!(err instanceof WorkerRequestError && err.code === UNKNOWN_HOLD))
          return;
      }
      pendingReleases.delete(holdId);
    },
    async forceReleaseLoginHold(holdId) {
      try {
        decodeHoldReleased(
          await request(
            CONTROL_METHODS.loginForceRelease,
            encodeControlRequest({ holdId }),
          ),
        );
      } catch (err) {
        log(
          `${CONTROL_METHODS.loginForceRelease} (hold ${holdId}): ${failure(err)}`,
        );
        if (err instanceof WorkerRequestError && err.code === UNKNOWN_HOLD)
          return;
        throw new GatewayLoginUnavailableError();
      }
    },
    onLoginStatus(listener) {
      loginStatusListeners.add(listener);
      return () => {
        loginStatusListeners.delete(listener);
      };
    },
    credentialStatus(profileId) {
      const needsLogin = credentialStatuses.get(profileId);
      return needsLogin === undefined ? undefined : { needsLogin };
    },
    reportsCredentialStatus: true,
    onCredentialStatus(listener) {
      credentialListeners.add(listener);
      return () => {
        credentialListeners.delete(listener);
      };
    },
    needsLoginProfiles() {
      return [...credentialStatuses]
        .filter(([, needsLogin]) => needsLogin)
        .map(([profileId]) => profileId);
    },
    loginStatus(profileId) {
      const status = loginStatuses.get(profileId);
      return status && { ...status };
    },
    close() {
      closing ??= (async () => {
        if (installed === link) installed = undefined;
        stopped = true;
        unsubscribe();
        clearTimeout(outageTimer);
        wakeRetry?.();
        connection?.end("the server link closed");
        resolveBoot(false);
        for (const resolve of readyWaiters) resolve(false);
        readyWaiters.clear();
        await attempts;
        await gateway?.close();
      })();
      return closing;
    },
  };
  installed = link;
  return link;
}
