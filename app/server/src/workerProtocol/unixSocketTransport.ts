/**
 * The worker protocol's byte stream over a socket: a Unix socket between
 * processes on one host (the server and the relay's client-protocol socket),
 * or a `tls.TLSSocket` (the gateway edge's mutual-TLS client port). Frame
 * reassembly stays in `FrameDecoder`; this only moves bytes.
 *
 * The standalone gateway listens for its control connection here
 * (`gateway/process.ts`), and the server dials it.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { basename, dirname, join } from "node:path";
import type { ByteEndpoint } from "./inProcessTransport.ts";

/** A peer that never closes after `close` is cut off after this long. */
const CLOSE_GRACE_MS = 1000;

export function socketEndpoint(socket: net.Socket): ByteEndpoint {
  let closeListener: (() => void) | undefined;
  let closed = false;
  socket.on("close", () => {
    if (closed) return;
    closed = true;
    closeListener?.();
  });
  socket.on("error", () => socket.destroy());
  return {
    write(bytes) {
      if (!closed && !socket.destroyed) socket.write(bytes);
    },
    close() {
      // Written bytes go out first.
      socket.end();
      setTimeout(() => socket.destroy(), CLOSE_GRACE_MS).unref();
    },
    onData(listener) {
      socket.on("data", (chunk: Buffer) => listener(chunk));
    },
    onClose(listener) {
      closeListener = listener;
    },
  };
}

/** Connects to the Unix socket at `path`; rejects on failure or timeout. */
export function dialUnixSocket(
  path: string,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<ByteEndpoint> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`No answer on ${path} within ${timeoutMs} ms.`));
    }, timeoutMs);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeAllListeners("error");
      resolve(socketEndpoint(socket));
    });
  });
}

/**
 * Listens on the Unix socket at `path` and hands each accepted connection to
 * `onEndpoint`. Refuses non-socket paths and live listeners; only a real stale
 * socket is removed first. The file gets mode 0600, and `close`
 * stops listening, ends open connections and removes the file. On Linux an
 * abstract socket serializes ownership, including stale-file recovery. The
 * kernel releases that claim on crash, without a stale lock to recover.
 * macOS uses monotonic generation files and exclusive loopback reservations,
 * not PID or connect-based liveness; even a paused owner retains its claim.
 */
export async function listenUnixSocket(
  path: string,
  onEndpoint: (endpoint: ByteEndpoint) => void,
): Promise<{ close(): Promise<void> }> {
  const provided = socketEntry(path);
  if (provided && !provided.isSocket())
    throw new Error(`Control path exists and is not a socket: ${path}`);
  // Derive ownership from the canonical socket path: previews and production
  // never share a claim, while relative paths and symlinks still contend.
  const identity = createHash("sha256")
    .update(`${realpathSync(dirname(path))}/${basename(path)}`)
    .digest("hex");
  if (process.platform !== "linux") {
    const claimDir = join(
      realpathSync(dirname(path)),
      `.pandeck-socket-${identity}`,
    );
    const release = await acquireFileSocketClaim(path, identity, claimDir);
    try {
      const listener = await listenClaimedUnixSocket(path, onEndpoint);
      let closing: Promise<void> | undefined;
      return {
        close() {
          closing ??= (async () => {
            try {
              await listener.close();
            } finally {
              await release();
            }
          })();
          return closing;
        },
      };
    } catch (error) {
      await release();
      throw error;
    }
  }
  const claim = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    claim.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`Another process listens on ${path}.`)
          : err,
      );
    });
    claim.listen(`\u0000pandeck-unix-${identity}`, () => {
      claim.removeAllListeners("error");
      resolve();
    });
  });
  const release = (): Promise<void> =>
    new Promise((resolve) => claim.close(() => resolve()));
  try {
    const listener = await listenClaimedUnixSocket(path, onEndpoint);
    let closing: Promise<void> | undefined;
    return {
      close() {
        closing ??= (async () => {
          try {
            await listener.close();
          } finally {
            await release();
          }
        })();
        return closing;
      },
    };
  } catch (err) {
    await release();
    throw err;
  }
}

function socketEntry(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Unknown or permission-denied liveness never authorizes stale recovery. */
async function socketAnswers(path: string): Promise<boolean> {
  // A foreign listener may briefly refuse while its accept queue is full.
  // Repeated refusal, not one failed connect, is needed before stale cleanup.
  for (const delay of [0, 250, 750]) {
    if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    const state = await socketAnswerOnce(path);
    if (state === "alive") return true;
    if (state === "missing") return false;
  }
  return false;
}

function socketAnswerOnce(
  path: string,
): Promise<"alive" | "missing" | "refused"> {
  return new Promise((resolve, reject) => {
    const probe = net.createConnection(path);
    const timer = setTimeout(() => {
      probe.destroy();
      reject(new Error(`Cannot verify socket ownership at ${path}.`));
    }, 1000);
    probe.once("connect", () => {
      clearTimeout(timer);
      probe.destroy();
      resolve("alive");
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED") resolve("refused");
      else if (error.code === "ENOENT") resolve("missing");
      else reject(error);
    });
  });
}

/** Predictable directories are safe only when real, ours, and not writable by others. */
function privateClaimDirectory(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.geteuid?.() ||
    (stat.mode & 0o022) !== 0
  ) {
    throw new Error(
      `Unsafe socket claim directory (must be a real private directory owned by this user): ${path}`,
    );
  }
}

/** Every ancestor must keep other users from renaming a checked child. */
function privateClaimAncestry(parent: string): void {
  const uid = process.geteuid?.();
  if (uid === undefined)
    throw new Error("Socket claims require a Unix user identity.");
  const ancestors: string[] = [];
  for (let path = parent; ; path = dirname(path)) {
    ancestors.push(path);
    if (dirname(path) === path) break;
  }
  for (const path of ancestors.reverse()) {
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      (stat.uid !== 0 && stat.uid !== uid) ||
      ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
    ) {
      throw new Error(
        `Unsafe control socket parent (use private or sticky ancestry owned by root or this user): ${path}`,
      );
    }
  }
}

interface SocketClaimOwner {
  v: 2;
  identity: string;
  port: number;
}

function socketClaimGenerations(path: string): number[] {
  return readdirSync(path)
    .flatMap((name) => {
      const match = /^claim\.([1-9]\d*)$/.exec(name);
      const n = match ? Number(match[1]) : NaN;
      return Number.isSafeInteger(n) ? [n] : [];
    })
    .sort((a, b) => b - a);
}

/**
 * An exclusive bind tests the kernel reservation, even if the owner's event
 * loop is stopped or its accept queue is full. Connect errors cannot prove
 * that: Darwin may return ECONNREFUSED for a live overloaded listener.
 */
function claimPortOccupied(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer((socket) => socket.destroy());
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(true);
      else reject(error);
    });
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      probe.close((error) => (error ? reject(error) : resolve(false)));
    });
  });
}

/**
 * Darwin has no abstract namespace. A published generation instead names a
 * loopback TCP port bound BEFORE publication. Exclusive bind, not a reusable
 * PID or a connect/backlog probe, proves ownership. Generation numbers never
 * reset on release: only a successor deletes older generations.
 */
async function acquireFileSocketClaim(
  path: string,
  identity: string,
  claimDir: string,
): Promise<() => Promise<void>> {
  privateClaimAncestry(dirname(claimDir));
  privateClaimDirectory(claimDir);
  const live = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    live.once("error", reject);
    live.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      live.removeListener("error", reject);
      resolve();
    });
  });
  live.unref();
  const port = (live.address() as net.AddressInfo).port;
  let generation: string | undefined;
  let draft: string | undefined;
  let closing: Promise<void> | undefined;
  const release = (): Promise<void> =>
    (closing ??= new Promise<void>((resolve) => live.close(() => resolve())));
  try {
    // Release closes only the kernel reservation. Its generation remains as
    // a stale tombstone, preventing cached readers racing an empty-directory
    // reset from publishing both claim.1 and claim.N+1.
    const owner: SocketClaimOwner = { v: 2, identity, port };
    draft = join(claimDir, `draft-${randomUUID()}`);
    writeFileSync(draft, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    for (
      let attempt = 0;
      attempt < 32 && generation === undefined;
      attempt += 1
    ) {
      const generations = socketClaimGenerations(claimDir);
      const latest = generations[0] ?? 0;
      if (latest >= Number.MAX_SAFE_INTEGER)
        throw new Error(
          `Invalid socket claim generation; inspect ${claimDir}.`,
        );
      if (latest > 0) {
        const previousPath = join(claimDir, `claim.${latest}`);
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(previousPath, "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw new Error(
            `Cannot read socket ownership claim; inspect ${previousPath}.`,
          );
        }
        if (
          !raw ||
          typeof raw !== "object" ||
          !("v" in raw) ||
          raw.v !== 2 ||
          !("identity" in raw) ||
          raw.identity !== identity ||
          !("port" in raw) ||
          typeof raw.port !== "number" ||
          !Number.isInteger(raw.port) ||
          raw.port < 1024 ||
          raw.port > 65535
        ) {
          throw new Error(
            `Invalid socket ownership claim; inspect ${previousPath}.`,
          );
        }
        // If our fresh reservation reused that very port, our successful bind
        // already proved the old reservation gone. Otherwise test it directly.
        if (raw.port !== port && (await claimPortOccupied(raw.port))) {
          throw new Error(
            `Another process listens on ${path}; reservation 127.0.0.1:${raw.port}; ownership claim: ${previousPath}`,
          );
        }
      }
      const next = join(claimDir, `claim.${latest + 1}`);
      let raced = false;
      try {
        linkSync(draft, next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") raced = true;
        else throw error;
      }
      if (raced) continue;
      generation = next;
      // A cached listing can outlive two owners: a successor may have removed
      // this lower name after publishing a higher generation. Publication alone
      // then does NOT confer ownership. The highest tombstone never disappears,
      // so this post-check detects every such reused-name publication.
      if ((socketClaimGenerations(claimDir)[0] ?? 0) > latest + 1) {
        try {
          unlinkSync(next);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        throw new Error(
          `Socket ownership claim was superseded; inspect ${claimDir}.`,
        );
      }
      // Only after the post-check may this owner prune older metadata or touch
      // the control path. Distinct prefix avoids DATA_DIR locks.
      for (const old of generations) {
        try {
          unlinkSync(join(claimDir, `claim.${old}`));
        } catch {
          /* Stale metadata does not invalidate the new exclusive claim. */
        }
      }
    }
    if (generation !== undefined) return release;
    throw new Error(`Could not claim socket ownership; inspect ${claimDir}.`);
  } catch (error) {
    await release();
    throw error;
  } finally {
    if (draft) {
      try {
        unlinkSync(draft);
      } catch {
        /* Only our random draft. */
      }
    }
  }
}

/** Every caller holds its platform ownership claim until this listener closes. */
async function listenClaimedUnixSocket(
  path: string,
  onEndpoint: (endpoint: ByteEndpoint) => void,
): Promise<{ close(): Promise<void> }> {
  const previous = socketEntry(path);
  if (previous) {
    if (!previous.isSocket())
      throw new Error(`Control path exists and is not a socket: ${path}`);
    if (await socketAnswers(path))
      throw new Error(`Another process listens on ${path}.`);
    const current = socketEntry(path);
    if (current) {
      if (
        !current.isSocket() ||
        current.dev !== previous.dev ||
        current.ino !== previous.ino
      ) {
        throw new Error(`Control socket path changed during startup: ${path}`);
      }
      unlinkSync(path);
    }
  }
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    onEndpoint(socketEndpoint(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  try {
    chmodSync(path, 0o600);
  } catch (err) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw err;
  }
  const bound = statSync(path);
  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        try {
          const current = statSync(path);
          if (current.ino === bound.ino && current.dev === bound.dev)
            unlinkSync(path);
        } catch {
          // Removed already.
        }
      });
      return closing;
    },
  };
}
