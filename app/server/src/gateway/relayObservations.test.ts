import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import type net from "node:net";
import { afterEach, test, vi } from "vitest";
import { createRelayDedup } from "./relayDedup.ts";
import { createRelayObservations } from "./relayObservations.ts";
import type { RequestEntry } from "./requestLog.ts";
import { edgeTlsFor } from "./x509.ts";

const boot = "d".repeat(32);
const open: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (open.length) await open.pop()!();
});

async function rig(hosts: string[], certificateHosts = hosts) {
  const records: RequestEntry[] = [];
  const lines: string[] = [];
  const dedup = createRelayDedup({ log: (line) => lines.push(line) });
  open.push(() => dedup.close());
  const options = {
    hosts,
    certificate: edgeTlsFor(certificateHosts, undefined).serverCertPem,
    dedup,
    log: (line: string) => lines.push(line),
    requests: {
      record(entry: RequestEntry) {
        records.push(entry);
        return { ...entry, seq: records.length } as never;
      },
    },
  };
  const ingest = createRelayObservations(options);
  const server = http.createServer((req, res) =>
    ingest(req, res, { id: "c1", label: "devbox", userId: "u1" }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  open.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const port = (server.address() as net.AddressInfo).port;
  return {
    records,
    lines,
    async post(value: unknown) {
      return new Promise<number>((resolve, reject) => {
        const request = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/relay/observations",
            method: "POST",
            agent: false,
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode!));
            res.on("error", reject);
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify(value));
      });
    },
  };
}
function report(host: string, n: number) {
  return {
    d: n,
    rid: `${boot}:${n}`,
    at: 100,
    host,
    method: "GET",
    path: "/failure",
    status: 502,
    outcome: "failed",
    reason: "edge-unreachable",
    clientCredential: "none",
    clientCookie: false,
    requestBytes: 0,
    responseBytes: 0,
    durationMs: 1,
  };
}

test("F007 TLS-equivalent ownership is bounded, atomic and performs no DNS lookup", async () => {
  const r = await rig(["localhost", "127.0.0.1", "::1", "*.relay.localhost"]);
  const lookup = vi.spyOn(dns, "lookup").mockImplementation(() => {
    throw new Error("Ownership must not resolve names.");
  });
  for (const host of [
    "elsewhere.test",
    "127.0.0.2",
    "::2",
    "127.0.0.1.",
    "::1.",
    "[::1]",
    "fe80::1%lo",
    "evillocalhost",
    "a.relay.localhost.evil",
    "relay.localhost",
    "b.a.relay.localhost",
    "api.openai.com",
    "localhost..",
    "*.relay.localhost",
  ]) {
    assert.equal(
      await r.post({
        boot,
        records: [report("localhost", 1), report(host, 2)],
      }),
      400,
      host,
    );
    assert.equal(r.records.length, 0);
  }
  const accepted = [
    "LOCALHOST.",
    "127.0.0.1",
    "0:0:0:0:0:0:0:1",
    "a.relay.localhost",
    "B.ReLaY.LOCALHOST.",
  ];
  for (const [i, host] of accepted.entries()) {
    assert.equal(
      await r.post({ boot, records: [report(host, i + 1)] }),
      200,
      host,
    );
    assert.equal(r.records.at(-1)!.host, host.toLowerCase());
  }
  assert.equal(r.records.length, accepted.length);
  assert.equal(lookup.mock.calls.length, 0);
});

test("P7 report names are separate from configured edge certificate ownership", async () => {
  const r = await rig(["localhost"], ["elsewhere.test"]);
  const lookup = vi.spyOn(dns, "lookup").mockImplementation(() => {
    throw new Error("Report validation must not resolve names.");
  });
  const hosts = [
    "api.anthropic.com",
    "mcp-proxy.anthropic.com",
    "claude.ai",
    "downloads.claude.com",
  ];
  for (const host of [
    "localhost",
    "api.openai.com",
    "api.anthropic.com.evil",
    "API.ANTHROPIC.COM",
    "api.anthropic.com.",
  ]) {
    assert.equal(
      await r.post({ boot, records: [report(hosts[0]!, 1), report(host, 2)] }),
      400,
      host,
    );
    assert.equal(
      r.records.length,
      0,
      "neither P7 nor edge records commit from an invalid batch",
    );
  }
  assert.equal(
    await r.post({
      boot,
      records: hosts.map((host, i) => report(host, i + 1)),
    }),
    200,
  );
  assert.deepEqual(
    r.records.map((record) => record.host),
    hosts,
  );
  assert.equal(lookup.mock.calls.length, 0);
});

test.each([
  [
    "exact dotted SAN and config accept undotted report",
    ["localhost."],
    ["localhost."],
    "localhost",
    200,
  ],
  [
    "exact dotted SAN and config accept dotted report",
    ["localhost."],
    ["localhost."],
    "localhost.",
    200,
  ],
  [
    "dotted SAN accepts either case spelling",
    ["localhost"],
    ["localhost."],
    "LOCALHOST.",
    200,
  ],
  [
    "undotted SAN accepts dotted report",
    ["localhost"],
    ["localhost"],
    "LOCALHOST.",
    200,
  ],
  [
    "dotted wildcard SAN accepts child spellings",
    ["*.relay.localhost."],
    ["*.relay.localhost."],
    "A.RELAY.LOCALHOST.",
    200,
  ],
  [
    "dotted wildcard SAN accepts undotted child",
    ["*.relay.localhost"],
    ["*.relay.localhost."],
    "a.relay.localhost",
    200,
  ],
  [
    "undotted SAN and dotted config accept undotted report",
    ["localhost."],
    ["localhost"],
    "localhost",
    200,
  ],
  [
    "undotted wildcard SAN accepts dotted config and report",
    ["*.relay.localhost."],
    ["*.relay.localhost"],
    "A.RELAY.LOCALHOST.",
    200,
  ],
  [
    "exact config accepts dotted wildcard SAN",
    ["a.relay.localhost"],
    ["*.relay.localhost."],
    "a.relay.localhost",
    200,
  ],
  [
    "wildcard config accepts exact dotted child SAN",
    ["*.relay.localhost."],
    ["a.relay.localhost."],
    "a.relay.localhost",
    200,
  ],
  [
    "dotted wildcard accepts underscore label",
    ["*.relay.localhost."],
    ["*.relay.localhost."],
    "a_b.relay.localhost",
    200,
  ],
  [
    "dotted wildcard accepts hyphen label",
    ["*.relay.localhost."],
    ["*.relay.localhost."],
    "a-b.relay.localhost",
    200,
  ],
  ["canonical IPv6 remains accepted", ["::1"], ["::1"], "::1", 200],
  ["expanded IPv6 remains accepted", ["::1"], ["::1"], "0:0:0:0:0:0:0:1", 200],
  [
    "dotted SAN still requires certificate ownership",
    ["localhost"],
    ["elsewhere.test"],
    "localhost",
    400,
  ],
  [
    "dotted wildcard SAN does not own apex",
    ["*.relay.localhost."],
    ["*.relay.localhost."],
    "relay.localhost",
    400,
  ],
  [
    "dotted wildcard SAN does not own extra label",
    ["*.relay.localhost."],
    ["*.relay.localhost."],
    "b.a.relay.localhost",
    400,
  ],
  [
    "dotted SAN does not admit malformed multiple trailing dots",
    ["localhost.."],
    ["localhost.."],
    "localhost..",
    400,
  ],
  ["CN-only certificate is not ownership", ["localhost"], [], "localhost", 400],
  [
    "extra provider SAN is not configuration ownership",
    ["localhost"],
    ["localhost", "api.anthropic.com"],
    "api.anthropic.com",
    400,
  ],
  [
    "exact config does not own another wildcard child",
    ["a.relay.localhost"],
    ["*.relay.localhost."],
    "b.relay.localhost",
    400,
  ],
  [
    "wildcard config does not own foreign suffix",
    ["*.relay.localhost."],
    ["*.relay.localhost."],
    "a.relay.localhost.evil",
    400,
  ],
  [
    "wildcard config does not own near suffix",
    ["*.relay.localhost."],
    ["*.relay.localhost."],
    "a.evilrelay.localhost",
    400,
  ],
  [
    "partial wildcard SAN is not ownership",
    ["ab.relay.localhost"],
    ["a*.relay.localhost."],
    "ab.relay.localhost",
    400,
  ],
  [
    "multiple wildcard SAN is not ownership",
    ["b.a.relay.localhost"],
    ["*.*.relay.localhost."],
    "b.a.relay.localhost",
    400,
  ],
  [
    "unrelated exact SAN is not ownership",
    ["*.relay.localhost."],
    ["other.relay.localhost."],
    "a.relay.localhost",
    400,
  ],
  [
    "caller literal wildcard is not a concrete name",
    ["*.relay.localhost."],
    ["*.relay.localhost."],
    "*.relay.localhost.",
    400,
  ],
  [
    "slash label cannot use literal proof",
    ["*.relay.localhost."],
    ["*.relay.localhost."],
    "a/b.relay.localhost",
    400,
  ],
  [
    "at-sign label cannot use literal proof",
    ["*.relay.localhost."],
    ["*.relay.localhost."],
    "a@b.relay.localhost",
    400,
  ],
  [
    "empty internal label cannot use literal proof",
    ["a..relay.localhost"],
    ["*.relay.localhost."],
    "a..relay.localhost",
    400,
  ],
  [
    "top-level dotted wildcard cannot use literal proof",
    ["*.com."],
    ["*.com."],
    "a.com",
    400,
  ],
  [
    "IP still requires actual IP SAN",
    ["127.0.0.1"],
    ["127.0.0.2"],
    "127.0.0.1",
    400,
  ],
  [
    "dotted IPv4 is not an IP SAN",
    ["127.0.0.1"],
    ["127.0.0.1"],
    "127.0.0.1.",
    400,
  ],
  [
    "dotted wildcard does not own extra label even with exact config",
    ["b.a.relay.localhost"],
    ["*.relay.localhost."],
    "b.a.relay.localhost",
    400,
  ],
  [
    "dotted wildcard does not own apex even with exact config",
    ["relay.localhost"],
    ["*.relay.localhost."],
    "relay.localhost",
    400,
  ],
] as const)(
  "F007 certificate spelling: %s",
  async (_name, hosts, certificateHosts, host, expected) => {
    const cnOnly = certificateHosts.length === 0;
    const control = cnOnly ? [] : ["control.localhost"];
    const r = await rig(
      [...hosts, ...control],
      [...certificateHosts, ...control],
    );
    assert.equal(
      await r.post({
        boot,
        records: [report(cnOnly ? host : control[0]!, 1), report(host, 2)],
      }),
      expected,
    );
    assert.equal(r.records.length, expected === 200 ? 2 : 0);
    if (expected === 400)
      assert.deepEqual(r.lines, ["relay observations: invalid batch"]);
  },
);

test.each([
  [["localhost"], ["elsewhere.test"], "localhost"],
  [["localhost"], [], "localhost"],
  [["localhost"], ["localhost", "api.openai.com"], "api.openai.com"],
  [["*.relay.localhost"], ["other.relay.localhost"], "a.relay.localhost"],
  [["a.relay.localhost"], ["*.relay.localhost"], "b.relay.localhost"],
  [["a*.relay.localhost"], ["a*.relay.localhost"], "ab.relay.localhost"],
  [["127.0.0.1"], ["127.0.0.2"], "127.0.0.1"],
] as const)(
  "F007 both configured ownership and actual certificate must allow %s / %s / %s",
  async (hosts, certificateHosts, host) => {
    const r = await rig([...hosts], [...certificateHosts]);
    assert.equal(await r.post({ boot, records: [report(host, 1)] }), 400);
    assert.equal(r.records.length, 0);
    assert.deepEqual(r.lines, ["relay observations: invalid batch"]);
  },
);
