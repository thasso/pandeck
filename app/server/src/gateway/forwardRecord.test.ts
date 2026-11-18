/**
 * The forwarder's record of a request whose end races its client (Task-1430
 * F002, F003): the forwarder alone, with a credential wait the test settles
 * and a listener answer the test writes, over real sockets.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { createCompatUpstream } from "./compatUpstream.ts";
import {
  createForwarder,
  type AdmittedClient,
  type GatewayStats,
  type MachineAccess,
} from "./forward.ts";
import { LeaseTable, type LoginBinding } from "./leases.ts";
import { createRequestLog, type RequestEntry } from "./requestLog.ts";
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
  /** Calls to either pool selection path. */
  selections: () => number;
  /** Connections the upstream address received. */
  upstreamConnections: () => number;
  /** Fresh selections made and released, and the order of both. */
  fresh: { acquired: number; released: number; events: string[] };
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
    machinePaths?: "permissive" | "strict";
    /** Settle an unexpected credential read instead of leaving it pending. */
    credential?: VaultCredential;
    /** Raw CONNECT target for defensive display tests, if a runtime admits it. */
    connectTarget?: string;
    /** Whether a selection holds after the credential wait (default true). */
    current?: () => boolean;
    /** The method the forwarder sees, as a runtime admitting it would pass. */
    method?: string;
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
  const fresh = { acquired: 0, released: 0, events: [] as string[] };
  let selections = 0;
  const machine: MachineAccess = {
    pool: {
      select: (userId) => {
        selections += 1;
        return {
          ok: true,
          selection: {
            userId,
            pin: { clientId: "c1", provider: "claude", keyHash: null },
            binding: BINDING,
            leaseId: "machine-lease",
            kind: "pinned",
          },
        };
      },
      selectFresh: (userId) => {
        selections += 1;
        const n = (fresh.acquired += 1);
        fresh.events.push(`acquire ${n}`);
        let held = true;
        return {
          ok: true,
          selection: {
            userId,
            pin: { clientId: "c1", provider: "claude", keyHash: null },
            binding: BINDING,
            leaseId: "machine-lease",
            kind: "fresh",
          },
          release: () => {
            if (!held) return;
            held = false;
            fresh.released += 1;
            fresh.events.push(`release ${n} after ${entries.length} records`);
          },
        };
      },
      isCurrent: options.current ?? (() => true),
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
      "api.anthropic.com": {
        connect: { host: "127.0.0.1", port: upstreamPort },
      },
    },
    compat: createCompatUpstream(),
    compatCa: undefined,
    stats,
    vault: {
      credentialFor: () =>
        new Promise((resolve, reject) => {
          waits.push({ resolve, reject });
          if (options.credential) resolve(options.credential);
        }),
      upstream401: () => {},
    },
    clientOf: () => "c1",
    machine: options.machine ? machine : undefined,
    machinePaths: options.machinePaths,
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
    if (options.method) req.method = options.method;
    if (!local) return forwarder.handleRequest(req, res, ADMITTED);
    const answer = forwarder.observeLocal(req, res, ADMITTED);
    local(req, res, (reason) => answer.refuse(reason));
  });
  server.on("connect", (req, socket, head) => {
    if (options.connectTarget) req.url = options.connectTarget;
    forwarder.refuseConnect(req, socket, head, ADMITTED, {
      case: "denied",
      id: "method",
    });
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
    selections: () => selections,
    fresh,
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

test.each([
  ["/anthropic-mcp", "mcp-proxy.anthropic.com", "", 401],
  ["/anthropic-mcp?q=SENTINEL", "mcp-proxy.anthropic.com", "", 401],
  ["/anthropic-mcp/", "mcp-proxy.anthropic.com", "/", 401],
  [
    "/anthropic-mcp/v1/messages?q=SENTINEL",
    "mcp-proxy.anthropic.com",
    "/v1/messages",
    401,
  ],
  [
    "/anthropic-mcpX/v1/messages?q=SENTINEL",
    "",
    "/anthropic-mcpX/v1/messages",
    404,
  ],
  [
    "/anthropic-mcp.evil/v1/messages",
    "",
    "/anthropic-mcp.evil/v1/messages",
    404,
  ],
  ["/ANTHROPIC-MCP/v1/messages", "", "/ANTHROPIC-MCP/v1/messages", 404],
  [
    "/anthropic/v1/messages?q=SENTINEL",
    "api.anthropic.com",
    "/v1/messages",
    401,
  ],
])(
  "F009: fixed-prefix metadata for %s never bypasses lease admission or trusts Host",
  async (target, host, path, status) => {
    const r = await rig();
    const request = start(r.port, target, { host: "spoof-SENTINEL.example" });
    await new Promise<void>((resolve) =>
      request.on("response", (res) => {
        assert.equal(res.statusCode, status);
        res.resume();
        res.on("end", resolve);
      }),
    );
    await vi.waitFor(() => assert.equal(r.entries.length, 1));
    const entry = r.entries[0]!;
    assert.deepEqual(
      [
        entry.host,
        entry.path,
        entry.status,
        entry.outcome,
        entry.reason,
        entry.account,
      ],
      [
        host,
        path,
        status,
        "refused",
        status === 404 ? "unknown-prefix" : "unknown-lease",
        undefined,
      ],
    );
    assert.equal(r.waits.length, 0);
    assert.equal(r.upstreamConnections(), 0);
    assert.equal(r.lines.length, 1);
    assert.ok(!JSON.stringify(r.entries).includes("SENTINEL"));
    assert.ok(!r.lines.join("\n").includes("SENTINEL"));
  },
);

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

for (const status of [200, 204, 304])
  for (const method of ["GET", "HEAD"])
    test(`F005 local ${method} ${status} counts only emitted body bytes`, async () => {
      const r = await rig({
        local: (_req, res) => {
          res.writeHead(status);
          res.write("ans");
          res.end("wer");
        },
      });
      let bytes = 0;
      await new Promise<void>((resolve, reject) => {
        const request = http.request(
          {
            host: "127.0.0.1",
            port: r.port,
            path: "/local",
            method,
            agent: false,
          },
          (response) => {
            assert.equal(response.statusCode, status);
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
            });
            response.on("end", resolve);
            response.on("error", reject);
          },
        );
        request.on("error", reject);
        request.end();
      });
      await vi.waitFor(() => assert.equal(r.entries.length, 1));
      assert.equal(
        bytes,
        method === "HEAD" || status === 204 || status === 304 ? 0 : 6,
      );
      assert.equal(r.entries[0]!.responseBytes, bytes);
      assert.equal(r.lines.length, 1);
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

// --- Task-1430 PR3: the token routes' machine path ------------------------

/** Sends a body-less request and resolves with its status. */
function ask(
  port: number,
  method: string,
  path: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path, method, agent: false, headers },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

const C8_ROOTS: readonly [string, string][] = [
  ["v1-oauth", "/v1/oauth"],
  ["oauth-token", "/api/oauth/token"],
  ["oauth-authorize", "/api/oauth/authorize"],
  ["oauth-revoke", "/api/oauth/revoke"],
  ["cli-create-api-key", "/api/oauth/claude_cli/create_api_key"],
  ["v1-org-api-keys", "/v1/organizations/api_keys"],
  ["v1-org-x-api-keys", "/v1/organizations/o1/api_keys"],
  ["org-x-api-keys", "/api/organizations/o1/api_keys"],
  ["v1-org-invites", "/v1/organizations/invites"],
  ["v1-org-users", "/v1/organizations/users"],
  ["v1-org-x-invites", "/v1/organizations/o1/invites"],
  ["v1-org-x-users", "/v1/organizations/o1/users"],
  ["org-x-invites", "/api/organizations/o1/invites"],
  ["org-x-members", "/api/organizations/o1/members"],
  ["api-auth", "/api/auth"],
];

test("the floors refuse a token-route machine request marked and recorded, with no selection or upstream", async () => {
  const r = await rig({ machine: true });
  const cases: [string, string, string][] = [
    ...C8_ROOTS.map(([id, root]): [string, string, string] => [
      "POST",
      `/anthropic${root}?q=SENTINEL`,
      `denied:${id}`,
    ]),
    ["POST", "/anthropic-mcp/api/oauth/token", "denied:oauth-token"],
    [
      "GET",
      "/anthropic-mcp/v1/organizations/o1/users",
      "denied:v1-org-x-users",
    ],
    ["TRACE", "/anthropic/v1/messages", "denied:method"],
    ["TRACE", "/anthropic-mcp/v1/mcp/x", "denied:method"],
    ["GET", "/anthropic/api/x/", "non-canonical-path"],
    ["GET", "/anthropic-mcp/v1/%6dcp/x", "non-canonical-path"],
  ];
  for (const [method, path, reason] of cases) {
    const before = r.entries.length;
    assert.equal(await ask(r.port, method, path), 403, path);
    await vi.waitFor(() => assert.equal(r.entries.length, before + 1));
    const entry = r.entries.at(-1)!;
    const pathname = path.slice(path.indexOf("/", 1)).split("?")[0]!;
    assert.deepEqual(
      [entry.outcome, entry.reason, entry.listed, entry.pathKey, entry.path],
      ["refused", reason, false, pathname, pathname],
      path,
    );
    assert.equal(
      entry.host,
      path.startsWith("/anthropic-mcp")
        ? "mcp-proxy.anthropic.com"
        : "api.anthropic.com",
    );
  }
  const text = r.lines.join("\n");
  assert.equal(
    r.lines.filter((l) => l.includes(" via=gateway")).length,
    cases.length,
  );
  assert.ok(!text.includes("SENTINEL"));
  assert.ok(!JSON.stringify(r.entries).includes("SENTINEL"));
  assert.match(text, / refused denied:method 403 /);
  assert.equal(r.fresh.acquired, 0);
  assert.equal(r.waits.length, 0);
  assert.equal(r.upstreamConnections(), 0);
});

for (const mode of ["permissive", "strict"] as const)
  test(`F001: every floor's raw # and ; suffix is refused and recorded before selection (${mode})`, async () => {
    const r = await rig({
      machine: true,
      machinePaths: mode,
      credential: {
        ok: false,
        refusal: { case: "credential", problem: "missing" },
      },
    });
    for (const [, root] of C8_ROOTS)
      for (const prefix of ["/anthropic", "/anthropic-mcp"])
        for (const suffix of ["#FRAGMENT_SENTINEL@evil", ";parameter=1"]) {
          const before = r.entries.length;
          const target = `${prefix}${root}${suffix}`;
          assert.equal(await ask(r.port, "POST", target), 403, target);
          assert.equal(r.entries.length, before + 1, target);
          const entry = r.entries.at(-1)!;
          const shown = suffix.startsWith("#") ? root : `${root}${suffix}`;
          assert.deepEqual(
            [
              entry.status,
              entry.reason,
              entry.outcome,
              entry.listed,
              entry.path,
              entry.pathKey,
            ],
            [403, "non-canonical-path", "refused", false, shown, shown],
            target,
          );
          assert.equal(r.lines.length, before + 1, "one line per refusal");
          assert.equal(r.selections(), 0, target);
          assert.equal(r.waits.length, 0, target);
          assert.equal(r.upstreamConnections(), 0, target);
        }
    assert.ok(
      !JSON.stringify([r.entries, r.lines]).includes("FRAGMENT_SENTINEL"),
    );
  });

test("F001: CONNECT authority display cuts fragments before userinfo if admitted by a runtime", async () => {
  // Node rejects # in CONNECT authority form at its parser. Exercise the
  // forwarder's defensive display path with an admitted target explicitly.
  for (const target of [
    "user:pw@api.anthropic.com:443#FRAGMENT_SENTINEL@evil",
    "api.anthropic.com:443#FRAGMENT_SENTINEL@evil?q=SENTINEL",
    "user:pw@api.anthropic.com:443?q=SENTINEL#FRAGMENT_SENTINEL@evil",
  ]) {
    const r = await rig({ machine: true, connectTarget: target });
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(r.port, "127.0.0.1");
      const chunks: Buffer[] = [];
      socket.on("connect", () =>
        socket.write(
          "CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n",
        ),
      );
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      socket.on("error", reject);
    });
    assert.match(reply, /^HTTP\/1\.1 403 /);
    assert.equal(r.entries.length, 1);
    assert.equal(r.lines.length, 1);
    assert.equal(r.entries[0]!.path, "api.anthropic.com:443");
    assert.ok(!("listed" in r.entries[0]!));
    assert.ok(
      !/user:pw|pw@|SENTINEL|evil/.test(JSON.stringify([r.entries, r.lines])),
    );
    assert.equal(r.selections(), 0);
    assert.equal(r.waits.length, 0);
    assert.equal(r.upstreamConnections(), 0);
  }
});

test("F001: local admission refusals classify the raw route but never display its fragment", async () => {
  const r = await rig({
    machine: true,
    local: (_req, res, refuse) => {
      refuse("forbidden");
      res.writeHead(403).end("no");
    },
  });
  assert.equal(
    await ask(
      r.port,
      "GET",
      "/anthropic/api/oauth/usage#FRAGMENT_SENTINEL@evil",
    ),
    403,
  );
  assert.equal(r.entries.length, 1);
  const entry = r.entries[0]!;
  assert.deepEqual(
    [entry.host, entry.path, entry.pathKey, entry.listed],
    ["", "/anthropic/api/oauth/usage", "/api/oauth/usage", false],
  );
  assert.ok(!JSON.stringify([r.entries, r.lines]).includes("SENTINEL"));
  assert.equal(r.selections(), 0);
  assert.equal(r.waits.length, 0);
  assert.equal(r.upstreamConnections(), 0);
});

test("F001: fragment display cuts cover origin, unknown and lease paths, fallback keys and persisted identities", async () => {
  const r = await rig({ machine: true });
  const lease = r.leases.grant(BINDING, {
    kind: "engine",
    owner: { workerId: "w1", clientId: "c1" },
  });
  for (const [path, headers, expected] of [
    [
      "/anthropic/api/oauth/usage#FRAGMENT_SENTINEL@evil",
      { origin: "https://evil.example" },
      "/api/oauth/usage",
    ],
    ["/unknown#FRAGMENT_SENTINEL?query=SENTINEL", {}, "/unknown"],
    [
      "/anthropic/x@y#FRAGMENT_SENTINEL",
      { authorization: `Bearer ${lease.token}` },
      "/x@y",
    ],
    [
      "/anthropic/x@y?query=SENTINEL#FRAGMENT_SENTINEL",
      { authorization: `Bearer ${lease.token}` },
      "/x@y",
    ],
  ] as const) {
    await ask(r.port, "GET", path, headers);
    assert.equal(r.entries.at(-1)!.path, expected);
  }
  assert.equal(
    r.entries[0]!.listed,
    false,
    "classify the raw fragment-bearing path, not its listed display",
  );
  assert.ok(
    !("pathKey" in r.entries[2]!),
    "lease path uses the projection's fallback",
  );
  const dir = mkdtempSync(join(tmpdir(), "gateway-fragment-"));
  open.push(() => rmSync(dir, { recursive: true, force: true }));
  const projectedLines: string[] = [];
  const log = createRequestLog({
    stateDir: dir,
    log: (line) => projectedLines.push(line),
  });
  const projected = r.entries.map((entry) => log.record(entry));
  assert.equal(projected[2]!.pathKey, "/x@y");
  assert.equal(
    projected[3]!.firstSeen,
    false,
    "suffixes never become new identities",
  );
  assert.ok(
    !JSON.stringify([r.entries, r.lines, projected, projectedLines]).includes(
      "SENTINEL",
    ),
  );
  assert.ok(
    !readFileSync(join(dir, "seenRequests.json"), "utf8").includes("SENTINEL"),
  );
  assert.equal(r.selections(), 0);
  assert.equal(r.waits.length, 0);
  assert.equal(r.upstreamConnections(), 0);
});

test("TRACK, if a runtime admitted it, is refused by the forwarder's floor and recorded", async () => {
  const r = await rig({ machine: true, method: "TRACK" });
  for (const path of ["/anthropic/v1/messages", "/anthropic-mcp/v1/mcp/x"]) {
    const before = r.entries.length;
    assert.equal(await ask(r.port, "GET", path), 403);
    await vi.waitFor(() => assert.equal(r.entries.length, before + 1));
    const entry = r.entries.at(-1)!;
    assert.deepEqual(
      [entry.method, entry.reason, entry.listed],
      ["TRACK", "denied:method", false],
    );
  }
  assert.equal(r.upstreamConnections(), 0);
  assert.equal(r.waits.length, 0);
});

test("strict mode refuses an unlisted path forbidden, unlisted; a listed one passes to selection", async () => {
  const r = await rig({ machine: true, machinePaths: "strict" });
  assert.equal(await ask(r.port, "GET", "/anthropic/api/new_thing"), 403);
  assert.equal(await ask(r.port, "PUT", "/anthropic-mcp/x"), 403);
  await vi.waitFor(() => assert.equal(r.entries.length, 2));
  for (const entry of r.entries)
    assert.deepEqual([entry.reason, entry.listed], ["forbidden", false]);
  assert.equal(r.fresh.acquired, 0);
  const listed = start(r.port, "/anthropic/api/oauth/validate");
  await vi.waitFor(() => assert.equal(r.waits.length, 1));
  assert.equal(r.fresh.acquired, 1);
  listed.destroy();
  await vi.waitFor(() => assert.equal(r.entries.length, 3));
  assert.equal(r.entries[2]!.listed, true);
  assert.equal(r.upstreamConnections(), 0);
});

test("an origin refusal is marked at admission; a lease-shaped request never is", async () => {
  const r = await rig({ machine: true });
  for (const [method, path, listed, pathKey] of [
    ["GET", "/anthropic/api/oauth/usage", true, "/api/oauth/usage"],
    ["GET", "/anthropic/api/new_thing", false, "/api/new_thing"],
    ["POST", "/anthropic-mcp/v1/mcp/linear", true, "/v1/mcp/:slug"],
    ["POST", "/anthropic-mcp/x", false, "/x"],
  ] as const) {
    const before = r.entries.length;
    assert.equal(
      await ask(r.port, method, path, { origin: "https://evil.example" }),
      403,
    );
    await vi.waitFor(() => assert.equal(r.entries.length, before + 1));
    const entry = r.entries.at(-1)!;
    assert.deepEqual(
      [entry.reason, entry.listed, entry.pathKey],
      ["machine-origin", listed, pathKey],
    );
  }
  // `/chatgpt` is no token route: its machine records carry no marking.
  assert.equal(
    await ask(r.port, "GET", "/chatgpt/x", { origin: "https://e.example" }),
    403,
  );
  await vi.waitFor(() => assert.equal(r.entries.length, 5));
  assert.ok(!("listed" in r.entries[4]!));
  const lease = r.leases.grant(BINDING, {
    kind: "engine",
    owner: { workerId: "w1", clientId: "c1" },
  });
  for (const path of [
    "/anthropic/api/claude_code/settings",
    "/anthropic-mcp/v1/mcp/x",
  ]) {
    const before = r.entries.length;
    assert.equal(
      await ask(r.port, "GET", path, {
        authorization: `Bearer ${lease.token}`,
      }),
      403,
    );
    await vi.waitFor(() => assert.equal(r.entries.length, before + 1));
    const entry = r.entries.at(-1)!;
    assert.equal(entry.reason, "forbidden");
    assert.ok(!("listed" in entry) && !("pathKey" in entry), path);
  }
  assert.equal(r.upstreamConnections(), 0);
});

/** A fresh request's credential wait, settled by `settleWait`. */
const releaseCases: [
  string,
  (r: Rig, request: http.ClientRequest) => void,
  string,
][] = [
  [
    "a credential refusal",
    (r) =>
      r.waits[0]!.resolve({
        ok: false,
        refusal: { case: "credential", problem: "missing" },
      }),
    "credential",
  ],
  [
    "a locked vault",
    (r) => r.waits[0]!.resolve({ ok: false, locked: true }),
    "vault-locked",
  ],
  [
    "a client abort during the wait",
    (_r, request) => request.destroy(),
    "client-closed",
  ],
  [
    "an upstream error",
    (r) => r.waits[0]!.resolve({ ok: true, headers: LATE_HEADERS, token: "" }),
    "ECONNRESET",
  ],
  [
    "an internal error after acquisition",
    (r) => r.waits[0]!.reject(new Error("vault gone")),
    "internal-error",
  ],
];

for (const [name, settleWait, reason] of releaseCases)
  test(`a fresh hold is released once, after the record: ${name}`, async () => {
    const r = await rig({ machine: true });
    const request = start(r.port, "/anthropic/api/oauth/validate");
    await vi.waitFor(() => assert.equal(r.waits.length, 1));
    assert.deepEqual(r.fresh.events, ["acquire 1"]);
    settleWait(r, request);
    await vi.waitFor(() => assert.equal(r.entries.length, 1));
    await settle();
    const [entry] = r.entries;
    assert.equal(entry!.listed, true);
    if (reason === "ECONNRESET")
      assert.ok(
        entry!.reason === "ECONNRESET" ||
          entry!.reason === "unreachable" ||
          entry!.reason === "EPIPE",
        entry!.reason,
      );
    else assert.equal(entry!.reason, reason);
    assert.deepEqual(r.fresh.events, [
      "acquire 1",
      "release 1 after 1 records",
    ]);
  });

test("a re-selection holds the new lease before it releases the old; machine-retry releases the last", async () => {
  const r = await rig({ machine: true, current: () => false });
  const request = start(r.port, "/anthropic-mcp/v1/mcp/linear");
  await vi.waitFor(() => assert.equal(r.waits.length, 1));
  r.waits[0]!.resolve({ ok: true, headers: LATE_HEADERS, token: "" });
  await vi.waitFor(() => assert.equal(r.waits.length, 2));
  assert.deepEqual(r.fresh.events, [
    "acquire 1",
    "acquire 2",
    "release 1 after 0 records",
  ]);
  r.waits[1]!.resolve({ ok: true, headers: LATE_HEADERS, token: "" });
  await vi.waitFor(() => assert.equal(r.entries.length, 1));
  assert.equal(r.entries[0]!.reason, "machine-retry");
  assert.deepEqual(r.fresh.events.at(-1), "release 2 after 1 records");
  assert.equal(r.fresh.released, 2);
  assert.equal(r.waits.length, 2, "no third read");
  request.destroy();
});

test("a model run or a session key is pinned, never fresh", async () => {
  const r = await rig({ machine: true });
  const run = start(r.port, "/anthropic/v1/messages");
  const keyed = start(r.port, "/anthropic/api/oauth/usage", {
    "x-claude-code-session-id": "s1",
  });
  await vi.waitFor(() => assert.equal(r.waits.length, 2));
  assert.equal(r.fresh.acquired, 0);
  // `count_tokens` and MCP are no model runs: fresh.
  const count = start(r.port, "/anthropic/v1/messages/count_tokens");
  const mcp = start(r.port, "/anthropic-mcp/v1/messages");
  await vi.waitFor(() => assert.equal(r.waits.length, 4));
  assert.equal(r.fresh.acquired, 2);
  for (const request of [run, keyed, count, mcp]) request.destroy();
  await vi.waitFor(() => assert.equal(r.entries.length, 4));
  assert.equal(r.fresh.released, 2);
});
