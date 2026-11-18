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
    "api.anthropic.com",
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

test.each([
  [["localhost"], ["elsewhere.test"], "localhost"],
  [["localhost"], [], "localhost"],
  [["localhost"], ["localhost", "api.anthropic.com"], "api.anthropic.com"],
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
