/**
 * Task-1368 AC17 (RV-1368-02): a 401 after the gateway renewed a login is
 * transient, never a dead login. A real in-process link, health store and
 * usage cache; a Claude and a Codex account, each fake-expired; token hosts
 * that renew, and upstreams that answer 401 to every renewed token. The
 * sibling: a renewal answered `invalid_grant` is the gateway's needs-login.
 * Every upstream and token host is a fake; `fetch` answers anything off
 * loopback itself.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";

vi.mock("./accountHealth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accountHealth.ts")>();
  return {
    ...actual,
    reportAccountUsageFailure: vi.fn(actual.reportAccountUsageFailure),
  };
});

const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_MODEL_ID = "gpt-5.6-luna";
// Synthetic fixture values; none is a real credential.
const FAKE_ACCOUNT = "acct-renewed-unauthorized";
const CLAUDE_RENEWED = "fake-ac17-claude-renewed";
const CODEX_RENEWED = "renewed-ac17";

function fakeJwt(tag: string): string {
  const part = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({
    tag,
    "https://api.openai.com/auth": { chatgpt_account_id: FAKE_ACCOUNT },
  })}.sig`;
}

/** Whether the token hosts renew or reject with `invalid_grant`. */
let renews = true;
let codexRenewals = 0;
const realFetch = globalThis.fetch;
vi.stubGlobal(
  "fetch",
  async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    if (url.href !== CODEX_TOKEN_URL)
      return new Response("{}", { status: 404 });
    codexRenewals += 1;
    return renews
      ? Response.json({
          access_token: fakeJwt(`${CODEX_RENEWED}-${codexRenewals}`),
          refresh_token: `fake-ac17-codex-refresh-${codexRenewals}`,
          expires_in: 3600,
        })
      : Response.json({ error: "invalid_grant" }, { status: 400 });
  },
);

const health = await import("./accountHealth.ts");
const { analyzeProviderError, loginEnded, runFailureFacts } =
  await import("./providerErrors.ts");
const profiles = await import("./credentialProfiles.ts");
const { rotatingClaudeTokens, startFakeUpstreams } =
  await import("./test/gatewayFixtures.ts");
const { startGatewayLink } = await import("./gatewayLink.ts");
const { followGatewayCredentialStatuses } = await import("./gatewayHealth.ts");
const { renewCodexCredential } = await import("./piSdk/codexRenewal.ts");
const { runPiOneShot } = await import("./piSdk/oneShot.ts");
const { readUsageSnapshot, resetUsageCacheForTests } =
  await import("./usageCache.ts");

/** Every bearer an upstream saw. */
const bearers: string[] = [];
const unauthorized = (
  seen: { headers: Record<string, string | string[] | undefined> },
  res: ServerResponse,
): void => {
  bearers.push(String(seen.headers.authorization));
  res.writeHead(401, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "Invalid bearer token" },
    }),
  );
};
const claudeRenewal = rotatingClaudeTokens(CLAUDE_RENEWED);
const upstreams = await startFakeUpstreams({
  claude: unauthorized,
  codex: unauthorized,
  claudeToken: (seen, res) => {
    if (renews) return claudeRenewal(seen, res);
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_grant" }));
  },
});

const push = vi.fn(async () => {});
health.initializeAccountHealth({
  broadcast: () => {},
  push,
  profiles: profiles.listCredentialProfiles,
  hasCredential: profiles.credentialProfileHasCredential,
  subscribeChanges: profiles.subscribeCredentialProfileChanges,
  subscribeDeleted: profiles.subscribeCredentialProfileDeleted,
});

const stateRoot = mkdtempSync(join(tmpdir(), "renewed401"));
const lines: string[] = [];
const link = startGatewayLink({
  stateDir: join(stateRoot, "state"),
  port: 0,
  log: (line) => lines.push(line),
  upstreams: upstreams.overrides,
  claudeTokenEndpoint: upstreams.tokenEndpoint,
  renewCodex: renewCodexCredential,
});
/** Every status the link reported, in order. */
const reported: [string, boolean][] = [];
link.onCredentialStatus((id, needsLogin) => reported.push([id, needsLogin]));
let unfollow: () => void = () => {};

beforeAll(async () => {
  assert.equal(await link.ready, true, lines.join("\n"));
  unfollow = followGatewayCredentialStatuses(link);
});
afterEach(() => {
  resetUsageCacheForTests();
  push.mockClear();
  bearers.length = 0;
  reported.length = 0;
});
afterAll(async () => {
  unfollow();
  await link.close();
  await upstreams.close();
  vi.unstubAllGlobals();
  rmSync(stateRoot, { recursive: true, force: true });
});

const EXPIRED = Date.now() - 3_600_000;

function claudeAccount(name: string): { id: string; file: string } {
  const id = profiles.createCredentialProfile({ name, provider: "claude" }).id;
  const file = join(profiles.claudeConfigDir(id), ".credentials.json");
  writeFileSync(
    file,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `fake-ac17-claude-expired-${id}`,
        refreshToken: `fake-ac17-claude-refresh-${id}`,
        expiresAt: EXPIRED,
        subscriptionType: "max",
      },
    }),
  );
  return { id, file };
}

function codexAccount(name: string): { id: string; file: string } {
  const id = profiles.createCredentialProfile({
    name,
    provider: "openai-codex",
  }).id;
  const file = join(profiles.piAgentDir(id), "auth.json");
  writeFileSync(
    file,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: fakeJwt(`expired-${id}`),
        refresh: `fake-ac17-codex-refresh-${id}`,
        expires: EXPIRED,
        accountId: FAKE_ACCOUNT,
      },
    }),
  );
  return { id, file };
}

/** A Codex one-shot on the server lease, through the gateway's pi port. */
async function codexOneShot(profileId: string): Promise<string> {
  const access = await link.serverAccess(profileId);
  const result = await runPiOneShot({
    model: {
      id: CODEX_MODEL_ID,
      name: CODEX_MODEL_ID,
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    } as Parameters<typeof runPiOneShot>[0]["model"],
    credentialProfileId: profileId,
    thinkingLevel: "off",
    systemPrompt: "system",
    prompt: "prompt",
    timeoutMs: 20_000,
    timeoutMessage: "The fixture timed out.",
    gateway: { baseUrl: link.gateway!.url, leaseToken: access.leaseToken },
  });
  // A pi turn reports its end in the result; success fails the proof.
  assert.equal(result.stopReason, "error", "the one-shot must fail");
  return result.errorMessage ?? "";
}

const state = (id: string) => health.readAccountHealth(id, true).state;

test("1368 AC17: a 401 on a renewed token is transient for both usage providers and the pi engine", async () => {
  renews = true;
  const claude = claudeAccount("AC17 Claude");
  const codex = codexAccount("AC17 Codex");
  const before = [statSync(claude.file).ino, statSync(codex.file).ino];
  const usageFailure = vi.mocked(health.reportAccountUsageFailure);
  usageFailure.mockClear();

  await assert.rejects(
    readUsageSnapshot(claude.id, "claude", { force: true }),
    {
      message: "Claude did not accept the usage request.",
    },
  );
  await assert.rejects(
    readUsageSnapshot(codex.id, "openai-codex", { force: true }),
    { message: "OpenAI usage request failed (HTTP 401)." },
  );
  // The renewals came first: each file was renamed in, and no upstream ever
  // saw a token but a renewed one.
  assert.ok(upstreams.platform.length >= 1, "Claude renewed");
  assert.ok(codexRenewals >= 1, "Codex renewed");
  assert.notEqual(statSync(claude.file).ino, before[0]);
  assert.notEqual(statSync(codex.file).ino, before[1]);
  assert.ok(bearers.length >= 2, "both upstreams were asked");
  for (const bearer of bearers)
    assert.ok(
      bearer.startsWith(`Bearer ${CLAUDE_RENEWED}-access-`) ||
        isRenewedCodex(bearer),
      `a renewed token: ${bearer.slice(0, 24)}`,
    );
  assert.ok(
    usageFailure.mock.calls.some(
      ([id, text]) =>
        id === claude.id && text === "Claude did not accept the usage request.",
    ),
    "Claude's failure reached health",
  );

  // The pi engine on the same 401, reported as a run's failure is.
  const text = await codexOneShot(codex.id);
  const facts = runFailureFacts(
    analyzeProviderError(text, { provider: "openai-codex", statusCode: 401 }),
  );
  health.reportAccountRunFailure(codex.id, facts, "openai-codex");
  assert.equal(loginEnded(facts, true), false);

  for (const id of [claude.id, codex.id])
    assert.notEqual(state(id), "needs-login", `${id} is not needs-login`);
  assert.equal(push.mock.calls.length, 0);
  assert.deepEqual(
    reported.filter(([, needsLogin]) => needsLogin),
    [],
    "the link never heard needsLogin:true",
  );
  assert.deepEqual(link.needsLoginProfiles(), []);
});

/** Whether a Codex bearer is one the fake token host issued. */
function isRenewedCodex(bearer: string): boolean {
  const payload = bearer.replace(/^Bearer /, "").split(".")[1] ?? "";
  try {
    const tag = (
      JSON.parse(Buffer.from(payload, "base64url").toString()) as {
        tag?: string;
      }
    ).tag;
    return tag?.startsWith(`${CODEX_RENEWED}-`) === true;
  } catch {
    return false;
  }
}

test("1368 AC17 sibling: a renewal answered invalid_grant is the gateway's needs-login", async () => {
  renews = false;
  try {
    const claude = claudeAccount("AC17 Claude rejected");
    const codex = codexAccount("AC17 Codex rejected");
    await readUsageSnapshot(claude.id, "claude", { force: true }).catch(
      () => {},
    );
    await readUsageSnapshot(codex.id, "openai-codex", { force: true }).catch(
      () => {},
    );
    for (const id of [claude.id, codex.id]) {
      assert.equal(state(id), "needs-login", `${id} needs a login`);
      assert.ok(reported.some(([seen, needs]) => seen === id && needs));
    }
    assert.deepEqual(
      link.needsLoginProfiles().sort(),
      [claude.id, codex.id].sort(),
    );
    assert.equal(push.mock.calls.length, 2, "one push per account");
    // The engine's turn is refused with the needs-login text.
    const text = await codexOneShot(codex.id);
    const facts = runFailureFacts(analyzeProviderError(text));
    assert.equal(facts.gatewayNeedsLogin, true, text);
    assert.equal(loginEnded(facts, true), true);
  } finally {
    renews = true;
  }
});
