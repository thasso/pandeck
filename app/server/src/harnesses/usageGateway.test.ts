/**
 * Codex usage, reset credits and the irreversible consume under the credential
 * gateway (G4a): the server's requests carry only its lease, the gateway adds
 * the profile's token and account id, and a gateway refusal is a temporary
 * failure that never benches the account. Every upstream is a fake; nothing
 * here may consume a real credit.
 */
import assert from "node:assert/strict";
import type { OpenAiUsageSnapshot } from "@assistant/shared/usage";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import {
  initializeAccountHealth,
  readAccountHealth,
  withAccountHealthProfiles,
} from "../accountHealth.ts";
import {
  createCredentialProfile,
  listCredentialProfiles,
  piAgentDir,
} from "../credentialProfiles.ts";
import { GATEWAY_REFUSAL_MARKER, refusalText } from "../gateway/refusals.ts";
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
  peekUsageSnapshot,
  readUsageSnapshot,
  resetUsageCacheForTests,
} from "../usageCache.ts";
import { fetchOpenAiAccountUsage, redeemOpenAiResetCredit } from "./usage.ts";

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

let upstreams: FakeUpstreams;
let gateway: TestGatewayLink;
let egress: EgressObserver;
/** What the server sent the gateway's listener, through a wrapped `fetch`. */
let sent: Sent[];

beforeAll(async () => {
  initializeAccountHealth({
    profiles: () =>
      withAccountHealthProfiles(() =>
        listCredentialProfiles().map((profile) => ({
          ...profile,
          health: readAccountHealth(profile.id, true),
        })),
      ),
    hasCredential: () => true,
    push: async () => {},
    broadcast: () => {},
    subscribeChanges: () => () => {},
    subscribeDeleted: () => () => {},
  });
  upstreams = await startFakeUpstreams({ codex: wham });
  gateway = await startGatewayLinkForTests({ upstreams: upstreams.overrides });
  egress = startEgressObserver([`127.0.0.1:${gateway.link.gateway!.port}`]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetUsageCacheForTests();
  upstreams.reset();
  assert.deepEqual(egress.unauthorized(), [], "nothing left for elsewhere");
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
  const lease = (await gateway.link.serverAccess(id)).leaseToken;
  leases.push(lease);
  return { id, lease };
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
    "503 credential missing its account id",
    async (id) => writeAuth(id, { ...LOGIN, accountId: undefined }),
    new RegExp(
      escape(refusalText({ case: "credential", problem: "malformed" })),
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

test("AC16: an upstream's own 401 still reads as a rejected login", async () => {
  const { id } = await leased("Usage rejected upstream");
  await readCodexUsage(id);
  answers.usage = { status: 401, body: { error: "unauthorized" } };
  const rejected = await readCodexUsage(id);
  assert.equal(rejected.available, false);
  assert.equal(rejected.unavailableCode, "rejected");
  assert.equal(readAccountHealth(id, true).state, "needs-login");
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
