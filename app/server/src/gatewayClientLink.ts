/**
 * Client mode (plan Task-1384 §4, M15): the server's {@link GatewayLink} to a
 * remote gateway it reaches through the relay (`relay/relay.ts`). Gateway
 * client 1.0 runs over the relay's Unix socket; engines spend their leases at
 * the relay's loopback port, which adds the client's TLS identity.
 *
 * The gateway owns the accounts: on connect and on every `accounts.changed`
 * the link mirrors them into the credential profile registry
 * (`mirrorRemoteCredentialProfiles`), metadata only, so routing, pins and
 * Automatic work on them unchanged. Nothing is pushed. The first connect
 * reconciles the in-process Worker with no live lease; a lost connection is
 * dialled again every 2 s, without a reconcile, and grants in between fail
 * with U7's text. The server's own requests spend a client lease
 * (`leases.client`), one per account for this boot. Logins are the gateway's
 * (Task-1385): `remoteLogins.ts` drives them through `logins.*`, and the
 * login-hold calls refuse here. A lost connection marks the running logins
 * interrupted, and every connect has them reconciled with the gateway. The user's Atlassian credential is the
 * gateway's too (Task-1397): `remoteIntegrations.ts` sets, clears and reads
 * its status through `integrations.*`; after every connect the link reads
 * the status and announces the Jira section, so Settings shows it. The
 * gateway's tools (Task-1398) are listed on every connect before the
 * connection is published (`remoteTools.ts`), and the agents' calls go out
 * as `tools.call`, each bounded at 40 s. A gateway write (gateway client 1.1,
 * Task-1463 P6b) proposes with `tools.prepare`, bounded the same, and an
 * approved one applies with `tools.apply`, bounded at 55 s, whose outcome
 * says whether the edge provably never saw it. A file tool's call (gateway
 * client 1.2, Task-1441 P7a) is `tools.call` bounded at 215 s and read only
 * as a file answer; one runs at a time, and its slot is held until the
 * request retires, so late 100 MiB answers never stack. A client-mode upload
 * (gateway client 1.3, Task-1441 P8a) opens a reservation with
 * `uploads.open` and sends the approved bytes as `uploads.put` chunks of at
 * most 1 MiB, each bounded at 30 s; the apply that consumes it is bounded
 * for its bytes, `uploadApplyCallMs(W)`, at most 155 s.
 */
import {
  mirrorRemoteCredentialProfiles,
  type RemoteCredentialProfile,
} from "./credentialProfiles.ts";
import { errorText } from "./errors.ts";
import {
  CLIENT_METHODS,
  GATEWAY_CLIENT_PROTOCOL,
  FileAnswerRefusal,
  decodeAccounts,
  decodeClientIdentity,
  decodeFileAnswer,
  decodeIntegrationStatus,
  decodeLoginEvent,
  decodeApplyAnswer,
  decodeLoginStarted,
  decodePrepareAnswer,
  decodeToolAnswer,
  decodeToolListing,
  decodeUploadOpenAnswer,
  decodeUploadPutAnswer,
  decodeUploadReleaseAnswer,
  encodeClientMessage,
  UNKNOWN_LOGIN,
  type ClientAccount,
} from "./gateway/clientMethods.ts";
import {
  decodeLeaseGranted,
  decodeLeaseRevoked,
  decodeLeasesRevoked,
  encodeControlDone,
} from "./gateway/controlMethods.ts";
import {
  GATEWAY_LOGIN_UNAVAILABLE_TEXT,
  GatewayUnavailableError,
  installGatewayLink,
  type GatewayConnectionState,
  type GatewayLink,
} from "./gatewayLink.ts";
import {
  IntegrationRefusal,
  installRemoteIntegrationPort,
  isIntegrationRefusalCode,
  rememberAtlassianStatus,
} from "./remoteIntegrations.ts";
import {
  installRemoteLoginPort,
  remoteLoginEvent,
  remoteLoginsDisconnected,
  remoteLoginsReconnected,
} from "./remoteLogins.ts";
import {
  RemoteToolRefusal,
  acceptRemoteTools,
  applyListing,
  installRemoteToolPort,
  markDisconnected,
  type RemoteFileAnswer,
  type RemotePrepareAnswer,
  type RemoteUploadPort,
  type RemoteToolAnswer,
  type RemoteToolDescriptor,
} from "./remoteTools.ts";
import type { Payload } from "./workerProtocol/codec.ts";
import {
  UNKNOWN_METHOD,
  WorkerConnection,
  type ConnectionLimits,
  WorkerRequestError,
  WorkerRequestNotSentError,
} from "./workerProtocol/connection.ts";
import type { EngineGatewayAccess } from "./workerProtocol/engineMethods.ts";
import { dialUnixSocket } from "./workerProtocol/unixSocketTransport.ts";

const READY_TIMEOUT_MS = 10_000;
/** The in-process Worker's id, as `gatewayLink.ts` names it. */
const IN_PROCESS_WORKER_ID = "local";
const REDIAL_MS = 2_000;
/** Bounds an agent's gateway tool call beyond the edge's own 30 s. */
const TOOL_CALL_MS = 40_000;
/**
 * Bounds an approved gateway write beyond the edge's own 45 s apply deadline
 * (Task-1463 P6b); it has no caller signal.
 */
const APPLY_CALL_MS = 55_000;
/**
 * Bounds a file tool's call (Task-1441 P7a, G1): the edge's own 150 s
 * `FILE_DEADLINE_MS` (`gatewayTools/confluenceDownload.ts`, which this
 * server may not import), 60 s for up to 102 MiB to arrive (about 1.7 MB/s),
 * and a 5 s margin.
 */
const FILE_CALL_MS = 150_000 + 60_000 + 5_000;
/**
 * A file call stopped here (timeout or cancel) whose request has not retired
 * this long after it was sent ends the link (Task-1441 P7a, H1): past the
 * edge's longest legitimate path, 150 s deadline + 65 s output + 1 s grace.
 */
const FILE_RETIRE_MS = 300_000;
const MIB = 1024 * 1024;
/**
 * Bound `uploads.open` and each `uploads.put` (Task-1441 P8a, v09 P3): one
 * put is at most 1 MiB, so 30 s is far past P7a's assumed 1.7 MB/s floor.
 */
const OPEN_CALL_MS = 30_000;
const PUT_CALL_MS = 30_000;

/**
 * Bounds an apply that consumes an upload of `work` bytes (Task-1441 P8a,
 * v09 P3): the edge's own upload deadline, 45 s plus 1 s per started MiB
 * and at most 145 s (`uploadApplyDeadlineMs` in `gatewayTools/uploads.ts`,
 * which this server may not import), plus 10 s, at most 155 s. A table test
 * pins both copies.
 */
export function uploadApplyCallMs(work: number): number {
  const edge = Math.min(145_000, 45_000 + 1_000 * Math.ceil(work / MIB));
  return Math.min(155_000, edge + 10_000);
}
/**
 * What the edge may send this server (Task-1441 P7a, G4): one maximal file
 * answer, 100 MiB plus its 2 MiB headroom, beside 4 MiB of ordinary traffic.
 * The link serves only `accounts.changed` and `logins.event`.
 */
const LINK_LIMITS: ConnectionLimits = {
  maxMessageBytes: 102 * MIB,
  maxBufferedBytes: 106 * MIB,
  maxPartialMessages: 8,
  maxServing: 256,
};

/** An answer the link's decoder refused; `cause` is the decoder's error. */
class UndecodableAnswer extends Error {}

function decodeOrThrow<A>(
  decode: (payload: Payload) => A,
  payload: Payload,
): A {
  try {
    return decode(payload);
  } catch (err) {
    throw new UndecodableAnswer("undecodable answer", { cause: err });
  }
}

export interface GatewayClientLinkOptions {
  /** The relay's client-protocol socket. */
  socketPath: string;
  /** The relay's loopback model port. */
  relayPort: number;
  log?: (line: string) => void;
}

function failure(err: unknown): string {
  return err instanceof WorkerRequestError ? err.code : errorText(err);
}

function loginUnavailable(): Error {
  return new Error(GATEWAY_LOGIN_UNAVAILABLE_TEXT);
}

/** Starts the remote link and installs it; it never throws on a dial. */
export function startGatewayClientLink(
  options: GatewayClientLinkOptions,
): GatewayLink {
  const log =
    options.log ??
    ((line: string) => console.log(`[gateway-client-link] ${line}`));
  const baseUrl = `http://127.0.0.1:${options.relayPort}`;
  let connection: WorkerConnection | undefined;
  let closing = false;
  let reconciled = false;
  let redial: ReturnType<typeof setTimeout> | undefined;
  const needsLogin = new Map<string, boolean>();
  const serverLeases = new Map<string, Promise<EngineGatewayAccess>>();
  const stateListeners = new Set<(state: GatewayConnectionState) => void>();
  /** Connected or connecting only: client mode reports no unreachable yet. */
  const stateNow = (): GatewayConnectionState =>
    connection ? "connected" : "connecting";
  const stateChanged = (): void => {
    const state = stateNow();
    for (const listener of [...stateListeners]) listener(state);
  };
  let resolveReady!: (ok: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });

  // Client mode from the start: no local account shows before the mirror.
  mirrorRemoteCredentialProfiles([]);

  const mirror = (accounts: ClientAccount[]): void => {
    needsLogin.clear();
    for (const account of accounts)
      needsLogin.set(account.id, account.needsLogin);
    for (const id of serverLeases.keys())
      if (!needsLogin.has(id)) serverLeases.delete(id);
    mirrorRemoteCredentialProfiles(
      accounts.map((account): RemoteCredentialProfile => ({ ...account })),
    );
  };

  const dial = async (): Promise<WorkerConnection> => {
    const endpoint = await dialUnixSocket(options.socketPath);
    const opened: WorkerConnection = new WorkerConnection(endpoint, {
      handshake: { role: "worker", workerId: "pandeck-server" },
      protocol: GATEWAY_CLIENT_PROTOCOL,
      limits: LINK_LIMITS,
      handlers: {
        [CLIENT_METHODS.accountsChanged]: (payload) => {
          mirror(decodeAccounts(payload));
          return Promise.resolve(encodeControlDone());
        },
        [CLIENT_METHODS.loginEvent]: (payload) => {
          const decoded = decodeLoginEvent(payload);
          if (decoded) remoteLoginEvent(decoded.loginId, decoded.event);
          return Promise.resolve(encodeControlDone());
        },
      },
      onEnd: (reason) => {
        if (connection === opened) {
          connection = undefined;
          markDisconnected();
          // Login events sent meanwhile are lost (the gateway keeps none).
          remoteLoginsDisconnected();
          stateChanged();
        }
        if (closing) return;
        log(`connection ended: ${reason}`);
        schedule();
      },
    });
    return opened;
  };

  const connect = async (): Promise<void> => {
    redial = undefined;
    let opened: WorkerConnection | undefined;
    try {
      opened = await dial();
      const { clientId, userId } = decodeClientIdentity(
        await opened.request(CLIENT_METHODS.hello, encodeClientMessage({})),
      );
      mirror(
        decodeAccounts(
          await opened.request(
            CLIENT_METHODS.listAccounts,
            encodeClientMessage({}),
          ),
        ),
      );
      if (!reconciled) {
        // This boot holds no lease yet: an earlier boot's engines died with it.
        const { revoked } = decodeLeasesRevoked(
          await opened.request(
            CLIENT_METHODS.reconcileWorker,
            encodeClientMessage({ workerId: IN_PROCESS_WORKER_ID, live: [] }),
          ),
        );
        reconciled = true;
        log(`revoked ${revoked.length} engine leases of earlier boots`);
      }
      const tools = await listTools(opened);
      // A dial that ended meanwhile has scheduled its redial; it publishes
      // nothing, nor does a closing link.
      if (closing || opened.isEnded) {
        opened.end("the server link closed");
        return;
      }
      applyListing(tools);
      connection = opened;
      stateChanged();
      log(`ready as client ${clientId} of user ${userId}`);
      remoteLoginsReconnected();
      resolveReady(true);
      void readIntegrationStatus(opened);
    } catch (err) {
      log(`unavailable: ${failure(err)}`);
      // An unpublished dial goes with its failed connect; the redial replaces it.
      if (opened && connection !== opened) opened.end("the connect failed");
      schedule();
    }
  };

  /** The gateway's tools; a gateway without tools lists none. */
  const listTools = async (
    opened: WorkerConnection,
  ): Promise<RemoteToolDescriptor[]> => {
    try {
      return acceptRemoteTools(
        decodeToolListing(
          await opened.request(
            CLIENT_METHODS.toolsList,
            encodeClientMessage({}),
          ),
        ),
      );
    } catch (err) {
      if (
        err instanceof WorkerRequestError &&
        (err.code === "tools_unavailable" || err.code === UNKNOWN_METHOD)
      )
        return [];
      throw err;
    }
  };

  /** The stored credential's status, so a restarted server shows it. */
  const readIntegrationStatus = async (
    opened: WorkerConnection,
  ): Promise<void> => {
    try {
      rememberAtlassianStatus(
        decodeIntegrationStatus(
          await opened.request(
            CLIENT_METHODS.integrationStatus,
            encodeClientMessage({ integration: "atlassian", check: false }),
          ),
        ),
      );
    } catch (err) {
      log(`${CLIENT_METHODS.integrationStatus}: ${failure(err)}`);
      return;
    }
    try {
      const { announceSettingsWritten } = await import("./settingsService.ts");
      await announceSettingsWritten(["jira"]);
    } catch (err) {
      log(`announcing the Jira status failed: ${errorText(err)}`);
    }
  };

  const schedule = (): void => {
    if (closing || redial) return;
    redial = setTimeout(() => void connect(), REDIAL_MS);
    redial.unref();
  };

  const readyWithin = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void ready.then((ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });

  const request = async (
    method: string,
    payload: Payload,
  ): Promise<Payload> => {
    if (!connection) throw new Error("the relay is not connected");
    return connection.request(method, payload);
  };

  const grantClientLease = async (
    accountId: string,
  ): Promise<EngineGatewayAccess> => {
    if (!(await readyWithin(READY_TIMEOUT_MS)))
      throw new GatewayUnavailableError();
    try {
      const granted = decodeLeaseGranted(
        await request(
          CLIENT_METHODS.clientLease,
          encodeClientMessage({ accountId }),
        ),
      );
      return { baseUrl, leaseToken: granted.token };
    } catch (err) {
      log(
        `${CLIENT_METHODS.clientLease} (account ${accountId}): ${failure(err)}`,
      );
      throw new GatewayUnavailableError();
    }
  };

  const uninstallLogins = installRemoteLoginPort({
    async start(start) {
      if (!(await readyWithin(READY_TIMEOUT_MS)))
        throw new Error(GATEWAY_LOGIN_UNAVAILABLE_TEXT);
      const started = decodeLoginStarted(
        await request(CLIENT_METHODS.loginStart, encodeClientMessage(start)),
      );
      // A new account is in the mirror before its login is answered.
      if (!needsLogin.has(started.accountId))
        mirror(
          decodeAccounts(
            await request(CLIENT_METHODS.listAccounts, encodeClientMessage({})),
          ),
        );
      log(`logins.start (account ${started.accountId}): ok`);
      return started;
    },
    async input(loginId, text) {
      await request(
        CLIENT_METHODS.loginInput,
        encodeClientMessage({ loginId, text }),
      );
    },
    async remove(accountId) {
      await request(
        CLIENT_METHODS.removeAccount,
        encodeClientMessage({ accountId }),
      );
      // The mirror drops it now, not only at the next `accounts.changed`.
      mirror(
        decodeAccounts(
          await request(CLIENT_METHODS.listAccounts, encodeClientMessage({})),
        ),
      );
    },
    async cancel(loginId) {
      try {
        await request(
          CLIENT_METHODS.loginCancel,
          encodeClientMessage({ loginId }),
        );
        return "cancelled";
      } catch (err) {
        if (err instanceof WorkerRequestError && err.code === UNKNOWN_LOGIN)
          return "unknown";
        throw err;
      }
    },
  });
  const integrationRequest = async (
    method: string,
    json: object,
  ): Promise<Payload> => {
    if (!(await readyWithin(READY_TIMEOUT_MS)))
      throw new IntegrationRefusal("gateway_unavailable");
    try {
      return await request(
        method,
        encodeClientMessage({ integration: "atlassian", ...json }),
      );
    } catch (err) {
      log(`${method}: ${failure(err)}`);
      throw new IntegrationRefusal(
        err instanceof WorkerRequestError && isIntegrationRefusalCode(err.code)
          ? err.code
          : "gateway_unavailable",
      );
    }
  };
  const uninstallIntegrations = installRemoteIntegrationPort({
    async set(input) {
      return decodeIntegrationStatus(
        await integrationRequest(CLIENT_METHODS.integrationSet, input),
      );
    },
    async clear() {
      await integrationRequest(CLIENT_METHODS.integrationClear, {});
    },
    async status(check) {
      return decodeIntegrationStatus(
        await integrationRequest(CLIENT_METHODS.integrationStatus, { check }),
      );
    },
  });
  /**
   * One bounded tool request: the caller's abort and the local bound share
   * one controller, so either settles the call now with `stopped(code)` and
   * sends a cancel; the edge's late answer retires the request and is dropped
   * unread, never decoded. An answer `decode` refuses throws
   * {@link UndecodableAnswer}. `sent` sees the request itself, which settles
   * only when the edge answers or the connection ends.
   */
  const boundedToolRequest = async <A>(
    opened: WorkerConnection,
    method: string,
    payload: Payload,
    signal: AbortSignal,
    decode: (payload: Payload) => A,
    stopped: (code: "timeout" | "cancelled") => A,
    ms = TOOL_CALL_MS,
    sent?: (request: Promise<Payload>) => void,
  ): Promise<A> => {
    const controller = new AbortController();
    let timedOut = false;
    let stop = (): void => {};
    const settled = new Promise<A>((resolve) => {
      stop = () => resolve(stopped(timedOut ? "timeout" : "cancelled"));
      controller.signal.addEventListener("abort", stop, { once: true });
    });
    const cancel = (): void => controller.abort();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
    const request = opened.request(method, payload, controller.signal);
    sent?.(request);
    try {
      return await Promise.race([
        request.then((answer) =>
          // A late answer lost the race already; it is never decoded.
          controller.signal.aborted ? settled : decodeOrThrow(decode, answer),
        ),
        settled,
      ]);
    } catch (err) {
      // Withdrawn before it was sent: the call always read this as cancelled.
      if (err instanceof WorkerRequestNotSentError) return stopped("cancelled");
      throw err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", stop);
    }
  };

  /**
   * A request the link could not make, or an answer it refused, as the tool
   * groups' refusal: a file it cannot take is its own (Task-1441 P7a).
   */
  const toolRefusal = (method: string, err: unknown): RemoteToolRefusal => {
    const cause = err instanceof UndecodableAnswer ? err.cause : err;
    log(`${method}: ${failure(cause)}`);
    if (cause instanceof FileAnswerRefusal)
      return new RemoteToolRefusal(
        cause.reason === "corrupted" ? "corrupted_file" : "unexpected_file",
      );
    return new RemoteToolRefusal(
      err instanceof WorkerRequestError && err.code === "tools_unavailable"
        ? "tools_unavailable"
        : "gateway_unavailable",
    );
  };

  /**
   * One bounded upload request (Task-1441 P8a): its decoded answer, the
   * edge's refusal text included; the link's own failure, an answer it
   * refused and the bound passing all throw {@link RemoteToolRefusal}. No
   * log line holds the upload's id, a name or a byte.
   */
  const uploadRequest = async <A>(
    method: string,
    payload: Payload,
    decode: (payload: Payload) => A,
    ms: number,
  ): Promise<A> => {
    const opened = connection;
    if (!opened) throw new RemoteToolRefusal("gateway_unavailable");
    let answer: A | undefined;
    try {
      answer = await boundedToolRequest<A | undefined>(
        opened,
        method,
        payload,
        new AbortController().signal,
        decode,
        () => undefined,
        ms,
      );
    } catch (err) {
      if (err instanceof UndecodableAnswer) {
        log(`${method}: ${failure(err.cause)}`);
        throw new RemoteToolRefusal("undecodable");
      }
      throw toolRefusal(method, err);
    }
    if (answer === undefined) {
      log(`${method}: no answer in time`);
      throw new RemoteToolRefusal("gateway_unavailable");
    }
    return answer;
  };
  const uploads: RemoteUploadPort = {
    async open(streams, work) {
      const answer = await uploadRequest(
        CLIENT_METHODS.uploadsOpen,
        encodeClientMessage({
          streams: streams.map(({ stagedAttachmentId, size, sha256 }) => ({
            stagedAttachmentId,
            size,
            sha256,
          })),
          work,
        }),
        decodeUploadOpenAnswer,
        OPEN_CALL_MS,
      );
      return answer.ok ? answer : { ok: false, message: answer.message };
    },
    async put(uploadId, stagedAttachmentId, offset, chunk) {
      const answer = await uploadRequest(
        CLIENT_METHODS.uploadsPut,
        {
          json: { uploadId, stagedAttachmentId, offset },
          bytes: { chunk },
        },
        decodeUploadPutAnswer,
        PUT_CALL_MS,
      );
      return answer.ok ? answer : { ok: false, message: answer.message };
    },
    release(uploadId) {
      // Sent without waiting (v03 K3); the edge discards it on its own
      // timers or the connection's end when this never arrives.
      const opened = connection;
      if (!opened || opened.isEnded) return;
      opened
        .request(
          CLIENT_METHODS.uploadsRelease,
          encodeClientMessage({ uploadId }),
        )
        .then((payload) => {
          if (!decodeUploadReleaseAnswer(payload).ok)
            log(`${CLIENT_METHODS.uploadsRelease}: refused`);
        })
        .catch((err: unknown) => {
          log(`${CLIENT_METHODS.uploadsRelease}: ${failure(err)}`);
        });
    },
  };

  /** The one file call this server runs at a time (Task-1441 P7a, G2). */
  let fileCall: object | undefined;

  const uninstallTools = installRemoteToolPort({
    async call(name, args, signal) {
      const opened = connection;
      if (!opened) throw new RemoteToolRefusal("gateway_unavailable");
      try {
        return await boundedToolRequest<RemoteToolAnswer>(
          opened,
          CLIENT_METHODS.toolsCall,
          encodeClientMessage({ name, args }),
          signal,
          decodeToolAnswer,
          (code) => ({ ok: false, code, message: "" }),
        );
      } catch (err) {
        throw toolRefusal(CLIENT_METHODS.toolsCall, err);
      }
    },
    async callFile(name, args, signal, expect, use) {
      const opened = connection;
      if (!opened) throw new RemoteToolRefusal("gateway_unavailable");
      if (fileCall) throw new RemoteToolRefusal("file_busy");
      // The slot is free again only when both are done: the request retired
      // (answered or its connection ended) and `use` has finished with it.
      const slot = {};
      fileCall = slot;
      let retired = false;
      let used = false;
      let retireTimer: ReturnType<typeof setTimeout> | undefined;
      const release = (): void => {
        if (!retired || !used || fileCall !== slot) return;
        fileCall = undefined;
        clearTimeout(retireTimer);
      };
      const watch = (request: Promise<Payload>): void => {
        retireTimer = setTimeout(() => {
          log(`${CLIENT_METHODS.toolsCall}: a file answer did not retire`);
          opened.end("a file answer did not retire in time");
        }, FILE_RETIRE_MS);
        retireTimer.unref?.();
        void request
          .catch(() => undefined)
          .then(() => {
            retired = true;
            release();
          });
      };
      try {
        let answer: RemoteFileAnswer;
        try {
          answer = await boundedToolRequest<RemoteFileAnswer>(
            opened,
            CLIENT_METHODS.toolsCall,
            encodeClientMessage({ name, args }),
            signal,
            (payload) => decodeFileAnswer(payload, expect),
            (code) => ({ kind: "failure", code, message: "" }),
            FILE_CALL_MS,
            watch,
          );
        } catch (err) {
          throw toolRefusal(CLIENT_METHODS.toolsCall, err);
        }
        return await use(answer);
      } finally {
        // Withdrawn before it was sent: nothing will retire it.
        if (!retireTimer) retired = true;
        used = true;
        release();
      }
    },
    async prepare(name, args, signal, declared) {
      const opened = connection;
      if (!opened) throw new RemoteToolRefusal("gateway_unavailable");
      try {
        return await boundedToolRequest<RemotePrepareAnswer>(
          opened,
          CLIENT_METHODS.toolsPrepare,
          encodeClientMessage({
            name,
            args,
            ...(declared
              ? { uploads: declared.map((entry) => ({ ...entry })) }
              : {}),
          }),
          signal,
          decodePrepareAnswer,
          (code) => ({ ok: false, code, message: "" }),
        );
      } catch (err) {
        if (err instanceof UndecodableAnswer) {
          log(`${CLIENT_METHODS.toolsPrepare}: ${failure(err.cause)}`);
          throw new RemoteToolRefusal("undecodable");
        }
        throw toolRefusal(CLIENT_METHODS.toolsPrepare, err);
      }
    },
    async apply(name, site, items, upload) {
      // Not sent is claimed only when the edge provably never saw the
      // request: no open connection right before it, or the connection's own
      // "not sent" error. Every other failure after the request may have
      // written (Task-1463 P6b, M2/D2), an error answer included: a
      // `WorkerRequestError` frame is `lost`. A decoded answer, `ok: false`
      // included, is the edge's own certificate and passes through whole;
      // only its `effects: "none"` lets the executor say nothing was written
      // (D6(i), M2).
      const opened = connection;
      if (!opened || opened.isEnded) return { outcome: "notSent" };
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<"timeout">((resolve) => {
        timer = setTimeout(
          () => {
            // Asks the edge to start no further item; a late answer is
            // dropped unread.
            controller.abort();
            resolve("timeout");
          },
          upload ? uploadApplyCallMs(upload.work) : APPLY_CALL_MS,
        );
      });
      let payload: Payload;
      try {
        const sent = await Promise.race([
          opened.request(
            CLIENT_METHODS.toolsApply,
            encodeClientMessage({
              name,
              site,
              items,
              ...(upload ? { uploadId: upload.uploadId } : {}),
            }),
            controller.signal,
          ),
          expired,
        ]);
        if (sent === "timeout") {
          log(`${CLIENT_METHODS.toolsApply}: no answer in time`);
          return { outcome: "timeout" };
        }
        payload = sent;
      } catch (err) {
        log(`${CLIENT_METHODS.toolsApply}: ${failure(err)}`);
        return err instanceof WorkerRequestNotSentError
          ? { outcome: "notSent" }
          : { outcome: "lost" };
      } finally {
        clearTimeout(timer);
      }
      try {
        return { outcome: "answer", answer: decodeApplyAnswer(payload) };
      } catch (err) {
        log(`${CLIENT_METHODS.toolsApply}: ${failure(err)}`);
        return { outcome: "undecodable" };
      }
    },
    uploads,
  });
  let uninstall: () => void = () => {};
  const link: GatewayLink = {
    ready,
    connectionState: stateNow,
    onConnectionState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    gateway: undefined,
    baseUrl,
    async grantEngineLease({ workerId, sessionId, profileId }) {
      if (!(await readyWithin(READY_TIMEOUT_MS))) {
        log(`${CLIENT_METHODS.grant} (account ${profileId}): not ready`);
        throw new GatewayUnavailableError();
      }
      try {
        return decodeLeaseGranted(
          await request(
            CLIENT_METHODS.grant,
            encodeClientMessage({
              accountId: profileId,
              workerId: workerId ?? IN_PROCESS_WORKER_ID,
              ...(sessionId !== undefined ? { sessionId } : {}),
            }),
          ),
        );
      } catch (err) {
        log(`${CLIENT_METHODS.grant} (account ${profileId}): ${failure(err)}`);
        throw new GatewayUnavailableError();
      }
    },
    serverAccess(profileId) {
      const known = serverLeases.get(profileId);
      if (known) return known;
      const granting = grantClientLease(profileId);
      serverLeases.set(profileId, granting);
      granting.catch(() => {
        if (serverLeases.get(profileId) === granting)
          serverLeases.delete(profileId);
      });
      return granting;
    },
    async bindLeaseSession(leaseId, sessionId) {
      try {
        await request(
          CLIENT_METHODS.bindSession,
          encodeClientMessage({ leaseId, sessionId }),
        );
      } catch (err) {
        log(
          `${CLIENT_METHODS.bindSession} (lease ${leaseId}): ${failure(err)}`,
        );
      }
    },
    async revokeLease(leaseId, reason) {
      try {
        decodeLeaseRevoked(
          await request(
            CLIENT_METHODS.revoke,
            encodeClientMessage({ leaseId, reason }),
          ),
        );
      } catch (err) {
        log(`${CLIENT_METHODS.revoke} (lease ${leaseId}): ${failure(err)}`);
      }
    },
    // Logins move into the gateway with slice 4 (Task-1385).
    acquireLoginHold: () => Promise.reject(loginUnavailable()),
    registerLoginWriter: () => Promise.reject(loginUnavailable()),
    releaseLoginHold: () => Promise.resolve(),
    forceReleaseLoginHold: () => Promise.resolve(),
    loginStatus: () => undefined,
    onLoginStatus: () => () => {},
    credentialStatus(profileId) {
      const value = needsLogin.get(profileId);
      return value === undefined ? undefined : { needsLogin: value };
    },
    // The remote gateway's needs-login arrives only on its account list, and
    // health keeps the error classifier for these accounts.
    reportsCredentialStatus: false,
    onCredentialStatus: () => () => {},
    needsLoginProfiles: () => [],
    async close() {
      if (closing) return;
      closing = true;
      uninstall();
      uninstallLogins();
      uninstallIntegrations();
      uninstallTools();
      if (redial) clearTimeout(redial);
      connection?.end("the server link closed");
      mirrorRemoteCredentialProfiles(undefined);
    },
  };
  uninstall = installGatewayLink(link);
  void connect();
  return link;
}
