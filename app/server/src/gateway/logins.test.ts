/**
 * The edge's login manager (`logins.ts`, Task-1402 B2) over a fake vault
 * whose drivers settle only when a test says so: slots per account, the
 * take-over and its successor wait, registration cleanup after settlement,
 * readable views and their reasons.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  createLoginManager,
  LoginNotRun,
  LoginOutcomeUnknown,
  LoginRefusal,
  UNCERTAIN_HOLD_MS,
  type LoginActor,
  type LoginEvent,
} from "./logins.ts";
import type { LoginProfile } from "./profiles.ts";
import {
  LOGIN_CLOSE_WAIT_MS,
  LOGIN_COMMIT_TIMEOUT_MS,
  LOGIN_GROUP_WAIT_MS,
  LOGIN_KILL_GRACE_MS,
  VAULT_LOGIN_SETTLE_BOUND_MS,
  VAULT_LOGIN_TIMEOUT_MS,
} from "./vaultMethods.ts";
import type { LoginDriverEvents, LoginRun, VaultPort } from "./vaultPort.ts";

type VaultLogin = Parameters<VaultPort["login"]>[0];

const WAIT_MS = 1_000;
const MARKER = "MARKER-sk-ant-oat01-fake-https://leak.invalid/x?code=fake123";

interface FakeRun {
  request: VaultLogin;
  events: LoginDriverEvents;
  inputs: string[];
  cancels: number;
  /** The driver finished: the vault asks to commit, as `vaultLogins.ts`. */
  succeed(): Promise<void>;
  fail(err?: Error): void;
  /** The driver honoured its cancel. */
  stopped(): void;
  /** Asks the edge to commit, as the vault does before it installs. */
  commit(): Promise<boolean>;
  /** The vault installed: `done` resolves. */
  installed(): void;
}

let clock = 0;

function harness({
  failPut,
  uncertainHoldMs,
}: { failPut?: (n: number) => boolean; uncertainHoldMs?: number } = {}) {
  let puts = 0;
  const runs: FakeRun[] = [];
  let refuse = false;
  const profiles = new Map<string, LoginProfile>();
  const owners = new Map<string, string>();
  const put: string[] = [];
  const removed: string[] = [];
  const events: { actor: string; loginId: string; event: LoginEvent }[] = [];
  const logs: string[] = [];
  const manager = createLoginManager({
    vault: {
      login(request, driverEvents): LoginRun | undefined {
        if (refuse) return undefined;
        let resolve!: () => void;
        let reject!: (err: Error) => void;
        const done = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        done.catch(() => {});
        const run: FakeRun = {
          request,
          events: driverEvents,
          inputs: [],
          cancels: 0,
          async succeed() {
            if (await request.commit()) resolve();
            else reject(new Error("cancelled"));
            await flush();
          },
          fail: (err = new Error(`driver failed ${MARKER}`)) => reject(err),
          stopped: () => reject(new Error(`stopped ${MARKER}`)),
          commit: async () => (await request.commit()) === true,
          installed: () => resolve(),
        };
        runs.push(run);
        return {
          input: (text) => run.inputs.push(text),
          cancel: () => run.cancels++,
          done,
        };
      },
      newTokenFile: (kind, id) => `/fake/${kind}/${id}`,
    },
    profiles: { get: (id) => profiles.get(id) },
    ownerOf: (id) => owners.get(id),
    putAccount: ({ userId, ...profile }) => {
      if (failPut?.(++puts)) throw new Error("registry write failed");
      profiles.set(profile.id, profile);
      owners.set(profile.id, userId);
      put.push(profile.id);
    },
    removeAccount: (id) => {
      profiles.delete(id);
      owners.delete(id);
      removed.push(id);
    },
    send: (actor, loginId, _accountId, event) =>
      events.push({ actor: `${actor.kind}:${actor.id}`, loginId, event }),
    log: (line) => logs.push(line),
    now: () => clock,
    successorWaitMs: WAIT_MS,
    ...(uncertainHoldMs !== undefined ? { uncertainHoldMs } : {}),
  });
  const addAccount = (id: string, userId = "u1") => {
    profiles.set(id, {
      id,
      provider: "claude",
      name: id,
      enabled: true,
      tokenFile: `/fake/claude/${id}`,
    });
    owners.set(id, userId);
  };
  const states = (loginId: string) =>
    events
      .filter((e) => e.loginId === loginId && e.event.type === "state")
      .map((e) => e.event as Extract<LoginEvent, { type: "state" }>);
  return {
    manager,
    runs,
    put,
    removed,
    events,
    logs,
    states,
    addAccount,
    owners,
    refuse: (value: boolean) => (refuse = value),
  };
}

function actor(
  id: string,
  userId = "u1",
  kind: LoginActor["kind"] = "client",
): LoginActor & { alive: boolean } {
  const self = {
    kind,
    id,
    userId,
    alive: true,
    active: () => self.alive,
  };
  return self;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  clock = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

test("a new account is listed while its first login runs and kept once it succeeds", async () => {
  const h = harness();
  const a = actor("c1");
  const { loginId, accountId } = h.manager.start(a, { kind: "claude" });
  assert.deepEqual([...h.manager.pendingAccounts()], [accountId]);
  assert.deepEqual(h.put, [accountId]);
  h.runs[0]!.events.output("Paste code: ");
  h.manager.input(a, loginId, "  the-code \n");
  assert.deepEqual(h.runs[0]!.inputs, ["the-code"]);
  await h.runs[0]!.succeed();
  assert.deepEqual(
    h.states(loginId).map((s) => s.state),
    ["running", "ready"],
  );
  assert.equal(h.manager.pendingAccounts().size, 0);
  assert.deepEqual(h.removed, []);
  const view = h.manager.read(a, loginId, 0);
  assert.equal(view.state, "ready");
  assert.equal(view.output, "Paste code: ");
});

test("a cancelled first login removes its account only after its driver settled", async () => {
  const h = harness();
  const a = actor("c1");
  const { loginId, accountId } = h.manager.start(a, { kind: "claude" });
  h.manager.cancel(a, loginId);
  assert.equal(h.runs[0]!.cancels, 1);
  await flush();
  assert.deepEqual(h.removed, []);
  assert.equal(h.manager.read(a, loginId, 0).state, "running");
  h.runs[0]!.stopped();
  await flush();
  assert.deepEqual(h.removed, [accountId]);
  assert.equal(h.states(loginId).at(-1)!.state, "cancelled");
});

test("AC11: two accounts per user and four in all hold a slot; a cancelled, unsettled driver still counts", async () => {
  const h = harness();
  const u1 = actor("c1");
  h.manager.start(u1, { kind: "claude" });
  const second = h.manager.start(u1, { kind: "claude" });
  assert.throws(
    () => h.manager.start(u1, { kind: "claude" }),
    (err) => err instanceof LoginRefusal && err.code === "login_unavailable",
  );
  // Another user still starts.
  const u2 = actor("c2", "u2");
  h.manager.start(u2, { kind: "claude" });
  h.manager.start(u2, { kind: "claude" });
  // Four in all now: a fifth is refused even for a third user.
  assert.throws(
    () => h.manager.start(actor("c3", "u3"), { kind: "claude" }),
    (err) => err instanceof LoginRefusal && err.code === "login_unavailable",
  );
  // A cancel alone frees nothing; the settlement does.
  h.manager.cancel(u1, second.loginId);
  await flush();
  assert.throws(() => h.manager.start(u1, { kind: "claude" }), LoginRefusal);
  h.runs[1]!.stopped();
  await flush();
  h.manager.start(u1, { kind: "claude" });
});

test("AC11: a take-over at the user's bound is admitted: the account already holds its slot", async () => {
  const h = harness();
  h.addAccount("claude-a");
  const first = actor("c1");
  h.manager.start(first, { kind: "claude", accountId: "claude-a" });
  h.manager.start(first, { kind: "claude" });
  const other = actor("s1", "u1", "session");
  const taken = h.manager.start(other, {
    kind: "claude",
    accountId: "claude-a",
  });
  assert.ok(taken.loginId);
});

test("AC9: a take-over ends the old login at once and starts no driver before the old one settled", async () => {
  const h = harness();
  h.addAccount("claude-a");
  const client = actor("c1");
  const session = actor("s1", "u1", "session");
  const old = h.manager.start(client, {
    kind: "claude",
    accountId: "claude-a",
  });
  const next = h.manager.start(session, {
    kind: "claude",
    accountId: "claude-a",
  });
  assert.notEqual(next.loginId, old.loginId);
  assert.deepEqual(h.states(old.loginId).at(-1), {
    type: "state",
    state: "cancelled",
    error: "This login was started again elsewhere.",
  });
  assert.equal(h.manager.read(client, old.loginId, 0).reason, "superseded");
  assert.equal(h.runs[0]!.cancels, 1);
  assert.equal(h.runs.length, 1, "no successor driver yet");
  assert.equal(await h.runs[0]!.request.commit(), false);
  // The new login reads as running while it waits.
  assert.equal(h.manager.read(session, next.loginId, 0).state, "running");
  h.runs[0]!.stopped();
  await flush();
  assert.equal(h.runs.length, 2);
  await h.runs[1]!.succeed();
  assert.equal(h.manager.read(session, next.loginId, 0).state, "ready");
  // The old login's stop emitted nothing more to its actor.
  assert.equal(h.states(old.loginId).length, 2);
});

test("AC9: the same actor's second start answers its running login", () => {
  const h = harness();
  h.addAccount("claude-a");
  const a = actor("c1");
  const first = h.manager.start(a, { kind: "claude", accountId: "claude-a" });
  const again = h.manager.start(a, { kind: "claude", accountId: "claude-a" });
  assert.equal(again.loginId, first.loginId);
  assert.equal(h.runs.length, 1);
});

test("another user's account stays unknown, running or not", () => {
  const h = harness();
  h.addAccount("claude-a", "u1");
  h.manager.start(actor("c1"), { kind: "claude", accountId: "claude-a" });
  assert.throws(
    () =>
      h.manager.start(actor("c2", "u2"), {
        kind: "claude",
        accountId: "claude-a",
      }),
    (err) => err instanceof LoginRefusal && err.code === "unknown_account",
  );
});

test("R1.2: a successor that waited too long ends unavailable, never starts, and the account keeps its slot until release", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const h = harness();
  const client = actor("c1");
  const session = actor("s1", "u1", "session");
  const first = h.manager.start(client, { kind: "claude" });
  const next = h.manager.start(session, {
    kind: "claude",
    accountId: first.accountId,
  });
  vi.advanceTimersByTime(WAIT_MS);
  const view = h.manager.read(session, next.loginId, 0);
  assert.equal(view.state, "error");
  assert.equal(view.reason, "unavailable");
  assert.equal(h.runs.length, 1);
  // Still a slot and still listed.
  assert.deepEqual([...h.manager.pendingAccounts()], [first.accountId]);
  h.manager.start(client, { kind: "claude" });
  assert.throws(
    () => h.manager.start(client, { kind: "claude" }),
    LoginRefusal,
  );
  vi.useRealTimers();
  h.runs[0]!.stopped();
  await flush();
  assert.deepEqual(h.removed, [first.accountId]);
  assert.equal(h.runs.length, 2, "only the other account's driver started");
});

test("R1.3: a retry after a wait timeout owns the registration; a stale duty never removes it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const h = harness();
  const client = actor("c1");
  const session = actor("s1", "u1", "session");
  const first = h.manager.start(client, { kind: "claude" });
  h.manager.start(session, { kind: "claude", accountId: first.accountId });
  vi.advanceTimersByTime(WAIT_MS);
  const retry = h.manager.start(session, {
    kind: "claude",
    accountId: first.accountId,
  });
  vi.useRealTimers();
  h.runs[0]!.stopped();
  await flush();
  assert.deepEqual(h.removed, []);
  assert.equal(h.runs.length, 2);
  await h.runs[1]!.succeed();
  assert.equal(h.manager.read(session, retry.loginId, 0).state, "ready");
  assert.deepEqual(h.removed, []);
  assert.equal(h.manager.pendingAccounts().size, 0);
});

test("R1.3: a failing retry removes the account once, after its own driver settled", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const h = harness();
  const client = actor("c1");
  const session = actor("s1", "u1", "session");
  const first = h.manager.start(client, { kind: "claude" });
  h.manager.start(session, { kind: "claude", accountId: first.accountId });
  vi.advanceTimersByTime(WAIT_MS);
  h.manager.start(session, { kind: "claude", accountId: first.accountId });
  vi.useRealTimers();
  h.runs[0]!.stopped();
  await flush();
  h.runs[1]!.fail();
  await flush();
  assert.deepEqual(h.removed, [first.accountId]);
});

test("R1.4: cancelling a waiting successor ends it at once; the account goes once after the release", async () => {
  const h = harness();
  const client = actor("c1");
  const session = actor("s1", "u1", "session");
  const first = h.manager.start(client, { kind: "claude" });
  const next = h.manager.start(session, {
    kind: "claude",
    accountId: first.accountId,
  });
  h.manager.cancel(session, next.loginId);
  assert.equal(h.manager.read(session, next.loginId, 0).state, "cancelled");
  assert.deepEqual(h.removed, []);
  h.runs[0]!.stopped();
  await flush();
  assert.deepEqual(h.removed, [first.accountId]);
  assert.equal(h.runs.length, 1);
});

test("R1.5: a successor the vault refuses ends unavailable; its new account goes once", async () => {
  const h = harness();
  const client = actor("c1");
  const session = actor("s1", "u1", "session");
  const first = h.manager.start(client, { kind: "claude" });
  const next = h.manager.start(session, {
    kind: "claude",
    accountId: first.accountId,
  });
  h.runs[0]!.stopped();
  await flush();
  h.runs[1]!.fail(new LoginNotRun("This gateway cannot run that login now."));
  await flush();
  const view = h.manager.read(session, next.loginId, 0);
  assert.equal(view.state, "error");
  assert.equal(view.reason, "unavailable");
  assert.deepEqual(h.removed, [first.accountId]);
});

test("R1.7: removing the account during a wait is its only cleanup", async () => {
  const h = harness();
  const client = actor("c1");
  const session = actor("s1", "u1", "session");
  const first = h.manager.start(client, { kind: "claude" });
  const next = h.manager.start(session, {
    kind: "claude",
    accountId: first.accountId,
  });
  h.manager.forget(first.accountId);
  assert.equal(h.manager.read(session, next.loginId, 0).state, "cancelled");
  h.runs[0]!.stopped();
  await flush();
  assert.deepEqual(h.removed, []);
  assert.equal(h.runs.length, 1);
});

test("AC10: an inactive actor's driver cannot commit, and ending the actor cancels it", async () => {
  const h = harness();
  const session = actor("s1", "u1", "session");
  const { loginId, accountId } = h.manager.start(session, { kind: "claude" });
  session.alive = false;
  await h.runs[0]!.succeed();
  assert.equal(h.manager.read(session, loginId, 0).state, "cancelled");
  assert.deepEqual(h.removed, [accountId]);

  const other = actor("s2", "u1", "session");
  const second = h.manager.start(other, { kind: "claude" });
  h.manager.endActor({ kind: "session", id: "s2" });
  assert.equal(h.runs[1]!.cancels, 1);
  h.runs[1]!.stopped();
  await flush();
  const view = h.manager.read(other, second.loginId, 0);
  assert.equal(view.state, "cancelled");
  assert.equal(view.reason, "session_ended");
});

test("a login is read, fed and cancelled only by its own actor; another kind with the same id is another actor", () => {
  const h = harness();
  const client = actor("same");
  const session = actor("same", "u1", "session");
  const { loginId } = h.manager.start(client, { kind: "claude" });
  const unknown = (err: unknown) =>
    err instanceof LoginRefusal && err.code === "unknown_login";
  assert.throws(() => h.manager.read(session, loginId, 0), unknown);
  assert.throws(() => h.manager.input(session, loginId, "x"), unknown);
  assert.throws(() => h.manager.cancel(session, loginId), unknown);
  assert.equal(h.runs[0]!.cancels, 0);
});

test("AC5: output reads by cursor; device fields once told; finished views kept 2 minutes, at most 64", async () => {
  const h = harness();
  const a = actor("s1", "u1", "session");
  const { loginId } = h.manager.start(a, { kind: "openai-codex" });
  h.runs[0]!.events.url("https://auth.example/device");
  h.runs[0]!.events.code("ABCD-1234");
  h.runs[0]!.events.output("one ");
  h.runs[0]!.events.output("two");
  const head = h.manager.read(a, loginId, 0);
  assert.equal(head.output, "one two");
  assert.equal(head.cursor, 7);
  assert.equal(head.url, "https://auth.example/device");
  assert.equal(head.code, "ABCD-1234");
  assert.equal(h.manager.read(a, loginId, 4).output, "two");
  assert.equal(h.manager.read(a, loginId, 99).output, "");
  await h.runs[0]!.succeed();
  clock += 2 * 60_000 - 1;
  assert.equal(h.manager.read(a, loginId, 0).state, "ready");
  clock += 1;
  assert.throws(() => h.manager.read(a, loginId, 0), LoginRefusal);

  // 64 newer finished logins push the oldest out.
  const ids: string[] = [];
  for (let i = 0; i < 65; i++) {
    const { loginId: id } = h.manager.start(a, { kind: "claude" });
    ids.push(id);
    h.runs.at(-1)!.fail();
    await flush();
  }
  assert.throws(() => h.manager.read(a, ids[0]!, 0), LoginRefusal);
  assert.equal(h.manager.read(a, ids[1]!, 0).state, "error");
});

test("AC15: a failed login's view carries a fixed reason; no log line holds driver text, input, url or code", async () => {
  const h = harness();
  const a = actor("s1", "u1", "session");
  const { loginId } = h.manager.start(a, { kind: "claude" });
  h.runs[0]!.events.output(`out ${MARKER}`);
  h.runs[0]!.events.url(MARKER);
  h.runs[0]!.events.code(MARKER);
  h.manager.input(a, loginId, MARKER);
  h.runs[0]!.fail();
  await flush();
  const view = h.manager.read(a, loginId, 0);
  assert.equal(view.state, "error");
  assert.equal(view.reason, "failed");
  for (const line of h.logs) assert.ok(!line.includes("MARKER"), line);
});

test("a timed-out driver keeps its slot until it settles", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const h = harness();
  const a = actor("c1");
  const { loginId } = h.manager.start(a, { kind: "claude" });
  h.manager.start(a, { kind: "claude" });
  vi.advanceTimersByTime(10 * 60_000);
  assert.equal(h.runs[0]!.cancels, 1);
  // Withdrawn, not settled: still running for its actor, still a slot.
  assert.equal(h.manager.read(a, loginId, 0).state, "running");
  assert.throws(() => h.manager.start(a, { kind: "claude" }), LoginRefusal);
  vi.useRealTimers();
  h.runs[0]!.stopped();
  await flush();
  const view = h.manager.read(a, loginId, 0);
  assert.equal(view.state, "error");
  assert.equal(view.reason, "timed_out");
  h.manager.start(a, { kind: "claude" });
});

test("a refused immediate start leaves nothing behind", () => {
  const h = harness();
  h.refuse(true);
  assert.throws(
    () => h.manager.start(actor("c1"), { kind: "claude" }),
    (err) => err instanceof LoginRefusal && err.code === "login_unavailable",
  );
  assert.deepEqual(h.put, []);
  assert.equal(h.manager.pendingAccounts().size, 0);
});

// --- review rv-1402-b2-code-01 ---------------------------------------------

test("C1: a take-over after the commit was granted leaves the old login alone; the saved account survives the successor", async () => {
  const h = harness();
  const client = actor("c1");
  const session = actor("s1", "u1", "session");
  const old = h.manager.start(client, { kind: "claude" });
  assert.equal(await h.runs[0]!.commit(), true);
  const next = h.manager.start(session, {
    kind: "claude",
    accountId: old.accountId,
  });
  // Not superseded, not cancelled: its outcome stands.
  assert.equal(h.manager.read(client, old.loginId, 0).state, "running");
  assert.equal(h.runs[0]!.cancels, 0);
  assert.equal(h.runs.length, 1);
  h.runs[0]!.installed();
  await flush();
  assert.equal(h.manager.read(client, old.loginId, 0).state, "ready");
  assert.equal(h.manager.pendingAccounts().size, 0);
  assert.equal(h.runs.length, 2, "the successor started after the old driver");
  h.runs[1]!.fail();
  await flush();
  assert.equal(h.manager.read(session, next.loginId, 0).state, "error");
  assert.deepEqual(h.removed, []);
});

test("C1: a committing predecessor that fails hands the new account to the waiting successor", async () => {
  const h = harness();
  const client = actor("c1");
  const session = actor("s1", "u1", "session");
  const old = h.manager.start(client, { kind: "claude" });
  await h.runs[0]!.commit();
  h.manager.start(session, { kind: "claude", accountId: old.accountId });
  // The vault's install failed after the commit.
  h.runs[0]!.fail();
  await flush();
  assert.equal(h.manager.read(client, old.loginId, 0).state, "error");
  assert.deepEqual(h.removed, []);
  assert.deepEqual([...h.manager.pendingAccounts()], [old.accountId]);
  h.runs[1]!.fail();
  await flush();
  assert.deepEqual(h.removed, [old.accountId]);
});

test("C1: removing the account while its login commits registers nothing afterwards", async () => {
  const h = harness();
  const client = actor("c1");
  const old = h.manager.start(client, { kind: "claude" });
  await h.runs[0]!.commit();
  h.manager.forget(old.accountId);
  h.runs[0]!.installed();
  await flush();
  assert.equal(h.manager.read(client, old.loginId, 0).state, "cancelled");
  assert.deepEqual(h.put, [old.accountId], "only the start's registration");
});

test("C2: a lost vault link ends the login at once but holds its slot and cleanup until the hold passed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const h = harness({ uncertainHoldMs: 5_000 });
  const a = actor("s1", "u1", "session");
  const first = h.manager.start(a, { kind: "claude" });
  h.manager.start(a, { kind: "claude" });
  h.runs[0]!.fail(new LoginOutcomeUnknown("The vault became unavailable."));
  await vi.advanceTimersByTimeAsync(0);
  const view = h.manager.read(a, first.loginId, 0);
  assert.equal(view.state, "error");
  assert.equal(view.reason, "unavailable");
  assert.throws(() => h.manager.start(a, { kind: "claude" }), LoginRefusal);
  assert.deepEqual(h.removed, []);
  await vi.advanceTimersByTimeAsync(4_999);
  assert.deepEqual(h.removed, []);
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(h.removed, [first.accountId]);
  h.manager.start(a, { kind: "claude" });
});

test("C3: a registry write failing after success still ends the login, frees the account and keeps it", async () => {
  const h = harness({ failPut: (n) => n === 2 });
  const a = actor("s1", "u1", "session");
  const first = h.manager.start(a, { kind: "claude" });
  await h.runs[0]!.succeed();
  const view = h.manager.read(a, first.loginId, 0);
  assert.equal(view.state, "error");
  assert.equal(view.reason, "unavailable");
  // Saved: not removed, and no longer pending as a first login.
  assert.deepEqual(h.removed, []);
  assert.equal(h.manager.pendingAccounts().size, 0);
  // A retry is a new login, not the stranded one; the old one is finished.
  const retry = h.manager.start(a, {
    kind: "claude",
    accountId: first.accountId,
  });
  assert.notEqual(retry.loginId, first.loginId);
  assert.throws(() => h.manager.cancel(a, first.loginId), LoginRefusal);
  await h.runs[1]!.succeed();
  assert.equal(h.manager.read(a, retry.loginId, 0).state, "ready");
});

test("C2: the edge's hold after a lost link outlasts the vault's own settle bound, with a minute's margin", () => {
  assert.equal(
    VAULT_LOGIN_SETTLE_BOUND_MS,
    VAULT_LOGIN_TIMEOUT_MS +
      LOGIN_KILL_GRACE_MS +
      LOGIN_CLOSE_WAIT_MS +
      LOGIN_GROUP_WAIT_MS +
      LOGIN_COMMIT_TIMEOUT_MS +
      5_000,
  );
  assert.equal(UNCERTAIN_HOLD_MS, VAULT_LOGIN_SETTLE_BOUND_MS + 60_000);
});
