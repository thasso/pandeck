/**
 * The relay (`gateway-service` plan M14, Task-1384): the only holder of a
 * gateway client's key on its box. It understands no protocol; it adds the
 * client's TLS identity and pipes bytes to the gateway edge.
 *
 * - A loopback HTTP listener for model traffic: every request goes to the
 *   edge's model port over mutual TLS, unchanged, lease token included. Both
 *   bodies stream with `pipe`, so a paused engine holds the edge back.
 * - A Unix socket (0600, the relay's account) for the client protocol: each
 *   accepted connection is piped byte for byte to the edge's client port.
 *
 * `enrollRelay` makes the key and the MCP token with `node:crypto`, redeems a
 * one-time code at the edge's enrollment port with the public key and the
 * token's hash, and keeps key, certificate, CA, the edge's ports and the token
 * (`mcp-token`) in the state directory, every file 0600.
 * `enrollRelayByApproval` (Task-1410) does the same through a request the
 * user approves in the gateway page instead of a code. Imports only `node:`
 * modules.
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import tls from "node:tls";

const KEY_FILE = "client-key.pem";
const CERT_FILE = "client-cert.pem";
const CA_FILE = "gateway-ca.pem";
const EDGE_FILE = "edge.json";
/** The machine's MCP token, for the agents on this machine; never sent. */
const MCP_TOKEN_FILE = "mcp-token";
/** Every enrollment request's deadline, connect to last byte. */
const ENROLL_REQUEST_TIMEOUT_MS = 15_000;
const MAX_ENROLL_ANSWER_BYTES = 64 * 1024;

/** Where the edge listens, as the relay's state names it. */
interface EdgeAddress {
  host: string;
  clientId: string;
  modelPort: number;
  clientPort: number;
}

interface RelayIdentity extends EdgeAddress {
  key: string;
  cert: string;
  ca: string;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function forwardable(
  headers: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
  return out;
}

/** The TLS name to check the edge's certificate for; an IP gets no SNI. */
function tlsName(host: string): { servername?: string } {
  return net.isIP(host) ? {} : { servername: host };
}

function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * What this machine makes for an enrollment: its key pair and its MCP token
 * (`pgmcp_` and 32 random bytes, base64url, the format of the page's minted
 * tokens). Only the public key and the token's SHA-256 leave the machine.
 */
interface MachineSecrets {
  privateKeyPem: string;
  publicKeyPem: string;
  mcpToken: string;
  mcpTokenHash: string;
}

function machineSecrets(): MachineSecrets {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const mcpToken = `pgmcp_${randomBytes(32).toString("base64url")}`;
  return {
    privateKeyPem: privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    mcpToken,
    mcpTokenHash: createHash("sha256").update(mcpToken, "utf8").digest("hex"),
  };
}

/** An answer of the enrollment port: its status, `retry-after` and JSON. */
interface EnrollAnswer {
  status: number;
  retryAfterSeconds: number | undefined;
  body: unknown;
}

interface EnrollTarget {
  host: string;
  enrollPort: number;
  caPem: string;
}

/**
 * POSTs a JSON body to the enrollment port. Rejects on a network error, when
 * the answer has not fully arrived within `timeoutMs`, or when `signal`
 * aborts (with its reason). A body that is not JSON reads as undefined.
 */
function postEnroll(
  target: EnrollTarget,
  path: string,
  json: object,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<EnrollAnswer> {
  const body = JSON.stringify(json);
  const deadline = AbortSignal.timeout(timeoutMs);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return new Promise<EnrollAnswer>((resolve, reject) => {
    const fail = (err: Error) => {
      const reason: unknown = signal?.aborted ? signal.reason : undefined;
      reject(
        reason instanceof Error
          ? reason
          : deadline.aborted
            ? new Error("The gateway did not answer in time.")
            : err,
      );
    };
    const request = https.request(
      {
        host: target.host,
        port: target.enrollPort,
        ...tlsName(target.host),
        ca: target.caPem,
        method: "POST",
        path,
        agent: false,
        signal: bounded,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ENROLL_ANSWER_BYTES)
            response.destroy(
              new Error("The gateway's enrollment answer is too large."),
            );
          else chunks.push(chunk);
        });
        response.on("end", () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            parsed = undefined;
          }
          const retryAfter = Number(response.headers["retry-after"]);
          resolve({
            status: response.statusCode ?? 0,
            retryAfterSeconds:
              Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter
                : undefined,
            body: parsed,
          });
        });
        response.on("error", fail);
      },
    );
    request.on("error", fail);
    request.end(body);
  });
}

/**
 * Writes what an enrollment answered, with the machine's key and MCP token,
 * into the state directory, every file 0600. Checks the whole answer before
 * the first write.
 */
function writeEnrollment(
  stateDir: string,
  host: string,
  secrets: MachineSecrets,
  answer: unknown,
): string {
  const { clientId, certificatePem, caPem, modelPort, clientPort } = (answer ??
    {}) as Record<string, unknown>;
  if (
    typeof clientId !== "string" ||
    typeof certificatePem !== "string" ||
    typeof caPem !== "string" ||
    !Number.isSafeInteger(modelPort) ||
    !Number.isSafeInteger(clientPort)
  )
    throw new Error("The gateway's enrollment answer is malformed.");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  writePrivate(join(stateDir, KEY_FILE), secrets.privateKeyPem);
  writePrivate(join(stateDir, CERT_FILE), certificatePem);
  writePrivate(join(stateDir, CA_FILE), caPem);
  writePrivate(join(stateDir, MCP_TOKEN_FILE), `${secrets.mcpToken}\n`);
  const edge: EdgeAddress = {
    host,
    clientId,
    modelPort: modelPort as number,
    clientPort: clientPort as number,
  };
  writePrivate(join(stateDir, EDGE_FILE), `${JSON.stringify(edge, null, 2)}\n`);
  return clientId;
}

export interface RelayEnrollment extends EnrollTarget {
  stateDir: string;
  /** The edge's host and enrollment port. */
  host: string;
  enrollPort: number;
  /** The gateway's CA, PEM: the only trust root for the edge. */
  caPem: string;
  code: string;
}

/**
 * Enrolls this relay with a typed one-time code: answers the client id the
 * gateway assigned. Sends the MCP token's hash with the code; the files,
 * `mcp-token` among them, are written only after the gateway answered 200.
 */
export async function enrollRelay(options: RelayEnrollment): Promise<string> {
  const secrets = machineSecrets();
  const answer = await postEnroll(
    options,
    "/enroll",
    {
      code: options.code,
      publicKeyPem: secrets.publicKeyPem,
      mcpTokenHash: secrets.mcpTokenHash,
    },
    ENROLL_REQUEST_TIMEOUT_MS,
    undefined,
  );
  if (answer.status !== 200)
    throw new Error(`The gateway refused the enrollment (${answer.status}).`);
  return writeEnrollment(options.stateDir, options.host, secrets, answer.body);
}

/** What a machine says it is; the page shows it as the machine's claim. */
export type MachineKind = "devbox" | "laptop" | "other";

/** What the person approving needs: the link and the code. Nothing secret. */
/**
 * Why the gateway left a devbox's start to the page (Task-1410 PR2), from
 * its fixed set; nothing else about the proof is answered.
 */
const AUTOMATIC_REFUSED = [
  "not_configured",
  "token_rejected",
  "not_admitted",
  "claim_pending",
  "already_used",
  "limit",
  "unavailable",
] as const;
type AutomaticRefused = (typeof AUTOMATIC_REFUSED)[number];

export interface ApprovalPrompt {
  verificationUri: string;
  userCode: string;
  expiresInSeconds: number;
  /**
   * With a devbox proof: why it did not approve the request, the gateway's
   * fixed reason, or `unavailable` when the start with it failed and was
   * sent again without it.
   */
  automaticRefused?: AutomaticRefused;
}

/** Time for the approval loop; tests pass a virtual one. */
export interface EnrollClock {
  now(): number;
  /** Resolves after `ms`; rejects with the signal's reason when it aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const REAL_CLOCK: EnrollClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    sleep(ms, undefined, signal ? { signal } : {}).catch((err: unknown) => {
      throw signal?.aborted ? signal.reason : err;
    }),
};

export interface RelayApprovalEnrollment extends EnrollTarget {
  stateDir: string;
  /** Shown on the page as the machine's own claim. */
  name: string;
  kind?: MachineKind;
  /** Called once the request is open: show the link and code to a person. */
  onPrompt(prompt: ApprovalPrompt): void;
  /**
   * A devbox's proof of its owner (Task-1410 PR2): the owner's Google access
   * token, sent with the start only, never written or logged.
   */
  devbox?: { googleAccessToken: string };
  /** Called instead of `onPrompt` when the gateway approved at once. */
  onAutomatic?(): void;
  /** Aborting (SIGINT) stops the wait; nothing is written. */
  signal?: AbortSignal;
  /** Test seam: a virtual clock. */
  clock?: EnrollClock;
  /** Test seam: a shorter per-request deadline than 15 s. */
  requestTimeoutMs?: number;
}

/** A refusal that ends an approval enrollment, with a fixed reason. */
export class ApprovalEnrollmentError extends Error {
  constructor(
    readonly reason:
      "refused" | "denied" | "expired" | "revoked" | "unknown" | "malformed",
    message: string,
  ) {
    super(message);
  }
}

/** The first and the longest wait after a 503 or a network error. */
const BACKOFF_FIRST_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
/** Added to the poll interval on each `slow_down`. */
const SLOW_DOWN_MS = 5_000;
/** How long past the request's expiry the machine keeps polling. */
const DEADLINE_GRACE_MS = 30_000;

function decodeStartAnswer(body: unknown) {
  const {
    requestId,
    userCode,
    verificationUri,
    expiresInSeconds,
    intervalSeconds,
    approval,
    automaticRefused,
  } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof requestId !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    !Number.isSafeInteger(expiresInSeconds) ||
    (expiresInSeconds as number) <= 0 ||
    !Number.isSafeInteger(intervalSeconds) ||
    (intervalSeconds as number) <= 0
  )
    throw new ApprovalEnrollmentError(
      "malformed",
      "The gateway's enrollment request answer is malformed.",
    );
  return {
    requestId,
    userCode,
    verificationUri,
    expiresInSeconds: expiresInSeconds as number,
    intervalSeconds: intervalSeconds as number,
    // A gateway before Task-1410 PR2 answers no `approval`: the browser.
    automatic: approval === "automatic",
    automaticRefused: AUTOMATIC_REFUSED.find(
      (reason) => reason === automaticRefused,
    ),
  };
}

/**
 * Enrolls this relay by approval in the gateway page (Task-1410): opens a
 * request with the public key, the MCP token's hash, `name` and `kind`, hands
 * the link and code to `onPrompt`, then polls until the request is decided.
 *
 * Polls every `intervalSeconds` the gateway gave, 5 s longer after each 429
 * `slow_down`; after a 503 (any 5xx) or a network error it waits 5 s, doubling
 * to 60 s, until a poll is answered again. Every request has a 15 s deadline.
 * It gives up `expiresInSeconds` + 30 s after the start, on a denial, an
 * expired, revoked or unknown request, or when `signal` aborts. Its files
 * are written only after a 200, so a stopped or refused enrollment leaves
 * none.
 *
 * With `devbox` (Task-1410 PR2) the start carries the owner's proof. When the
 * gateway answers `approval: "automatic"` there is no prompt and the first
 * poll goes at once; otherwise the prompt gets the reason. A start with the
 * proof that times out, fails on the network or answers 5xx is sent once more
 * at once without it; an abort is never retried.
 */
export async function enrollRelayByApproval(
  options: RelayApprovalEnrollment,
): Promise<string> {
  const clock = options.clock ?? REAL_CLOCK;
  const timeoutMs = options.requestTimeoutMs ?? ENROLL_REQUEST_TIMEOUT_MS;
  const { signal } = options;
  signal?.throwIfAborted();
  const secrets = machineSecrets();
  const request = {
    publicKeyPem: secrets.publicKeyPem,
    mcpTokenHash: secrets.mcpTokenHash,
    name: options.name,
    kind: options.kind ?? "other",
  };
  const startWithout = () =>
    postEnroll(options, "/enroll/start", request, timeoutMs, signal);
  let started: EnrollAnswer | undefined;
  let proofDropped = false;
  if (options.devbox) {
    try {
      started = await postEnroll(
        options,
        "/enroll/start",
        {
          ...request,
          devbox: { googleAccessToken: options.devbox.googleAccessToken },
        },
        timeoutMs,
        signal,
      );
    } catch (err) {
      // A cancel ends here; a timeout or a network failure is retried.
      if (signal?.aborted || !(err instanceof Error)) throw err;
    }
    if (started === undefined || started.status >= 500) {
      proofDropped = true;
      started = await startWithout();
    }
  } else started = await startWithout();
  if (started.status !== 200)
    throw new ApprovalEnrollmentError(
      "refused",
      `The gateway refused the enrollment request (${started.status}).`,
    );
  const start = decodeStartAnswer(started.body);
  const deadline =
    clock.now() + start.expiresInSeconds * 1000 + DEADLINE_GRACE_MS;
  const automatic = !proofDropped && start.automatic;
  const refused = proofDropped ? "unavailable" : start.automaticRefused;
  if (automatic) options.onAutomatic?.();
  else
    options.onPrompt({
      verificationUri: start.verificationUri,
      userCode: start.userCode,
      expiresInSeconds: start.expiresInSeconds,
      ...(options.devbox && refused ? { automaticRefused: refused } : {}),
    });

  let interval = start.intervalSeconds * 1000;
  let backoff = BACKOFF_FIRST_MS;
  // Approved already: collect at once.
  let wait = automatic ? 0 : interval;
  const expired = () =>
    new ApprovalEnrollmentError(
      "expired",
      "The enrollment request expired before it was approved.",
    );
  for (;;) {
    const left = deadline - clock.now();
    if (left <= 0) throw expired();
    if (wait > 0) await clock.sleep(Math.min(wait, left), signal);
    else signal?.throwIfAborted();
    const remaining = deadline - clock.now();
    if (remaining <= 0) throw expired();
    let answer: EnrollAnswer;
    try {
      answer = await postEnroll(
        options,
        "/enroll/poll",
        { requestId: start.requestId },
        Math.min(timeoutMs, remaining),
        signal,
      );
    } catch (err) {
      // A cancel ends the wait; a network error or a stall backs off.
      if (signal?.aborted) throw signal.reason;
      if (!(err instanceof Error)) throw err;
      wait = backoff;
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      continue;
    }
    const error = (answer.body as { error?: unknown } | undefined)?.error;
    if (answer.status === 200)
      return writeEnrollment(
        options.stateDir,
        options.host,
        secrets,
        answer.body,
      );
    if (answer.status === 202) {
      backoff = BACKOFF_FIRST_MS;
      wait = interval;
      continue;
    }
    if (answer.status === 429) {
      interval += SLOW_DOWN_MS;
      wait = Math.max(interval, (answer.retryAfterSeconds ?? 0) * 1000);
      continue;
    }
    if (answer.status >= 500) {
      wait = backoff;
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      continue;
    }
    if (answer.status === 403)
      throw new ApprovalEnrollmentError(
        "denied",
        "The enrollment request was denied.",
      );
    if (answer.status === 410 && error === "revoked")
      throw new ApprovalEnrollmentError(
        "revoked",
        "The client enrolled by this request was revoked.",
      );
    if (answer.status === 410) throw expired();
    if (answer.status === 404)
      throw new ApprovalEnrollmentError(
        "unknown",
        "The gateway no longer knows this enrollment request.",
      );
    throw new ApprovalEnrollmentError(
      "refused",
      `The gateway refused the poll (${answer.status}).`,
    );
  }
}

function readIdentity(stateDir: string): RelayIdentity {
  const edge = JSON.parse(
    readFileSync(join(stateDir, EDGE_FILE), "utf8"),
  ) as EdgeAddress;
  return {
    ...edge,
    key: readFileSync(join(stateDir, KEY_FILE), "utf8"),
    cert: readFileSync(join(stateDir, CERT_FILE), "utf8"),
    ca: readFileSync(join(stateDir, CA_FILE), "utf8"),
  };
}

export interface RelayOptions {
  stateDir: string;
  /** The loopback model port; 0 picks a free one. */
  port: number;
  /** The client protocol's Unix socket. */
  socketPath: string;
  log?: (line: string) => void;
}

export interface RunningRelay {
  /** `http://127.0.0.1:<port>`: where engines send model requests. */
  readonly url: string;
  readonly port: number;
  readonly socketPath: string;
  close(): Promise<void>;
}

/** Removes a stale socket file; refuses to remove anything else. */
function clearSocketPath(path: string): void {
  if (!existsSync(path)) return;
  if (!lstatSync(path).isSocket())
    throw new Error(`${path} exists and is not a socket.`);
  unlinkSync(path);
}

export async function startRelay(options: RelayOptions): Promise<RunningRelay> {
  const log = options.log ?? ((line: string) => console.log(`[relay] ${line}`));
  const identity = readIdentity(options.stateDir);
  const tlsOptions = {
    host: identity.host,
    key: identity.key,
    cert: identity.cert,
    ca: identity.ca,
    ...tlsName(identity.host),
  };
  const agent = new https.Agent({ keepAlive: true, ...tlsOptions });
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };

  const model = http.createServer((req, res) => {
    const started = Date.now();
    const upstream = https.request({
      ...tlsOptions,
      port: identity.modelPort,
      agent,
      method: req.method,
      path: req.url,
      headers: forwardable(req.headers),
    });
    let settled = false;
    upstream.on("response", (edgeRes) => {
      res.writeHead(edgeRes.statusCode ?? 502, forwardable(edgeRes.headers));
      edgeRes.pipe(res);
      edgeRes.on("error", () => res.destroy());
      edgeRes.on("close", () => {
        if (!edgeRes.complete) res.destroy();
      });
      res.on("finish", () => {
        settled = true;
        log(`${req.method} ${edgeRes.statusCode} ${Date.now() - started}ms`);
      });
    });
    upstream.on("error", (err) => {
      if (settled) return;
      settled = true;
      const code = (err as { code?: unknown }).code;
      log(`${req.method} edge unreachable (${String(code ?? "error")})`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const body = JSON.stringify({
        error: { message: "The relay cannot reach the gateway." },
      });
      res.writeHead(502, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.on("error", () => upstream.destroy());
    req.pipe(upstream);
  });
  model.on("connection", track);
  model.on("clientError", (_err, socket) => socket.destroy());

  const control = net.createServer((local) => {
    track(local);
    const edge = tls.connect({ ...tlsOptions, port: identity.clientPort });
    track(edge);
    const end = (): void => {
      local.destroy();
      edge.destroy();
    };
    local.on("error", end);
    edge.on("error", (err) => {
      const code = (err as { code?: unknown }).code;
      log(`client connection: edge failed (${String(code ?? "error")})`);
      end();
    });
    local.on("close", end);
    edge.on("close", end);
    local.pipe(edge);
    edge.pipe(local);
  });

  await new Promise<void>((resolve, reject) => {
    model.once("error", reject);
    model.listen(options.port, "127.0.0.1", () => {
      model.removeListener("error", reject);
      resolve();
    });
  });
  clearSocketPath(options.socketPath);
  // The socket is created 0600: no window in which another account opens it.
  const umask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      control.once("error", reject);
      control.listen(options.socketPath, () => {
        control.removeListener("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(umask);
  }
  chmodSync(options.socketPath, 0o600);
  const address = model.address();
  const port = typeof address === "object" && address ? address.port : 0;
  log(
    `client ${identity.clientId}: model on 127.0.0.1:${port}, client protocol on ${options.socketPath}`,
  );
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    socketPath: options.socketPath,
    async close() {
      const closed = Promise.all([
        new Promise<void>((resolve) => model.close(() => resolve())),
        new Promise<void>((resolve) => control.close(() => resolve())),
      ]);
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      agent.destroy();
      await closed;
    },
  };
}
