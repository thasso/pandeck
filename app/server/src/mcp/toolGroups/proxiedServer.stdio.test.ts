/**
 * The REAL stdio client factory in `proxiedServer.ts` (pi-mcp `McpClient` +
 * `StdioTransport`), driven against a tiny JSON-RPC MCP server script instead
 * of Playwright. `proxiedServer.test.ts` covers the layers above it through
 * the injectable fake factory.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/mcp/toolGroups/proxiedServer.stdio.test.ts
 *
 * Covers: the child sees only the external-process allowlist plus the trusted
 * overrides (pi-mcp would otherwise merge `process.env`), a tool call round
 * trip, an unexpected exit reported with the server's stderr, and an explicit
 * close that is not reported as a crash.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  closeProxiedConnection,
  openProxiedConnection,
  type ProxiedServerSpec,
} from "./proxiedServer.ts";

const PROBE_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "probe", version: "0" },
    } });
  } else if (msg.method === "tools/call") {
    if (msg.params.name === "crash") {
      process.stderr.write("probe crashed on purpose");
      process.exit(3);
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({
      secret: process.env.PA_PROBE_SECRET ?? null,
      trusted: process.env.PA_PROBE_TRUSTED ?? null,
    }) }] } });
  }
});
`;

let dir: string;
let spec: ProxiedServerSpec;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proxied-stdio-"));
  const script = join(dir, "probe-server.cjs");
  writeFileSync(script, PROBE_SERVER);
  vi.stubEnv("PA_PROBE_SECRET", "must-not-leak");
  spec = {
    name: "Probe MCP",
    outputDir: (sessionId) => join(dir, sessionId),
    spawn: () => ({
      command: process.execPath,
      args: [script],
      trustedEnv: { PA_PROBE_TRUSTED: "server-owned" },
    }),
  };
});

afterEach(async () => {
  await closeProxiedConnection("probe-session");
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

test("the server sees only the allowlist and trusted overrides, and calls round-trip", async () => {
  const connection = await openProxiedConnection("probe-session", spec, false);
  assert.equal(connection.status, "running");
  assert.ok(connection.pid, "the child pid is exposed");

  const result = await connection.call("env", {});
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? "null"), {
    secret: null,
    trusted: "server-owned",
  });

  await closeProxiedConnection("probe-session");
  assert.equal(connection.status, "exited", "an explicit close is no crash");
  assert.equal(connection.error, undefined);
});

test("an unexpected exit is reported with the server's stderr", async () => {
  const connection = await openProxiedConnection("probe-session", spec, false);
  await assert.rejects(connection.call("crash", {}));
  await vi.waitFor(() => assert.equal(connection.status, "error"));
  assert.match(
    connection.error ?? "",
    /Probe MCP exited unexpectedly: probe crashed on purpose/,
  );
});
