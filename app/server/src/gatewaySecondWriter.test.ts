/**
 * Task-1368 AC7, the second-writer proof (C13): with the gateway on, the
 * gateway is the only refresher. Expired fake logins for claude-default (in
 * `DATA_DIR`), a named Claude account and two Codex accounts. The server's pi
 * runtimes ask no token host; each account's first usage read renews it once,
 * through the gateway; a Codex one-shot on the gateway's pi port and later
 * reads renew nothing more. Every upstream and token host is a fake, and
 * `fetch` answers anything off loopback itself.
 */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";

vi.mock("./config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.ts")>();
  return { ...actual, GATEWAY_ENABLED: true };
});

const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_MODEL_ID = "gpt-5.6-luna";
// Synthetic fixture values; none is a real credential.
const FAKE_CLAUDE_ACCESS = "fake-second-writer-claude-access";
const FAKE_CODEX_ACCOUNT = "acct-second-writer";

function fakeJwt(tag: string): string {
  const part = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({
    tag,
    "https://api.openai.com/auth": { chatgpt_account_id: FAKE_CODEX_ACCOUNT },
  })}.sig`;
}

/** Codex token requests, by the refresh token each carried. */
const codexRenewals: string[] = [];
/** Requests `fetch` answered off loopback, as `METHOD host/path`. */
const offLoopback: string[] = [];
const realFetch = globalThis.fetch;
vi.stubGlobal(
  "fetch",
  async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (url.hostname === "127.0.0.1") return realFetch(input, init);
    const method =
      init.method ?? (input instanceof Request ? input.method : "GET");
    offLoopback.push(`${method} ${url.host}${url.pathname}`);
    if (url.href === CODEX_TOKEN_URL) {
      const refresh = new URLSearchParams(String(init.body ?? "")).get(
        "refresh_token",
      );
      codexRenewals.push(refresh ?? "");
      return Response.json({
        access_token: fakeJwt(`renewed-${codexRenewals.length}`),
        refresh_token: `fake-second-writer-renewed-${codexRenewals.length}`,
        expires_in: 3600,
      });
    }
    // The catalog and anything else: refused, so nothing real is reached.
    return new Response("{}", { status: 404 });
  },
);

const { MEASURED_USAGE } = await import("./test/claudeUsageFixtures.ts");
const { fakeCodexStream, startFakeUpstreams } =
  await import("./test/gatewayFixtures.ts");
const profiles = await import("./credentialProfiles.ts");
const { startGatewayLink } = await import("./gatewayLink.ts");
const { renewCodexCredential } = await import("./piSdk/codexRenewal.ts");
const { fetchClaudeAccountUsage, fetchOpenAiAccountUsage } =
  await import("./harnesses/usage.ts");

const codexAnswer = fakeCodexStream("second-writer answer");
const upstreams = await startFakeUpstreams({
  claude: (seen, res) => {
    res.writeHead(seen.url === "/api/oauth/usage" ? 200 : 404, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(MEASURED_USAGE));
  },
  codex: (seen, res) => {
    if (seen.url.endsWith("/codex/responses")) return codexAnswer(seen, res);
    res.writeHead(seen.url.endsWith("/wham/usage") ? 200 : 404, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify({
        plan_type: "plus",
        rate_limit: { allowed: true, limit_reached: false },
      }),
    );
  },
});

interface Account {
  id: string;
  provider: "claude" | "openai-codex";
  file: string;
  refresh: string;
}

const EXPIRED = Date.now() - 3_600_000;

function claudeAccount(id: string): Account {
  const file = join(profiles.claudeConfigDir(id), ".credentials.json");
  const refresh = `fake-second-writer-claude-refresh-${id}`;
  writeFileSync(
    file,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: FAKE_CLAUDE_ACCESS,
        refreshToken: refresh,
        expiresAt: EXPIRED,
        subscriptionType: "max",
      },
    }),
  );
  return { id, provider: "claude", file, refresh };
}

function codexAccount(name: string): Account {
  const id = profiles.createCredentialProfile({
    name,
    provider: "openai-codex",
  }).id;
  const file = join(profiles.piAgentDir(id), "auth.json");
  const refresh = `fake-second-writer-codex-refresh-${id}`;
  writeFileSync(
    file,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: fakeJwt(`expired-${id}`),
        refresh,
        expires: EXPIRED,
        accountId: FAKE_CODEX_ACCOUNT,
      },
    }),
  );
  return { id, provider: "openai-codex", file, refresh };
}

const accounts: Account[] = [
  claudeAccount(profiles.DEFAULT_CLAUDE_PROFILE_ID),
  claudeAccount(
    profiles.createCredentialProfile({ name: "Named", provider: "claude" }).id,
  ),
  codexAccount("Codex one"),
  codexAccount("Codex two"),
];

interface Identity {
  ino: number;
  bytes: string;
}
const identity = (account: Account): Identity => ({
  ino: statSync(account.file).ino,
  bytes: readFileSync(account.file, "utf8"),
});

/** Token requests that carried this account's refresh token, either host. */
function renewalsOf(account: Account): number {
  if (account.provider === "openai-codex")
    return codexRenewals.filter((refresh) => refresh === account.refresh)
      .length;
  return upstreams.platform.filter((seen) =>
    seen.body.toString().includes(account.refresh),
  ).length;
}

const stateRoot = mkdtempSync(join(tmpdir(), "secondwriter"));
const lines: string[] = [];
const link = startGatewayLink({
  stateDir: join(stateRoot, "state"),
  port: 0,
  log: (line) => lines.push(line),
  upstreams: upstreams.overrides,
  claudeTokenEndpoint: upstreams.tokenEndpoint,
  renewCodex: renewCodexCredential,
});

beforeAll(async () => {
  assert.equal(await link.ready, true, lines.join("\n"));
});
afterAll(async () => {
  await link.close();
  await upstreams.close();
  vi.unstubAllGlobals();
  rmSync(stateRoot, { recursive: true, force: true });
});

const initial = accounts.map(identity);
let renewed: Identity[];

test("1368 AC7 step 1: model runtime creation, warm-up and the forced refresh renew nothing", async () => {
  const models = await import("./piSdk/models.ts");
  await models.warmCredentialProfileModelRuntimes();
  await models.refreshModels();
  for (const account of accounts)
    assert.equal(renewalsOf(account), 0, `${account.id} not renewed`);
  assert.ok(
    !offLoopback.includes(`POST auth.openai.com/oauth/token`),
    offLoopback.join(", "),
  );
  assert.deepEqual(accounts.map(identity), initial, "every file untouched");
});

test("1368 AC7 step 2: each account's first usage read renews it once, through the gateway", async () => {
  for (const account of accounts)
    if (account.provider === "claude")
      assert.equal(
        (await fetchClaudeAccountUsage(account.id, 20_000)).rateLimitsAvailable,
        true,
      );
    else
      assert.equal((await fetchOpenAiAccountUsage(account.id)).available, true);
  renewed = accounts.map(identity);
  accounts.forEach((account, index) => {
    assert.equal(renewalsOf(account), 1, `${account.id}: one renewal`);
    assert.notEqual(renewed[index]!.ino, initial[index]!.ino, "renamed in");
    assert.notEqual(renewed[index]!.bytes, initial[index]!.bytes);
  });
});

test("1368 AC7 step 3: a Codex one-shot on the gateway's pi port and later reads renew nothing more", async () => {
  const { runPiOneShot } = await import("./piSdk/oneShot.ts");
  const codex = accounts.find(
    (account) => account.provider === "openai-codex",
  )!;
  const access = await link.serverAccess(codex.id);
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
    credentialProfileId: codex.id,
    thinkingLevel: "off",
    systemPrompt: "system",
    prompt: "prompt",
    timeoutMs: 20_000,
    timeoutMessage: "The fixture timed out.",
    gateway: { baseUrl: link.gateway!.url, leaseToken: access.leaseToken },
  });
  assert.equal(result.text, "second-writer answer");
  assert.ok(
    upstreams.chatgpt.some((seen) => seen.url.endsWith("/codex/responses")),
    "the one-shot reached the fake upstream through the gateway",
  );
  for (const account of accounts)
    if (account.provider === "claude")
      await fetchClaudeAccountUsage(account.id, 20_000);
    else await fetchOpenAiAccountUsage(account.id);
  for (const account of accounts)
    assert.equal(renewalsOf(account), 1, `${account.id}: still one renewal`);
  assert.deepEqual(accounts.map(identity), renewed, "no second write");
});
