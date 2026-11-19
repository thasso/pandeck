/**
 * The UI config's Atlassian OAuth client by vault topology (`gatewayEdge.ts`
 * `integrationClientFor`, Task-1411): the in-process vault takes both halves or
 * neither and `startEdge` refuses a half before anything listens; a remote
 * vault keeps only the id, starts without a secret, and a secret it finds is
 * neither passed nor used, only named once in a fixed line. Every value is
 * fake.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { FAKE_CLIENT } from "./test/atlassianFake.ts";
import { edgeVaultLinkFile } from "./gateway/vaultMethods.ts";
import { startVaultServer } from "./gateway/vaultServer.ts";
import { edgeTlsFor, selfSignedIdentity } from "./gateway/x509.ts";
import {
  EdgeStartRefusal,
  integrationClientFor,
  startEdge,
} from "./gatewayEdge.ts";

const { clientId: FAKE_EDGE_CLIENT_ID, clientSecret: FAKE_EDGE_CLIENT_SECRET } =
  FAKE_CLIENT;
const HALF =
  "atlassian.clientId and atlassian.clientSecret must both be set, or neither, with the vault in this process";
const IGNORED =
  "atlassian.clientSecret in the UI config is ignored: the remote vault holds the Atlassian client secret; remove it from this file";

const edgeTls = edgeTlsFor(["localhost", "127.0.0.1"], undefined);
const open: { close(): unknown }[] = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
  vi.restoreAllMocks();
});

test("the helper: in-process both or neither, remote never a secret", () => {
  const preset = (fields: { clientId?: string; clientSecret?: string }) => ({
    emailFromSignIn: false,
    scopes: ["offline_access"],
    ...fields,
  });
  // In process: the pair goes to the vault; neither, nothing.
  assert.deepEqual(
    integrationClientFor(
      "atlassian",
      preset({
        clientId: FAKE_EDGE_CLIENT_ID,
        clientSecret: FAKE_EDGE_CLIENT_SECRET,
      }),
      false,
    ),
    {
      integrationClients: {
        atlassian: {
          clientId: FAKE_EDGE_CLIENT_ID,
          clientSecret: FAKE_EDGE_CLIENT_SECRET,
        },
      },
    },
  );
  assert.deepEqual(integrationClientFor("atlassian", undefined, false), {});
  assert.deepEqual(integrationClientFor("atlassian", preset({}), false), {});
  // In process, half a client is refused with a fixed text.
  for (const half of [
    { clientId: FAKE_EDGE_CLIENT_ID },
    { clientSecret: FAKE_EDGE_CLIENT_SECRET },
  ]) {
    assert.throws(
      () => integrationClientFor("atlassian", preset(half), false),
      (err: unknown) => err instanceof EdgeStartRefusal && err.message === HALF,
    );
  }
  // Remote: nothing is passed, the id alone is fine, a secret only warns.
  assert.deepEqual(
    integrationClientFor(
      "atlassian",
      preset({ clientId: FAKE_EDGE_CLIENT_ID }),
      true,
    ),
    {},
  );
  assert.deepEqual(integrationClientFor("atlassian", undefined, true), {});
  assert.deepEqual(
    integrationClientFor(
      "atlassian",
      preset({
        clientId: FAKE_EDGE_CLIENT_ID,
        clientSecret: FAKE_EDGE_CLIENT_SECRET,
      }),
      true,
    ),
    { warning: IGNORED },
  );
  assert.deepEqual(
    integrationClientFor(
      "atlassian",
      preset({ clientSecret: FAKE_EDGE_CLIENT_SECRET }),
      true,
    ),
    {
      warning: IGNORED,
    },
  );
});

/** A UI config with `atlassian`, and an empty edge state directory. */
function edgeFixture(atlassian: Record<string, unknown>) {
  mkdirSync(DATA_DIR, { recursive: true });
  const dir = mkdtempSync(join(DATA_DIR, "gateway-edge-atl-"));
  const dist = join(dir, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "gateway.html"), "<!doctype html>");
  writeFileSync(join(dir, "cert.pem"), edgeTls.serverCertPem);
  writeFileSync(join(dir, "key.pem"), edgeTls.serverKeyPem, { mode: 0o600 });
  const uiConfig = join(dir, "ui.json");
  writeFileSync(
    uiConfig,
    JSON.stringify({
      port: 0,
      publicOrigin: "https://gateway.example.test",
      certFile: join(dir, "cert.pem"),
      keyFile: join(dir, "key.pem"),
      distDir: dist,
      oidc: {
        issuer: "https://issuer.example.test",
        clientId: FAKE_CLIENT.clientId,
        clientSecret: FAKE_EDGE_CLIENT_SECRET,
      },
      allow: { emailDomains: ["example.test"] },
      atlassian,
    }),
    { mode: 0o600 },
  );
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  return { uiConfig, stateDir };
}

const ports = { port: 0, modelPort: 0, clientPort: 0, enrollPort: 0 };

/** Every line the edge writes, its own and the console's. */
function capture(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return lines;
}

test("an in-process edge refuses half a client before anything starts, naming no value", async () => {
  for (const half of [
    { site: "t.atlassian.net", clientId: FAKE_EDGE_CLIENT_ID },
    { clientSecret: FAKE_EDGE_CLIENT_SECRET },
  ]) {
    const { uiConfig, stateDir } = edgeFixture(half);
    const lines = capture();
    await assert.rejects(
      startEdge(
        { stateDir, ...ports, uiConfig },
        { log: (line) => lines.push(line) },
      ),
      (err: unknown) => err instanceof EdgeStartRefusal && err.message === HALF,
    );
    // Nothing started: the gateway wrote no state.
    assert.deepEqual(readdirSync(stateDir), []);
    assert.doesNotMatch(
      lines.join("\n"),
      new RegExp(`${FAKE_EDGE_CLIENT_ID}|${FAKE_EDGE_CLIENT_SECRET}`),
    );
  }
});

test("an in-process edge starts with both halves and with neither, with no warning", async () => {
  for (const atlassian of [
    {
      clientId: FAKE_EDGE_CLIENT_ID,
      clientSecret: FAKE_EDGE_CLIENT_SECRET,
    },
    {},
  ]) {
    const { uiConfig, stateDir } = edgeFixture(atlassian);
    const lines = capture();
    const edge = await startEdge(
      { stateDir, ...ports, uiConfig },
      { log: (line) => lines.push(line) },
    );
    open.push(edge);
    assert.ok(edge.uiPort);
    assert.ok(!lines.includes(IGNORED));
    assert.doesNotMatch(lines.join("\n"), new RegExp(FAKE_EDGE_CLIENT_SECRET));
  }
});

test("a remote-vault edge starts with the id alone, and with a secret only logs the fixed line once", async () => {
  const vaultId = selfSignedIdentity("pandeck-gateway-vault", "server", [
    "localhost",
    "127.0.0.1",
  ]);
  const edgeId = selfSignedIdentity("pandeck-gateway-edge", "client");
  for (const [atlassian, warned] of [
    [{ clientId: FAKE_EDGE_CLIENT_ID }, false],
    [
      {
        clientId: FAKE_EDGE_CLIENT_ID,
        clientSecret: FAKE_EDGE_CLIENT_SECRET,
      },
      true,
    ],
  ] as const) {
    const { uiConfig, stateDir } = edgeFixture(atlassian);
    const vaultDir = mkdtempSync(join(DATA_DIR, "gateway-edge-atl-vault-"));
    const vaultLines: string[] = [];
    const vault = await startVaultServer({
      stateDir: vaultDir,
      port: 0,
      tls: {
        keyPem: vaultId.keyPem,
        certPem: vaultId.certPem,
        peerCertPem: edgeId.certPem,
      },
      controlSocket: join(vaultDir, "control.sock"),
      log: (line) => vaultLines.push(line),
    });
    open.push(vault);
    edgeVaultLinkFile(stateDir).write({
      v: 1,
      keyPem: edgeId.keyPem,
      certPem: edgeId.certPem,
      vaultCertPem: vaultId.certPem,
    });
    const lines = capture();
    const edge = await startEdge(
      {
        stateDir,
        ...ports,
        uiConfig,
        vault: { host: "127.0.0.1", port: vault.port },
      },
      { log: (line) => lines.push(line) },
    );
    open.push(edge);
    assert.ok(edge.uiPort);
    assert.equal(
      lines.filter((line) => line === IGNORED).length,
      warned ? 1 : 0,
    );
    assert.doesNotMatch(
      [...lines, ...vaultLines].join("\n"),
      new RegExp(FAKE_EDGE_CLIENT_SECRET),
    );
  }
});
