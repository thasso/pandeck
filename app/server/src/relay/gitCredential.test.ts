/**
 * The relay's git credential helper (Task-1446 plan v03 §4, V3) against a
 * fake edge on the real `WorkerConnection` with the gateway client protocol,
 * so failures arrive exactly as in production (a `text:message` stream, then
 * the response), and against a raw scripted server for every frame the
 * helper must refuse. Every value is fake; no test leaves the machine.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import {
  CLIENT_METHODS,
  GATEWAY_CLIENT_PROTOCOL,
  GATEWAY_CLIENT_VERSION,
  GIT_CREDENTIAL_FAILURES,
} from "../gateway/clientMethods.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import {
  UNKNOWN_METHOD,
  WorkerConnection,
  WorkerMethodError,
  type ConnectionLimits,
  type MethodHandler,
} from "../workerProtocol/connection.ts";
import { socketEndpoint } from "../workerProtocol/unixSocketTransport.ts";
import {
  GIT_CREDENTIAL_CLIENT_VERSION,
  GIT_CREDENTIAL_LINES,
  GIT_CREDENTIAL_METHOD,
  runGitCredential,
  type GitCredentialRun,
} from "./gitCredential.ts";

let dir: string;
let sockets = 0;
const closers: (() => Promise<void>)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-gitcred-"));
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LIMITS: ConnectionLimits = {
  maxMessageBytes: 2 * 1024 * 1024,
  maxBufferedBytes: 4 * 1024 * 1024,
  maxPartialMessages: 8,
  maxServing: 256,
};
const TOKEN = "fake-install-token-1";
const FUTURE = () => Date.now() + 3_600_000;
const GET =
  "protocol=https\nhost=github.com\npath=fake-owner/fake-repo.git\nusername=x\n\n";
const GENERIC = /^pandeck relay: no git credential from the gateway/;
const SENTINEL = "SENTINEL-EDGE-MESSAGE";

function listen(onSocket: (socket: net.Socket) => void) {
  const path = join(dir, `s${++sockets}.sock`);
  const server = net.createServer(onSocket);
  const counted = { path, connections: 0 };
  server.on("connection", () => (counted.connections += 1));
  closers.push(
    () =>
      new Promise<void>((done) => {
        server.close(() => done());
      }),
  );
  return new Promise<typeof counted>((ready) =>
    server.listen(path, () => ready(counted)),
  );
}

/** A fake edge serving `git.credential` with `handler`, if any. */
async function fakeEdge(
  handler?: (
    payload: Payload,
    connection: WorkerConnection,
  ) => Promise<Payload>,
  limits: ConnectionLimits = LIMITS,
) {
  const requests: Payload[] = [];
  const hellos: { workerId: string; version: string }[] = [];
  const open: WorkerConnection[] = [];
  const edge = await listen((socket) => {
    const holder: { connection?: WorkerConnection } = {};
    const method: MethodHandler = (payload) => {
      requests.push(payload);
      return handler!(payload, holder.connection!);
    };
    holder.connection = new WorkerConnection(socketEndpoint(socket), {
      protocol: GATEWAY_CLIENT_PROTOCOL,
      handshake: {
        role: "server",
        admit: (hello) => {
          hellos.push(hello);
          return undefined;
        },
      },
      handlers: handler ? { [CLIENT_METHODS.gitCredential]: method } : {},
      limits,
    });
    open.push(holder.connection);
  });
  closers.push(async () => {
    for (const connection of open) connection.end("test done");
  });
  return {
    ...edge,
    requests,
    hellos,
    get connections() {
      return edge.connections;
    },
  };
}

const okAnswer = (expiresAt = FUTURE()): Promise<Payload> =>
  Promise.resolve({ json: { token: TOKEN, expiresAt } });

function sink() {
  let text = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      text += chunk.toString("utf8");
      done();
    },
  });
  return { stream, text: () => text };
}

async function helper(
  socketPath: string,
  input: string = GET,
  extra: Partial<GitCredentialRun> = {},
) {
  const stdin = new PassThrough();
  stdin.end(input);
  const stdout = sink();
  const stderr = sink();
  const code = await runGitCredential({
    operation: "get",
    socketPath,
    stdin,
    stdout: stdout.stream,
    stderr: stderr.stream,
    ...extra,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

const refusedWith = (
  result: { code: number; stdout: string; stderr: string },
  line: string | RegExp,
): void => {
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "quit=1\n");
  if (typeof line === "string") assert.equal(result.stderr, `${line}\n`);
  else assert.match(result.stderr, line);
  assert.equal(result.stderr.split("\n").length, 2, "one stderr line");
};

test("ok: exactly the three lines, the expiry in whole seconds, nothing on stderr", async () => {
  const expiresAt = FUTURE() + 999;
  const edge = await fakeEdge(() => okAnswer(expiresAt));
  const result = await helper(edge.path);
  assert.deepEqual(result, {
    code: 0,
    stdout: `username=x-access-token\npassword=${TOKEN}\npassword_expiry_utc=${Math.floor(expiresAt / 1000)}\n`,
    stderr: "",
  });
});

test("the request: hello as git-credential at 1.4, then exactly {host, path, access: read} with no stream", async () => {
  const edge = await fakeEdge(() => okAnswer());
  await helper(edge.path);
  assert.equal(edge.hellos.length, 1);
  assert.equal(edge.hellos[0]!.version, "gateway-client/1.4");
  assert.equal(edge.hellos[0]!.workerId, "git-credential");
  assert.equal(edge.requests.length, 1);
  const [request] = edge.requests;
  assert.deepEqual(request!.json, {
    host: "github.com",
    path: "fake-owner/fake-repo.git",
    access: "read",
  });
  assert.deepEqual(Object.keys(request!.text ?? {}), []);
  assert.deepEqual(Object.keys(request!.bytes ?? {}), []);
});

for (const code of [
  "git_not_connected",
  "git_reconnect",
  "git_denied",
  "vault_locked",
  "vault_unavailable",
  "invalid_params",
] as const)
  test(`a ${code} failure, its message stream read and discarded: quit=1 and the relay's own line`, async () => {
    const edge = await fakeEdge(() => {
      throw new WorkerMethodError(code, `${SENTINEL} for ${code}`);
    });
    const result = await helper(edge.path);
    refusedWith(result, GIT_CREDENTIAL_LINES[code]);
    assert.ok(!result.stdout.includes(SENTINEL));
    assert.ok(!result.stderr.includes(SENTINEL));
    assert.equal(edge.connections, 1, "no retry");
  });

test("a long failure message under the 16 KiB cap is discarded; one over it is a protocol error", async () => {
  const under = await fakeEdge(() => {
    throw new WorkerMethodError("git_denied", SENTINEL + "x".repeat(6000));
  });
  const first = await helper(under.path);
  refusedWith(first, GIT_CREDENTIAL_LINES.git_denied);
  assert.ok(!first.stderr.includes(SENTINEL));
  const over = await fakeEdge(() => {
    throw new WorkerMethodError("git_denied", SENTINEL + "x".repeat(9000));
  });
  const second = await helper(over.path);
  refusedWith(second, GENERIC);
  assert.ok(!second.stderr.includes(SENTINEL));
});

test("an edge without the method answers unknown_method: the too-old line", async () => {
  const edge = await fakeEdge();
  refusedWith(await helper(edge.path), GIT_CREDENTIAL_LINES.unknown_method);
  assert.equal(UNKNOWN_METHOD, "unknown_method");
});

test("an edge at its serving limit answers busy: the busy line, no retry", async () => {
  const edge = await fakeEdge(() => okAnswer(), { ...LIMITS, maxServing: 0 });
  refusedWith(await helper(edge.path), GIT_CREDENTIAL_LINES.busy);
  assert.equal(edge.connections, 1);
});

test("git_busy twice, then ok: three connections, two jittered waits", async () => {
  let calls = 0;
  const edge = await fakeEdge(() => {
    calls += 1;
    if (calls <= 2) throw new WorkerMethodError("git_busy", SENTINEL);
    return okAnswer();
  });
  const waits: number[] = [];
  const result = await helper(edge.path, GET, {
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  assert.match(result.stdout, /^username=x-access-token\npassword=/);
  assert.equal(edge.connections, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits[0]! >= 250 && waits[0]! <= 375, String(waits[0]));
  assert.ok(waits[1]! >= 500 && waits[1]! <= 750, String(waits[1]));
});

test("four git_busy answers in a row: quit=1 with the busy line after four connections", async () => {
  const edge = await fakeEdge(() => {
    throw new WorkerMethodError("git_busy", SENTINEL);
  });
  const waits: number[] = [];
  const result = await helper(edge.path, GET, {
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  refusedWith(result, GIT_CREDENTIAL_LINES.git_busy);
  assert.equal(edge.connections, 4);
  assert.equal(waits.length, 3);
  assert.ok(waits[2]! >= 1000 && waits[2]! <= 1500, String(waits[2]));
});

test("a deadline shorter than the backoff refuses before the next attempt", async () => {
  const edge = await fakeEdge(() => {
    throw new WorkerMethodError("git_busy", SENTINEL);
  });
  const waits: number[] = [];
  const result = await helper(edge.path, GET, {
    deadlineMs: 200,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  refusedWith(result, GIT_CREDENTIAL_LINES.git_busy);
  assert.equal(edge.connections, 1);
  assert.equal(waits.length, 0);
});

test("input that is not an https GitHub request with a path, or over 64 KiB, never opens the socket", async () => {
  const edge = await fakeEdge(() => okAnswer());
  for (const [input, line] of [
    [
      GET.replace("https", "http"),
      /serves only GitHub repositories over https/,
    ],
    [GET.replace("github.com", "gitlab.com"), /serves only GitHub/],
    [
      "protocol=https\nhost=github.com\n\n",
      /set credential\.useHttpPath = true/,
    ],
    [`protocol=https\nhost=github.com\nx=${"a".repeat(70 * 1024)}`, GENERIC],
  ] as const)
    refusedWith(await helper(edge.path, input), line);
  assert.equal(edge.connections, 0);
});

test("store, erase and any other operation print nothing, exit 0 and never open the socket", async () => {
  const edge = await fakeEdge(() => okAnswer());
  for (const operation of ["store", "erase", "foo"]) {
    const result = await helper(
      edge.path,
      `${GET.trimEnd()}\npassword=${TOKEN}\n\n`,
      { operation },
    );
    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" }, operation);
  }
  assert.equal(edge.connections, 0);
});

test("an edge request racing in before the response is skipped unanswered; a 512 KiB one too; over 4 MiB is refused", async () => {
  const small = await fakeEdge(async (_payload, connection) => {
    void connection
      .request(CLIENT_METHODS.accountsChanged, { json: { accounts: [] } })
      .catch(() => {});
    void connection
      .request(CLIENT_METHODS.accountsChanged, {
        json: { pad: "x".repeat(512 * 1024) },
      })
      .catch(() => {});
    return okAnswer();
  });
  assert.match((await helper(small.path)).stdout, /^username=x-access-token\n/);

  const flood = await fakeEdge(async (_payload, connection) => {
    for (let i = 0; i < 5; i++)
      void connection
        .request(CLIENT_METHODS.accountsChanged, {
          json: { pad: "x".repeat(900 * 1024) },
        })
        .catch(() => {});
    return okAnswer();
  });
  refusedWith(await helper(flood.path), GENERIC);
});

test("the relay's constants are clientMethods.ts's, and its lines are its own", () => {
  assert.equal(GIT_CREDENTIAL_CLIENT_VERSION, GATEWAY_CLIENT_VERSION);
  assert.equal(GIT_CREDENTIAL_METHOD, CLIENT_METHODS.gitCredential);
  for (const code of Object.keys(GIT_CREDENTIAL_FAILURES))
    assert.ok(Object.hasOwn(GIT_CREDENTIAL_LINES, code), code);
  for (const code of ["invalid_params", UNKNOWN_METHOD, "busy"])
    assert.ok(Object.hasOwn(GIT_CREDENTIAL_LINES, code), code);
  const edgeTexts = Object.values(GIT_CREDENTIAL_FAILURES) as string[];
  for (const line of Object.values(GIT_CREDENTIAL_LINES)) {
    assert.ok(!edgeTexts.includes(line), line);
    for (const text of edgeTexts) assert.ok(!line.includes(text), line);
    assert.ok(!line.includes("github.com"), line);
  }
});

// --- raw frames -----------------------------------------------------------

function rawFrame(header: object, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(head.length, 0);
  prefix.writeUInt32BE(payload.length, 4);
  return Buffer.concat([prefix, head, payload]);
}
const json = (value: unknown): Buffer =>
  Buffer.from(JSON.stringify(value), "utf8");
const WELCOME = rawFrame({ type: "welcome", version: GATEWAY_CLIENT_VERSION });
const success = (payload: Buffer, head: object = {}) =>
  rawFrame(
    { type: "response", id: 1, text: [], bytes: [], chunks: 0, ...head },
    payload,
  );
const message = (stream: string, seq: number, bytes = Buffer.from("x\0")) =>
  rawFrame({ type: "data", of: "response", id: 1, stream, seq }, bytes);
const failure = (chunks: number, text: string[] = ["message"]) =>
  rawFrame(
    {
      type: "response",
      id: 1,
      failure: "git_denied",
      text,
      bytes: [],
      chunks,
    },
    json(null),
  );

/** A server that welcomes, then answers the request with `frames`. */
async function rawEdge(
  frames: Buffer[],
  handshake: Buffer | undefined = WELCOME,
) {
  return listen((socket) => {
    let seen = 0;
    socket.on("error", () => {});
    socket.on("data", () => {
      seen += 1;
      if (seen === 1 && handshake) socket.write(handshake);
      if (seen === 2) for (const part of frames) socket.write(part);
    });
  });
}

test("a hand-written correct answer passes (the raw harness's control)", async () => {
  const edge = await rawEdge([
    success(json({ token: TOKEN, expiresAt: FUTURE() })),
  ]);
  assert.match((await helper(edge.path)).stdout, /^username=x-access-token\n/);
  const failed = await rawEdge([
    message("text:message", 0, Buffer.from(SENTINEL, "utf16le")),
    failure(1),
  ]);
  refusedWith(await helper(failed.path), GIT_CREDENTIAL_LINES.git_denied);
});

const PROTOCOL_REFUSALS: [
  string,
  () => Buffer[] | "silent" | "refused" | "garbage",
][] = [
  [
    "a token with a newline",
    () => [success(json({ token: "a\nusername=evil", expiresAt: FUTURE() }))],
  ],
  ["an empty token", () => [success(json({ token: "", expiresAt: FUTURE() }))]],
  [
    "a past expiresAt",
    () => [success(json({ token: TOKEN, expiresAt: Date.now() - 1000 }))],
  ],
  [
    "an extra member",
    () => [success(json({ token: TOKEN, expiresAt: FUTURE(), x: 1 }))],
  ],
  [
    "a success with text",
    () => [
      success(json({ token: TOKEN, expiresAt: FUTURE() }), {
        text: ["message"],
      }),
    ],
  ],
  [
    "a success with bytes",
    () => [
      success(json({ token: TOKEN, expiresAt: FUTURE() }), { bytes: ["x"] }),
    ],
  ],
  [
    "a success after a message frame",
    () => [
      message("text:message", 0),
      success(json({ token: TOKEN, expiresAt: FUTURE() }), { chunks: 1 }),
    ],
  ],
  ["a failure with a bytes stream", () => [message("bytes:x", 0), failure(1)]],
  ["a failure with a body stream", () => [message("body", 0), failure(1)]],
  ["a chunks mismatch", () => [message("text:message", 0), failure(2)]],
  [
    "an oversize header",
    () => {
      const prefix = Buffer.alloc(8);
      prefix.writeUInt32BE(70 * 1024, 0);
      return [prefix, Buffer.alloc(70 * 1024, 0x20)];
    },
  ],
  [
    "a 17 KiB success payload",
    () => [
      success(
        Buffer.concat([
          json({ token: TOKEN, expiresAt: FUTURE() }),
          Buffer.alloc(17 * 1024, 0x20),
        ]),
      ),
    ],
  ],
  ["garbage", () => "garbage"],
  ["a refused handshake", () => "refused"],
  ["a silent server", () => "silent"],
];

for (const [name, script] of PROTOCOL_REFUSALS)
  test(`protocol refusal: ${name} → quit=1 with the generic line`, async () => {
    const plan = script();
    const edge =
      plan === "silent"
        ? await rawEdge([], undefined)
        : plan === "refused"
          ? await rawEdge(
              [],
              rawFrame({
                type: "refused",
                version: GATEWAY_CLIENT_VERSION,
                reason: SENTINEL,
              }),
            )
          : plan === "garbage"
            ? await rawEdge(
                [],
                Buffer.from("\xff\xff\xff\xffnot frames at all"),
              )
            : await rawEdge(plan);
    const result = await helper(edge.path, GET, { deadlineMs: 300 });
    refusedWith(result, GENERIC);
    assert.ok(!result.stdout.includes("password="));
    assert.ok(!result.stderr.includes(SENTINEL));
  });

test("a missing socket, or one the helper may not open, is refused with the generic line", async () => {
  refusedWith(await helper(join(dir, "absent.sock")), GENERIC);
  if (process.getuid?.() === 0) return; // root opens a mode 000 socket
  const edge = await rawEdge([
    success(json({ token: TOKEN, expiresAt: FUTURE() })),
  ]);
  chmodSync(edge.path, 0o000);
  refusedWith(await helper(edge.path), GENERIC);
});

test("spawned: main.ts git-credential --socket <s> get prints the three lines and exits 0 (stdout drains)", async () => {
  const edge = await fakeEdge(() => okAnswer());
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("src", "relay/main.ts"),
      "git-credential",
      "--socket",
      edge.path,
      "get",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.stdin.end(GET);
  const code = await new Promise<number | null>((done) =>
    child.on("close", done),
  );
  assert.equal(code, 0, stderr);
  assert.match(
    stdout,
    new RegExp(
      `^username=x-access-token\\npassword=${TOKEN}\\npassword_expiry_utc=\\d+\\n$`,
    ),
  );
  assert.equal(stderr, "");
}, 30_000);
