/**
 * The link's file calls (Task-1441 P7a, G1/G2/AC4): `callFile` against a stub
 * edge on a Unix socket. A file answer reaches `use` only decoded against the
 * caller's E; a stream on a plain call is an unexpected file; one file call
 * runs at a time and holds its slot until its request retires, past a
 * timeout or cancel; a request that never retires ends the link; an answer
 * over the link's message bound ends the connection. Every value is fake.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import type { RemoteFileAnswer } from "./remoteTools.ts";
import type { Payload } from "./workerProtocol/codec.ts";

const home = mkdtempSync(join(tmpdir(), "gateway-files-home-"));
process.env.HOME = home;

const { startGatewayClientLink } = await import("./gatewayClientLink.ts");
const remoteTools = await import("./remoteTools.ts");
const { updateJiraSettings } = await import("./jiraSettings.ts");
const { remoteToolsFor } = await import("./tools/gateway/remoteToolGroup.ts");
const { UNEXPECTED_FILE_ANSWER } =
  await import("./tools/gateway/remoteReadRules.ts");
const { listSessionAttachments } = await import("./sessionAttachments.ts");
const { WorkerConnection } = await import("./workerProtocol/connection.ts");
const { socketEndpoint } =
  await import("./workerProtocol/unixSocketTransport.ts");
const { CLIENT_METHODS, GATEWAY_CLIENT_PROTOCOL, encodeClientMessage } =
  await import("./gateway/clientMethods.ts");

const open: { close(): unknown }[] = [];

afterEach(async () => {
  vi.useRealTimers();
  while (open.length) await open.pop()!.close();
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

const MiB = 1024 * 1024;
/** A name that must never reach a log line. */
const MARKER = "MARKER-p7a-name.bin";

type Handler = (payload: Payload, signal: AbortSignal) => Promise<Payload>;

/** A stub edge: hello, accounts and reconcile, plus `handlers`. */
async function stubEdge(handlers: Record<string, Handler>) {
  const dir = mkdtempSync(join(tmpdir(), "stub-edge-"));
  const socketPath = join(dir, "edge.sock");
  const connections: InstanceType<typeof WorkerConnection>[] = [];
  const server = net.createServer((socket) => {
    connections.push(
      new WorkerConnection(socketEndpoint(socket), {
        protocol: GATEWAY_CLIENT_PROTOCOL,
        handshake: { role: "server", admit: () => undefined },
        handlers: {
          [CLIENT_METHODS.hello]: () =>
            Promise.resolve(
              encodeClientMessage({ clientId: "c-stub", userId: "u-stub" }),
            ),
          [CLIENT_METHODS.listAccounts]: () =>
            Promise.resolve(encodeClientMessage({ accounts: [] })),
          [CLIENT_METHODS.reconcileWorker]: () =>
            Promise.resolve(encodeClientMessage({ revoked: [] })),
          [CLIENT_METHODS.toolsList]: () =>
            Promise.resolve(encodeClientMessage({ tools: [STUB_TOOL] })),
          ...handlers,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  open.push({
    close: async () => {
      for (const connection of connections) connection.end("stub closed");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  });
  return { socketPath, connections };
}

const STUB_TOOL = {
  name: "jira_stub_read",
  description: "A stub read tool.",
  inputSchema: { type: "object", properties: {} },
  effect: "read",
  actionKey: "jira:read",
};

async function linkTo(socketPath: string) {
  const lines: string[] = [];
  const link = startGatewayClientLink({
    socketPath,
    relayPort: 1,
    log: (line) => lines.push(line),
  });
  open.push(link);
  assert.equal(await link.ready, true);
  return { link, lines, port: remoteTools.remoteToolPort()! };
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const bytesOf = (size: number) =>
  new Uint8Array(size).map((_byte, index) => index % 251);

/** A file answer as the edge frames it; `digestOf` lies about the bytes. */
function fileAnswer(bytes: Uint8Array, digestOf: Uint8Array = bytes): Payload {
  return {
    json: {
      ok: true,
      text: '{"status":"fixture"}',
      file: {
        name: MARKER,
        mimeType: "application/octet-stream",
        size: bytes.length,
        sha256: sha256(digestOf),
      },
    },
    bytes: { file: bytes },
  };
}

const argsMode = (payload: Payload) =>
  ((payload.json as { args: { mode?: string } }).args.mode ?? "") as string;

const refusal =
  (code: string) =>
  (err: unknown): boolean =>
    err instanceof remoteTools.RemoteToolRefusal && err.code === code;

const never = new AbortController().signal;

/** Lets socket I/O run without `vi.waitFor`, which would move a faked clock. */
async function until(check: () => boolean): Promise<void> {
  for (let turn = 0; !check(); turn++) {
    if (turn > 10_000) throw new Error("condition was not reached");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a stream on a plain call is an unexpected file: the agent reads the fixed text and nothing is kept", async () => {
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsCall]: () => Promise.resolve(fileAnswer(bytesOf(5))),
  });
  const { port, lines } = await linkTo(edge.socketPath);
  await assert.rejects(
    port.call("jira_stub_read", {}, never),
    refusal("unexpected_file"),
  );
  await updateJiraSettings({ enabled: true });
  open.push({ close: () => updateJiraSettings({ enabled: false }) });
  const tool = remoteToolsFor("jira").find((t) => t.name === "jira_stub_read");
  assert.ok(tool);
  const sessionId = "p7a-plain-stream";
  await assert.rejects(tool.execute({}, { session: { sessionId } } as never), {
    message: UNEXPECTED_FILE_ANSWER,
  });
  assert.deepEqual(listSessionAttachments(sessionId), []);
  assert.ok(
    lines.includes("tools.call: The gateway's file answer is unexpected."),
  );
  assert.ok(lines.every((line) => !line.includes(MARKER)));
  // The link goes on.
  assert.equal(remoteTools.remoteToolsConnected(), true);
});

test("a file call: its answer within E reaches `use` once with its bytes; over E, a digest mismatch or a stray shape never does", async () => {
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsCall]: (payload) => {
      switch (argsMode(payload)) {
        case "corrupt":
          return Promise.resolve(fileAnswer(bytesOf(5), bytesOf(6)));
        case "plain":
          return Promise.resolve(
            encodeClientMessage({ ok: true, text: "inline" }),
          );
        case "fail":
          return Promise.resolve(
            encodeClientMessage({
              ok: false,
              code: "tool_error",
              message: "The edge's own text.",
            }),
          );
        case "text":
          return Promise.resolve({
            json: { ok: true, text: "x" },
            text: { file: "not bytes" },
          });
        default:
          return Promise.resolve(fileAnswer(bytesOf(5)));
      }
    },
  });
  const { port, lines } = await linkTo(edge.socketPath);
  const seen: RemoteFileAnswer[] = [];
  const use = (answer: RemoteFileAnswer) => {
    seen.push(answer);
    return answer.kind;
  };
  const call = (mode: string, maxBytes = 5) =>
    port.callFile("any_file", { mode }, never, { maxBytes }, use);

  assert.equal(await call("file"), "file");
  const [file] = seen;
  assert.ok(file?.kind === "file");
  assert.deepEqual(Buffer.from(file.bytes), Buffer.from(bytesOf(5)));
  assert.deepEqual(file.file, {
    name: MARKER,
    mimeType: "application/octet-stream",
    size: 5,
    sha256: sha256(bytesOf(5)),
  });
  assert.equal(await call("plain"), "plain");
  assert.equal(await call("fail"), "failure");
  assert.deepEqual(seen.at(-1), {
    kind: "failure",
    code: "tool_error",
    message: "The edge's own text.",
  });
  // Each refusal is the link's own, and never reaches `use`.
  const before = seen.length;
  await assert.rejects(call("file", 4), refusal("unexpected_file"));
  await assert.rejects(call("corrupt"), refusal("corrupted_file"));
  await assert.rejects(call("text"), refusal("unexpected_file"));
  assert.equal(seen.length, before);
  // Every call retired: the slot is free for the next.
  assert.equal(await call("file"), "file");
  assert.ok(lines.every((line) => !line.includes(MARKER)));
});

test("a file call is bounded at 215 s; the slot stays held until its request retires, and the late file never reaches `use`", async () => {
  const signals: AbortSignal[] = [];
  let answerLate!: () => void;
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsCall]: (payload, signal) => {
      if (argsMode(payload) === "plain")
        return Promise.resolve(encodeClientMessage({ ok: true, text: "ok" }));
      if (argsMode(payload) === "file")
        return Promise.resolve(fileAnswer(bytesOf(5)));
      signals.push(signal);
      // Ignores its cancel, as an executor that has not settled yet.
      return new Promise((resolve) => {
        answerLate = () => resolve(fileAnswer(bytesOf(5)));
      });
    },
  });
  const { port } = await linkTo(edge.socketPath);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const seen: RemoteFileAnswer[] = [];
  const use = (answer: RemoteFileAnswer) => {
    seen.push(answer);
    return answer.kind;
  };
  let settled = false;
  const slow = port
    .callFile("any_file", { mode: "slow" }, never, { maxBytes: 5 }, use)
    .finally(() => (settled = true));
  await until(() => signals.length === 1);
  await vi.advanceTimersByTimeAsync(214_999);
  assert.equal(settled, false);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(await slow, "failure");
  assert.deepEqual(seen, [{ kind: "failure", code: "timeout", message: "" }]);
  // A cancel went to the edge.
  await until(() => signals[0]!.aborted);

  // Unretired: another file call is refused here, before anything is sent.
  await assert.rejects(
    port.callFile("any_file", { mode: "file" }, never, { maxBytes: 5 }, use),
    refusal("file_busy"),
  );
  assert.equal(signals.length, 1);
  // An ordinary call is not held up.
  assert.deepEqual(
    await port.call("jira_stub_read", { mode: "plain" }, never),
    {
      ok: true,
      text: "ok",
    },
  );

  // The late file retires the request, unread; then the slot is free.
  vi.useRealTimers();
  answerLate();
  await vi.waitFor(async () =>
    assert.equal(
      await port.callFile(
        "any_file",
        { mode: "file" },
        never,
        { maxBytes: 5 },
        use,
      ),
      "file",
    ),
  );
  assert.deepEqual(
    seen.map((answer) => answer.kind),
    ["failure", "file"],
  );
});

test("a caller's abort: `use` reads cancelled, the edge gets a cancel, and the slot waits for the answer; an abort before the send frees it at once", async () => {
  const signals: AbortSignal[] = [];
  const answers: (() => void)[] = [];
  let calls = 0;
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsCall]: (_payload, signal) => {
      calls += 1;
      signals.push(signal);
      return new Promise((resolve) => {
        answers.push(() => resolve(fileAnswer(bytesOf(5))));
      });
    },
  });
  const { port } = await linkTo(edge.socketPath);
  const seen: string[] = [];
  const use = (answer: RemoteFileAnswer) => {
    seen.push(answer.kind === "failure" ? answer.code : answer.kind);
    return answer.kind;
  };
  const caller = new AbortController();
  const call = port.callFile(
    "any_file",
    {},
    caller.signal,
    { maxBytes: 5 },
    use,
  );
  await vi.waitFor(() => assert.equal(signals.length, 1));
  caller.abort();
  assert.equal(await call, "failure");
  assert.deepEqual(seen, ["cancelled"]);
  await vi.waitFor(() => assert.ok(signals[0]!.aborted));
  await assert.rejects(
    port.callFile("any_file", {}, never, { maxBytes: 5 }, use),
    refusal("file_busy"),
  );
  answers[0]!();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(seen, ["cancelled"]);

  // Already aborted: never sent, cancelled, and the slot is free again.
  const aborted = new AbortController();
  aborted.abort();
  await vi.waitFor(async () =>
    assert.equal(
      await port.callFile("any_file", {}, aborted.signal, { maxBytes: 5 }, use),
      "failure",
    ),
  );
  assert.equal(seen.at(-1), "cancelled");
  assert.equal(calls, 1);
  const next = port.callFile("any_file", {}, never, { maxBytes: 5 }, use);
  await vi.waitFor(() => assert.equal(calls, 2));
  answers[1]!();
  assert.equal(await next, "file");
});

test("a file request that never retires ends the link at 300 s with a fixed log line; the redial frees the slot", async () => {
  let calls = 0;
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsCall]: (payload) => {
      calls += 1;
      if (argsMode(payload) === "file")
        return Promise.resolve(fileAnswer(bytesOf(5)));
      return new Promise<Payload>(() => {});
    },
  });
  const { port, lines } = await linkTo(edge.socketPath);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const use = (answer: RemoteFileAnswer) => answer.kind;
  const stuck = port.callFile("any_file", {}, never, { maxBytes: 5 }, use);
  await until(() => calls === 1);
  await vi.advanceTimersByTimeAsync(215_000);
  assert.equal(await stuck, "failure");
  await vi.advanceTimersByTimeAsync(300_000 - 215_000 - 1);
  assert.equal(remoteTools.remoteToolsConnected(), true);
  await vi.advanceTimersByTimeAsync(1);
  await until(() => !remoteTools.remoteToolsConnected());
  assert.ok(lines.includes("tools.call: a file answer did not retire"));
  // The redial was scheduled on the faked clock.
  await vi.advanceTimersByTimeAsync(2_000);
  vi.useRealTimers();
  await vi.waitFor(
    () => assert.equal(remoteTools.remoteToolsConnected(), true),
    {
      timeout: 8_000,
    },
  );
  assert.equal(
    await port.callFile(
      "any_file",
      { mode: "file" },
      never,
      { maxBytes: 5 },
      use,
    ),
    "file",
  );
});

test(
  "the link takes a 100 MiB file answer; one over its 102 MiB message bound ends the connection and reaches no `use`",
  { timeout: 120_000 },
  async () => {
    const edge = await stubEdge({
      [CLIENT_METHODS.toolsCall]: (payload) =>
        Promise.resolve(
          fileAnswer(
            argsMode(payload) === "over"
              ? new Uint8Array(102 * MiB + 1)
              : new Uint8Array(100 * MiB),
          ),
        ),
    });
    const { port } = await linkTo(edge.socketPath);
    const seen: number[] = [];
    const use = (answer: RemoteFileAnswer) => {
      seen.push(answer.kind === "file" ? answer.bytes.length : -1);
    };
    await port.callFile("any_file", {}, never, { maxBytes: 100 * MiB }, use);
    assert.deepEqual(seen, [100 * MiB]);
    await assert.rejects(
      port.callFile(
        "any_file",
        { mode: "over" },
        never,
        { maxBytes: 100 * MiB },
        use,
      ),
      refusal("gateway_unavailable"),
    );
    assert.deepEqual(seen, [100 * MiB]);
    await vi.waitFor(() =>
      assert.equal(remoteTools.remoteToolsConnected(), false),
    );
  },
);

test("without a connection a file call is refused before anything is held", async () => {
  const edge = await stubEdge({
    [CLIENT_METHODS.toolsCall]: () => Promise.resolve(fileAnswer(bytesOf(5))),
  });
  const { link, port } = await linkTo(edge.socketPath);
  await link.close();
  await assert.rejects(
    port.callFile("any_file", {}, never, { maxBytes: 5 }, () => "used"),
    refusal("gateway_unavailable"),
  );
});
