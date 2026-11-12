/**
 * The edge entries' flags (`gatewayEdge.ts`, Task-1401 V2): the live edge
 * unit's flag list, the dev entry's defaults and the packaged entry's
 * required `--vault-host`. The composition itself is exercised by
 * `gatewayWeb/signIn.test.ts` (V7).
 */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import { parseEdgeArgs } from "./gatewayEdge.ts";

/** The IDB edge unit's flags, as its ExecStart runs them (2026-11-12). */
const LIVE = [
  "--state-dir",
  "/var/lib/pandeck-gateway/gateway",
  "--port",
  "8790",
  "--model-port",
  "8791",
  "--client-port",
  "8792",
  "--enroll-port",
  "8793",
  "--bind-host",
  "100.121.101.25",
  "--host",
  "pandeck-gateway-edge.internal.castlabs.com",
  "--host",
  "100.121.101.25",
  "--vault-host",
  "100.121.200.77",
  "--vault-port",
  "8794",
];

test("the live unit's flags parse to its options, for either entry", () => {
  const expected = {
    stateDir: "/var/lib/pandeck-gateway/gateway",
    port: 8790,
    modelPort: 8791,
    clientPort: 8792,
    enrollPort: 8793,
    bindHost: "100.121.101.25",
    hosts: ["pandeck-gateway-edge.internal.castlabs.com", "100.121.101.25"],
    vault: { host: "100.121.200.77", port: 8794 },
  };
  assert.deepEqual(parseEdgeArgs(LIVE, { requireVault: true }), expected);
  assert.deepEqual(parseEdgeArgs(LIVE, { requireVault: false }), expected);
  assert.deepEqual(
    parseEdgeArgs([...LIVE, "--ui-config", "ui.json"], { requireVault: true }),
    { ...expected, uiConfig: resolve("ui.json") },
  );
});

test("defaults: free ports, vault port 8794, no bind host, hosts or UI", () => {
  assert.deepEqual(
    parseEdgeArgs(["--state-dir", "s", "--vault-host", "10.0.0.2"], {
      requireVault: true,
    }),
    {
      stateDir: resolve("s"),
      port: 0,
      modelPort: 0,
      clientPort: 0,
      enrollPort: 0,
      vault: { host: "10.0.0.2", port: 8794 },
    },
  );
});

test("usage errors: no state directory, a bad port, an unknown flag, no vault where required", () => {
  const usage = (argv: string[], requireVault = false) =>
    assert.equal(
      parseEdgeArgs(argv, { requireVault }),
      undefined,
      argv.join(" "),
    );
  usage([]);
  usage(["--port", "1"]);
  for (const flag of [
    "--port",
    "--model-port",
    "--client-port",
    "--enroll-port",
    "--vault-port",
  ])
    for (const value of ["65536", "-1", "1.5", "x"])
      usage(["--state-dir", "s", "--vault-host", "h", flag, value]);
  usage(["--state-dir", "s", "--unknown", "1"]);
  usage(["--state-dir", "s"], true);
  usage(["--state-dir", "s", "--vault-port", "8794"], true);
  // The dev entry runs its vault in process without `--vault-host`.
  assert.deepEqual(
    parseEdgeArgs(["--state-dir", "s"], { requireVault: false }),
    {
      stateDir: resolve("s"),
      port: 0,
      modelPort: 0,
      clientPort: 0,
      enrollPort: 0,
    },
  );
});
