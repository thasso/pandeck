/**
 * Fixtures for the credential gateway's control and state tests and the
 * engine contract tests: fake TLS upstreams for `api.anthropic.com` and
 * `chatgpt.com` (a minimal Anthropic stream among their answers), an egress
 * recorder that refuses everything sent through it as a proxy, token files
 * under the test's temp `DATA_DIR`, a control dialer on an in-process pair, a
 * model request, and the processes a login hold names: a fake probe, or idle
 * children of this test. Every value is fake. It imports nothing from
 * `gateway/`, whose only importer outside itself is pinned
 * (`workerBoundary.test.ts`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import {
  issueLeafCertificate,
  loadOrCreateCa,
} from "../packageProxy/certificateAuthority.ts";
import {
  WorkerConnection,
  type ConnectionProtocol,
  type MethodHandlers,
} from "../workerProtocol/connection.ts";
import type { ByteEndpoint } from "../workerProtocol/inProcessTransport.ts";

// Synthetic fixture values; none is a real credential.
export const CLAUDE_ACCESS = "fake-claude-access";
export const CODEX_ACCESS = "fake-codex-access";
export const CODEX_ACCOUNT = "acct-test";

export const CLAUDE_PATH = "/anthropic/v1/messages";
export const CODEX_PATH = "/chatgpt/backend-api/codex/responses";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

/** Answers one upstream request, once its body was read. */
export type UpstreamResponder = (seen: Seen, res: http.ServerResponse) => void;

const answerOk: UpstreamResponder = (_seen, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"ok":true}');
};

/** A 200 Anthropic message stream whose one text block is `text`. */
export function fakeClaudeStream(text: string): UpstreamResponder {
  const events: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: "claude-fake",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  const body = events
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
  return (_seen, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(body);
  };
}

export interface FakeUpstreams {
  /** Requests each upstream received: "no upstream request" is empty. */
  readonly anthropic: Seen[];
  readonly chatgpt: Seen[];
  /** `startGateway`'s `upstreams` option. */
  readonly overrides: {
    claude: { connect: { host: string; port: number }; ca: string };
    "openai-codex": { connect: { host: string; port: number }; ca: string };
  };
  reset(): void;
  close(): Promise<void>;
}

/** The fake upstreams; each answers 200 `{"ok":true}` unless given a responder. */
export async function startFakeUpstreams(
  respond: { claude?: UpstreamResponder } = {},
): Promise<FakeUpstreams> {
  const ca = await loadOrCreateCa();
  const servers: https.Server[] = [];
  const start = async (
    host: string,
    seen: Seen[],
    responder: UpstreamResponder,
  ) => {
    const leaf = issueLeafCertificate(ca, host);
    const server = https.createServer(
      { key: leaf.keyPem, cert: leaf.certPem },
      (req, res) => {
        req.resume();
        req.on("end", () => {
          const request = {
            method: req.method ?? "",
            url: req.url ?? "",
            headers: req.headers,
          };
          seen.push(request);
          responder(request, res);
        });
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    servers.push(server);
    const { port } = server.address() as net.AddressInfo;
    return { connect: { host: "127.0.0.1", port }, ca: ca.certPem };
  };
  const anthropic: Seen[] = [];
  const chatgpt: Seen[] = [];
  const overrides = {
    claude: await start(
      "api.anthropic.com",
      anthropic,
      respond.claude ?? answerOk,
    ),
    "openai-codex": await start("chatgpt.com", chatgpt, answerOk),
  };
  return {
    anthropic,
    chatgpt,
    overrides,
    reset() {
      anthropic.length = 0;
      chatgpt.length = 0;
      for (const server of servers) server.closeAllConnections();
    },
    async close() {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}

export interface EgressRecorder {
  /** The proxy URL, for `HTTPS_PROXY` and its siblings. */
  readonly url: string;
  /** Every request and CONNECT sent through it, in arrival order. */
  readonly seen: { method: string; target: string }[];
  close(): Promise<void>;
}

/**
 * A loopback HTTP proxy that refuses every request and CONNECT with 403 and
 * records it: what a child sends through its proxy variables, such as a
 * token-host refresh, shows up here instead of leaving.
 */
export async function startEgressRecorder(): Promise<EgressRecorder> {
  const seen: { method: string; target: string }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", target: req.url ?? "" });
    req.resume();
    res.writeHead(403).end();
  });
  server.on("connect", (req, socket) => {
    seen.push({ method: "CONNECT", target: req.url ?? "" });
    socket.on("error", () => socket.destroy());
    socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Fresh Claude and Codex token files with fake credentials. */
export async function writeTokenFiles(): Promise<{
  claudeFile: string;
  codexFile: string;
}> {
  await mkdir(DATA_DIR, { recursive: true });
  const root = await mkdtemp(join(DATA_DIR, "gateway-tokens-"));
  const claudeFile = join(root, "claude", ".credentials.json");
  const codexFile = join(root, "pi", "auth.json");
  await mkdir(join(root, "claude"));
  await mkdir(join(root, "pi"));
  const expires = Date.now() + 3_600_000;
  await writeFile(
    claudeFile,
    JSON.stringify({
      claudeAiOauth: { accessToken: CLAUDE_ACCESS, expiresAt: expires },
    }),
  );
  await writeFile(
    codexFile,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: CODEX_ACCESS,
        accountId: CODEX_ACCOUNT,
        expires,
      },
    }),
  );
  return { claudeFile, codexFile };
}

/**
 * Attaches the listener end of a fresh in-process pair through `attach` and
 * dials the other with `protocol` (the worker protocol when absent), serving
 * `handlers` (what the gateway sends the server). The test makes the pair:
 * only the isolation boundary makes one outside tests.
 */
export function dialControl(
  [server, gateway]: [ByteEndpoint, ByteEndpoint],
  attach: (endpoint: ByteEndpoint) => void,
  protocol?: ConnectionProtocol,
  handlers?: MethodHandlers,
): WorkerConnection {
  attach(gateway);
  return new WorkerConnection(server, {
    handshake: { role: "worker", workerId: "pandeck-server" },
    ...(protocol ? { protocol } : {}),
    ...(handlers ? { handlers } : {}),
  });
}

/** A model request through the gateway; answers its status and body text. */
export async function modelRequest(
  port: number,
  path: string,
  token: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent: false,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end('{"model":"fixture"}');
  });
}

/** What a fake process answers `processState`'s probe. */
type FakeProcessState = "running" | "exited" | "eperm";

/**
 * A `processProbe` that observes no real process: each pid answers as `set`
 * says, `fallback` otherwise, and has no readable start time.
 */
export interface FakeProcesses {
  probe: {
    kill(pid: number, signal: 0): void;
    startTime(pid: number): string | null;
  };
  set(pid: number, state: FakeProcessState): void;
  /** Every pid the probe was asked about, in order. */
  readonly probed: number[];
}

export function fakeProcesses(
  fallback: FakeProcessState = "running",
): FakeProcesses {
  const states = new Map<number, FakeProcessState>();
  const probed: number[] = [];
  const failure = (code: string) =>
    Object.assign(new Error(`fake ${code}`), { code });
  return {
    probe: {
      kill(pid) {
        probed.push(pid);
        const state = states.get(pid) ?? fallback;
        if (state === "exited") throw failure("ESRCH");
        if (state === "eperm") throw failure("EPERM");
      },
      startTime: () => null,
    },
    set: (pid, state) => states.set(pid, state),
    probed,
  };
}

/**
 * An idle child of this test, the only kind of process a test observes for
 * real; end it with {@link endChild}, through its own handle.
 */
export function spawnIdleChild(): ChildProcess & { pid: number } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    stdio: "ignore",
  });
  if (child.pid === undefined) throw new Error("the idle child did not start");
  return child as ChildProcess & { pid: number };
}

/** Ends `child` through its handle and waits until it has exited. */
export async function endChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await exited;
}
