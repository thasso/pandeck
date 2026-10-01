import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it, vi } from "vitest";
import { DATA_DIR, SKILLS_LIBRARY_DIR, SKILLS_RUNTIME_DIR } from "./config.ts";

describe("DATA_DIR child paths", () => {
  it("keeps the skills library and generated runtime beside other app data", () => {
    assert.equal(SKILLS_LIBRARY_DIR, join(DATA_DIR, "skills"));
    assert.equal(SKILLS_RUNTIME_DIR, join(DATA_DIR, "skills-runtime"));
  });
});

describe("deployment integration credentials", () => {
  const dirs: string[] = [];

  /** Config is resolved once at import time, so each case gets a fresh module. */
  async function loadConfig(
    env: Record<string, string | undefined> = {},
  ): Promise<typeof import("./config.ts")> {
    const dir = mkdtempSync(join(tmpdir(), "pa-config-test-"));
    dirs.push(dir);
    const configPath = join(dir, "app.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        google: {
          oauthClientId: "google-client-id",
          oauthClientSecret: "ignored-google-file-secret",
        },
        tempo: {
          oauthClientId: "tempo-client-id",
          oauthClientSecret: "ignored-tempo-file-secret",
        },
        slack: {
          teamId: "T1",
          workspaceHost: "example.slack.com",
          clientId: "slack-client-id",
          clientSecret: "ignored-slack-file-secret",
          appToken: "ignored-slack-file-token",
        },
      }),
    );
    for (const [key, value] of Object.entries({
      ASSISTANT_CONFIG: configPath,
      ASSISTANT_GOOGLE_OAUTH_CLIENT_SECRET: undefined,
      ASSISTANT_TEMPO_OAUTH_CLIENT_SECRET: undefined,
      ASSISTANT_SLACK_CLIENT_SECRET: undefined,
      ASSISTANT_SLACK_APP_TOKEN: undefined,
      ASSISTANT_SLACK_APP_DISABLED: undefined,
      GOOGLE_OAUTH_CLIENT_SECRET: undefined,
      TEMPO_OAUTH_CLIENT_SECRET: undefined,
      ...env,
    }))
      vi.stubEnv(key, value);
    vi.resetModules();
    return import("./config.ts");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it("ignores secret fields in app.json while retaining nonsecret integration metadata", async () => {
    const config = await loadConfig();

    assert.equal(config.GOOGLE_OAUTH_CLIENT_ID, "google-client-id");
    assert.equal(config.GOOGLE_OAUTH_CLIENT_SECRET, "");
    assert.equal(config.TEMPO_OAUTH_CLIENT_ID, "tempo-client-id");
    assert.equal(config.TEMPO_OAUTH_CLIENT_SECRET, "");
    assert.equal(config.SLACK_STATIC_CONFIG.clientId, "slack-client-id");
    assert.equal(config.SLACK_STATIC_CONFIG.clientSecret, "");
    assert.equal(config.SLACK_STATIC_CONFIG.appToken, "");
  });

  it("loads integration secrets only from the approved deployment variables", async () => {
    const config = await loadConfig({
      ASSISTANT_GOOGLE_OAUTH_CLIENT_SECRET: "google-env-sentinel",
      ASSISTANT_TEMPO_OAUTH_CLIENT_SECRET: "tempo-env-sentinel",
      ASSISTANT_SLACK_CLIENT_SECRET: "slack-env-sentinel",
      ASSISTANT_SLACK_APP_TOKEN: "slack-token-env-sentinel",
    });

    assert.equal(config.GOOGLE_OAUTH_CLIENT_SECRET, "google-env-sentinel");
    assert.equal(config.TEMPO_OAUTH_CLIENT_SECRET, "tempo-env-sentinel");
    assert.equal(config.SLACK_STATIC_CONFIG.clientSecret, "slack-env-sentinel");
    assert.equal(
      config.SLACK_STATIC_CONFIG.appToken,
      "slack-token-env-sentinel",
    );
    for (const name of [
      "ASSISTANT_GOOGLE_OAUTH_CLIENT_SECRET",
      "ASSISTANT_TEMPO_OAUTH_CLIENT_SECRET",
      "ASSISTANT_SLACK_CLIENT_SECRET",
      "ASSISTANT_SLACK_APP_TOKEN",
    ])
      assert.equal(
        process.env[name],
        undefined,
        `${name} must be deleted during capture`,
      );
  });

  it("discards legacy aliases without overriding approved secret variables", async () => {
    const config = await loadConfig({
      ASSISTANT_GOOGLE_OAUTH_CLIENT_SECRET: "approved-google-sentinel",
      ASSISTANT_TEMPO_OAUTH_CLIENT_SECRET: "approved-tempo-sentinel",
      GOOGLE_OAUTH_CLIENT_SECRET: "ignored-google-env-secret",
      TEMPO_OAUTH_CLIENT_SECRET: "ignored-tempo-env-secret",
    });

    assert.equal(config.GOOGLE_OAUTH_CLIENT_SECRET, "approved-google-sentinel");
    assert.equal(config.TEMPO_OAUTH_CLIENT_SECRET, "approved-tempo-sentinel");
    assert.equal(process.env.GOOGLE_OAUTH_CLIENT_SECRET, undefined);
    assert.equal(process.env.TEMPO_OAUTH_CLIENT_SECRET, undefined);
  });

  it("empties Slack app credentials when disabled, whatever the environment says", async () => {
    const config = await loadConfig({
      ASSISTANT_SLACK_APP_DISABLED: "1",
      ASSISTANT_SLACK_APP_TOKEN: "slack-token-env-sentinel",
      ASSISTANT_SLACK_CLIENT_SECRET: "slack-env-sentinel",
    });

    assert.equal(config.SLACK_STATIC_CONFIG.appToken, "");
    assert.equal(config.SLACK_STATIC_CONFIG.clientId, "");
    assert.equal(config.SLACK_STATIC_CONFIG.clientSecret, "");
    assert.equal(config.SLACK_STATIC_CONFIG.teamId, "T1");
    assert.equal(config.SLACK_STATIC_CONFIG.workspaceHost, "example.slack.com");
  });

  it("names no deployment's Atlassian site and ships the Slack scopes itself", async () => {
    const config = await loadConfig({
      ASSISTANT_JIRA_HOST: undefined,
      ASSISTANT_CONFLUENCE_HOST: undefined,
    });

    assert.equal(config.JIRA_HOST, "");
    assert.equal(config.CONFLUENCE_HOST, "");
    assert.ok(config.SLACK_STATIC_CONFIG.botScopes.includes("chat:write"));
    assert.ok(config.SLACK_STATIC_CONFIG.userScopes.includes("search:read"));
  });

  it("keeps the packaged app.json free of deployment values", () => {
    const packaged: unknown = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../config/app.json", import.meta.url)),
        "utf8",
      ),
    );
    assert.deepEqual(packaged, { dataDir: "assistant-data" });
  });
});
