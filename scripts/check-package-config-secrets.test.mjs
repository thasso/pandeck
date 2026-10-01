import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertPackageConfigHasNoSecrets,
  forbiddenPackageConfigPaths,
} from "./check-package-config-secrets.mjs";

const tempDirs = [];
const CHECK_SCRIPT = fileURLToPath(
  new URL("./check-package-config-secrets.mjs", import.meta.url),
);
const BUILD_SCRIPT = fileURLToPath(
  new URL("./build-bun-server-bundle.mjs", import.meta.url),
);

function fixture(content) {
  const dir = mkdtempSync(join(tmpdir(), "pa-package-config-"));
  tempDirs.push(dir);
  const path = join(dir, "app.json");
  writeFileSync(
    path,
    typeof content === "string" ? content : JSON.stringify(content),
  );
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("accepts nonsecret deployment metadata", () => {
  const config = {
    google: { oauthClientId: "client-id-sentinel" },
    slack: {
      clientId: "client-id-sentinel",
      userScopes: ["channels:read"],
      workspaceHost: "example.slack.com",
    },
  };

  assert.deepEqual(forbiddenPackageConfigPaths(config), []);
  assert.doesNotThrow(() => assertPackageConfigHasNoSecrets(fixture(config)));
});

test("rejects every former app.json integration secret field", () => {
  const paths = forbiddenPackageConfigPaths({
    google: { oauthClientSecret: "google-secret-sentinel" },
    tempo: { oauthClientSecret: "tempo-secret-sentinel" },
    slack: {
      clientSecret: "slack-secret-sentinel",
      appToken: "slack-token-sentinel",
    },
  });

  assert.deepEqual(paths, [
    "$.google.oauthClientSecret",
    "$.tempo.oauthClientSecret",
    "$.slack.clientSecret",
    "$.slack.appToken",
  ]);
});

test("rejects newly introduced secret-shaped fields at any depth", () => {
  assert.deepEqual(
    forbiddenPackageConfigPaths({
      future: {
        api_password: "password-sentinel",
        credentials: { api_key: "sentinel" },
        nested: [{ private_keys: ["private-key-sentinel"] }],
      },
    }),
    [
      "$.future.api_password",
      "$.future.credentials",
      "$.future.nested[0].private_keys",
    ],
  );
});

test("the package builder checks config before touching its output", () => {
  const source = readFileSync(BUILD_SCRIPT, "utf8");
  const guardAt = source.indexOf("assertPackageConfigHasNoSecrets(");
  const outputMutationAt = source.indexOf("rmSync(outputDir");

  assert.ok(guardAt >= 0, "package builder must invoke the config guard");
  assert.ok(outputMutationAt >= 0, "package builder must prepare its output");
  assert.ok(guardAt < outputMutationAt, "config guard must run before output");
});

test("CLI diagnostics name fields but never print their values", () => {
  const sentinel = "must-not-appear-in-diagnostics";
  const path = fixture({ integration: { refreshToken: sentinel } });
  const result = spawnSync(process.execPath, [CHECK_SCRIPT, "--config", path], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\$\.integration\.refreshToken/);
  assert.doesNotMatch(result.stderr, new RegExp(sentinel));
  assert.equal(result.stdout, "");
});

test("invalid JSON fails closed without echoing source bytes", () => {
  const sentinel = "malformed-secret-sentinel";
  const path = fixture(`{"clientSecret":"${sentinel}"`);
  const result = spawnSync(process.execPath, [CHECK_SCRIPT, "--config", path], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not valid JSON/);
  assert.doesNotMatch(result.stderr, new RegExp(sentinel));
});
