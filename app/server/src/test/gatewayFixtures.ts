/**
 * Fixtures for the credential gateway's control and state tests and the
 * engine contract tests: fake TLS upstreams for `api.anthropic.com` and
 * `chatgpt.com` (minimal Anthropic and Codex streams among their answers), a
 * fake OpenAI-compatible endpoint, a recording pass-through in front of the
 * gateway's listener, an egress recorder that refuses everything
 * sent through it as a proxy, an egress observer that sees every connection
 * attempt in this process, token files under the test's temp `DATA_DIR`, a
 * control dialer on an in-process pair, a model request, and the processes a
 * login hold names: a fake probe, or idle children of this test. Every value
 * is fake. It imports nothing from `gateway/`, whose only importer outside
 * itself is pinned (`workerBoundary.test.ts`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import diagnostics from "node:diagnostics_channel";
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
/** The default profile's own, so a test can tell which file was read. */
export const CODEX_DEFAULT_ACCESS = "fake-codex-default-access";
export const CODEX_DEFAULT_ACCOUNT = "acct-default-test";
/** Three OpenAI-compatible endpoints' keys. */
export const COMPAT_KEY_A = "fake-compat-key-a";
export const COMPAT_KEY_B = "fake-compat-key-b";
export const COMPAT_KEY_C = "fake-compat-key-c";

export const CLAUDE_PATH = "/anthropic/v1/messages";
export const CODEX_PATH = "/chatgpt/backend-api/codex/responses";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  /** The body as received, still encoded. */
  body: Buffer;
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

/**
 * A 200 Codex responses stream whose one output message is `text`: the
 * events pi reads, as the measured upstream sends them.
 */
export function fakeCodexStream(text: string): UpstreamResponder {
  const item = {
    type: "message",
    id: "msg_fake",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const response = (status: string, output: unknown[]) => ({
    id: "resp_fake",
    object: "response",
    status,
    model: "fake",
    output,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  });
  const events: ({ type: string } & Record<string, unknown>)[] = [
    { type: "response.created", response: response("in_progress", []) },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: response("completed", [item]) },
  ];
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
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
  respond: { claude?: UpstreamResponder; codex?: UpstreamResponder } = {},
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
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const request = {
            method: req.method ?? "",
            url: req.url ?? "",
            headers: req.headers,
            body: Buffer.concat(chunks),
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
    "openai-codex": await start(
      "chatgpt.com",
      chatgpt,
      respond.codex ?? answerOk,
    ),
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

/** A request a fake OpenAI-compatible endpoint received. */
interface CompatSeen {
  method: string;
  url: string;
  authorization: string | undefined;
}

export interface FakeCompatEndpoint {
  /** Its base URL, as the settings name it: `http://127.0.0.1:<port><basePath>`. */
  readonly baseUrl: string;
  readonly seen: CompatSeen[];
  close(): Promise<void>;
}

/**
 * A plain-HTTP OpenAI-compatible endpoint on loopback: `GET <basePath>/models`
 * lists `models`, and `POST <basePath>/chat/completions` streams `reply` as
 * one chunk. `basePath` is `/v1` unless named. Every request is recorded with
 * the authorization it carried.
 */
export async function startFakeCompatEndpoint(
  models: string[],
  reply: string,
  { basePath = "/v1" }: { basePath?: string } = {},
): Promise<FakeCompatEndpoint> {
  const seen: CompatSeen[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
      });
      if (req.method === "GET" && req.url === `${basePath}/models`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: models.map((id) => ({ id, object: "model" })),
          }),
        );
        return;
      }
      if (req.method !== "POST" || req.url !== `${basePath}/chat/completions`) {
        res.writeHead(404).end();
        return;
      }
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          created: 0,
          model: "fake",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        chunk({ role: "assistant", content: reply }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as net.AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}${basePath}`,
    seen,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface EgressAttempt {
  /** The diagnostics channel that saw it. */
  via: string;
  /** `host:port`, the port spelled out. */
  target: string;
}

export interface EgressObserver {
  /** Every connection or request attempt seen, in order. */
  readonly attempts: EgressAttempt[];
  /** The attempts whose target is not `allowed`. */
  unauthorized(): EgressAttempt[];
  /** Permits one more `host:port`. */
  allow(target: string): void;
  close(): void;
}

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "ws:": "80",
  "wss:": "443",
};

/** A loopback `node:http` request whose port the observer cannot see. */
const LOOPBACK_UNKNOWN_PORT = "127.0.0.1:?";

function targetOf(host: string, port: string, protocol: string): string {
  return `${host}:${port || DEFAULT_PORTS[protocol] || "?"}`;
}

function originTarget(origin: unknown, protocol?: unknown): string {
  try {
    const url = new URL(
      typeof protocol === "string"
        ? `${protocol}//${String(origin)}`
        : String(origin),
    );
    return targetOf(url.hostname, url.port, url.protocol);
  } catch {
    return `unparsed:${String(origin)}`;
  }
}

/**
 * Observes every outgoing attempt this process makes, before it connects:
 * undici's request creation and its pre-connect (so `fetch`, which pi uses),
 * and `node:http`'s client requests. A socket's own channel is not used: it
 * names no destination. Anything not `allowed` is unauthorized, except a
 * loopback `node:http` request whose port is unknown.
 */
export function startEgressObserver(allowed: Iterable<string>): EgressObserver {
  const permitted = new Set(allowed);
  const attempts: EgressAttempt[] = [];
  const channels: Record<string, (message: unknown) => void> = {
    "undici:request:create": (message) => {
      const { request } = message as { request?: { origin?: unknown } };
      attempts.push({
        via: "undici:request:create",
        target: originTarget(request?.origin),
      });
    },
    "undici:client:beforeConnect": (message) => {
      const { connectParams } = message as {
        connectParams?: { hostname?: string; port?: string; protocol?: string };
      };
      attempts.push({
        via: "undici:client:beforeConnect",
        target: targetOf(
          connectParams?.hostname ?? "?",
          connectParams?.port ?? "",
          connectParams?.protocol ?? "",
        ),
      });
    },
    "http.client.request.start": (message) => {
      const { request } = message as {
        request?: http.ClientRequest & { protocol?: string };
      };
      // The host it connects to; the port only when the Host header names
      // that host. The gateway's own upstream request connects to loopback
      // under its logical host's name, so its port is unknown here.
      const host = request?.host ?? "?";
      const header = String(request?.getHeader("host") ?? "");
      const port =
        header === host
          ? ""
          : header.startsWith(`${host}:`)
            ? header.slice(host.length + 1)
            : "?";
      attempts.push({
        via: "http.client.request.start",
        target: targetOf(host, port, request?.protocol ?? "http:"),
      });
    },
  };
  for (const [name, listener] of Object.entries(channels))
    diagnostics.subscribe(name, listener);
  return {
    attempts,
    unauthorized: () =>
      attempts.filter(
        (a) => !permitted.has(a.target) && a.target !== LOOPBACK_UNKNOWN_PORT,
      ),
    allow: (target) => permitted.add(target),
    close() {
      for (const [name, listener] of Object.entries(channels))
        diagnostics.unsubscribe(name, listener);
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

/** A request a {@link startPassThrough} forwarded, as the server sent it. */
interface PassedThrough {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface PassThrough {
  /** Its URL: what the server is told the gateway's listener is. */
  readonly url: string;
  readonly seen: PassedThrough[];
  close(): Promise<void>;
}

/**
 * A loopback pass-through in front of `target` (the gateway's listener) that
 * records every request the server sends it, headers and body, and forwards
 * it unchanged: what left the server toward the gateway.
 */
export async function startPassThrough(target: string): Promise<PassThrough> {
  const seen: PassedThrough[] = [];
  const to = new URL(target);
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: body.toString("utf8"),
      });
      const forwarded = http.request(
        {
          host: to.hostname,
          port: to.port,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, host: to.host },
          agent: false,
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      forwarded.on("error", () => res.destroy());
      forwarded.end(body);
    });
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
