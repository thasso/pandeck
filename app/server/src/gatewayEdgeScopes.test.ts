/**
 * The edge builds its tools from the Atlassian scope list it asks for
 * (`gatewayEdge.ts`, Task-1463 P5b): `startEdge` passes the loaded UI
 * config's `atlassian.scopes`, or the default list, to `createEdgeTools`, so
 * `confluence_mutate_page` offers a delete only when that list holds its
 * scope. Every value is fake.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { edgeTlsFor } from "./gateway/x509.ts";
import { FAKE_CLIENT } from "./test/atlassianFake.ts";

const spy = vi.hoisted(() => ({ scopes: [] as unknown[] }));

vi.mock("./gatewayTools/index.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./gatewayTools/index.ts")>();
  return {
    ...real,
    createEdgeTools: (options: Parameters<typeof real.createEdgeTools>[0]) => {
      spy.scopes.push(options?.atlassianScopes);
      return real.createEdgeTools(options);
    },
  };
});

const { startEdge } = await import("./gatewayEdge.ts");

const edgeTls = edgeTlsFor(["localhost", "127.0.0.1"], undefined);
const open: { close(): unknown }[] = [];
const ports = { port: 0, modelPort: 0, clientPort: 0, enrollPort: 0 };
const DELETES = ["delete:page:confluence", "delete:attachment:confluence"];

afterEach(async () => {
  while (open.length) await open.pop()!.close();
  spy.scopes.length = 0;
});

/** A UI config with `atlassian`, and an empty edge state directory. */
function edgeFixture(atlassian: Record<string, unknown>) {
  mkdirSync(DATA_DIR, { recursive: true });
  const dir = mkdtempSync(join(DATA_DIR, "gateway-edge-scopes-"));
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
        clientSecret: FAKE_CLIENT.clientSecret,
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

/** The scope list `startEdge` handed `createEdgeTools` for `atlassian`. */
async function scopesFor(atlassian: Record<string, unknown>) {
  const { uiConfig, stateDir } = edgeFixture(atlassian);
  const edge = await startEdge(
    { stateDir, ...ports, uiConfig },
    { log: () => {} },
  );
  open.push(edge);
  assert.equal(spy.scopes.length, 1, "the edge built its tools once");
  const scopes = spy.scopes.pop();
  assert.ok(Array.isArray(scopes));
  return scopes as string[];
}

test("without atlassian.scopes the edge's tools get the default list, which holds both deletes", async () => {
  const scopes = await scopesFor({});
  for (const scope of DELETES) assert.ok(scopes.includes(scope), scope);
  assert.equal(scopes.at(-1), "offline_access");
});

test("atlassian.scopes reaches the edge's tools as loaded: a page-only list holds no attachment delete", async () => {
  assert.deepEqual(
    await scopesFor({
      clientId: FAKE_CLIENT.clientId,
      clientSecret: FAKE_CLIENT.clientSecret,
      scopes: ["read:page:confluence", "delete:page:confluence"],
    }),
    ["read:page:confluence", "delete:page:confluence", "offline_access"],
  );
  assert.deepEqual(
    await scopesFor({
      clientId: FAKE_CLIENT.clientId,
      clientSecret: FAKE_CLIENT.clientSecret,
      scopes: ["read:page:confluence"],
    }),
    ["read:page:confluence", "offline_access"],
  );
});
