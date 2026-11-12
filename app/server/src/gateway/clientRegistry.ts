/**
 * The gateway's users, enrolled clients, one-time enrollment codes and which
 * user owns each account (plan Task-1384 §1), in `clients.json` through
 * `privateJsonFile.ts`. A code is kept only as its SHA-256 and is used up
 * once; a client is named by the common name of its certificate and matched
 * by its fingerprint too. A client's MCP token (Task-1397) is likewise kept
 * only as its SHA-256.
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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
const CODE_TTL_MS = 15 * 60_000;
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

function hashOf(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

const HASH_RE = /^[a-f0-9]{64}$/;

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
        !Array.isArray(value.accounts)
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

  /** A one-time code for `userId`'s next client; only its hash is kept. */
  createCode(userId: string, clientLabel: string): string {
    if (!this.user(userId)) throw new Error(`No user ${userId}.`);
    const code = randomBytes(18).toString("base64url");
    this.change((state) => {
      state.codes.push({
        hash: hashOf(code),
        userId,
        label: label(clientLabel),
        expiresAt: this.now() + CODE_TTL_MS,
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
