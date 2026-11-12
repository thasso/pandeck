/**
 * A gateway login whose end is lost while the client link is down
 * (Task-1402 B1, review rv-1402-b1-code-01 C2), end to end: a real edge,
 * relay and client link, and a fake Codex driver. The gateway sends login
 * events only over current connections, so the server must reconcile the
 * run after the link is back, never leave it connecting. Every value is fake.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";
import type { WebSocket } from "ws";

const tmp = mkdtempSync(join(tmpdir(), "gateway-login-interrupted-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
process.env.HOME = join(tmp, "home");

const profiles = await import("./credentialProfiles.ts");
const { attachAccountLoginSocket } = await import("./accountLoginSocket.ts");
const { startGatewayClientLink } = await import("./gatewayClientLink.ts");
const { startGateway } = await import("./gateway/gateway.ts");
const { enrollRelay, startRelay } = await import("./relay/relay.ts");

const INTERRUPTED =
  "The gateway connection was interrupted. Start the login again.";
const open: { close(): unknown }[] = [];
afterAll(async () => {
  while (open.length) await open.pop()!.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A browser on the login dialog's socket. */
function viewer(profileId: string) {
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    messages: [] as { type: string; [key: string]: unknown }[],
    send(text: string) {
      socket.messages.push(JSON.parse(text) as { type: string });
    },
    close() {
      socket.readyState = 3;
      socket.emit("close");
    },
  });
  attachAccountLoginSocket(
    socket as unknown as WebSocket,
    {
      url: `/ws/account-login?profileId=${profileId}&intent=start`,
      headers: { host: "localhost" },
    } as IncomingMessage,
  );
  const status = () =>
    socket.messages.filter((m) => m.type === "status").at(-1);
  return { socket, status };
}

test("a login that ends while the link is down is reconciled after it is back, and a retry starts a new login", async () => {
  const gatewayLogs: string[] = [];
  const drivers: { fail(error: Error): void }[] = [];
  const gateway = await startGateway({
    stateDir: join(tmp, "gateway"),
    log: (line: string) => gatewayLogs.push(line),
    clients: {},
    loginDrivers: {
      "openai-codex": (_dir, events) => {
        let fail!: (error: Error) => void;
        const done = new Promise<void>((_resolve, reject) => {
          fail = reject;
        });
        drivers.push({ fail });
        events.url("https://auth.example/device");
        events.code(`CODE-${drivers.length}`);
        return {
          input: () => {},
          cancel: () => fail(new Error("This operation was aborted")),
          done,
        };
      },
    },
  });
  open.push(gateway);
  const edge = gateway.clients!;
  edge.registry.addUser("fixture");
  const relayDir = join(tmp, "relay");
  await enrollRelay({
    stateDir: relayDir,
    host: "127.0.0.1",
    enrollPort: edge.enrollPort,
    caPem: edge.caPem,
    code: edge.registry.createCode("fixture", "devbox"),
  });
  const relay = await startRelay({
    stateDir: relayDir,
    port: 0,
    socketPath: join(relayDir, "relay.sock"),
    log: () => {},
  });
  open.push(relay);
  const id = "codex-existing";
  const tokenFile = join(tmp, "existing-auth.json");
  writeFileSync(
    tokenFile,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "fake-existing-access",
        refresh: "fake-existing-refresh",
        expires: Date.now() + 3_600_000,
      },
    }),
  );
  edge.putAccount({
    id,
    provider: "openai-codex",
    name: "Existing Codex",
    enabled: true,
    tokenFile,
    userId: "fixture",
  });
  const options = {
    socketPath: relay.socketPath,
    relayPort: relay.port,
    log: () => {},
  };

  const firstLink = startGatewayClientLink(options);
  open.push(firstLink);
  assert.equal(await firstLink.ready, true);
  const first = viewer(id);
  await vi.waitFor(() =>
    assert.ok(first.socket.messages.some((m) => m.type === "device")),
  );

  // The login ends on the gateway while its event connection is down.
  await firstLink.close();
  drivers[0]!.fail(new Error("The provider refused."));
  await vi.waitFor(() =>
    assert.ok(gatewayLogs.some((line) => /login .*: error$/.test(line))),
  );
  assert.equal(first.status(), undefined, "nothing reached this server");

  const secondLink = startGatewayClientLink(options);
  open.push(secondLink);
  assert.equal(await secondLink.ready, true);
  // The reconnect's cancel learns the gateway no longer runs it.
  await vi.waitFor(() => assert.equal(first.status()?.status, "error"));
  assert.equal(first.status()?.error, INTERRUPTED);
  assert.notEqual(
    profiles.credentialProfileSummaryById(id)?.status,
    "connecting",
  );

  // A retry is a new login on the gateway, not the stale run.
  const retry = viewer(id);
  assert.equal(retry.socket.messages[0]?.type, "snapshot");
  assert.equal(retry.socket.messages[0]?.status, "connecting");
  assert.equal(retry.socket.messages[0]?.device, undefined);
  await vi.waitFor(() => assert.equal(drivers.length, 2));
  await vi.waitFor(() =>
    assert.equal(
      (
        retry.socket.messages.find((m) => m.type === "device")?.device as
          { userCode?: string } | undefined
      )?.userCode,
      "CODE-2",
    ),
  );
  retry.socket.emit("message", Buffer.from(JSON.stringify({ type: "cancel" })));
  await vi.waitFor(() => assert.equal(retry.status()?.status, "cancelled"));
}, 30_000);
