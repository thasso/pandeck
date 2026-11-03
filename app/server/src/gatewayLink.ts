/**
 * The server's link to the credential gateway (`docs/workers.md`
 * "Credentials"), behind `ASSISTANT_GATEWAY=1`. It runs the gateway in this
 * process with its state in `DATA_DIR/gateway/` and speaks gateway control
 * 1.1 to it over an in-process pair, until the gateway gets its own process
 * and socket.
 *
 * Before it is ready the link says hello as this server boot, syncs every
 * credential profile and reconciles the in-process Worker with no live lease:
 * an engine of an earlier boot died with it. Profile changes follow, in order:
 * every request takes one queue.
 *
 * The engine seam (`workers/engineClient.ts`) grants an engine lease before
 * each profiled open and revokes it at the engine's end. A grant the link
 * cannot get fails the open with {@link GATEWAY_UNAVAILABLE_TEXT}. Binding a
 * session and revoking are best-effort and only logged: a revocation whose
 * save failed holds in the gateway's memory until a later save or the next
 * boot's reconcile.
 *
 * The login hold calls are G5's to wire into the login flows; nothing calls
 * them yet. A hold waiting for its profile's writer lane is ordered after the
 * queue but never holds it up. The link records each profile's latest
 * `profiles.status` for the login-stuck state.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  claudeConfigDir,
  credentialProfileById,
  listCredentialProfiles,
  piAgentDir,
  subscribeCredentialProfileChanges,
  type CredentialProfile,
} from "./credentialProfiles.ts";
import { errorText } from "./errors.ts";
import {
  CONTROL_METHODS,
  GATEWAY_CONTROL_PROTOCOL,
  decodeHoldReleased,
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
import {
  WorkerConnection,
  WorkerRequestError,
} from "./workerProtocol/connection.ts";
import { createInProcessTransport } from "./workerProtocol/inProcessTransport.ts";

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
interface LoginStatus {
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
  log?: (line: string) => void;
  /** Test and probe seam, passed to the gateway; the server never sets it. */
  upstreams?: UpstreamOverrides;
  /** Test seam: what starts the gateway. */
  start?: (options: GatewayOptions) => Promise<RunningGateway>;
}

interface EngineLeaseGrant {
  /** The engine's Worker; the in-process Worker when unknown. */
  workerId: string | undefined;
  /** Absent until the open names it; see `bindLeaseSession`. */
  sessionId?: string;
  profileId: string;
}

export interface GatewayLink {
  /** True once hello, sync and reconcile are done; false if the link failed. */
  readonly ready: Promise<boolean>;
  /** The gateway this link started, once it has. Tests and the probe read it. */
  readonly gateway: RunningGateway | undefined;
  /**
   * Waits for ready (at most 10 s), then grants. Rejects with a
   * {@link GatewayUnavailableError} when no lease could be had.
   */
  grantEngineLease(grant: EngineLeaseGrant): Promise<LeaseGranted>;
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
  /** The operator's Clear; rejects with U7's login text on any failure. */
  forceReleaseLoginHold(holdId: string): Promise<void>;
  /** The profile's latest login status from the gateway, if any. */
  loginStatus(profileId: string): LoginStatus | undefined;
  /** Uninstalls the link and closes its gateway (tests and the probe only); once. */
  close(): Promise<void>;
}

let installed: GatewayLink | undefined;

/** The process's link while one runs; without it no open grants a lease. */
export function installedGatewayLink(): GatewayLink | undefined {
  return installed;
}

/** A request failure as a log line may name it: its code, or the error's text. */
function failure(err: unknown): string {
  return err instanceof WorkerRequestError ? err.code : errorText(err);
}

/** The gateway's view of `profile`, or undefined when it cannot hold it. */
function gatewayProfile(
  profile: CredentialProfile,
): GatewayProfile | undefined {
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
  const loginStatuses = new Map<string, LoginStatus>();

  const boot = (async (): Promise<boolean> => {
    try {
      gateway = await (options.start ?? startGateway)({
        stateDir: options.stateDir,
        port: options.port,
        ...(options.log ? { log: options.log } : {}),
        ...(options.upstreams ? { upstreams: options.upstreams } : {}),
      });
      const [serverEnd, gatewayEnd] = createInProcessTransport();
      gateway.attachControl(gatewayEnd);
      const control = new WorkerConnection(serverEnd, {
        handshake: { role: "worker", workerId: "pandeck-server" },
        protocol: GATEWAY_CONTROL_PROTOCOL,
        handlers: {
          [CONTROL_METHODS.status]: (payload) => {
            const { profileId, ...status } = decodeHoldStatus(payload);
            loginStatuses.set(profileId, status);
            return Promise.resolve(encodeControlDone());
          },
        },
        onEnd: (reason) => {
          if (!closing) log(`control connection ended: ${reason}`);
        },
      });
      connection = control;
      const ofOtherBoots = decodeLeasesRevoked(
        await control.request(
          CONTROL_METHODS.hello,
          encodeControlRequest(hello),
        ),
      ).revoked;
      const profiles: GatewayProfile[] = [];
      for (const profile of listCredentialProfiles()) {
        const known = gatewayProfile(profile);
        if (known) profiles.push(known);
        else log(`profile ${profile.id} skipped: the gateway cannot hold it`);
      }
      decodeLeasesRevoked(
        await control.request(
          CONTROL_METHODS.syncProfiles,
          encodeControlRequest({ profiles }),
        ),
      );
      // This boot holds no lease yet: every grant waits for ready.
      const ofDeadEngines = decodeLeasesRevoked(
        await control.request(
          CONTROL_METHODS.reconcileWorker,
          encodeControlRequest({ workerId: IN_PROCESS_WORKER_ID, live: [] }),
        ),
      ).revoked;
      log(
        `ready: ${profiles.length} profiles; revoked ${ofOtherBoots.length} server and ${ofDeadEngines.length} engine leases of earlier boots`,
      );
      return true;
    } catch (err) {
      log(`unavailable: ${failure(err)}`);
      return false;
    }
  })();

  /** The tail of the one queue, so requests reach the gateway in call order. */
  let tail: Promise<unknown> = boot;
  const request = (method: string, payload: Payload): Promise<Payload> => {
    const sent = tail.then(() => {
      if (!connection) throw new Error("the gateway did not start");
      return connection.request(method, payload);
    });
    tail = sent.catch(() => {});
    return sent;
  };

  /** After the queue's tail like `request`, without becoming it. */
  const requestAside = (method: string, payload: Payload): Promise<Payload> =>
    tail.then(() => {
      if (!connection) throw new Error("the gateway did not start");
      return connection.request(method, payload);
    });

  const readyWithin = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void boot.then((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });

  const unsubscribe = subscribeCredentialProfileChanges((id) => {
    // Read now, so quick changes are sent in the order they happened.
    const current = credentialProfileById(id);
    const profile = current && gatewayProfile(current);
    const method = profile
      ? CONTROL_METHODS.upsertProfile
      : CONTROL_METHODS.removeProfile;
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
  });

  const link: GatewayLink = {
    ready: boot,
    get gateway() {
      return gateway;
    },
    async grantEngineLease({ workerId, sessionId, profileId }) {
      if (!(await readyWithin(READY_TIMEOUT_MS))) {
        log(`${CONTROL_METHODS.grant} (profile ${profileId}): not ready`);
        throw new GatewayUnavailableError();
      }
      try {
        return decodeLeaseGranted(
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
      } catch (err) {
        log(`${CONTROL_METHODS.grant} (profile ${profileId}): ${failure(err)}`);
        throw new GatewayUnavailableError();
      }
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
      }
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
        throw new GatewayLoginUnavailableError();
      }
    },
    loginStatus(profileId) {
      const status = loginStatuses.get(profileId);
      return status && { ...status };
    },
    close() {
      closing ??= (async () => {
        if (installed === link) installed = undefined;
        unsubscribe();
        await boot;
        connection?.end("the server link closed");
        await gateway?.close();
      })();
      return closing;
    },
  };
  installed = link;
  return link;
}
