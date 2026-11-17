/**
 * The devbox proof verifier (Task-1410 PR2, AC3, AC4, AC9, AC11) against a
 * loopback Google with the measured answer shapes, an injected clock and the
 * page's real allow rule. Every token, id and address is fake.
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { afterAll, afterEach, beforeAll, test, vi } from "vitest";
import { admittedEmail, type AllowRule } from "../gatewayWeb/config.ts";
import {
  FAKE_CODER_CLIENT_ID,
  FAKE_OWNER_EMAIL,
  FAKE_OWNER_SUB,
  FAKE_OWNER_TOKEN,
  type GoogleFake,
  jsonResponder,
  measuredTokenInfo,
  measuredUserInfo,
  startGoogleFake,
} from "../test/googleFake.ts";
import {
  type DevboxProofDeps,
  type DevboxProofResult,
  MAX_PROOFS_IN_FLIGHT,
  ProofSlots,
  verifyDevboxProof,
} from "./devboxProof.ts";

const ALLOW: AllowRule = {
  emailDomains: ["example.test"],
  emails: [],
  claims: { hd: "example.test" },
};
const T0 = 1_800_000_000_000;

let google: GoogleFake;
const results: DevboxProofResult[] = [];

beforeAll(async () => {
  google = await startGoogleFake();
});

afterAll(async () => {
  await google.close();
});

afterEach(() => {
  google.seen.length = 0;
  google.tokenInfo = jsonResponder(200, measuredTokenInfo());
  google.userInfo = jsonResponder(200, measuredUserInfo());
  // AC11: no result ever holds the token.
  for (const result of results.splice(0))
    assert.ok(!JSON.stringify(result).includes(FAKE_OWNER_TOKEN));
});

function deps(change: Partial<DevboxProofDeps> = {}) {
  const clock = { t: T0 };
  const slots = new ProofSlots();
  return {
    clock,
    slots,
    deps: {
      googleClientId: FAKE_CODER_CLIENT_ID,
      admit: (claims: Record<string, unknown>) => admittedEmail(ALLOW, claims),
      now: () => clock.t,
      slots,
      endpoints: google.endpoints,
      ...change,
    } satisfies DevboxProofDeps,
  };
}

async function verify(
  d: DevboxProofDeps,
  token = FAKE_OWNER_TOKEN,
): Promise<DevboxProofResult> {
  const result = await verifyDevboxProof(token, d);
  results.push(result);
  return result;
}

test("a valid token passes: token info by form POST, userinfo by Bearer, both to Google's names; notAfter is the clock at send plus expires_in, fixed once", async () => {
  const { clock, slots, deps: d } = deps();
  // Time passes while each call runs; notAfter must not move with it.
  google.tokenInfo = (_seen, res) => {
    clock.t += 700;
    res.status(200, measuredTokenInfo());
  };
  google.userInfo = (_seen, res) => {
    clock.t += 900;
    res.status(200, measuredUserInfo());
  };
  assert.deepEqual(await verify(d), {
    ok: true,
    subject: FAKE_OWNER_SUB,
    email: FAKE_OWNER_EMAIL,
    notAfter: T0 + 3566 * 1_000,
  });
  const [info, user, ...more] = google.seen;
  assert.equal(more.length, 0);
  assert.equal(info!.route, "tokeninfo");
  assert.equal(info!.path, "/tokeninfo");
  assert.equal(info!.servername, "oauth2.googleapis.com");
  assert.equal(info!.headers.host, "oauth2.googleapis.com");
  assert.equal(
    info!.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(
    new URLSearchParams(info!.body).get("access_token"),
    FAKE_OWNER_TOKEN,
  );
  assert.equal(info!.headers.authorization, undefined);
  assert.equal(user!.route, "userinfo");
  assert.equal(user!.path, "/v1/userinfo");
  assert.equal(user!.servername, "openidconnect.googleapis.com");
  assert.equal(user!.headers.host, "openidconnect.googleapis.com");
  assert.equal(user!.headers.authorization, `Bearer ${FAKE_OWNER_TOKEN}`);
  assert.equal(user!.body, "");
  for (const seen of google.seen)
    assert.ok(!seen.path.includes(FAKE_OWNER_TOKEN), "no token in a URL");
  assert.equal(slots.inFlight, 0);
});

test("token info's email, email_verified and hd are never read: a string false, no hd and another address still pass with a valid userinfo", async () => {
  const { deps: d } = deps();
  google.tokenInfo = jsonResponder(
    200,
    measuredTokenInfo({
      email: "someone-else@elsewhere.test",
      email_verified: "false",
      hd: "elsewhere.test",
    }),
  );
  const result = await verify(d);
  assert.ok(result.ok);
  assert.equal(result.email, FAKE_OWNER_EMAIL);
  // And without those fields at all.
  const bare = measuredTokenInfo();
  delete bare.email;
  delete bare.email_verified;
  google.tokenInfo = jsonResponder(200, bare);
  assert.ok((await verify(deps().deps)).ok);
});

test("token info's audience, lifetime, subject and scope: each accepted shape passes", async () => {
  const noAzp = measuredTokenInfo();
  delete noAzp.azp;
  for (const info of [
    noAzp,
    measuredTokenInfo({ expires_in: 3600 }),
    measuredTokenInfo({ expires_in: "1" }),
    measuredTokenInfo({ scope: "email" }),
    measuredTokenInfo({
      scope: "openid https://www.googleapis.com/auth/userinfo.email",
    }),
  ]) {
    google.tokenInfo = jsonResponder(200, info);
    const result = await verify(deps().deps);
    assert.ok(result.ok, JSON.stringify(info));
  }
});

test("token_rejected: a refused token, another client, a lifetime outside 1-3600, no subject, no email scope, another subject or a refused userinfo", async () => {
  const noSub = measuredTokenInfo();
  delete noSub.sub;
  const noExpiry = measuredTokenInfo();
  delete noExpiry.expires_in;
  const cases: [string, () => void, string | undefined][] = [
    [
      "token info 400",
      () => (google.tokenInfo = jsonResponder(400, { error: "invalid_token" })),
      "400",
    ],
    [
      "other aud",
      () =>
        (google.tokenInfo = jsonResponder(
          200,
          measuredTokenInfo({ aud: "FAKE_other-client" }),
        )),
      undefined,
    ],
    [
      "other azp",
      () =>
        (google.tokenInfo = jsonResponder(
          200,
          measuredTokenInfo({ azp: "FAKE_other-client" }),
        )),
      undefined,
    ],
    ...(
      [
        ["0", "0"],
        ["3601", "3601"],
        ["3601 as a number", 3601],
        ["abc", "abc"],
        ["1.5", "1.5"],
        ["-5", -5],
      ] as const
    ).map(([name, value]): [string, () => void, undefined] => [
      `expires_in ${name}`,
      () =>
        (google.tokenInfo = jsonResponder(
          200,
          measuredTokenInfo({ expires_in: value }),
        )),
      undefined,
    ]),
    [
      "expires_in missing",
      () => (google.tokenInfo = jsonResponder(200, noExpiry)),
      undefined,
    ],
    [
      "sub missing",
      () => (google.tokenInfo = jsonResponder(200, noSub)),
      undefined,
    ],
    [
      "scope without email",
      () =>
        (google.tokenInfo = jsonResponder(
          200,
          measuredTokenInfo({ scope: "openid profile" }),
        )),
      undefined,
    ],
    [
      "token info not JSON",
      () => (google.tokenInfo = jsonResponder(200, "not json")),
      undefined,
    ],
    [
      "userinfo sub different",
      () =>
        (google.userInfo = jsonResponder(
          200,
          measuredUserInfo({ sub: "FAKE_sub-someone-else" }),
        )),
      undefined,
    ],
    [
      "userinfo 401",
      () => (google.userInfo = jsonResponder(401, { error: "invalid_token" })),
      "401",
    ],
  ];
  for (const [name, arrange, code] of cases) {
    google.tokenInfo = jsonResponder(200, measuredTokenInfo());
    google.userInfo = jsonResponder(200, measuredUserInfo());
    arrange();
    assert.deepEqual(
      await verify(deps().deps),
      { ok: false, reason: "token_rejected", ...(code ? { code } : {}) },
      name,
    );
  }
});

test("a token that cannot be one is rejected without a call", async () => {
  for (const token of ["", "a".repeat(2049), "FAKE_with space", "FAKE_\n"]) {
    const { slots, deps: d } = deps();
    assert.deepEqual(await verify(d, token), {
      ok: false,
      reason: "token_rejected",
    });
    assert.equal(slots.inFlight, 0);
  }
  assert.equal(google.seen.length, 0);
});

test("the clock passing notAfter while userinfo is pending rejects the token", async () => {
  const { clock, deps: d } = deps();
  google.tokenInfo = jsonResponder(
    200,
    measuredTokenInfo({ expires_in: "60" }),
  );
  const held = google.hold("userinfo");
  const pending = verify(d);
  await held.arrived;
  clock.t = T0 + 60_000;
  held.release();
  assert.deepEqual(await pending, { ok: false, reason: "token_rejected" });
  // One millisecond earlier it still counts.
  google.tokenInfo = jsonResponder(200, measuredTokenInfo());
  const early = deps();
  const again = google.hold("userinfo");
  const passing = verify(early.deps);
  await again.arrived;
  early.clock.t = T0 + 3566 * 1_000 - 1;
  again.release();
  assert.ok((await passing).ok);
});

test("not_admitted: userinfo's email_verified false or the string true, an address outside the rule, another hd", async () => {
  for (const change of [
    { email_verified: false },
    { email_verified: "true" },
    { email: "owner@elsewhere.test" },
    { hd: "elsewhere.test" },
    { hd: undefined },
  ]) {
    google.userInfo = jsonResponder(200, measuredUserInfo(change));
    assert.deepEqual(
      await verify(deps().deps),
      { ok: false, reason: "not_admitted" },
      JSON.stringify(change),
    );
  }
  // The rule sees userinfo's claims, not token info's.
  google.userInfo = jsonResponder(200, measuredUserInfo());
  let seen: Record<string, unknown> | undefined;
  await verify(
    deps({
      admit: (claims) => {
        seen = claims;
        return admittedEmail(ALLOW, claims);
      },
    }).deps,
  );
  assert.deepEqual(seen, measuredUserInfo());
});

test("unavailable: 5xx, a redirect (not followed), an oversized answer, an unreachable host", async () => {
  google.tokenInfo = jsonResponder(503, { error: "backend" });
  assert.deepEqual(await verify(deps().deps), {
    ok: false,
    reason: "unavailable",
    code: "503",
  });
  google.tokenInfo = jsonResponder(200, measuredTokenInfo());
  google.userInfo = jsonResponder(500, { error: "backend" });
  assert.deepEqual(await verify(deps().deps), {
    ok: false,
    reason: "unavailable",
    code: "500",
  });
  google.seen.length = 0;
  google.userInfo = jsonResponder(200, measuredUserInfo());
  google.tokenInfo = (_seen, res) => {
    res.raw.writeHead(302, { location: "https://elsewhere.test/tokeninfo" });
    res.raw.end();
  };
  assert.deepEqual(await verify(deps().deps), {
    ok: false,
    reason: "unavailable",
    code: "redirect",
  });
  assert.equal(google.seen.length, 1, "the redirect is not followed");
  google.tokenInfo = jsonResponder(200, { padding: "x".repeat(65 * 1024) });
  assert.deepEqual(await verify(deps().deps), {
    ok: false,
    reason: "unavailable",
    code: "oversize",
  });
  // A port nothing listens on.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const { slots, deps: d } = deps({
    endpoints: {
      connect: { host: "127.0.0.1", port },
      ca: google.endpoints.ca,
    },
  });
  assert.deepEqual(await verify(d), {
    ok: false,
    reason: "unavailable",
    code: "ECONNREFUSED",
  });
  assert.equal(slots.inFlight, 0);
});

test("a hanging call ends at its own deadline: unavailable, the fake sees its socket closed, the slot is free", async () => {
  const { slots, deps: d } = deps({
    timeouts: { callMs: 200, proofMs: 10_000 },
  });
  const held = google.hold("tokeninfo");
  const started = Date.now();
  const pending = verify(d);
  const seen = await held.arrived;
  assert.equal(slots.inFlight, 1);
  assert.deepEqual(await pending, {
    ok: false,
    reason: "unavailable",
    code: "timeout",
  });
  assert.ok(Date.now() - started < 2_000);
  await seen.closed;
  assert.equal(slots.inFlight, 0);
  held.release();
});

test("the whole proof ends at its deadline even when each call is within its own", async () => {
  const { slots, deps: d } = deps({
    timeouts: { callMs: 10_000, proofMs: 300 },
  });
  const held = google.hold("userinfo");
  const started = Date.now();
  const pending = verify(d);
  const seen = await held.arrived;
  assert.deepEqual(await pending, {
    ok: false,
    reason: "unavailable",
    code: "timeout",
  });
  assert.ok(Date.now() - started < 2_000);
  await seen.closed;
  assert.equal(slots.inFlight, 0);
  held.release();
});

test("at most four proofs run at once: a fifth is unavailable at once with no call; the caller's abort ends the rest and frees every slot", async () => {
  const parked: Promise<void>[] = [];
  let arrived!: () => void;
  const four = new Promise<void>((resolve) => (arrived = resolve));
  google.tokenInfo = (seen) => {
    parked.push(seen.closed);
    if (parked.length === MAX_PROOFS_IN_FLIGHT) arrived();
  };
  const controller = new AbortController();
  const shared = deps({ signal: controller.signal });
  const running = Array.from({ length: MAX_PROOFS_IN_FLIGHT }, () =>
    verify(shared.deps),
  );
  await four;
  assert.equal(shared.slots.inFlight, MAX_PROOFS_IN_FLIGHT);
  assert.deepEqual(await verify(shared.deps), {
    ok: false,
    reason: "unavailable",
    code: "busy",
  });
  assert.equal(google.seen.length, MAX_PROOFS_IN_FLIGHT, "no fifth call");
  controller.abort();
  for (const result of await Promise.all(running))
    assert.deepEqual(result, {
      ok: false,
      reason: "unavailable",
      code: "aborted",
    });
  await Promise.all(parked);
  assert.equal(shared.slots.inFlight, 0);
  // Free again: the next proof runs.
  google.tokenInfo = jsonResponder(200, measuredTokenInfo());
  assert.ok((await verify(deps().deps)).ok);
});

test("the verifier logs nothing", async () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map(
    (method) => vi.spyOn(console, method),
  );
  try {
    await verify(deps().deps);
    google.userInfo = jsonResponder(401, { error: "invalid_token" });
    await verify(deps().deps);
    for (const spy of spies) assert.equal(spy.mock.calls.length, 0);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
