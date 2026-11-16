/**
 * The gateway's users, enrolled clients, one-time enrollment codes and which
 * user owns each account (plan Task-1384 §1), in `clients.json` through
 * `privateJsonFile.ts`. A code is kept only as its SHA-256 and is used up
 * once; a client is named by the common name of its certificate and matched
 * by its fingerprint too. A client's MCP token (Task-1397) is likewise kept
 * only as its SHA-256.
 *
 * A machine can also enroll by approval (Task-1410): it starts a request
 * with its public key and the hash of the MCP token it generated, a signed-in
 * user approves or denies it once by its user code, and the machine collects
 * its certificate with its request id. The first collect stores the issued
 * (public) certificate on the request, so a repeat answers it unchanged.
 *
 * A user signs in to the gateway's page (Task-1402) with an OIDC identity,
 * issuer plus subject; the email is an attribute. An operator's claim binds
 * the next admitted sign-in with that email to an existing user once.
 *
 * The admin CLI writes the same file from its own process, so reads always
 * reload the current file. Writers hold clients.json.lock across the complete
 * read-modify-rename, including code redemption. A crashed writer leaves its
 * lock behind and fails closed until an operator removes it.
 */
import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createPrivateJsonFile } from "../privateJsonFile.ts";

/** How long an enrollment code stays valid. */
export const ENROLLMENT_CODE_TTL_MS = 15 * 60_000;
/** How long an enrollment request may be decided or collected. */
export const ENROLLMENT_REQUEST_TTL_MS = 10 * 60_000;
/**
 * How long a request's record stays after it expires, so a machine that lost
 * its collect's answer can poll it again.
 */
export const ENROLLMENT_REQUEST_RETAIN_MS = 10 * 60_000;
/** Open requests at most from one source address. */
export const MAX_OPEN_REQUESTS_PER_SOURCE = 4;
/** Open requests at most in all. */
export const MAX_OPEN_REQUESTS = 64;
/** Retained enrollment records at most, including open and terminal requests. */
export const MAX_RETAINED_REQUESTS = 256;
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** Whether `text` has the shape of a request id: 32 bytes in base64url. */
export function isRequestId(text: unknown): text is string {
  return typeof text === "string" && REQUEST_ID_RE.test(text);
}
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LABEL = 200;
const MAX_EMAIL = 254;

export interface GatewayUser {
  id: string;
  label: string;
  /** The OIDC identity this user signs in to the gateway's page with. */
  oidc?: { issuer: string; subject: string };
  /** The email of the latest sign-in, lowercased; an attribute, not a key. */
  email?: string;
}

export interface GatewayClient {
  id: string;
  userId: string;
  label: string;
  /** SHA-256 fingerprint of its certificate, as `X509Certificate` writes it. */
  fingerprint: string;
  createdAt: number;
  revokedAt?: number;
  /** Hex SHA-256 of the client's MCP token, when one was minted. */
  mcpTokenHash?: string;
}

interface PendingCode {
  /** Hex SHA-256 of the code. */
  hash: string;
  userId: string;
  label: string;
  expiresAt: number;
}

/** What a machine asking to enroll says it is; only ever displayed. */
export type EnrollmentKind = "devbox" | "laptop" | "other";

/**
 * A machine's pending enrollment (Task-1410): started on the enrollment port,
 * decided once in the gateway page, collected by the machine with its
 * `requestId`. Only the hashes of the request id and user code are kept.
 */
interface EnrollmentRequest {
  idHash: string;
  userCodeHash: string;
  /** The machine's public key, as SPKI PEM. */
  publicKeyPem: string;
  /** Hex SHA-256 of the MCP token the machine generated. */
  mcpTokenHash: string;
  name: string;
  kind: EnrollmentKind;
  /** The address the request came from. */
  from: string;
  createdAt: number;
  expiresAt: number;
  decision?: { userId: string; at: number } | "denied";
  /** The client the first collect created; the certificate is public. */
  issued?: { clientId: string; certificatePem: string };
}

/** An operator's `user claim`: binds the next admitted sign-in once. */
interface PendingClaim {
  userId: string;
  /** Lowercased. */
  email: string;
  expiresAt: number;
}

/** How a sign-in reached its user. */
export type SignInOutcome = "existing" | "created" | "bound";

interface AccountOwner {
  profileId: string;
  userId: string;
}

interface Stored {
  v: 1;
  users: GatewayUser[];
  clients: GatewayClient[];
  codes: PendingCode[];
  accounts: AccountOwner[];
  /** Absent in a file an older build wrote; read as empty. */
  claims?: PendingClaim[];
  /** Absent in a file an older build wrote; read as empty. */
  requests?: EnrollmentRequest[];
}

const empty = (): Stored => ({
  v: 1,
  users: [],
  clients: [],
  codes: [],
  accounts: [],
});

function isGatewayId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

function label(text: string): string {
  return text.slice(0, MAX_LABEL);
}

function hasIdentity(user: GatewayUser): boolean {
  return typeof user.oidc === "object" && user.oidc !== null;
}

function emailOf(text: string): string {
  const email = text.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1 || email.length > MAX_EMAIL)
    throw new Error("Not an email address.");
  return email;
}

/** An opaque random user id; it fits `ID_RE`. */
function newUserId(state: Stored): string {
  for (;;) {
    const id = `u_${randomBytes(12).toString("base64url")}`;
    if (!state.users.some((user) => user.id === id)) return id;
  }
}

/**
 * A new client's opaque random id; it fits `ID_RE`. The `c_` prefix keeps it
 * from starting with `-`, which an argument parser would read as an option
 * (`gateway-admin clients revoke <id>`). Ids enrolled before the prefix keep
 * their shape and may start with `-`; the admin CLI takes them after `--`.
 */
export function newClientId(
  random: (size: number) => Buffer = randomBytes,
): string {
  return `c_${random(12).toString("base64url")}`;
}

function hashOf(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

const HASH_RE = /^[a-f0-9]{64}$/;

/** Whether `text` has the shape of a stored hash: 64 lowercase hex. */
export function isHash(text: unknown): text is string {
  return typeof text === "string" && HASH_RE.test(text);
}

/** Whether the stored hash equals `hash`, in constant time; malformed is no. */
function hashEquals(stored: unknown, hash: Buffer): boolean {
  return isHash(stored) && timingSafeEqual(Buffer.from(stored, "hex"), hash);
}

/**
 * The user code without its dash, spaces or case, if it can be one: 8 letters
 * of the code alphabet.
 */
function normalUserCode(text: string): string | undefined {
  const code = text.replace(/[\s-]/g, "").toUpperCase();
  return USER_CODE_RE.test(code) ? code : undefined;
}

function newUserCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++)
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return code;
}

/**
 * Whether `token` is the client's MCP token. A stored hash that is not 64
 * hex characters counts as none.
 */
export function mcpTokenMatches(client: GatewayClient, token: string): boolean {
  const stored = client.mcpTokenHash;
  if (typeof stored !== "string" || !HASH_RE.test(stored)) return false;
  return timingSafeEqual(
    Buffer.from(stored, "hex"),
    Buffer.from(hashOf(token), "hex"),
  );
}

/** One line of `clients list`. */
export function clientListLine(client: GatewayClient): string {
  return `${client.id}\tuser=${client.userId}\t${client.revokedAt !== undefined ? "revoked" : "active"}\tmcp=${client.mcpTokenHash !== undefined ? "yes" : "no"}\t${client.label}`;
}

export class ClientRegistryLockedError extends Error {
  constructor(lock: string) {
    super(
      `Gateway client registry lock ${lock} did not clear within one second. Check that the writer PID recorded in this file is no longer running before removing the lock and retrying.`,
    );
  }
}

/**
 * Bounds on a user's enrollment codes, checked where a code is issued: at
 * most `maxPendingCodes` unexpired codes, and active clients plus unexpired
 * codes at most `maxClients`. A pending code reserves a client's place, so
 * redeeming every code keeps the user within `maxClients`. An approved,
 * uncollected, unexpired enrollment request counts as a pending code, both
 * where a code is issued and where a request is approved.
 */
export interface EnrollmentLimits {
  maxPendingCodes: number;
  maxClients: number;
}

/** A code would take the user past its `EnrollmentLimits`; nothing written. */
export class EnrollmentLimitError extends Error {
  constructor() {
    super("The user has too many clients or unused enrollment codes.");
  }
}

/** What `startRequest` gets from the enrollment port, already checked. */
interface EnrollmentRequestStart {
  publicKeyPem: string;
  mcpTokenHash: string;
  name: string;
  kind: EnrollmentKind;
  from: string;
}

/**
 * A started request, or why none was: `source_limit` for too many open
 * requests from that address, `capacity` for too many in all.
 */
type StartOutcome =
  | { ok: true; requestId: string; userCode: string; expiresAt: number }
  | { ok: false; reason: "source_limit" | "capacity" };

/** What the gateway page shows of an undecided request. */
interface EnrollmentRequestView {
  name: string;
  kind: EnrollmentKind;
  from: string;
  createdAt: number;
  expiresAt: number;
}

/** A decision's outcome; `unknown` covers decided and expired requests too. */
type DecideOutcome = "approved" | "denied" | "unknown" | "limit";

/** What a collect answers the machine. */
export type CollectOutcome =
  | {
      status: "approved";
      clientId: string;
      certificatePem: string;
      /** Whether this collect created the client. */
      first: boolean;
    }
  | { status: "pending" | "denied" | "expired" | "revoked" | "unknown" };

/** The client and certificate `collect` asks its caller to issue. */
interface IssuedCertificate {
  clientId: string;
  certificatePem: string;
  fingerprint: string;
}

/** The user an approval bound, if the request was approved. */
function approverOf(request: EnrollmentRequest): string | undefined {
  const decision = request.decision;
  return typeof decision === "object" &&
    decision !== null &&
    typeof decision.userId === "string"
    ? decision.userId
    : undefined;
}

/** The user code as the machine shows it: `XXXX-XXXX`. */
function displayUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export class ClientRegistry {
  private readonly path: string;
  private readonly file: ReturnType<typeof createPrivateJsonFile>;
  private readonly now: () => number;
  private lockReported = false;
  private seenFile = false;

  constructor(
    stateDir: string,
    now: () => number = Date.now,
    private readonly reportLock: (message: string) => void = () => {},
  ) {
    this.path = join(stateDir, "clients.json");
    this.file = createPrivateJsonFile(this.path, "gateway clients", {
      privateDirectory: "enforce",
      uniqueTemp: true,
    });
    this.now = now;
  }

  private load(): Stored {
    return this.file.read<Stored, Stored>((value) => {
      if (value === undefined) {
        if (this.seenFile)
          throw new Error("Gateway client registry file is missing.");
        return empty();
      }
      if (
        !value ||
        value.v !== 1 ||
        !Array.isArray(value.users) ||
        !Array.isArray(value.clients) ||
        !Array.isArray(value.codes) ||
        !Array.isArray(value.accounts) ||
        (value.requests !== undefined && !Array.isArray(value.requests))
      )
        throw new Error("Invalid gateway client registry.");
      this.seenFile = true;
      return value;
    });
  }

  private change<T>(
    apply: (state: Stored) => T,
    write = (_answer: T) => true,
  ): T {
    const lock = `${this.path}.lock`;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 1_000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let fd: number;
    for (;;) {
      try {
        fd = openSync(lock, "wx", 0o600);
        this.lockReported = false;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (Date.now() >= deadline) {
          const error = new ClientRegistryLockedError(lock);
          if (!this.lockReported) {
            this.lockReported = true;
            this.reportLock(error.message);
          }
          throw error;
        }
        Atomics.wait(pause, 0, 0, 10);
      }
    }
    try {
      writeFileSync(fd, `${process.pid}\n`);
      const state = this.load();
      const answer = apply(state);
      if (write(answer)) {
        state.codes = state.codes.filter((code) => code.expiresAt > this.now());
        state.claims = (state.claims ?? []).filter(
          (claim) => claim.expiresAt > this.now(),
        );
        if (state.requests)
          state.requests = state.requests.filter((request) =>
            this.live(request),
          );
        this.file.write(state);
        this.seenFile = true;
      }
      return answer;
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }

  addUser(id: string, userLabel = id): void {
    if (!isGatewayId(id)) throw new Error("A user id is 1-64 of A-Za-z0-9_-.");
    this.change((state) => {
      if (!state.users.some((user) => user.id === id))
        state.users.push({ id, label: label(userLabel) });
    });
  }

  user(id: string): GatewayUser | undefined {
    return this.load().users.find((user) => user.id === id);
  }

  /** A copy of every user, for `user list`. */
  users(): GatewayUser[] {
    return this.load().users.map((user) => ({
      ...user,
      ...(user.oidc ? { oidc: { ...user.oidc } } : {}),
    }));
  }

  /**
   * Lets the next admitted sign-in with `email` become `userId`, once, within
   * `ttlMs`. Replaces an earlier claim on that user or that email. Throws for
   * an unknown user or one that already has an identity.
   */
  claimUser(userId: string, email: string, ttlMs: number): void {
    const claimed = emailOf(email);
    this.change((state) => {
      const user = state.users.find((u) => u.id === userId);
      if (!user) throw new Error(`No user ${userId}.`);
      if (hasIdentity(user))
        throw new Error(`User ${userId} already signs in with an identity.`);
      state.claims = (state.claims ?? []).filter(
        (claim) => claim.userId !== userId && claim.email !== claimed,
      );
      state.claims.push({
        userId,
        email: claimed,
        expiresAt: this.now() + ttlMs,
      });
    });
  }

  /**
   * The user an admitted OIDC sign-in reaches, in one change: the user with
   * this identity (its email updated), else the user an unexpired claim on
   * this email names, if it still has no identity (the claim used up), else a
   * new user. The caller has applied the deployment's allow rule.
   */
  signIn(identity: { issuer: string; subject: string; email: string }): {
    userId: string;
    outcome: SignInOutcome;
  } {
    const email = emailOf(identity.email);
    const { issuer, subject } = identity;
    const { userId, outcome } = this.change(
      (state) => {
        const known = state.users.find(
          (user) =>
            user.oidc?.issuer === issuer && user.oidc.subject === subject,
        );
        if (known) {
          const changed = known.email !== email;
          if (changed) {
            if (known.label === known.email) known.label = label(email);
            known.email = email;
          }
          return { userId: known.id, outcome: "existing" as const, changed };
        }
        const claims = state.claims ?? [];
        const index = claims.findIndex((claim) => {
          if (claim.email !== email || claim.expiresAt <= this.now())
            return false;
          const user = state.users.find((u) => u.id === claim.userId);
          return user !== undefined && !hasIdentity(user);
        });
        if (index >= 0) {
          const [claim] = claims.splice(index, 1);
          const user = state.users.find((u) => u.id === claim!.userId)!;
          user.oidc = { issuer, subject };
          user.email = email;
          return { userId: user.id, outcome: "bound" as const, changed: true };
        }
        const id = newUserId(state);
        state.users.push({
          id,
          label: label(email),
          oidc: { issuer, subject },
          email,
        });
        return { userId: id, outcome: "created" as const, changed: true };
      },
      (answer) => answer.changed,
    );
    return { userId, outcome };
  }

  /**
   * A one-time code for `userId`'s next client; only its hash is kept. With
   * `limits`, counted under the lock with the push, the code is refused
   * (`EnrollmentLimitError`) rather than take the user past them; without,
   * as the admin CLI issues, it is unbounded.
   */
  createCode(
    userId: string,
    clientLabel: string,
    limits?: EnrollmentLimits,
  ): string {
    if (!this.user(userId)) throw new Error(`No user ${userId}.`);
    const code = randomBytes(18).toString("base64url");
    this.change((state) => {
      if (limits && this.overLimits(state, userId, limits))
        throw new EnrollmentLimitError();
      state.codes.push({
        hash: hashOf(code),
        userId,
        label: label(clientLabel),
        expiresAt: this.now() + ENROLLMENT_CODE_TTL_MS,
      });
    });
    return code;
  }

  /**
   * Uses up `code` and records the client `register` builds from it, in one
   * change. Undefined for an unknown, used or expired code.
   */
  redeem(
    code: string,
    register: (pending: { userId: string; label: string }) => GatewayClient,
  ): GatewayClient | undefined {
    const hash = Buffer.from(hashOf(code), "hex");
    const matches = (pending: PendingCode): boolean =>
      pending.expiresAt > this.now() &&
      typeof pending.hash === "string" &&
      /^[a-f0-9]{64}$/.test(pending.hash) &&
      timingSafeEqual(Buffer.from(pending.hash, "hex"), hash);
    // Misses are read-only, even while an administrator holds the write lock.
    if (!this.load().codes.some(matches)) return undefined;
    return this.change(
      (state) => {
        // Recheck under the lock: another process may have used the code.
        const index = state.codes.findIndex(matches);
        if (index < 0) return undefined;
        const [pending] = state.codes.splice(index, 1);
        const client = register(pending!);
        state.clients.push(client);
        return client;
      },
      (client) => client !== undefined,
    );
  }

  /**
   * Opens an enrollment request for a machine (Task-1410), unless that
   * address has `MAX_OPEN_REQUESTS_PER_SOURCE` open requests, all have
   * `MAX_OPEN_REQUESTS` open requests, or the retained table has
   * `MAX_RETAINED_REQUESTS` records. A refusal writes nothing. Answers the
   * request id, the machine's secret for collecting, and the user code, shown
   * to a person; only their hashes are kept. Open requests are undecided or
   * approved but uncollected; denied and collected records remain retained
   * without consuming open-request admission.
   */
  startRequest(start: EnrollmentRequestStart): StartOutcome {
    return this.change(
      (state): StartOutcome => {
        const now = this.now();
        const requests = (state.requests ??= []);
        const live = requests.filter((request) => this.live(request));
        if (live.length >= MAX_RETAINED_REQUESTS)
          return { ok: false, reason: "capacity" };
        const open = live.filter((request) => this.open(request, now));
        if (
          open.filter((request) => request.from === start.from).length >=
          MAX_OPEN_REQUESTS_PER_SOURCE
        )
          return { ok: false, reason: "source_limit" };
        if (open.length >= MAX_OPEN_REQUESTS)
          return { ok: false, reason: "capacity" };
        const taken = (field: "idHash" | "userCodeHash", value: string) => {
          const hash = Buffer.from(hashOf(value), "hex");
          return live.some((request) => hashEquals(request[field], hash));
        };
        let requestId: string;
        do requestId = randomBytes(32).toString("base64url");
        while (taken("idHash", requestId));
        let userCode: string;
        do userCode = newUserCode();
        while (taken("userCodeHash", userCode));
        const expiresAt = now + ENROLLMENT_REQUEST_TTL_MS;
        requests.push({
          idHash: hashOf(requestId),
          userCodeHash: hashOf(userCode),
          publicKeyPem: start.publicKeyPem,
          mcpTokenHash: start.mcpTokenHash,
          name: label(start.name),
          kind: start.kind,
          from: start.from,
          createdAt: now,
          expiresAt,
        });
        return {
          ok: true,
          requestId,
          userCode: displayUserCode(userCode),
          expiresAt,
        };
      },
      (outcome) => outcome.ok,
    );
  }

  /**
   * What the page shows of the undecided, unexpired request with this user
   * code (dash, spaces and case ignored); undefined for any other. Read-only.
   */
  enrollmentRequest(userCode: string): EnrollmentRequestView | undefined {
    const request = this.undecided(this.load(), userCode);
    return request
      ? {
          name: request.name,
          kind: request.kind,
          from: request.from,
          createdAt: request.createdAt,
          expiresAt: request.expiresAt,
        }
      : undefined;
  }

  /**
   * Decides the undecided, unexpired request with this user code, once: the
   * first decision wins, rechecked under the lock. An approval binds `userId`
   * and, with `limits`, counts against them as a pending code (`limit`, and
   * nothing written, past them). A miss is read-only. Throws for an unknown
   * user.
   */
  decide(
    userCode: string,
    userId: string,
    approve: boolean,
    limits?: EnrollmentLimits,
  ): DecideOutcome {
    if (!this.undecided(this.load(), userCode)) return "unknown";
    return this.change(
      (state): DecideOutcome => {
        if (!state.users.some((user) => user.id === userId))
          throw new Error(`No user ${userId}.`);
        const request = this.undecided(state, userCode);
        if (!request) return "unknown";
        if (!approve) {
          request.decision = "denied";
          return "denied";
        }
        if (limits && this.overLimits(state, userId, limits)) return "limit";
        request.decision = { userId, at: this.now() };
        return "approved";
      },
      (outcome) => outcome === "approved" || outcome === "denied",
    );
  }

  /**
   * The hash of the live request with this id, a key for its poll limiter;
   * undefined when there is none. Read-only.
   */
  knownRequest(requestId: string): string | undefined {
    return this.requestById(this.load(), requestId)?.idHash;
  }

  /**
   * The machine's collect: `pending`, `denied` or `expired` while it can't
   * be collected, read-only. The first collect of an approved, unexpired
   * request asks `issue` for a client id and a certificate of the request's
   * key and, in one change, records the client with the request's MCP token
   * hash and the certificate on the request. Every later collect answers that
   * same certificate without writing, while the client is active, else
   * `revoked`. Each is rechecked under the lock. A collect never changes a
   * client's MCP token. A throwing `issue` or a failed write leaves the file
   * as it was. `unknown` once the record is swept.
   */
  collect(
    requestId: string,
    issue: (publicKeyPem: string) => IssuedCertificate,
  ): CollectOutcome {
    const seen = this.requestById(this.load(), requestId);
    if (!seen) return { status: "unknown" };
    const waiting = this.waiting(seen);
    if (waiting) return { status: waiting };
    const { outcome } = this.change(
      (state): { outcome: CollectOutcome; created: boolean } => {
        const request = this.requestById(state, requestId);
        if (!request) return { outcome: { status: "unknown" }, created: false };
        const waiting = this.waiting(request);
        if (waiting) return { outcome: { status: waiting }, created: false };
        const done = request.issued;
        if (done) {
          const client = state.clients.find((c) => c.id === done.clientId);
          return {
            outcome:
              client && client.revokedAt === undefined
                ? {
                    status: "approved",
                    clientId: done.clientId,
                    certificatePem: done.certificatePem,
                    first: false,
                  }
                : { status: "revoked" },
            created: false,
          };
        }
        const userId = approverOf(request)!;
        const issued = issue(request.publicKeyPem);
        if (state.clients.some((client) => client.id === issued.clientId))
          throw new Error("Client id already enrolled.");
        state.clients.push({
          id: issued.clientId,
          userId,
          label: label(request.name),
          fingerprint: issued.fingerprint,
          createdAt: this.now(),
          mcpTokenHash: request.mcpTokenHash,
        });
        request.issued = {
          clientId: issued.clientId,
          certificatePem: issued.certificatePem,
        };
        return {
          outcome: {
            status: "approved",
            clientId: issued.clientId,
            certificatePem: issued.certificatePem,
            first: true,
          },
          created: true,
        };
      },
      (answer) => answer.created,
    );
    return outcome;
  }

  /** Whether a request still consumes open-request admission. */
  private open(request: EnrollmentRequest, now: number): boolean {
    return (
      request.expiresAt > now &&
      (request.decision === undefined ||
        (approverOf(request) !== undefined && request.issued === undefined))
    );
  }

  /** Whether the request's record is kept: until its retention ends. */
  private live(request: EnrollmentRequest): boolean {
    return (
      typeof request.expiresAt === "number" &&
      request.expiresAt + ENROLLMENT_REQUEST_RETAIN_MS > this.now()
    );
  }

  private undecided(
    state: Stored,
    userCode: string,
  ): EnrollmentRequest | undefined {
    const code = normalUserCode(userCode);
    if (!code) return undefined;
    const hash = Buffer.from(hashOf(code), "hex");
    const now = this.now();
    return state.requests?.find(
      (request) =>
        request.expiresAt > now &&
        request.decision === undefined &&
        hashEquals(request.userCodeHash, hash),
    );
  }

  private requestById(
    state: Stored,
    requestId: string,
  ): EnrollmentRequest | undefined {
    if (!isRequestId(requestId)) return undefined;
    const hash = Buffer.from(hashOf(requestId), "hex");
    return state.requests?.find(
      (request) => this.live(request) && hashEquals(request.idHash, hash),
    );
  }

  /**
   * Why a request can't be collected now, or undefined when it can: issued
   * (answered again until swept), or approved and unexpired.
   */
  private waiting(
    request: EnrollmentRequest,
  ): "pending" | "denied" | "expired" | undefined {
    if (request.issued !== undefined) return undefined;
    if (!(request.expiresAt > this.now())) return "expired";
    if (request.decision === "denied") return "denied";
    if (approverOf(request) === undefined) return "pending";
    return undefined;
  }

  /**
   * Whether one more pending code would take `userId` past `limits`: its
   * unexpired codes and approved, uncollected, unexpired requests are
   * pending, and count with its active clients.
   */
  private overLimits(
    state: Stored,
    userId: string,
    limits: EnrollmentLimits,
  ): boolean {
    const now = this.now();
    const pending =
      state.codes.filter((c) => c.userId === userId && c.expiresAt > now)
        .length +
      (state.requests ?? []).filter(
        (r) =>
          r.expiresAt > now &&
          r.issued === undefined &&
          approverOf(r) === userId,
      ).length;
    const active = state.clients.filter(
      (c) => c.userId === userId && c.revokedAt === undefined,
    ).length;
    return (
      pending >= limits.maxPendingCodes || active + pending >= limits.maxClients
    );
  }

  clients(): GatewayClient[] {
    return this.load().clients.map((client) => ({ ...client }));
  }

  /** The client when it is enrolled with this certificate and not revoked. */
  active(
    clientId: string | undefined,
    fingerprint: string | undefined,
  ): GatewayClient | undefined {
    if (!clientId || !fingerprint) return undefined;
    const client = this.load().clients.find((c) => c.id === clientId);
    return client &&
      client.revokedAt === undefined &&
      client.fingerprint === fingerprint
      ? client
      : undefined;
  }

  /** Answers whether it revoked the client now. */
  revoke(clientId: string): boolean {
    return this.change((state) => {
      const client = state.clients.find((c) => c.id === clientId);
      if (!client || client.revokedAt !== undefined) return false;
      client.revokedAt = this.now();
      return true;
    });
  }

  /**
   * Mints the client's MCP token, replacing any earlier one, and answers it:
   * the only time it exists outside its holder. Throws for an unknown or
   * revoked client.
   */
  setMcpToken(clientId: string): string {
    const token = `pgmcp_${randomBytes(32).toString("base64url")}`;
    this.change((state) => {
      const client = state.clients.find((c) => c.id === clientId);
      if (!client || client.revokedAt !== undefined)
        throw new Error(`No active client ${clientId}.`);
      client.mcpTokenHash = hashOf(token);
    });
    return token;
  }

  /** Answers whether the client had an MCP token. */
  clearMcpToken(clientId: string): boolean {
    return this.change(
      (state) => {
        const client = state.clients.find((c) => c.id === clientId);
        if (!client || client.mcpTokenHash === undefined) return false;
        delete client.mcpTokenHash;
        return true;
      },
      (changed) => changed,
    );
  }

  setAccountOwner(profileId: string, userId: string): void {
    this.change((state) => {
      state.accounts = state.accounts.filter((a) => a.profileId !== profileId);
      state.accounts.push({ profileId, userId });
    });
  }

  removeAccount(profileId: string): void {
    this.change((state) => {
      state.accounts = state.accounts.filter((a) => a.profileId !== profileId);
    });
  }

  /** The ids of the accounts `userId` owns. */
  accountsOf(userId: string): string[] {
    return this.load()
      .accounts.filter((account) => account.userId === userId)
      .map((account) => account.profileId);
  }

  ownerOf(profileId: string): string | undefined {
    return this.load().accounts.find((a) => a.profileId === profileId)?.userId;
  }
}
