/**
 * The gateway's users, enrolled clients, one-time enrollment codes and which
 * user owns each account (plan Task-1384 §1), in `clients.json` through
 * `privateJsonFile.ts`. A code is kept only as its SHA-256 and is used up
 * once; a client is named by the common name of its certificate and matched
 * by its fingerprint too.
 *
 * The admin CLI writes the same file from its own process, so every read
 * reloads the file when it changed on disk and every change reloads before
 * writing: a `clients revoke` takes effect at the edge's next check.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { createPrivateJsonFile } from "../privateJsonFile.ts";

/** How long an enrollment code stays valid. */
const CODE_TTL_MS = 15 * 60_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LABEL = 200;

export interface GatewayUser {
  id: string;
  label: string;
}

export interface GatewayClient {
  id: string;
  userId: string;
  label: string;
  /** SHA-256 fingerprint of its certificate, as `X509Certificate` writes it. */
  fingerprint: string;
  createdAt: number;
  revokedAt?: number;
}

interface PendingCode {
  /** Hex SHA-256 of the code. */
  hash: string;
  userId: string;
  label: string;
  expiresAt: number;
}

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

function hashOf(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export class ClientRegistry {
  private readonly path: string;
  private readonly file: ReturnType<typeof createPrivateJsonFile>;
  private readonly now: () => number;
  private state: Stored = empty();
  /** The file's mtime and size when last read or written. */
  private seen = "";

  constructor(stateDir: string, now: () => number = Date.now) {
    this.path = join(stateDir, "clients.json");
    this.file = createPrivateJsonFile(this.path, "gateway clients", {
      privateDirectory: "enforce",
    });
    this.now = now;
  }

  private stamp(): string {
    try {
      const stat = statSync(this.path);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return "";
    }
  }

  private load(): Stored {
    const stamp = this.stamp();
    if (stamp === this.seen) return this.state;
    this.state = this.file.read<Partial<Stored>, Stored>((value) => ({
      ...empty(),
      ...(value ?? {}),
      v: 1,
    }));
    this.seen = stamp;
    return this.state;
  }

  private change<T>(apply: (state: Stored) => T): T {
    this.seen = "";
    const state = this.load();
    const answer = apply(state);
    const now = this.now();
    state.codes = state.codes.filter((code) => code.expiresAt > now);
    this.file.write(state);
    this.seen = this.stamp();
    return answer;
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
    return this.change((state) => {
      const now = this.now();
      const index = state.codes.findIndex(
        (pending) =>
          pending.expiresAt > now &&
          timingSafeEqual(Buffer.from(pending.hash, "hex"), hash),
      );
      if (index < 0) return undefined;
      const [pending] = state.codes.splice(index, 1);
      const client = register(pending!);
      state.clients.push(client);
      return client;
    });
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
