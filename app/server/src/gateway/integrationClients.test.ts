/**
 * The vault's `--integrations-config` loader (Task-1411, AC1; Slack,
 * Task-1452 AC1; the GitHub App, Task-1444 AC1): a 0600 JSON file of OAuth
 * clients by provider, the App's key a separate 0600 PEM file. Every refusal
 * is a fixed text holding no value from either file; unknown providers are
 * ignored. Every value is fake; the App key is generated here.
 */
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { FAKE_CLIENT } from "../test/atlassianFake.ts";
import { FAKE_GITHUB_APP_ID, FAKE_GITHUB_CLIENT } from "../test/githubFake.ts";
import { FAKE_SLACK_CLIENT } from "../test/slackFake.ts";
import {
  IntegrationClientsRefusal,
  loadIntegrationClients,
} from "./integrationClients.ts";

const root = mkdtempSync(join(tmpdir(), "int-clients-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SECRET = FAKE_CLIENT.clientSecret;
const ID = FAKE_CLIENT.clientId;
let n = 0;

function configFile(content: string, mode = 0o600): string {
  const file = join(root, `config-${n++}.json`);
  writeFileSync(file, content, { mode });
  chmodSync(file, mode);
  return file;
}

function refusal(file: string): string {
  try {
    loadIntegrationClients(file);
  } catch (err) {
    assert.ok(err instanceof IntegrationClientsRefusal);
    return err.message;
  }
  assert.fail("expected a refusal");
}

test("a 0600 file with Atlassian and Slack clients loads; other providers are ignored", () => {
  const file = configFile(
    JSON.stringify({
      atlassian: { clientId: ID, clientSecret: SECRET },
      slack: FAKE_SLACK_CLIENT,
      gitlab: { clientId: "fake-gitlab-id" },
    }),
  );
  assert.deepEqual(loadIntegrationClients(file), {
    atlassian: { clientId: ID, clientSecret: SECRET },
    slack: FAKE_SLACK_CLIENT,
  });
  const atlassianOnly = loadIntegrationClients(
    configFile(
      JSON.stringify({ atlassian: { clientId: ID, clientSecret: SECRET } }),
    ),
  );
  assert.equal(atlassianOnly.slack, undefined);
  assert.deepEqual(
    loadIntegrationClients(
      configFile(JSON.stringify({ slack: FAKE_SLACK_CLIENT })),
    ),
    { slack: FAKE_SLACK_CLIENT },
  );
  assert.deepEqual(loadIntegrationClients(configFile("{}")), {});
});

test("an unusable slack entry refuses with a fixed text naming slack and nothing from the file", () => {
  const { clientId, clientSecret } = FAKE_SLACK_CLIENT;
  for (const slack of [
    { clientId },
    { clientSecret },
    { clientId: "", clientSecret },
    { clientId, clientSecret: "" },
    { clientId: `${clientId} with spaces`, clientSecret },
    { clientId, clientSecret: `${clientSecret}\u0007` },
    clientSecret,
  ]) {
    const message = refusal(
      configFile(
        JSON.stringify({
          atlassian: { clientId: ID, clientSecret: SECRET },
          slack,
        }),
      ),
    );
    assert.equal(
      message,
      "the integrations config's slack entry needs a non-empty clientId and clientSecret",
    );
    assert.doesNotMatch(message, /fake-|sentinel/);
  }
});

test("each unusable file refuses with a fixed text that holds nothing from it", () => {
  const good = JSON.stringify({
    atlassian: { clientId: ID, clientSecret: SECRET },
  });
  const cases: [string, string][] = [
    [configFile(good, 0o640), "readable by group or others"],
    [configFile(good, 0o604), "readable by group or others"],
    [
      configFile(`{"atlassian": {"clientSecret": "${SECRET}"`),
      "not valid JSON",
    ],
    [configFile(`["${SECRET}"]`), "not a JSON object"],
    [
      configFile(JSON.stringify({ atlassian: { clientId: ID } })),
      "needs a non-empty clientId and clientSecret",
    ],
    [
      configFile(
        JSON.stringify({ atlassian: { clientId: "", clientSecret: SECRET } }),
      ),
      "needs a non-empty clientId and clientSecret",
    ],
    [
      configFile(
        JSON.stringify({
          atlassian: { clientId: ID, clientSecret: "" },
        }),
      ),
      "needs a non-empty clientId and clientSecret",
    ],
    [
      configFile(
        JSON.stringify({
          atlassian: { clientId: `${ID} with spaces`, clientSecret: SECRET },
        }),
      ),
      "needs a non-empty clientId and clientSecret",
    ],
    [configFile(JSON.stringify({ atlassian: SECRET })), "needs a non-empty"],
    [join(root, "absent.json"), "cannot be read"],
  ];
  const dir = join(root, "a-directory");
  mkdirSync(dir, { mode: 0o700 });
  cases.push([dir, "not a regular file"]);
  for (const [file, expected] of cases) {
    const message = refusal(file);
    assert.match(message, new RegExp(expected), file);
    assert.doesNotMatch(message, /fake-|sentinel/, file);
  }
});

// --- the GitHub App (Task-1444 AC1) -----------------------------------------

/** A test-only RSA key, generated here; its PEM text marks every refusal. */
const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PEM = appKey.privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

function keyFile(content: string, mode = 0o600): string {
  const file = join(root, `app-key-${n++}.pem`);
  writeFileSync(file, content, { mode });
  chmodSync(file, mode);
  return file;
}

function githubConfig(entry: Record<string, unknown>): string {
  return configFile(JSON.stringify({ github: entry }));
}

const githubEntry = (privateKeyFile: string) => ({
  appId: FAKE_GITHUB_APP_ID,
  ...FAKE_GITHUB_CLIENT,
  privateKeyFile,
});

test("a github entry with a 0600 RSA key loads; the key signs RS256 and is held nowhere else", () => {
  const key = keyFile(APP_PEM);
  const clients = loadIntegrationClients(
    configFile(
      JSON.stringify({
        atlassian: { clientId: ID, clientSecret: SECRET },
        github: githubEntry(key),
      }),
    ),
  );
  assert.deepEqual(clients.atlassian, { clientId: ID, clientSecret: SECRET });
  const github = clients.github!;
  assert.equal(github.appId, FAKE_GITHUB_APP_ID);
  assert.equal(github.clientId, FAKE_GITHUB_CLIENT.clientId);
  assert.equal(github.clientSecret, FAKE_GITHUB_CLIENT.clientSecret);
  const signature = github.sign("header.payload");
  assert.ok(
    verify(
      "sha256",
      Buffer.from("header.payload"),
      createPublicKey(appKey.privateKey),
      signature,
    ),
  );
  // Only the signer leaves: no key text or key object on the client.
  assert.deepEqual(Object.keys(github).sort(), [
    "appId",
    "clientId",
    "clientSecret",
    "sign",
  ]);
  assert.doesNotMatch(JSON.stringify(github), /PRIVATE KEY/);
  // A decimal string appId and a key path relative to the config file.
  const relative = loadIntegrationClients(
    githubConfig({
      ...githubEntry(key.slice(root.length + 1)),
      appId: String(FAKE_GITHUB_APP_ID),
    }),
  );
  assert.equal(relative.github!.appId, FAKE_GITHUB_APP_ID);
  // A file without github behaves as before.
  assert.equal(
    loadIntegrationClients(
      configFile(
        JSON.stringify({ atlassian: { clientId: ID, clientSecret: SECRET } }),
      ),
    ).github,
    undefined,
  );
});

test("an unusable github entry or key file refuses with a fixed text holding nothing from either file", () => {
  const good = keyFile(APP_PEM);
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const dir = join(root, "a-key-directory");
  mkdirSync(dir, { mode: 0o700 });
  const entry = "needs a positive integer appId";
  const cases: [string, string][] = [
    [githubConfig(githubEntry(keyFile(APP_PEM, 0o644))), "readable by group"],
    [githubConfig(githubEntry(keyFile(APP_PEM, 0o640))), "readable by group"],
    [githubConfig(githubEntry(dir)), "not a regular file"],
    [githubConfig(githubEntry(join(root, "absent.pem"))), "cannot be read"],
    [
      githubConfig(
        githubEntry(
          keyFile(
            ec.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
          ),
        ),
      ),
      "no RSA private key",
    ],
    [
      githubConfig(
        githubEntry(
          keyFile(
            appKey.publicKey.export({ type: "spki", format: "pem" }) as string,
          ),
        ),
      ),
      "no PEM private key",
    ],
    [
      githubConfig(githubEntry(keyFile(`garbage ${SECRET} not a key`))),
      "no PEM private key",
    ],
    [
      githubConfig(githubEntry(keyFile(`${APP_PEM}${"#".repeat(16_384)}`))),
      "too large",
    ],
    [githubConfig({ ...githubEntry(good), privateKeyFile: undefined }), entry],
    [githubConfig({ ...githubEntry(good), privateKeyFile: "" }), entry],
    [githubConfig({ ...githubEntry(good), appId: "fake-app" }), entry],
    [githubConfig({ ...githubEntry(good), appId: 0 }), entry],
    [githubConfig({ ...githubEntry(good), appId: -1 }), entry],
    [githubConfig({ ...githubEntry(good), appId: 1.5 }), entry],
    [githubConfig({ ...githubEntry(good), appId: undefined }), entry],
    [githubConfig({ ...githubEntry(good), clientSecret: "" }), entry],
    [githubConfig({ ...githubEntry(good), clientId: undefined }), entry],
    [configFile(JSON.stringify({ github: SECRET })), entry],
  ];
  for (const [file, expected] of cases) {
    const message = refusal(file);
    assert.match(message, new RegExp(expected), file);
    assert.doesNotMatch(
      message,
      /fake-|sentinel|PRIVATE|BEGIN|garbage|app-key|absent|directory/,
      file,
    );
  }
});
