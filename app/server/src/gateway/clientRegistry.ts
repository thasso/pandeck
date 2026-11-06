/**
 * The gateway's users, enrolled clients, one-time enrollment codes and which
 * user owns each account (plan Task-1384 §1), in `clients.json` through
 * `privateJsonFile.ts`. A code is kept only as its SHA-256 and is used up
 * once; a client is named by the common name of its certificate and matched
 * by its fingerprint too.
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

  constructor(stateDir: string, now: () => number = Date.now) {
    this.path = join(stateDir, "clients.json");
    this.file = createPrivateJsonFile(this.path, "gateway clients", {
      privateDirectory: "enforce",
    });
    this.now = now;
  }

  private load(): Stored {
    return this.file.read<Stored, Stored>((value) => {
      if (value === undefined) return empty();
      if (
        !value ||
        value.v !== 1 ||
        !Array.isArray(value.users) ||
        !Array.isArray(value.clients) ||
        !Array.isArray(value.codes) ||
        !Array.isArray(value.accounts)
      )
        throw new Error("Invalid gateway client registry.");
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
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (Date.now() >= deadline)
          throw new Error("Gateway client registry is busy.");
        Atomics.wait(pause, 0, 0, 10);
      }
    }
    try {
      writeFileSync(fd, `${process.pid}\n`);
      const state = this.load();
      const answer = apply(state);
      if (write(answer)) {
        state.codes = state.codes.filter((code) => code.expiresAt > this.now());
        this.file.write(state);
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
