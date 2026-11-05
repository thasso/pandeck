/**
 * The server's login-hold seam (`loginHolds.ts`) against a fake link: which
 * accounts take a hold, when a profile shows the login-stuck state, how often
 * that is announced, and what Clear does with a hold that runs here or not
 * (AC10, AC11, AC14). The flows' own holds are in `claudeLoginTerminal.test.ts`
 * and `piSdk/modelsProfileLogin.test.ts`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "login-holds-test-"));
process.env.DATA_DIR = join(tmp, "data");

const profiles = await import("./credentialProfiles.ts");
const loginHolds = await import("./loginHolds.ts");
const { GATEWAY_LOGIN_UNAVAILABLE_TEXT, LoginHeldError } =
  await import("./gatewayLink.ts");
const { fakeLoginHoldLink } = await import("./test/fakeLoginHoldLink.ts");

const CLAUDE = { id: "cp_claude", provider: "claude" } as const;
const CODEX = { id: "cp_codex", provider: "openai-codex" } as const;
const COMPATIBLE = {
  id: "cp_compatible",
  provider: "openai-compatible",
} as const;

let announced = 0;
let logged: string[] = [];

/** A fake link installed for the seam, and its call log. */
function linked() {
  const events: string[] = [];
  const fake = fakeLoginHoldLink(events);
  loginHolds.setLoginHoldLinkForTests(fake.link);
  return { events, fake };
}

/** Takes a hold through the seam; the answer of a login kind is a promise. */
async function take(
  profile: Parameters<typeof loginHolds.takeLoginHold>[0],
  abandon: () => void = () => {},
) {
  return await loginHolds.takeLoginHold(profile, abandon);
}

beforeEach(() => {
  announced = 0;
  loginHolds.setLoginHoldAnnouncer(() => {
    announced += 1;
  });
  logged = [];
  for (const method of ["log", "info", "warn", "error"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
});

afterEach(() => {
  // AC14: the seam logs nothing, so no hold id reaches a log line.
  assert.deepEqual(logged, []);
  vi.restoreAllMocks();
  loginHolds.setLoginHoldLinkForTests(null);
  loginHolds.setLoginHoldAnnouncer(() => {});
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("AC8: without a link every login runs unheld, nothing is stuck and Clear does nothing", async () => {
  loginHolds.setLoginHoldLinkForTests(undefined);
  for (const profile of [CLAUDE, CODEX]) {
    assert.deepEqual(
      loginHolds.takeLoginHold(profile, () => {}),
      { kind: "off" },
      "answered at once, not as a promise",
    );
    assert.equal(loginHolds.loginStuckOf(profile), false);
    await loginHolds.clearUnfinishedLogin(profile);
  }
  assert.equal(announced, 0);
});

test("AC11: a compatible account takes no hold, never shows the stuck state, and Clear does nothing", async () => {
  const { events, fake } = linked();
  assert.deepEqual(
    loginHolds.takeLoginHold(COMPATIBLE, () => {}),
    {
      kind: "off",
    },
  );
  fake.status(COMPATIBLE.id, { loginStuck: true, holdId: "hold-7" });
  assert.equal(loginHolds.loginStuckOf(COMPATIBLE), false);
  await loginHolds.clearUnfinishedLogin(COMPATIBLE);
  assert.deepEqual(events, []);
});

test("AC11: a stuck status sets the flag and a status ending that hold clears it, each announced once", () => {
  const { fake } = linked();
  loginHolds.followLoginHoldStatuses();
  assert.equal(loginHolds.loginStuckOf(CLAUDE), false);

  fake.status(CLAUDE.id, { loginStuck: true, holdId: "hold-7" });
  assert.equal(loginHolds.loginStuckOf(CLAUDE), true);
  assert.equal(announced, 1);
  fake.status(CLAUDE.id, { loginStuck: true, holdId: "hold-7" });
  assert.equal(announced, 1, "a repeated status changes nothing");

  fake.status(CLAUDE.id, { loginStuck: false, holdId: "hold-7" });
  assert.equal(loginHolds.loginStuckOf(CLAUDE), false);
  assert.equal(announced, 2);
});

test("AC11: a login_stuck refusal naming its hold marks the profile once; a status ending that hold clears the mark", async () => {
  const { fake } = linked();
  fake.acquire = () =>
    Promise.reject(new LoginHeldError("login_stuck", "hold-7"));

  assert.deepEqual(await take(CODEX), { kind: "stuck" });
  assert.equal(loginHolds.loginStuckOf(CODEX), true);
  assert.equal(announced, 1);
  assert.deepEqual(await take(CODEX), { kind: "stuck" });
  assert.equal(announced, 1, "the same refusal again changes nothing");

  // Another hold's end leaves the mark; its own clears it.
  fake.status(CODEX.id, { loginStuck: false, holdId: "hold-3" });
  assert.equal(loginHolds.loginStuckOf(CODEX), true);
  fake.status(CODEX.id, { loginStuck: false, holdId: "hold-7" });
  assert.equal(loginHolds.loginStuckOf(CODEX), false);
});

test.each([
  ["the gateway is unreachable", () => new Error("unreachable")],
  ["a hold exists", () => new LoginHeldError("hold_exists", "hold-7")],
  [
    "a login_stuck refusal names no hold",
    () => new LoginHeldError("login_stuck", undefined),
  ],
])(
  "AC6: when %s the acquire is unavailable and marks nothing",
  async (_case, refusal) => {
    const { fake } = linked();
    fake.acquire = () => Promise.reject(refusal());
    assert.deepEqual(await take(CLAUDE), { kind: "unavailable" });
    assert.equal(loginHolds.loginStuckOf(CLAUDE), false);
    assert.equal(announced, 0);
  },
);

test("AC11: a held acquire clears the mark, announced once", async () => {
  const { fake } = linked();
  fake.acquire = () =>
    Promise.reject(new LoginHeldError("login_stuck", "hold-7"));
  await take(CLAUDE);
  fake.acquire = () => Promise.resolve("hold-8");

  const taken = await take(CLAUDE);
  assert.equal(taken.kind, "held");
  assert.equal(loginHolds.loginStuckOf(CLAUDE), false);
  assert.equal(announced, 2);
});

test("AC11: deleting the profile clears its mark, announced once", async () => {
  const { fake } = linked();
  const profile = profiles.createCredentialProfile({
    name: "Stuck Claude",
    provider: "claude",
  });
  fake.acquire = () =>
    Promise.reject(new LoginHeldError("login_stuck", "hold-7"));
  await take(profile);
  assert.equal(announced, 1);

  profiles.deleteCredentialProfile(profile.id);
  assert.equal(loginHolds.loginStuckOf(profile), false);
  assert.equal(announced, 2);
});

test("a held hold names its writer and releases once", async () => {
  const { events } = linked();
  const taken = await take(CLAUDE);
  assert.ok(taken.kind === "held");
  await taken.hold.registerWriter(4321);
  taken.hold.release();
  taken.hold.release();
  assert.deepEqual(events, [
    `acquire ${CLAUDE.id}`,
    "writer hold-1 4321",
    "release hold-1",
  ]);
});

test.each([
  ["a stuck status", "status"],
  ["a login_stuck refusal", "refusal"],
] as const)(
  "AC10: Clear force-releases a hold that does not run here (%s), clears the state and announces it",
  async (_case, source) => {
    const { events, fake } = linked();
    if (source === "status") {
      loginHolds.followLoginHoldStatuses();
      fake.status(CODEX.id, { loginStuck: true, holdId: "hold-7" });
    } else {
      fake.acquire = () =>
        Promise.reject(new LoginHeldError("login_stuck", "hold-7"));
      await take(CODEX);
    }
    const before = announced;

    await loginHolds.clearUnfinishedLogin(CODEX);
    assert.equal(events.at(-1), "force hold-7");
    assert.equal(announced, before + 1);
    if (source === "refusal")
      assert.equal(loginHolds.loginStuckOf(CODEX), false);
    else {
      // The gateway's status for the released hold ends the stuck state.
      fake.status(CODEX.id, { loginStuck: false, holdId: "hold-7" });
      assert.equal(loginHolds.loginStuckOf(CODEX), false);
    }
  },
);

test("AC10: a failed force release rejects with U7's unavailable text and keeps the state (DQ3)", async () => {
  const { fake } = linked();
  fake.acquire = () =>
    Promise.reject(new LoginHeldError("login_stuck", "hold-7"));
  await take(CLAUDE);
  fake.forceRelease = () =>
    Promise.reject(new Error(GATEWAY_LOGIN_UNAVAILABLE_TEXT));

  await assert.rejects(loginHolds.clearUnfinishedLogin(CLAUDE), {
    message: GATEWAY_LOGIN_UNAVAILABLE_TEXT,
  });
  assert.equal(loginHolds.loginStuckOf(CLAUDE), true);
  assert.equal(announced, 1);
});

test("AC10: Clear abandons this boot's live login instead of force-releasing it, and keeps the hold until that login releases", async () => {
  const { events, fake } = linked();
  let abandoned = 0;
  const taken = await take(CLAUDE, () => {
    abandoned += 1;
  });
  assert.ok(taken.kind === "held");
  fake.status(CLAUDE.id, { loginStuck: true, holdId: "hold-1" });

  await loginHolds.clearUnfinishedLogin(CLAUDE);
  assert.equal(abandoned, 1);
  assert.deepEqual(events, [`acquire ${CLAUDE.id}`]);

  // Once the login released, the same hold is no longer this boot's.
  taken.hold.release();
  await loginHolds.clearUnfinishedLogin(CLAUDE);
  assert.equal(abandoned, 1);
  assert.equal(events.at(-1), "force hold-1");
});

test("AC10: Clear passes on what a live login's abandon threw (pi, DQ2)", async () => {
  const { events, fake } = linked();
  const refusal = new Error("refused while it runs");
  await take(CODEX, () => {
    throw refusal;
  });
  fake.status(CODEX.id, { loginStuck: true, holdId: "hold-1" });

  await assert.rejects(loginHolds.clearUnfinishedLogin(CODEX), refusal);
  assert.deepEqual(events, [`acquire ${CODEX.id}`]);
  assert.equal(loginHolds.loginStuckOf(CODEX), true);
});

test("Clear without a stuck hold does nothing", async () => {
  const { events, fake } = linked();
  fake.status(CLAUDE.id, { loginStuck: false, holdId: "hold-7" });
  await loginHolds.clearUnfinishedLogin(CLAUDE);
  assert.deepEqual(events, []);
});

test.each([
  ["a login account", "claude", 1],
  ["an endpoint account", "openai-compatible", 0],
] as const)(
  "AC10: Clear by account id (the route's call) resolves the account, then clears it like Clear (%s)",
  async (_case, provider, forced) => {
    const { events, fake } = linked();
    const account = profiles.createCredentialProfile({
      name: "Clear by id",
      provider,
    });
    fake.status(account.id, { loginStuck: true, holdId: "hold-7" });

    await loginHolds.clearUnfinishedProfileLogin(account.id);
    assert.deepEqual(events, forced ? ["force hold-7"] : []);
    profiles.deleteCredentialProfile(account.id);
  },
);

test("AC10: Clear by id refuses an unknown account before any link call", async () => {
  const { events } = linked();
  await assert.rejects(loginHolds.clearUnfinishedProfileLogin("cp_missing"), {
    message: "Credential profile not found.",
  });
  assert.deepEqual(events, []);
});

test("AC10: Clear by id rejects with U7's unavailable text (DQ3), or a live pi login's own refusal (DQ2)", async () => {
  const { fake } = linked();
  const claude = profiles.createCredentialProfile({
    name: "Clear fails",
    provider: "claude",
  });
  fake.status(claude.id, { loginStuck: true, holdId: "hold-7" });
  fake.forceRelease = () =>
    Promise.reject(new Error(GATEWAY_LOGIN_UNAVAILABLE_TEXT));
  await assert.rejects(loginHolds.clearUnfinishedProfileLogin(claude.id), {
    message: GATEWAY_LOGIN_UNAVAILABLE_TEXT,
  });

  const codex = profiles.createCredentialProfile({
    name: "Clear refused",
    provider: "openai-codex",
  });
  await take({ id: codex.id, provider: "openai-codex" }, () => {
    throw new Error("pi's own refusal");
  });
  fake.status(codex.id, { loginStuck: true, holdId: "hold-1" });
  await assert.rejects(loginHolds.clearUnfinishedProfileLogin(codex.id), {
    message: "pi's own refusal",
  });
  profiles.deleteCredentialProfile(claude.id);
  profiles.deleteCredentialProfile(codex.id);
});

test("AC8: without a link, Clear by id does nothing for an existing account", async () => {
  loginHolds.setLoginHoldLinkForTests(undefined);
  const claude = profiles.createCredentialProfile({
    name: "Clear unlinked",
    provider: "claude",
  });
  await loginHolds.clearUnfinishedProfileLogin(claude.id);
  profiles.deleteCredentialProfile(claude.id);
  assert.equal(announced, 0);
});
