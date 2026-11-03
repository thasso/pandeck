/**
 * Fixtures for the credential gateway's control and state tests: fake TLS
 * upstreams for `api.anthropic.com` and `chatgpt.com`, token files under the
 * test's temp `DATA_DIR`, a control dialer on an in-process pair, and a model
 * request. Every value is fake. It imports nothing from `gateway/`, whose only
 * importer outside itself is pinned (`workerBoundary.test.ts`).
 */
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
} from "../workerProtocol/connection.ts";
import type { ByteEndpoint } from "../workerProtocol/inProcessTransport.ts";

// Synthetic fixture values; none is a real credential.
export const CLAUDE_ACCESS = "fake-claude-access";
export const CODEX_ACCESS = "fake-codex-access";
export const CODEX_ACCOUNT = "acct-test";

export const CLAUDE_PATH = "/anthropic/v1/messages";
export const CODEX_PATH = "/chatgpt/backend-api/codex/responses";

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
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

export async function startFakeUpstreams(): Promise<FakeUpstreams> {
  const ca = await loadOrCreateCa();
  const servers: https.Server[] = [];
  const start = async (host: string, seen: Seen[]) => {
    const leaf = issueLeafCertificate(ca, host);
    const server = https.createServer(
      { key: leaf.keyPem, cert: leaf.certPem },
      (req, res) => {
        req.resume();
        req.on("end", () => {
          seen.push({ url: req.url ?? "", headers: req.headers });
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"ok":true}');
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
    claude: await start("api.anthropic.com", anthropic),
    "openai-codex": await start("chatgpt.com", chatgpt),
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
 * dials the other with `protocol` (the worker protocol when absent). The test
 * makes the pair: only the isolation boundary makes one outside tests.
 */
export function dialControl(
  [server, gateway]: [ByteEndpoint, ByteEndpoint],
  attach: (endpoint: ByteEndpoint) => void,
  protocol?: ConnectionProtocol,
): WorkerConnection {
  attach(gateway);
  return new WorkerConnection(server, {
    handshake: { role: "worker", workerId: "pandeck-server" },
    ...(protocol ? { protocol } : {}),
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
