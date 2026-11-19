/**
 * The UI config's Slack OAuth client by vault topology (`gatewayEdge.ts`
 * `integrationClientFor`, `integrationClientsFor`; Task-1452 AC1): the same
 * rule as Atlassian's, per provider. The in-process vault takes both halves
 * or neither and `startEdge` refuses a half before anything listens; a remote
 * vault keeps only the id, and a secret it finds is neither passed nor used,
 * only named once in a fixed line. Atlassian and Slack together both reach an
 * in-process vault. Every value is fake.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { DATA_DIR } from "./config.ts";
import { FAKE_CLIENT } from "./test/atlassianFake.ts";
import { FAKE_SLACK_CLIENT } from "./test/slackFake.ts";
import { edgeTlsFor } from "./gateway/x509.ts";
import {
  EdgeStartRefusal,
  integrationClientFor,
  integrationClientsFor,
  startEdge,
} from "./gatewayEdge.ts";

const { clientId: SLACK_ID, clientSecret: SLACK_SECRET } = FAKE_SLACK_CLIENT;
const HALF =
  "slack.clientId and slack.clientSecret must both be set, or neither, with the vault in this process";
const IGNORED =
  "slack.clientSecret in the UI config is ignored: the remote vault holds the Slack client secret; remove it from this file";
const ATLASSIAN_IGNORED =
  "atlassian.clientSecret in the UI config is ignored: the remote vault holds the Atlassian client secret; remove it from this file";
const SECRETS = new RegExp(`${SLACK_ID}|${SLACK_SECRET}`);

const edgeTls = edgeTlsFor(["localhost", "127.0.0.1"], undefined);
const open: { close(): unknown }[] = [];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

test("the helper: in-process both or neither, remote never a secret", () => {
  assert.deepEqual(integrationClientFor("slack", FAKE_SLACK_CLIENT, false), {
    integrationClients: { slack: FAKE_SLACK_CLIENT },
  });
  assert.deepEqual(integrationClientFor("slack", undefined, false), {});
  assert.deepEqual(integrationClientFor("slack", {}, false), {});
  for (const half of [{ clientId: SLACK_ID }, { clientSecret: SLACK_SECRET }])
    assert.throws(
      () => integrationClientFor("slack", half, false),
      (err: unknown) =>
        err instanceof EdgeStartRefusal &&
        err.message === HALF &&
        !SECRETS.test(err.message),
    );
  assert.deepEqual(
    integrationClientFor("slack", { clientId: SLACK_ID }, true),
    {},
  );
  assert.deepEqual(integrationClientFor("slack", undefined, true), {});
  assert.deepEqual(integrationClientFor("slack", FAKE_SLACK_CLIENT, true), {
    warning: IGNORED,
  });
  assert.deepEqual(
    integrationClientFor("slack", { clientSecret: SLACK_SECRET }, true),
    { warning: IGNORED },
  );
});

test("both providers: an in-process vault gets both pairs, a remote one neither, with one line per dropped secret", () => {
  const presets = { atlassian: FAKE_CLIENT, slack: FAKE_SLACK_CLIENT };
  assert.deepEqual(integrationClientsFor(presets, false), {
    integrationClients: { atlassian: FAKE_CLIENT, slack: FAKE_SLACK_CLIENT },
    warnings: [],
  });
  assert.deepEqual(integrationClientsFor({ slack: FAKE_SLACK_CLIENT }, false), {
    integrationClients: { slack: FAKE_SLACK_CLIENT },
    warnings: [],
  });
  assert.deepEqual(integrationClientsFor({}, false), { warnings: [] });
  assert.deepEqual(integrationClientsFor(presets, true), {
    warnings: [ATLASSIAN_IGNORED, IGNORED],
  });
  assert.deepEqual(
    integrationClientsFor(
      {
        atlassian: { clientId: FAKE_CLIENT.clientId },
        slack: FAKE_SLACK_CLIENT,
      },
      true,
    ),
    { warnings: [IGNORED] },
  );
  // A half Slack client refuses even beside a whole Atlassian one.
  assert.throws(
    () =>
      integrationClientsFor(
        { atlassian: FAKE_CLIENT, slack: { clientId: SLACK_ID } },
        false,
      ),
    (err: unknown) => err instanceof EdgeStartRefusal && err.message === HALF,
  );
});

/** A UI config with `slack` (and optionally `atlassian`), and a state dir. */
function edgeFixture(extra: Record<string, unknown>) {
  mkdirSync(DATA_DIR, { recursive: true });
  const dir = mkdtempSync(join(DATA_DIR, "gateway-edge-slack-"));
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
        clientId: "fake-oidc-client-id",
        clientSecret: "fake-oidc-client-secret",
      },
      allow: { emailDomains: ["example.test"] },
      ...extra,
    }),
    { mode: 0o600 },
  );
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  return { uiConfig, stateDir };
}

const ports = { port: 0, modelPort: 0, clientPort: 0, enrollPort: 0 };

test("an in-process edge refuses half a Slack client before anything starts, naming no value", async () => {
  for (const slack of [
    { clientId: SLACK_ID },
    { clientSecret: SLACK_SECRET },
  ]) {
    const { uiConfig, stateDir } = edgeFixture({
      atlassian: {
        clientId: FAKE_CLIENT.clientId,
        clientSecret: FAKE_CLIENT.clientSecret,
      },
      slack,
    });
    const lines: string[] = [];
    await assert.rejects(
      startEdge(
        { stateDir, ...ports, uiConfig },
        { log: (line) => lines.push(line) },
      ),
      (err: unknown) => err instanceof EdgeStartRefusal && err.message === HALF,
    );
    assert.deepEqual(readdirSync(stateDir), []);
    assert.doesNotMatch(lines.join("\n"), SECRETS);
  }
});

test("an in-process edge starts with Atlassian and Slack clients together, with no warning", async () => {
  const { uiConfig, stateDir } = edgeFixture({
    atlassian: {
      clientId: FAKE_CLIENT.clientId,
      clientSecret: FAKE_CLIENT.clientSecret,
    },
    slack: FAKE_SLACK_CLIENT,
  });
  const lines: string[] = [];
  const edge = await startEdge(
    { stateDir, ...ports, uiConfig },
    { log: (line) => lines.push(line) },
  );
  open.push(edge);
  assert.ok(edge.uiPort);
  assert.deepEqual(
    lines.filter((line) => line.includes("is ignored")),
    [],
  );
  assert.doesNotMatch(lines.join("\n"), new RegExp(SLACK_SECRET));
});
