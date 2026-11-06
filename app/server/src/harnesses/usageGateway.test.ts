/**
 * Codex usage, reset credits and the irreversible consume under the credential
 * gateway (G4a), and Claude usage (G4b): the server's requests carry only its
 * lease, the gateway adds the profile's token and account id, and a gateway
 * refusal is a temporary failure that never benches the account. Claude usage
 * runs no CLI child and refreshes nothing. Every upstream is a fake; nothing
 * here may consume a real credit.
 */
import assert from "node:assert/strict";
import type {
  ClaudeUsageSnapshot,
  OpenAiUsageSnapshot,
} from "@assistant/shared/usage";
import type { CredentialProfileSummary } from "@assistant/shared";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import {
  initializeAccountHealth,
  readAccountBench,
  readAccountHealth,
  reportAccountUsageFailure,
  withAccountHealthProfiles,
} from "../accountHealth.ts";
import { setClaudeSdkUsageSeam } from "../claudeSdk/usageQuery.ts";
import {
  claudeConfigDir,
  createCredentialProfile,
  deleteCredentialProfile,
  listCredentialProfiles,
  piAgentDir,
} from "../credentialProfiles.ts";
import { GATEWAY_REFUSAL_MARKER, refusalText } from "../gateway/refusals.ts";
import { analyzeProviderError, runFailureFacts } from "../providerErrors.ts";
import { DRIFTED_USAGE, MEASURED_USAGE } from "../test/claudeUsageFixtures.ts";
import {
  startEgressObserver,
  startFakeUpstreams,
  type EgressObserver,
  type FakeUpstreams,
  type UpstreamResponder,
} from "../test/gatewayFixtures.ts";
import {
  startGatewayLinkForTests,
  type TestGatewayLink,
} from "../test/gatewayLink.ts";
import {
  cachedUsageIndicator,
  peekUsageSnapshot,
  readUsageSnapshot,
  resetUsageCacheForTests,
} from "../usageCache.ts";
import {
  fetchClaudeAccountUsage,
  fetchOpenAiAccountUsage,
  redeemOpenAiResetCredit,
} from "./usage.ts";

/** A cache read of a Codex account: always an OpenAI snapshot. */
async function readCodexUsage(id: string): Promise<OpenAiUsageSnapshot> {
  return (await readUsageSnapshot(id, "openai-codex", {
    force: true,
  })) as OpenAiUsageSnapshot;
}

// Synthetic fixture values; none is a real credential.
const FAKE_ACCESS = "fake-codex-access";
const FAKE_ACCOUNT = "fake-account";
const CREDIT = "RateLimitResetCredit_fixture";
const FAKE_CLAUDE_ACCESS = "fake-claude-access";
const FAKE_CLAUDE_REFRESH = "fake-claude-refresh";

const USAGE = {
  plan_type: "plus",
  rate_limit: { allowed: true, limit_reached: true, primary_window: null },
  rate_limit_reset_credits: {
    available_count: 1,
    applicable_available_count: 1,
  },
};
const CREDITS = {
  available_count: 1,
  credits: [
    { id: CREDIT, status: "available", expires_at: "2030-01-01T00:00:00Z" },
  ],
};
const CONSUMED = { code: "reset", windows_reset: 1, credit: { id: CREDIT } };

/** How the fake chatgpt.com answers each wham path; "reset" drops the socket. */
type Answer = { status: number; body: unknown } | "reset";
let answers: Record<string, Answer>;

function answerOf(path: string): Answer {
  return answers[path] ?? { status: 404, body: { error: "not found" } };
}

const wham: UpstreamResponder = (seen, res) => {
  const answer = answerOf(seen.url.replace("/backend-api/wham/", ""));
  if (answer === "reset") {
    res.socket?.destroy();
    return;
  }
  res.writeHead(answer.status, { "content-type": "application/json" });
  res.end(JSON.stringify(answer.body));
};

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** How the fake api.anthropic.com answers `GET /api/oauth/usage`. */
let claudeAnswer: Answer;

const anthropicUsage: UpstreamResponder = (seen, res) => {
  const answer =
    seen.method === "GET" && seen.url === "/api/oauth/usage"
      ? claudeAnswer
      : { status: 404, body: { error: "not found" } };
  if (answer === "reset") {
    res.socket?.destroy();
    return;
  }
  res.writeHead(answer.status, { "content-type": "application/json" });
  res.end(
    typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body),
  );
};

/** Any CLI usage child under the switch: none may start. */
const cliUsageChild = vi.fn(() =>
  Promise.reject(new Error("no CLI usage child under the gateway")),
);

let upstreams: FakeUpstreams;
let gateway: TestGatewayLink;
let egress: EgressObserver;
/** What the server sent the gateway's listener, through a wrapped `fetch`. */
let sent: Sent[];

/** The health store's view of the registry, as the server syncs it. */
function healthProfiles(): CredentialProfileSummary[] {
  return withAccountHealthProfiles(() =>
    listCredentialProfiles().map((profile) => ({
      ...profile,
      health: readAccountHealth(profile.id, true),
    })),
  );
}

beforeAll(async () => {
  initializeAccountHealth({
    profiles: healthProfiles,
    hasCredential: () => true,
    push: async () => {},
    broadcast: () => {},
    subscribeChanges: () => () => {},
    subscribeDeleted: () => () => {},
  });
  setClaudeSdkUsageSeam(cliUsageChild);
  upstreams = await startFakeUpstreams({ codex: wham, claude: anthropicUsage });
  gateway = await startGatewayLinkForTests({ upstreams: upstreams.overrides });
  egress = startEgressObserver([`127.0.0.1:${gateway.link.gateway!.port}`]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetUsageCacheForTests();
  upstreams.reset();
  assert.deepEqual(egress.unauthorized(), [], "nothing left for elsewhere");
  assert.equal(cliUsageChild.mock.calls.length, 0, "no CLI usage child");
});

afterAll(async () => {
  egress.close();
  await gateway.close();
  await upstreams.close();
  // AC18: no log line of all of the above holds a credential, query or body.
  assert.ok(gateway.lines.length > 0);
  for (const line of gateway.lines)
    for (const value of [
      ...leases,
      ...leases.map((token) => token.split(".").at(-1)!),
      FAKE_ACCESS,
      FAKE_ACCOUNT,
      FAKE_CLAUDE_ACCESS,
      FAKE_CLAUDE_REFRESH,
      CREDIT,
      "redeem_request_id",
      "?",
    ])
      assert.ok(!line.includes(value), `a log line holds ${value}: ${line}`);
});

/** Every lease token the tests saw, for AC18's log check. */
const leases: string[] = [];

function writeAuth(id: string, entry: Record<string, unknown>): void {
  writeFileSync(
    join(piAgentDir(id), "auth.json"),
    JSON.stringify({ "openai-codex": entry }),
  );
}

const LOGIN = {
  type: "oauth",
  access: FAKE_ACCESS,
  refresh: "fake-refresh",
  expires: Date.now() + 86_400_000,
  accountId: FAKE_ACCOUNT,
};

/** A signed-in Codex profile, its server lease, and the wrapped `fetch`. */
async function leased(name: string): Promise<{ id: string; lease: string }> {
  const id = createCredentialProfile({ name, provider: "openai-codex" }).id;
  writeAuth(id, LOGIN);
  answers = {
    usage: { status: 200, body: USAGE },
    "rate-limit-reset-credits": { status: 200, body: CREDITS },
    "rate-limit-reset-credits/consume": { status: 200, body: CONSUMED },
  };
  recordSent();
  const lease = (await gateway.link.serverAccess(id)).leaseToken;
  leases.push(lease);
  return { id, lease };
}

/** Records into `sent` what the server sends, through a wrapped `fetch`. */
function recordSent(): void {
  sent = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({
      method: init.method ?? "GET",
      url,
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? init.body : "",
    });
    return realFetch(url, init);
  });
}

function serverLeaseId(profileId: string): string {
  const record = gateway.link
    .gateway!.leases.records()
    .find((r) => r.kind === "server" && r.profileId === profileId);
  assert.ok(record, "the profile has a server lease");
  return record.leaseId;
}

const consumes = (): number =>
  upstreams.chatgpt.filter((seen) => seen.url.endsWith("/consume")).length;

test("AC15: usage, credits and a redeem go through the gateway; only it puts the token and account id on them", async () => {
  const { id, lease } = await leased("Usage through the gateway");
  const snapshot = await fetchOpenAiAccountUsage(id);
  assert.equal(snapshot.available, true);
  assert.deepEqual(
    snapshot.resetCredits?.credits?.map((credit) => credit.id),
    [CREDIT],
  );
  const redeemed = await redeemOpenAiResetCredit(id, CREDIT, {
    redeemRequestId: "redeem-ac15",
  });
  assert.equal(redeemed.ok, true);

  const base = `${gateway.link.gateway!.url}/chatgpt/backend-api/wham`;
  assert.deepEqual(
    sent.map(({ method, url }) => [method, url]),
    [
      ["GET", `${base}/usage`],
      ["GET", `${base}/rate-limit-reset-credits`],
      ["GET", `${base}/usage`],
      ["POST", `${base}/rate-limit-reset-credits/consume`],
    ],
  );
  for (const request of sent) {
    assert.equal(request.headers.Authorization, `Bearer ${lease}`);
    const text = JSON.stringify(request);
    assert.ok(!text.includes(FAKE_ACCESS), "no Codex token from the server");
    assert.ok(!text.includes(FAKE_ACCOUNT), "no account id from the server");
  }
  assert.deepEqual(
    upstreams.chatgpt.map((seen) => [
      seen.method,
      seen.url,
      seen.headers.authorization,
      seen.headers["chatgpt-account-id"],
    ]),
    [
      ["GET", "/backend-api/wham/usage", `Bearer ${FAKE_ACCESS}`, FAKE_ACCOUNT],
      [
        "GET",
        "/backend-api/wham/rate-limit-reset-credits",
        `Bearer ${FAKE_ACCESS}`,
        FAKE_ACCOUNT,
      ],
      ["GET", "/backend-api/wham/usage", `Bearer ${FAKE_ACCESS}`, FAKE_ACCOUNT],
      [
        "POST",
        "/backend-api/wham/rate-limit-reset-credits/consume",
        `Bearer ${FAKE_ACCESS}`,
        FAKE_ACCOUNT,
      ],
    ],
  );
  assert.deepEqual(JSON.parse(upstreams.chatgpt[3]!.body.toString()), {
    credit_id: CREDIT,
    redeem_request_id: "redeem-ac15",
  });
});

/** The gateway refusals a server lease meets on usage, and how each is caused. */
const REFUSALS: [string, (id: string) => Promise<void>, RegExp][] = [
  [
    "401 revoked lease",
    (id) => gateway.link.revokeLease(serverLeaseId(id), "account-switch"),
    new RegExp(
      escape(refusalText({ case: "revoked-lease", reason: "account-switch" })),
    ),
  ],
  [
    "401 credential missing its account id",
    async (id) => writeAuth(id, { ...LOGIN, accountId: undefined }),
    new RegExp(
      escape(
        refusalText({
          case: "needs-login",
          name: "Usage refused: 401 credential missing its account id",
        }),
      ),
    ),
  ],
  [
    "502 unreachable",
    async () => {
      answers.usage = "reset";
    },
    new RegExp(
      `^${escape(GATEWAY_REFUSAL_MARKER)} ChatGPT could not be reached`,
    ),
  ],
];

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test.each(REFUSALS)(
  "AC16: a gateway %s keeps the last snapshot and never benches the account",
  async (name, refuse, text) => {
    const { id } = await leased(`Usage refused: ${name}`);
    const good = await readCodexUsage(id);
    assert.equal(good.available, true);

    await refuse(id);
    await assert.rejects(readCodexUsage(id), { message: text });
    assert.equal(peekUsageSnapshot(id, "openai-codex")?.snapshot, good);
    assert.notEqual(readAccountHealth(id, true).state, "needs-login");
  },
);

test("AC16/1368 AC4: an upstream's own 401 is transient, never a rejected login", async () => {
  const { id } = await leased("Usage rejected upstream");
  const good = await readCodexUsage(id);
  answers.usage = { status: 401, body: { error: "unauthorized" } };
  await assert.rejects(readCodexUsage(id), {
    message: "OpenAI usage request failed (HTTP 401).",
  });
  assert.equal(peekUsageSnapshot(id, "openai-codex")?.snapshot, good);
  assert.notEqual(readAccountHealth(id, true).state, "needs-login");
});

test("AC17a: a revoked server lease consumes nothing", async () => {
  const { id } = await leased("Consume revoked");
  await gateway.link.revokeLease(serverLeaseId(id), "account-switch");
  const marked = {
    message: refusalText({ case: "revoked-lease", reason: "account-switch" }),
  };
  await assert.rejects(redeemOpenAiResetCredit(id, CREDIT), marked);
  await assert.rejects(
    redeemOpenAiResetCredit(id, CREDIT, { requireApplicable: false }),
    marked,
  );
  assert.equal(upstreams.chatgpt.length, 0);
});

test("AC17b: a usage re-check the gateway refuses consumes nothing", async () => {
  const { id } = await leased("Consume re-check refused");
  answers.usage = "reset";
  await assert.rejects(redeemOpenAiResetCredit(id, CREDIT), {
    message: new RegExp(`^${escape(GATEWAY_REFUSAL_MARKER)} ChatGPT`),
  });
  assert.equal(consumes(), 0);
});

test("AC17c: a consume the upstream dropped is sent once, and its retry carries the same request id", async () => {
  const { id } = await leased("Consume dropped");
  answers["rate-limit-reset-credits/consume"] = "reset";
  await assert.rejects(
    redeemOpenAiResetCredit(id, CREDIT, { redeemRequestId: "redeem-once" }),
    { message: new RegExp(`^${escape(GATEWAY_REFUSAL_MARKER)} ChatGPT`) },
  );
  assert.equal(consumes(), 1);

  answers["rate-limit-reset-credits/consume"] = { status: 200, body: CONSUMED };
  const retried = await redeemOpenAiResetCredit(id, CREDIT, {
    redeemRequestId: "redeem-once",
  });
  assert.equal(retried.ok, true);
  const ids = upstreams.chatgpt
    .filter((seen) => seen.url.endsWith("/consume"))
    .map((seen) => JSON.parse(seen.body.toString()).redeem_request_id);
  assert.deepEqual(ids, ["redeem-once", "redeem-once"]);
});

test("AC17d: an engine lease never reaches the consume", async () => {
  const { id } = await leased("Consume by an engine");
  const engine = await gateway.link.grantEngineLease({
    workerId: undefined,
    profileId: id,
  });
  leases.push(engine.token);
  vi.unstubAllGlobals();
  const res = await fetch(
    `${gateway.link.gateway!.url}/chatgpt/backend-api/wham/rate-limit-reset-credits/consume`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${engine.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ credit_id: CREDIT, redeem_request_id: "engine" }),
    },
  );
  assert.equal(res.status, 403);
  assert.equal(
    ((await res.json()) as { error: { message: string } }).error.message,
    refusalText({ case: "forbidden" }),
  );
  assert.equal(upstreams.chatgpt.length, 0);
});

// --- Claude usage (G4b) ---

function claudeCredentialFile(id: string): string {
  return join(claudeConfigDir(id), ".credentials.json");
}

function writeClaudeCredential(id: string, expiresAt: number): void {
  writeFileSync(
    claudeCredentialFile(id),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: FAKE_CLAUDE_ACCESS,
        refreshToken: FAKE_CLAUDE_REFRESH,
        expiresAt,
        subscriptionType: "max",
      },
    }),
  );
}

/** A signed-in Claude profile answering the measured body, and its lease. */
async function claudeLeased(
  name: string,
  expiresAt = Date.now() + 86_400_000,
): Promise<{ id: string; lease: string }> {
  const id = createCredentialProfile({ name, provider: "claude" }).id;
  writeClaudeCredential(id, expiresAt);
  // The server's registry feed, which this file's health host leaves out.
  healthProfiles();
  claudeAnswer = { status: 200, body: MEASURED_USAGE };
  recordSent();
  const lease = (await gateway.link.serverAccess(id)).leaseToken;
  leases.push(lease);
  return { id, lease };
}

async function readClaudeUsage(id: string): Promise<ClaudeUsageSnapshot> {
  return (await readUsageSnapshot(id, "claude", {
    force: true,
  })) as ClaudeUsageSnapshot;
}

const usageRequests = (): number =>
  upstreams.anthropic.filter((seen) => seen.url === "/api/oauth/usage").length;

/** AC10: what the server sent carried only the lease, never a Claude token. */
function assertOnlyLeaseSent(lease: string): void {
  assert.ok(sent.length > 0, "the server sent a request");
  for (const request of sent) {
    assert.equal(request.headers.Authorization, `Bearer ${lease}`);
    const text = JSON.stringify(request);
    assert.ok(!text.includes(FAKE_CLAUDE_ACCESS), "no access token sent");
    assert.ok(!text.includes(FAKE_CLAUDE_REFRESH), "no refresh token sent");
  }
}

function isLoginDeathText(text: string): boolean {
  return runFailureFacts(analyzeProviderError(text)).loginDeath === true;
}

test("AC5/AC10: the measured body gives ok, the weekly indicator and no bench, on the lease alone", async () => {
  const { id, lease } = await claudeLeased("Claude usage measured");
  const snapshot = await readClaudeUsage(id);
  assert.equal(snapshot.rateLimitsAvailable, true);
  assert.equal(snapshot.subscriptionType, "max");
  assert.equal(readAccountHealth(id, true).state, "ok");
  assert.deepEqual(
    cachedUsageIndicator({ id, provider: "claude" }).short,
    null,
  );
  assert.deepEqual(cachedUsageIndicator({ id, provider: "claude" }).long, {
    usedPct: 1,
    resetsAt: "2026-11-11T01:00:00.154760+00:00",
  });
  assert.equal(readAccountBench(id, "claude-fable"), undefined);
  assert.equal(usageRequests(), 1);
  const [seen] = upstreams.anthropic;
  assert.equal(seen!.headers.authorization, `Bearer ${FAKE_CLAUDE_ACCESS}`);
  assertOnlyLeaseSent(lease);
});

test.each(DRIFTED_USAGE)(
  "AC5: drift (%s) is unavailable usage, and never a health verdict",
  async (_name, body) => {
    const { id } = await claudeLeased("Claude usage drift");
    await readClaudeUsage(id);
    assert.equal(readAccountHealth(id, true).state, "ok");
    claudeAnswer = { status: 200, body };
    const drifted = await readClaudeUsage(id);
    assert.equal(drifted.rateLimitsAvailable, false);
    assert.equal(drifted.subscriptionType, "max");
    assert.equal(readAccountHealth(id, true).state, "ok");

    reportAccountUsageFailure(id, "401 Unauthorized");
    assert.equal(readAccountHealth(id, true).state, "needs-login");
    const again = await readClaudeUsage(id);
    assert.equal(again.rateLimitsAvailable, false);
    assert.equal(readAccountHealth(id, true).state, "needs-login");
  },
);

const unreachable = new RegExp(
  `^${escape(GATEWAY_REFUSAL_MARKER)} Anthropic could not be reached: [A-Z_]+\\.$`,
);

/** U-G4b-1's cases: how each is caused, and the text it must throw. */
const CLAUDE_FAILURES: [
  string,
  (id: string) => Promise<void>,
  string | RegExp,
][] = [
  [
    "a revoked server lease (marked 401)",
    (id) => gateway.link.revokeLease(serverLeaseId(id), "account-switch"),
    refusalText({ case: "revoked-lease", reason: "account-switch" }),
  ],
  [
    "a malformed credential file (marked 401, needs login)",
    async (id) => writeFileSync(claudeCredentialFile(id), "{not json"),
    refusalText({ case: "needs-login", name: "Claude usage failure" }),
  ],
  [
    "an upstream reset before headers (marked 502)",
    async () => {
      claudeAnswer = "reset";
    },
    unreachable,
  ],
  [
    "an upstream 401",
    async () => {
      claudeAnswer = {
        status: 401,
        body: {
          type: "error",
          error: {
            type: "authentication_error",
            message: "OAuth token has expired",
          },
        },
      };
    },
    "Claude did not accept the usage request.",
  ],
  ...[403, 429, 503].map(
    (status): [string, (id: string) => Promise<void>, string] => [
      `an upstream ${status}`,
      async () => {
        claudeAnswer = {
          status,
          body: { type: "error", error: { type: "x", message: "upstream" } },
        };
      },
      `Claude usage request failed (HTTP ${status}).`,
    ],
  ),
];

test.each(CLAUDE_FAILURES)(
  "AC6: %s throws its text, keeps the snapshot, backs off and sets no health",
  async (_name, cause, text) => {
    const { id } = await claudeLeased("Claude usage failure");
    const good = await readClaudeUsage(id);
    assert.equal(readAccountHealth(id, true).state, "ok");

    await cause(id);
    let thrown = "";
    await assert.rejects(readClaudeUsage(id), (err: Error) => {
      thrown = err.message;
      return true;
    });
    if (typeof text === "string") assert.equal(thrown, text);
    else assert.match(thrown, text);
    assert.ok(!thrown.includes("OAuth token has expired"), "no upstream prose");
    assert.equal(isLoginDeathText(thrown), false);
    assert.equal(readAccountHealth(id, true).state, "ok");
    assert.equal(peekUsageSnapshot(id, "claude")?.snapshot, good);

    // Backed off: an unforced read serves the kept snapshot, asking nothing.
    const before = upstreams.anthropic.length;
    assert.equal(await readUsageSnapshot(id, "claude"), good);
    assert.equal(upstreams.anthropic.length, before);
  },
);

function fileIdentity(path: string): unknown {
  const stat = statSync(path);
  return {
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ino: stat.ino,
  };
}

test.each([
  ["401", { status: 401, body: { type: "error", error: { type: "x" } } }],
  ["200", { status: 200, body: MEASURED_USAGE }],
] as const)(
  "AC7: an expired credential whose renewal fails is sent once with the old token, answered %s",
  async (_name, answer) => {
    const { id, lease } = await claudeLeased(
      "Claude usage expired",
      Date.now() - 3_600_000,
    );
    const file = claudeCredentialFile(id);
    const before = fileIdentity(file);
    claudeAnswer = answer;
    await readClaudeUsage(id).catch(() => {});
    assert.deepEqual(fileIdentity(file), before, "the file is untouched");
    assert.equal(usageRequests(), 1, "one request, no retry");
    assert.deepEqual(egress.unauthorized(), [], "no refresh endpoint");
    assert.equal(cliUsageChild.mock.calls.length, 0, "no CLI usage child");
    assertOnlyLeaseSent(lease);
  },
);

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition reached");
}

test("AC11(b): a deleted profile's lease reaches no usage, and no later read reuses it", async () => {
  const { id, lease } = await claudeLeased("Claude usage deleted");
  await readClaudeUsage(id);
  assert.equal(sent[0]?.headers.Authorization, `Bearer ${lease}`);
  const leaseId = serverLeaseId(id);

  deleteCredentialProfile(id);
  await until(() =>
    gateway.link
      .gateway!.leases.records()
      .some((r) => r.leaseId === leaseId && r.revoked === "profile-removed"),
  );
  const before = upstreams.anthropic.length;
  vi.unstubAllGlobals();
  const res = await fetch(
    `${gateway.link.gateway!.url}/anthropic/api/oauth/usage`,
    { headers: { Authorization: `Bearer ${lease}` } },
  );
  assert.equal(res.status, 401);
  const message = ((await res.json()) as { error: { message: string } }).error
    .message;
  assert.equal(
    message,
    refusalText({ case: "revoked-lease", reason: "profile-removed" }),
  );
  assert.equal(isLoginDeathText(message), false);
  assert.equal(upstreams.anthropic.length, before);

  recordSent();
  await fetchClaudeAccountUsage(id, 20_000).catch(() => {});
  assert.ok(
    sent.every(
      (request) => request.headers.Authorization !== `Bearer ${lease}`,
    ),
    "the old lease is not reused",
  );
  assert.equal(upstreams.anthropic.length, before);
});
