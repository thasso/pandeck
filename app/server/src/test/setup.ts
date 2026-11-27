import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterAll, afterEach, beforeEach, onTestFinished, vi } from "vitest";
import { failOnStateTopicInvariantsForTests } from "../stateTopicKernel.ts";
import {
  installTokenHostGuard,
  takeTokenHostAttempts,
} from "./tokenHostGuard.ts";

// Bun's os.homedir() keeps the HOME the run was launched with, whatever a test
// sets later, and SDK code the tests reach resolves home through it. A Bun run
// launched with the user's real HOME can overwrite ~/.claude credentials, so it
// must start with a throwaway HOME ("Running the server suite under Bun" in
// docs/deployment.md).
if (
  process.versions.bun &&
  !resolve(homedir()).startsWith(resolve(tmpdir()) + sep)
)
  throw new Error(
    `Bun test runs must be launched with HOME set to a fresh temp directory, not ${homedir()}: HOME="$(mktemp -d)" bun ...`,
  );

// No test inherits a route or a credential off this machine. A git child once
// inherited the launching session's HTTPS_PROXY and sent CONNECT for
// github.com to the real proxy; tokens, askpass helpers, foreign CA trust and
// injected git config reach children the same way. A system gitconfig can name
// a credential helper holding real logins (macOS ships osxkeychain), and a
// prompt would hang the run. Tests that exercise these variables set their own
// (docs/child-processes.md#test-environment).
for (const key of [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NODE_USE_ENV_PROXY",
  "GIT_PROXY_COMMAND",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "GIT_SSL_NO_VERIFY",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
])
  delete process.env[key];
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";

// Every database a test opens is a throwaway in a temp directory, so durability
// across a power cut is not under test, and waiting on fsync for every commit
// was half the suite's time. Mocking the module here keeps the setting out of
// production code and out of any environment a server under test hands down.
vi.mock("node:sqlite", async (importOriginal) => {
  const sqlite = await importOriginal<typeof import("node:sqlite")>();
  class DatabaseSync extends sqlite.DatabaseSync {
    constructor(...args: ConstructorParameters<typeof sqlite.DatabaseSync>) {
      super(...args);
      // From the option, not `isOpen`: this file also runs under Bun, whose
      // SQLite adapter refuses `isOpen`.
      if (args[1]?.open !== false) this.exec("PRAGMA synchronous = OFF");
    }
  }
  return { ...sqlite, DatabaseSync };
});

const testCwd = mkdtempSync(join(tmpdir(), "assistant-server-test-"));

process.env.ASSISTANT_CWD = testCwd;
delete process.env.DATA_DIR;
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

// No test reaches a real OAuth token host: the lookup is refused, and the test
// whose renewal or refresh tried it fails (`tokenHostGuard.ts`).
installTokenHostGuard();
function failOnTokenHostAttempts(): void {
  const hosts = takeTokenHostAttempts();
  if (hosts.length)
    throw new Error(`a real token host was asked for: ${hosts.join(", ")}`);
}
beforeEach(() => onTestFinished(failOnTokenHostAttempts));

// A missed reporter fails the test that caused it, whatever catch converted
// the throw on its way out: the violation was recorded where it was found, in
// a ledger every kernel instance of this worker shares (`stateTopicKernel.ts`).
afterEach(() => failOnStateTopicInvariantsForTests());

afterAll(() => {
  failOnTokenHostAttempts();
  rmSync(testCwd, { recursive: true, force: true });
});
