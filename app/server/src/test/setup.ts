import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

// Every database a test opens is a throwaway in a temp directory, so durability
// across a power cut is not under test, and waiting on fsync for every commit
// was half the suite's time. Mocking the module here keeps the setting out of
// production code and out of any environment a server under test hands down.
vi.mock("node:sqlite", async (importOriginal) => {
  const sqlite = await importOriginal<typeof import("node:sqlite")>();
  class DatabaseSync extends sqlite.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof sqlite.DatabaseSync>) {
      super(...args);
      // From the option, not `isOpen`: the Bun SQLite adapter refuses members
      // the server never uses, and this file also runs under Bun
      // (docs/deployment.md#running-the-server-suite-under-bun).
      if (args[1]?.open !== false) this.exec("PRAGMA synchronous = OFF");
    }
  }
  return { ...sqlite, DatabaseSync };
});

const testCwd = mkdtempSync(join(tmpdir(), "assistant-server-test-"));

process.env.ASSISTANT_CWD = testCwd;
delete process.env.DATA_DIR;
// Production performs a one-time legacy pi seed. Tests must never inspect the
// developer's real ~/.pi; targeted migration tests pass an explicit source.
process.env.ASSISTANT_LEGACY_PI_AGENT_DIR = join(testCwd, "no-legacy-pi-agent");
// The packaged config/app.json names no deployment, and the integrations refuse
// to run without their site, workspace and client ids. Suites run against this
// fixture deployment instead; config.test.ts covers the unconfigured default.
const fixtureConfig = join(testCwd, "app.json");
writeFileSync(
  fixtureConfig,
  JSON.stringify({
    dataDir: "assistant-data",
    publicBaseUrl: "https://assistant.example.invalid",
    google: { oauthClientId: "fixture-google-client-id" },
    jira: { host: "example.atlassian.net" },
    tempo: { oauthClientId: "fixture-tempo-client-id" },
    slack: {
      workspaceHost: "example.slack.com",
      teamId: "T0FIXTURE",
      clientId: "fixture-slack-client-id",
    },
  }),
);
process.env.ASSISTANT_CONFIG = fixtureConfig;

afterAll(() => {
  rmSync(testCwd, { recursive: true, force: true });
});
