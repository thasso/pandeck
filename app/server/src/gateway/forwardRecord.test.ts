/**
 * The forwarder's record of a request whose end races its client (Task-1430
 * F002, F003): the forwarder alone, with a credential wait the test settles
 * and a listener answer the test writes, over real sockets.
 */
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, test, vi } from "vitest";
import { createCompatUpstream } from "./compatUpstream.ts";
import {
  createForwarder,
  type AdmittedClient,
  type GatewayStats,
  type MachineAccess,
} from "./forward.ts";
import { LeaseTable, type LoginBinding } from "./leases.ts";
import type { RequestEntry } from "./requestLog.ts";
import type { VaultCredential } from "./vaultPort.ts";

const ADMITTED: AdmittedClient = { id: "c1", label: "devbox", userId: "u1" };
const BINDING: LoginBinding = {
  profileId: "a",
  provider: "claude",
  tokenFile: "/nonexistent/token.json",
};

const open: (() => unknown)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

interface Rig {
  port: number;
  leases: LeaseTable;
  stats: GatewayStats;
  entries: RequestEntry[];
  lines: string[];
  /** Credential reads still waiting, oldest first. */
  waits: {
    resolve: (credential: VaultCredential) => void;
    reject: (err: unknown) => void;
  }[];
  /** Connections the upstream address received. */
  upstreamConnections: () => number;
}

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as net.AddressInfo).port;
}

/**
 * A forwarder on a plain listener whose every request is `ADMITTED`'s, its
 * Claude upstream a socket that only counts connections. `local` answers a
 * request itself through `observeLocal` instead.
 */
async function rig(
  options: {
    machine?: boolean;
    local?: (
      req: http.IncomingMessage,
      res: http.ServerResponse,
      refuse: (reason: string) => void,
    ) => void;
  } = {},
): Promise<Rig> {
  let connections = 0;
  const upstream = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  const upstreamPort = await listen(upstream);
  const leases = new LeaseTable();
  const stats: GatewayStats = {
    forwarded: 0,
    refused: 0,
    clientClosed: 0,
    upstreamErrors: 0,
  };
  const entries: RequestEntry[] = [];
  const lines: string[] = [];
  const waits: Rig["waits"] = [];
  const agent = new https.Agent();
  const httpAgent = new http.Agent();
  open.push(() => agent.destroy());
  open.push(() => httpAgent.destroy());
  const machine: MachineAccess = {
    pool: {
      select: (userId) => ({
        ok: true,
        selection: {
          userId,
          pin: { clientId: "c1", provider: "claude", keyHash: null },
          binding: BINDING,
          leaseId: "machine-lease",
        },
      }),
      isCurrent: () => true,
      observe: () => {},
    },
    userOf: () => "u1",
  };
  const forwarder = createForwarder({
    leases,
    log: (line) => lines.push(line),
    agent,
    httpAgent,
    upstreams: {
      claude: { connect: { host: "127.0.0.1", port: upstreamPort } },
    },
    compat: createCompatUpstream(),
    compatCa: undefined,
    stats,
    vault: {
      credentialFor: () =>
        new Promise((resolve, reject) => waits.push({ resolve, reject })),
      upstream401: () => {},
    },
    clientOf: () => "c1",
    machine: options.machine ? machine : undefined,
    requests: {
      log: {
        record(entry, text) {
          entries.push(entry);
          if (text !== undefined) lines.push(text);
          return { ...entry, seq: entries.length, firstSeen: false } as never;
        },
      },
      accountName: (profileId) => `Account ${profileId}`,
    },
  });
  const { local } = options;
  const server = http.createServer((req, res) => {
    if (!local) return forwarder.handleRequest(req, res, ADMITTED);
    const answer = forwarder.observeLocal(req, res, ADMITTED);
    local(req, res, (reason) => answer.refuse(reason));
  });
  const port = await listen(server);
  open.push(() => server.closeAllConnections());
  return {
    port,
    leases,
    stats,
    entries,
    lines,
    waits,
    upstreamConnections: () => connections,
  };
}

/** Starts a request and returns it, its errors swallowed. */
function start(
  port: number,
  path: string,
  headers: http.OutgoingHttpHeaders = {},
  body = '{"model":"fixture"}',
): http.ClientRequest {
  const request = http.request({
    host: "127.0.0.1",
    port,
    path,
    method: "POST",
    agent: false,
    headers: { "content-type": "application/json", ...headers },
  });
  request.on("error", () => {});
  request.end(body);
  return request;
}

/** A late credential's headers: never sent, so any fixed field will do. */
const LATE_HEADERS = { "x-fixture": "late" };

/** Lets every settled promise and timer of this turn run. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 50));

const lateResults: [
  string,
  (wait: Rig["waits"][number]) => void,
  { revoke?: boolean },
][] = [
  [
    "a credential",
    (wait) =>
      wait.resolve({
        ok: true,
        headers: LATE_HEADERS,
        token: "",
      }),
    {},
  ],
  ["a locked vault", (wait) => wait.resolve({ ok: false, locked: true }), {}],
  [
    "a needs-login refusal",
    (wait) =>
      wait.resolve({
        ok: false,
        refusal: { case: "needs-login", provider: "Claude" } as never,
      }),
    {},
  ],
  ["a rejection", (wait) => wait.reject(new Error("vault gone")), {}],
  [
    "a revoked lease, then a credential",
    (wait) =>
      wait.resolve({
        ok: true,
        headers: LATE_HEADERS,
        token: "",
      }),
    { revoke: true },
  ],
];

for (const path of ["lease", "machine"] as const)
  for (const [name, late, { revoke }] of lateResults) {
    if (revoke && path === "machine") continue;
    test(`${path}: a client gone during the credential wait is recorded at once; ${name} afterwards changes nothing`, async () => {
      const r = await rig({ machine: path === "machine" });
      const lease =
        path === "lease"
          ? r.leases.grant(BINDING, {
              kind: "engine",
              owner: { workerId: "w1", clientId: "c1" },
            })
          : undefined;
      const request = start(
        r.port,
        "/anthropic/v1/messages",
        lease ? { authorization: `Bearer ${lease.token}` } : {},
      );
      await vi.waitFor(() => assert.equal(r.waits.length, 1));
      request.destroy();
      // Recorded before the wait settles.
      await vi.waitFor(() => assert.equal(r.entries.length, 1));
      const [entry] = r.entries;
      assert.deepEqual(
        [entry!.outcome, entry!.status, entry!.reason, entry!.account],
        ["failed", null, "client-closed", "Account a"],
      );
      if (revoke && lease) r.leases.revoke(lease.leaseId, "profile-removed");
      late(r.waits[0]!);
      await settle();
      assert.equal(r.entries.length, 1);
      assert.equal(r.lines.filter((l) => l.includes(" via=gateway")).length, 1);
      assert.match(r.lines[0]!, / client closed \d+ms outcome=failed /);
      assert.ok(!r.lines.some((l) => l.startsWith("internal error")));
      assert.equal(r.upstreamConnections(), 0);
      assert.equal(r.stats.refused, 0);
      assert.equal(r.stats.clientClosed, 1);
    });
  }

test("a local answer is classed by the status it sent in full", async () => {
  const statuses = [200, 202, 400, 401, 405, 413, 418, 500, 502, 504];
  const r = await rig({
    local: (req, res) => {
      const status = Number(req.url!.slice(1));
      req.resume();
      req.on("end", () => res.writeHead(status).end("answer"));
    },
  });
  for (const status of statuses) {
    const request = start(r.port, `/${status}`);
    await new Promise<void>((resolve) =>
      request.on("response", (response) => {
        response.resume();
        response.on("end", resolve);
      }),
    );
  }
  await vi.waitFor(() => assert.equal(r.entries.length, statuses.length));
  assert.deepEqual(
    r.entries.map((e) => [e.status, e.outcome, e.reason]),
    [
      [200, "forwarded", undefined],
      [202, "forwarded", undefined],
      [400, "refused", "bad-request"],
      [401, "refused", "client-error"],
      [405, "refused", "method-not-allowed"],
      [413, "refused", "too-large"],
      [418, "refused", "client-error"],
      [500, "failed", "internal-error"],
      [502, "failed", "server-error"],
      [504, "failed", "timeout"],
    ],
  );
  for (const entry of r.entries) {
    assert.equal(entry.requestBytes, Buffer.byteLength('{"model":"fixture"}'));
    assert.equal(entry.responseBytes, Buffer.byteLength("answer"));
  }
  await settle();
  assert.equal(r.entries.length, statuses.length);
  assert.equal(
    r.lines.filter((l) => l.includes(" via=gateway")).length,
    statuses.length,
  );
});

test("a local answer: a gate's refusal wins and counts no body", async () => {
  const r = await rig({
    local: (_req, res, refuse) => {
      refuse("mcp-token");
      res.writeHead(401).end("no");
    },
  });
  start(r.port, "/mcp").on("response", (response) => response.resume());
  await vi.waitFor(() => assert.equal(r.entries.length, 1));
  const [entry] = r.entries;
  assert.deepEqual(
    [entry!.status, entry!.outcome, entry!.reason, entry!.requestBytes],
    [401, "refused", "mcp-token", 0],
  );
});

test("a local answer the handler destroys is failed: null before headers, its status after", async () => {
  const r = await rig({
    local: (req, res) => {
      req.resume();
      if (req.url === "/before") return void res.destroy();
      res.writeHead(200);
      res.write("part");
      setTimeout(() => res.destroy(), 10);
    },
  });
  start(r.port, "/before");
  await vi.waitFor(() => assert.equal(r.entries.length, 1));
  start(r.port, "/after").on("response", (response) =>
    response.on("error", () => {}).resume(),
  );
  await vi.waitFor(() => assert.equal(r.entries.length, 2));
  assert.deepEqual(
    r.entries.map((e) => [e.status, e.outcome, e.reason, e.responseBytes]),
    [
      [null, "failed", "aborted", 0],
      [200, "failed", "aborted", 4],
    ],
  );
  assert.equal(r.lines.filter((l) => l.includes(" via=gateway")).length, 2);
});

for (const status of [200, 400, 405, 413, 500])
  test(`a local ${status} answer ended under backpressure is failed if the caller aborts before finish`, async () => {
    let answer: http.ServerResponse | undefined;
    let finished = false;
    const r = await rig({
      local: (_req, res) => {
        answer = res;
        res.once("finish", () => (finished = true));
        res.writeHead(status);
        res.end(Buffer.alloc(32 * 1024 * 1024, 0x61));
      },
    });
    const request = start(r.port, "/large");
    await new Promise<void>((resolve) =>
      request.on("response", (response) => {
        response.on("error", () => {});
        response.once("data", () => {
          response.pause();
          resolve();
        });
      }),
    );
    assert.equal(answer!.writableEnded, true);
    assert.equal(answer!.writableFinished, false);
    assert.equal(finished, false);
    request.destroy();
    await vi.waitFor(() => assert.equal(r.entries.length, 1));
    assert.deepEqual(
      [r.entries[0]!.status, r.entries[0]!.outcome, r.entries[0]!.reason],
      [status, "failed", "client-closed"],
    );
    await settle();
    assert.equal(finished, false);
    assert.equal(answer!.writableFinished, false);
    assert.equal(r.entries.length, 1);
    assert.equal(r.lines.filter((l) => l.includes(" via=gateway")).length, 1);
  });

test("a local answer whose client goes away is failed, client-closed, never a success", async () => {
  const r = await rig({
    local: (req, res) => {
      req.resume();
      if (req.url === "/streaming") {
        res.writeHead(200);
        res.write("part");
      }
    },
  });
  const quiet = start(r.port, "/quiet");
  await settle();
  quiet.destroy();
  await vi.waitFor(() => assert.equal(r.entries.length, 1));
  const streaming = start(r.port, "/streaming");
  await new Promise<void>((resolve) =>
    streaming.on("response", (response) => {
      response.on("error", () => {});
      response.once("data", () => resolve());
    }),
  );
  streaming.destroy();
  await vi.waitFor(() => assert.equal(r.entries.length, 2));
  assert.deepEqual(
    r.entries.map((e) => [e.status, e.outcome, e.reason]),
    [
      [null, "failed", "client-closed"],
      [200, "failed", "client-closed"],
    ],
  );
});
