import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, test } from "vitest";
import {
  INSTANCE_OWNED_ENV_VARS,
  scrubInstanceEnvironment,
} from "./instanceEnv.ts";
import { SCRUBBED_INTEGRATION_SECRET_ENV_VARS } from "./integrationSecrets.ts";

const saved = new Map<string, string | undefined>();

function set(name: string, value: string): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

test("server startup scrubs its environment before its first tool subprocess", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const scrubAt = source.indexOf("scrubInstanceEnvironment();");
  const buildInfoAt = source.indexOf("const SERVER_BUILD = serverBuildInfo();");
  const hostToolsAt = source.indexOf("verifyRequiredHostTools();");
  const listenAt = source.indexOf("server.listen(");

  assert.ok(scrubAt >= 0, "index.ts must scrub the captured environment");
  assert.ok(buildInfoAt >= 0, "index.ts must resolve its build identity");
  assert.ok(hostToolsAt >= 0, "index.ts must verify host tools");
  assert.ok(listenAt >= 0, "index.ts must start its listener");
  assert.ok(scrubAt < buildInfoAt, "scrub must precede the git fallback");
  assert.ok(scrubAt < hostToolsAt, "scrub must precede host-tool probes");
  assert.ok(hostToolsAt < listenAt, "host tools must be checked before listen");
});

test("startup logs the auth requirement and token path without the token value", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const listenAt = source.indexOf("server.listen(");

  assert.match(source, /console\.log\(authTokenStartupMessage\(\)\)/);
  assert.doesNotMatch(
    source.slice(listenAt),
    /\bAUTH_TOKEN\b/,
    "startup callback must not access the API token",
  );
});

test("removes the instance-owned variables an agent must not inherit", () => {
  set("DATA_DIR", "/home/alice/assistant-data");
  set("ASSISTANT_TOKEN", "secret");
  set("ASSISTANT_PORT", "8787");
  set("ASSISTANT_CLAUDE_CLI_BIN", "/nix/store/example-claude");
  set("ASSISTANT_RUNTIME_DIR", "/nix/store/example-runtime");
  set("ASSISTANT_CONFIG", "/nix/store/example-personal-assistant-config.json");
  set("APNS_CREDENTIAL_FILE", "/run/secrets/example-apns");
  for (const name of SCRUBBED_INTEGRATION_SECRET_ENV_VARS)
    set(name, `${name}-sentinel`);

  const removed = scrubInstanceEnvironment();

  assert.equal(process.env.DATA_DIR, undefined);
  assert.equal(process.env.ASSISTANT_TOKEN, undefined);
  assert.equal(process.env.ASSISTANT_PORT, undefined);
  assert.equal(process.env.ASSISTANT_CLAUDE_CLI_BIN, undefined);
  assert.equal(process.env.ASSISTANT_RUNTIME_DIR, undefined);
  for (const name of SCRUBBED_INTEGRATION_SECRET_ENV_VARS)
    assert.equal(process.env[name], undefined);
  assert.equal(
    execFileSync(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify([
          "ASSISTANT_RUNTIME_DIR",
          "ASSISTANT_CLAUDE_CLI_BIN",
          "ASSISTANT_CONFIG",
          "APNS_CREDENTIAL_FILE",
          ...SCRUBBED_INTEGRATION_SECRET_ENV_VARS,
        ])}.map(name => process.env[name] ?? '').join(''))`,
      ],
      { encoding: "utf8" },
    ),
    "",
  );
  for (const name of [
    "DATA_DIR",
    "ASSISTANT_TOKEN",
    "ASSISTANT_PORT",
    "ASSISTANT_CLAUDE_CLI_BIN",
    "ASSISTANT_RUNTIME_DIR",
    "ASSISTANT_CONFIG",
    "APNS_CREDENTIAL_FILE",
    ...SCRUBBED_INTEGRATION_SECRET_ENV_VARS,
  ])
    assert.ok(removed.includes(name), `${name} should be reported as removed`);
});

test("reports only what was actually set, and is idempotent", () => {
  for (const name of INSTANCE_OWNED_ENV_VARS) {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    delete process.env[name];
  }
  set("DATA_DIR", "/tmp/whatever");

  assert.deepEqual(scrubInstanceEnvironment(), ["DATA_DIR"]);
  assert.deepEqual(scrubInstanceEnvironment(), []);
});

test("leaves the ambient environment a spawned agent still needs", () => {
  const path = process.env.PATH;
  const home = process.env.HOME;
  set("DATA_DIR", "/home/alice/assistant-data");
  // Model weights are immutable store paths shared by every instance, not this
  // instance's identity, so dictation keeps working in a spawned shell.
  set("ASSISTANT_STT_MODELS", "/nix/store/xxx-models");

  scrubInstanceEnvironment();

  assert.equal(process.env.PATH, path);
  assert.equal(process.env.HOME, home);
  assert.equal(process.env.ASSISTANT_STT_MODELS, "/nix/store/xxx-models");
});
