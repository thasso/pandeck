/**
 * The vault's `--integrations-config` loader (Task-1411, AC1): a 0600 JSON
 * file of OAuth clients by provider. Every refusal is a fixed text holding no
 * value from the file; unknown providers are ignored. Every value is fake.
 */
import assert from "node:assert/strict";
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

test("a 0600 file with an Atlassian client loads; other providers are ignored", () => {
  const file = configFile(
    JSON.stringify({
      atlassian: { clientId: ID, clientSecret: SECRET },
      slack: { clientId: "fake-slack-id" },
    }),
  );
  assert.deepEqual(loadIntegrationClients(file), {
    atlassian: { clientId: ID, clientSecret: SECRET },
  });
  assert.deepEqual(loadIntegrationClients(configFile("{}")), {});
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
