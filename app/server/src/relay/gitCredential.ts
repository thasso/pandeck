/**
 * `relay git-credential --socket <path> <operation>` (Task-1446): git's
 * credential helper for `https://github.com`, through the relay's client
 * socket to the gateway edge's `git.credential` (gateway-client 1.4).
 *
 * - `get` reads git's `key=value` lines from stdin, asks the edge for a read
 *   installation token for that one repository, and prints exactly
 *   `username=x-access-token`, `password=<token>` and
 *   `password_expiry_utc=<epoch seconds>`, or exactly `quit=1` with one fixed
 *   line on stderr. It always exits 0, and writes stdout once, at the end.
 * - `store`, `erase` and any other operation drain stdin, print nothing and
 *   never open the socket: git never stores the token through this helper.
 *
 * The token reaches git only through stdout. Nothing is logged or written to
 * a file, nothing is read from the environment, and the edge's failure
 * message is read off the wire and discarded, never decoded or printed: the
 * stderr lines are this module's own, chosen by failure code.
 *
 * The relay imports only `node:` modules and itself (`workerBoundary.test.ts`),
 * so this speaks a minimal client side of the worker protocol framing
 * (`workerProtocol/codec.ts`); `gitCredential.test.ts` runs it against the
 * real `WorkerConnection` and pins the constants below to `clientMethods.ts`.
 */
import net from "node:net";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";

/** Copies of `gateway/clientMethods.ts`'s, pinned by the cross test. */
export const GIT_CREDENTIAL_CLIENT_VERSION = "gateway-client/1.4";
export const GIT_CREDENTIAL_METHOD = "git.credential";

const WORKER_ID = "git-credential";
const MAX_FRAME_HEADER = 64 * 1024;
const MAX_FRAME_PAYLOAD = 1024 * 1024;
/** Everything skipped while waiting (edge requests and their data). */
const MAX_SKIPPED = 4 * 1024 * 1024;
/** The failure message stream's bytes, discarded unread. */
const MAX_MESSAGE = 16 * 1024;
const MAX_SUCCESS = 16 * 1024;
const MAX_STDIN = 64 * 1024;
const DEADLINE_MS = 45_000;
const BUSY_BACKOFF_MS = [250, 500, 1000];
const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;

const PREFIX = "pandeck relay: ";
/** This helper's own stderr lines, by the edge's failure code. */
export const GIT_CREDENTIAL_LINES = {
  git_not_connected: `${PREFIX}GitHub is not connected for this machine's gateway user; connect it on the gateway page`,
  git_reconnect: `${PREFIX}the gateway's GitHub connection stopped working; connect GitHub again on the gateway page`,
  git_denied: `${PREFIX}no read access to this repository through the gateway (no pull access, or the GitHub App is not installed on it)`,
  git_busy: `${PREFIX}too many git credential requests from this machine at once; try again`,
  vault_locked: `${PREFIX}the gateway's vault is locked; try again once it is unlocked`,
  vault_unavailable: `${PREFIX}the gateway could not get a git credential; try again`,
  invalid_params: `${PREFIX}the gateway refused this git credential request (GitHub repositories over https, read access only)`,
  unknown_method: `${PREFIX}the gateway is too old for git credentials`,
  busy: `${PREFIX}the gateway is at its connection limit; try again`,
} as const;
const GENERIC_LINE = `${PREFIX}no git credential from the gateway (relay socket or protocol error)`;
const NO_PATH_LINE = `${PREFIX}git sent no repository path; set credential.useHttpPath = true`;
const NOT_GITHUB_LINE = `${PREFIX}git-credential serves only GitHub repositories over https`;
const USAGE_LINE = `${PREFIX}git-credential needs --socket <path>`;

class ProtocolError extends Error {}

type Outcome =
  | { kind: "ok"; token: string; expiresAt: number }
  | { kind: "failure"; code: string }
  | { kind: "error" };

// --- framing ------------------------------------------------------------

function frame(header: object, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(head.length, 0);
  prefix.writeUInt32BE(payload.length, 4);
  return Buffer.concat([prefix, head, payload]);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Frames out of a byte stream, each checked against the frame caps. */
class FrameReader {
  private chunks: Buffer[] = [];
  private length = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  private take(count: number): Buffer {
    const all =
      this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    this.chunks = count < all.length ? [all.subarray(count)] : [];
    this.length -= count;
    return all.subarray(0, count);
  }

  private peekPrefix(): Buffer {
    if (this.chunks[0]!.length < 8) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0]!;
  }

  /** The next whole frame, or undefined until more bytes arrive. */
  next():
    | { header: Record<string, unknown>; payload: Buffer; size: number }
    | undefined {
    if (this.length < 8) return undefined;
    const prefix = this.peekPrefix();
    const headLength = prefix.readUInt32BE(0);
    const payloadLength = prefix.readUInt32BE(4);
    if (headLength > MAX_FRAME_HEADER || payloadLength > MAX_FRAME_PAYLOAD)
      throw new ProtocolError("frame over the cap");
    const size = 8 + headLength + payloadLength;
    if (this.length < size) return undefined;
    const bytes = this.take(size);
    let header: unknown;
    try {
      header = JSON.parse(utf8.decode(bytes.subarray(8, 8 + headLength)));
    } catch {
      throw new ProtocolError("bad header");
    }
    if (
      typeof header !== "object" ||
      header === null ||
      Array.isArray(header) ||
      typeof (header as { type?: unknown }).type !== "string"
    )
      throw new ProtocolError("bad header");
    return {
      header: header as Record<string, unknown>,
      payload: bytes.subarray(8 + headLength),
      size,
    };
  }
}

const isEmptyList = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 0;

/** The success answer's JSON: exactly a usable token and a future expiry. */
function credentialOf(payload: Buffer): Outcome {
  if (payload.length > MAX_SUCCESS) throw new ProtocolError("oversize answer");
  let json: unknown;
  try {
    json = JSON.parse(utf8.decode(payload));
  } catch {
    throw new ProtocolError("bad answer");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json))
    throw new ProtocolError("bad answer");
  const answer = json as Record<string, unknown>;
  const { token, expiresAt } = answer;
  if (
    Object.keys(answer).sort().join(",") !== "expiresAt,token" ||
    typeof token !== "string" ||
    !TOKEN_RE.test(token) ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now()
  )
    throw new ProtocolError("bad answer");
  return { kind: "ok", token, expiresAt };
}

/**
 * Reads frames after the request until its response. Edge requests (an
 * `accounts.changed` racing in), their data and cancels are skipped
 * unanswered, 4 MiB at most in all. The response's only accepted stream is a
 * failure's `text:message`, counted and discarded.
 */
class ResponseWaiter {
  private skipped = 0;
  private messageFrames = 0;
  private messageBytes = 0;

  constructor(private readonly id: number) {}

  /** The outcome once `header` is the response; undefined to keep reading. */
  read(
    header: Record<string, unknown>,
    payload: Buffer,
    size: number,
  ): Outcome | undefined {
    const { type } = header;
    if (
      type === "request" ||
      type === "cancel" ||
      (type === "data" && header.of === "request")
    ) {
      this.skipped += size;
      if (this.skipped > MAX_SKIPPED) throw new ProtocolError("too much");
      return undefined;
    }
    if (type === "data") {
      if (
        header.of !== "response" ||
        header.id !== this.id ||
        header.stream !== "text:message" ||
        header.seq !== this.messageFrames
      )
        throw new ProtocolError("unexpected data");
      this.messageFrames += 1;
      this.messageBytes += payload.length;
      if (this.messageBytes > MAX_MESSAGE)
        throw new ProtocolError("message over the cap");
      return undefined;
    }
    if (type !== "response" || header.id !== this.id)
      throw new ProtocolError("unexpected frame");
    if (!isEmptyList(header.bytes) || header.chunks !== this.messageFrames)
      throw new ProtocolError("bad response");
    if ("failure" in header) {
      const { failure, text } = header;
      const withMessage =
        Array.isArray(text) && text.length === 1 && text[0] === "message";
      if (
        typeof failure !== "string" ||
        !(isEmptyList(text) || withMessage) ||
        (!withMessage && this.messageFrames > 0)
      )
        throw new ProtocolError("bad failure");
      return { kind: "failure", code: failure };
    }
    if (!isEmptyList(header.text) || this.messageFrames > 0)
      throw new ProtocolError("stream on a success");
    return credentialOf(payload);
  }
}

/** One connection: hello, one `git.credential` request, its response. */
function attempt(
  socket: net.Socket,
  path: string,
  stop: AbortSignal,
): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const id = 1;
    const reader = new FrameReader();
    const waiter = new ResponseWaiter(id);
    let welcomed = false;
    let done = false;
    const finish = (outcome: Outcome): void => {
      if (done) return;
      done = true;
      stop.removeEventListener("abort", onStop);
      socket.destroy();
      resolve(outcome);
    };
    const onStop = (): void => finish({ kind: "error" });
    if (stop.aborted) return finish({ kind: "error" });
    stop.addEventListener("abort", onStop, { once: true });
    socket.on("error", () => finish({ kind: "error" }));
    socket.on("close", () => finish({ kind: "error" }));
    socket.on("connect", () => {
      socket.write(
        frame({
          type: "hello",
          workerId: WORKER_ID,
          version: GIT_CREDENTIAL_CLIENT_VERSION,
        }),
      );
    });
    socket.on("data", (chunk: Buffer) => {
      if (done) return;
      try {
        reader.push(chunk);
        for (let next = reader.next(); next; next = reader.next()) {
          if (!welcomed) {
            const { type, version } = next.header;
            if (type === "refused") return finish({ kind: "error" });
            if (
              type !== "welcome" ||
              typeof version !== "string" ||
              !version.startsWith("gateway-client/1.")
            )
              throw new ProtocolError("no welcome");
            welcomed = true;
            socket.write(
              frame(
                {
                  type: "request",
                  id,
                  method: GIT_CREDENTIAL_METHOD,
                  text: [],
                  bytes: [],
                  chunks: 0,
                },
                Buffer.from(
                  JSON.stringify({ host: "github.com", path, access: "read" }),
                  "utf8",
                ),
              ),
            );
            continue;
          }
          const outcome = waiter.read(next.header, next.payload, next.size);
          if (outcome) return finish(outcome);
        }
      } catch {
        finish({ kind: "error" });
      }
    });
  });
}

// --- git's side ---------------------------------------------------------

/**
 * stdin up to EOF or, with `untilBlank`, its first empty line: at most 64
 * KiB, before `stop`; undefined when over the cap or stopped.
 */
function readInput(
  stdin: Readable,
  stop: AbortSignal,
  untilBlank: boolean,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    const finish = (text: string | undefined): void => {
      if (done) return;
      done = true;
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      stop.removeEventListener("abort", onStop);
      stdin.pause();
      resolve(text);
    };
    const text = (): string => Buffer.concat(chunks).toString("utf8");
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      chunks.push(bytes);
      length += bytes.length;
      if (length > MAX_STDIN) return finish(undefined);
      if (untilBlank) {
        const sofar = text();
        if (sofar.startsWith("\n") || sofar.includes("\n\n")) finish(sofar);
      }
    };
    const onEnd = (): void => finish(text());
    const onError = (): void => finish(undefined);
    const onStop = (): void => finish(undefined);
    if (stop.aborted) return finish(undefined);
    stop.addEventListener("abort", onStop, { once: true });
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    stdin.resume();
  });
}

/** git's description of the credential it wants, up to the first empty line. */
function attributesOf(input: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const line of input.split("\n")) {
    if (line === "") break;
    const at = line.indexOf("=");
    if (at > 0) attributes.set(line.slice(0, at), line.slice(at + 1));
  }
  return attributes;
}

export interface GitCredentialRun {
  operation: string;
  socketPath: string;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** The whole run's deadline; 45 s. */
  deadlineMs?: number;
  /** Test seam: how the socket is opened. */
  connect?: (path: string) => net.Socket;
  /** Test seam: the wait before a `git_busy` retry. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves to the exit code, always 0. */
export async function runGitCredential(run: GitCredentialRun): Promise<number> {
  const deadlineMs = run.deadlineMs ?? DEADLINE_MS;
  const deadline = Date.now() + deadlineMs;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), deadlineMs);
  const refuse = (line: string): number => {
    run.stdout.write("quit=1\n");
    run.stderr.write(`${line}\n`);
    return 0;
  };
  try {
    if (run.operation !== "get") {
      await readInput(run.stdin, stop.signal, false);
      return 0;
    }
    const input = await readInput(run.stdin, stop.signal, true);
    if (input === undefined) return refuse(GENERIC_LINE);
    const attributes = attributesOf(input);
    if (
      attributes.get("protocol") !== "https" ||
      attributes.get("host")?.toLowerCase() !== "github.com"
    )
      return refuse(NOT_GITHUB_LINE);
    const path = attributes.get("path");
    if (!path) return refuse(NO_PATH_LINE);

    const connect =
      run.connect ??
      ((socketPath) => net.createConnection({ path: socketPath }));
    const sleep = run.sleep ?? defaultSleep;
    const ask = () => attempt(connect(run.socketPath), path, stop.signal);
    let outcome = await ask();
    // Only `git_busy` is retried, with jittered waits inside the deadline.
    for (
      let retry = 0;
      outcome.kind === "failure" &&
      outcome.code === "git_busy" &&
      retry < BUSY_BACKOFF_MS.length;
      retry += 1
    ) {
      const wait = BUSY_BACKOFF_MS[retry]! * (1 + Math.random() * 0.5);
      if (Date.now() + wait >= deadline)
        return refuse(GIT_CREDENTIAL_LINES.git_busy);
      await Promise.race([
        sleep(wait),
        new Promise((resolve) =>
          stop.signal.addEventListener("abort", resolve, { once: true }),
        ),
      ]);
      if (stop.signal.aborted) return refuse(GIT_CREDENTIAL_LINES.git_busy);
      outcome = await ask();
    }
    if (outcome.kind === "ok") {
      run.stdout.write(
        `username=x-access-token\npassword=${outcome.token}\npassword_expiry_utc=${Math.floor(outcome.expiresAt / 1000)}\n`,
      );
      return 0;
    }
    if (outcome.kind === "error") return refuse(GENERIC_LINE);
    const { code } = outcome;
    return refuse(
      Object.hasOwn(GIT_CREDENTIAL_LINES, code)
        ? GIT_CREDENTIAL_LINES[code as keyof typeof GIT_CREDENTIAL_LINES]
        : GENERIC_LINE,
    );
  } catch {
    return refuse(GENERIC_LINE);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The subcommand's command line, after `git-credential`: `--socket <path>`
 * and the operation as the single positional. On `get`, a missing socket or
 * a bad command line prints `quit=1`; any other operation exits silently.
 */
export function gitCredentialMain(
  args: string[],
  io: Pick<GitCredentialRun, "stdin" | "stdout" | "stderr">,
): Promise<number> {
  // Git may close our stdout or stderr before we write (it gave up or was
  // interrupted). The write then fails with EPIPE; nobody is left to tell,
  // so the helper ends quietly with exit 0 instead of an unhandled error and
  // a stack trace (F009). Each answer is one small write, never retried.
  for (const stream of [io.stdout, io.stderr]) stream.on("error", () => {});
  let socket: string | undefined;
  let operation: string | undefined;
  try {
    const { values, positionals } = parseArgs({
      args,
      options: { socket: { type: "string" } },
      allowPositionals: true,
    });
    socket = values.socket;
    operation = positionals.length === 1 ? positionals[0] : undefined;
  } catch {
    operation = undefined;
  }
  const asked = operation ?? (args.includes("get") ? "get" : "");
  if (asked === "get" && (operation === undefined || !socket)) {
    io.stdout.write("quit=1\n");
    io.stderr.write(`${USAGE_LINE}\n`);
    return Promise.resolve(0);
  }
  return runGitCredential({
    operation: asked,
    socketPath: socket ?? "",
    ...io,
  });
}
