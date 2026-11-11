/**
 * The renewal coordinator on a fake clock: when it renews (AC6), that it does
 * not refresh a token another writer just renewed (AC5), and how failures
 * back off without marking a login dead (AC10). Claude goes to a fake TLS
 * `platform.claude.com`; Codex to a fake port. Every token is a fake.
 */
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import {
  rotatingClaudeTokens,
  startFakeUpstreams,
  type FakeUpstreams,
  type UpstreamResponder,
} from "../test/gatewayFixtures.ts";
import { HoldTable, WriterLane } from "./holds.ts";
import { LeaseTable, type LeaseProvider } from "./leases.ts";
import { readCredential } from "./profileCredential.ts";
import { isLoginProfile, ProfileRegistry } from "./profiles.ts";
import {
  CODEX_MARGIN_MS,
  createRenewal,
  type CodexRenewPort,
  type Renewal,
} from "./renewal.ts";

// Passes through; AC2 counts the reads.
vi.mock("./profileCredential.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./profileCredential.ts")>();
  return { ...actual, readCredential: vi.fn(actual.readCredential) };
});

// Synthetic fixture values; none is a real credential.
const OLD_ACCESS = "fake-renewal-old-access";
const OLD_REFRESH = "fake-renewal-old-refresh";
const START = 1_800_000_000_000;
const MIN = 60_000;

let upstreams: FakeUpstreams;
let respond: UpstreamResponder;

beforeAll(async () => {
  upstreams = await startFakeUpstreams({
    claudeToken: (seen, res) => respond(seen, res),
  });
});

afterAll(async () => {
  await upstreams.close();
});

/** Every rig's log lines, checked after each test. */
const rigLines: string[][] = [];

afterEach(() => {
  // AC16: no renewal log line holds a token, stored or renewed.
  for (const line of rigLines.splice(0).flat())
    for (const token of [OLD_ACCESS, OLD_REFRESH, "fake-claude-renewed"])
      assert.ok(!line.includes(token), line);
});

beforeEach(() => {
  upstreams.platform.length = 0;
  respond = rotatingClaudeTokens();
});

interface Rig {
  renewal: Renewal;
  clock: { now: number };
  profiles: ProfileRegistry;
  leases: LeaseTable;
  holds: HoldTable;
  reports: [string, boolean][];
  lines: string[];
  portCalls: { file: string; minValidityMs: number }[];
  /** What the fake port does next; `{ ok: true }` by default. */
  port: {
    next: Awaited<ReturnType<CodexRenewPort>>;
    write?: () => Promise<void>;
  };
  lockSleep: { hook?: () => Promise<void> };
  /** Runs as the writer lane is released, before the outcome settles. */
  afterLane: { hook?: () => Promise<void> };
  /** Every profile id the writer lane ran for. */
  laneRuns: string[];
  /** Each seal-after-write call: the file, its token then, inside the lane. */
  written: { file: string; access: string; inLane: boolean }[];
}

function rig(): Rig {
  const clock = { now: START };
  const holds = new HoldTable({ now: () => clock.now });
  const profiles = new ProfileRegistry();
  const leases = new LeaseTable({ now: () => clock.now });
  const writerLane = new WriterLane(holds, (id) => {
    const profile = profiles.get(id);
    return profile && isLoginProfile(profile) ? profile.provider : undefined;
  });
  const afterLane: Rig["afterLane"] = {};
  const laneRuns: string[] = [];
  let lanesOpen = 0;
  const written: Rig["written"] = [];
  const lane: Pick<WriterLane, "run"> = {
    run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      laneRuns.push(id);
      const result = await writerLane.run(id, async () => {
        lanesOpen++;
        try {
          return await fn();
        } finally {
          lanesOpen--;
        }
      });
      await afterLane.hook?.();
      return result;
    },
  };
  const reports: [string, boolean][] = [];
  const lines: string[] = [];
  rigLines.push(lines);
  const portCalls: Rig["portCalls"] = [];
  const port: Rig["port"] = { next: { ok: true } };
  const lockSleep: Rig["lockSleep"] = {};
  const renewal = createRenewal({
    profiles,
    leases,
    lane,
    log: (line) => lines.push(line),
    now: () => clock.now,
    claudeEndpoint: upstreams.tokenEndpoint,
    renewCodex: async (file, minValidityMs) => {
      portCalls.push({ file, minValidityMs });
      await port.write?.();
      return port.next;
    },
    report: (profileId, needsLogin) => reports.push([profileId, needsLogin]),
    lockOptions: {
      sleep: async () => {
        await lockSleep.hook?.();
      },
    },
    written: (file) => {
      let doc: Record<string, { accessToken?: string; access?: string }>;
      try {
        doc = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return; // As the store: a missing file is not sealed.
      }
      written.push({
        file,
        access:
          doc.claudeAiOauth?.accessToken ?? doc["openai-codex"]?.access ?? "",
        inLane: lanesOpen > 0,
      });
    },
  });
  return {
    renewal,
    clock,
    profiles,
    leases,
    holds,
    reports,
    lines,
    portCalls,
    port,
    lockSleep,
    afterLane,
    laneRuns,
    written,
  };
}

async function claudeFile(
  expiresAt: number,
  access = OLD_ACCESS,
): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "renewal-")), "claude");
  await mkdir(dir);
  const file = join(dir, ".credentials.json");
  await writeClaude(file, expiresAt, access);
  return file;
}

async function writeClaude(
  file: string,
  expiresAt: number,
  access = OLD_ACCESS,
  refresh = OLD_REFRESH,
): Promise<void> {
  await writeFile(
    file,
    JSON.stringify({
      claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt },
    }),
  );
}

async function codexFile(
  expires: number,
  access = OLD_ACCESS,
): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "renewal-")), "pi");
  await mkdir(dir);
  const file = join(dir, "auth.json");
  await writeCodex(file, expires, access);
  return file;
}

async function writeCodex(
  file: string,
  expires: number,
  access = OLD_ACCESS,
): Promise<void> {
  await writeFile(
    file,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access,
        refresh: OLD_REFRESH,
        accountId: "acct-fixture",
        expires,
      },
    }),
  );
}

function register(
  r: Rig,
  id: string,
  provider: LeaseProvider,
  tokenFile: string,
  { enabled = true, lease = true } = {},
): void {
  r.profiles.upsert({
    id,
    provider,
    name: `Account ${id}`,
    enabled,
    tokenFile,
  });
  if (lease)
    r.leases.grant(
      { profileId: id, provider, tokenFile },
      { kind: "engine", owner: { workerId: "local", sessionId: `s-${id}` } },
    );
}

async function accessOf(file: string): Promise<string> {
  const doc = JSON.parse(await readFile(file, "utf8"));
  return doc.claudeAiOauth?.accessToken ?? doc["openai-codex"]?.access;
}

test("AC6: the tick renews Claude at 9 min left, not at 11, and Codex at 29, not 31", async () => {
  const r = rig();
  const claude9 = await claudeFile(START + 9 * MIN);
  const claude11 = await claudeFile(START + 11 * MIN);
  const codex29 = await codexFile(START + 29 * MIN);
  const codex31 = await codexFile(START + 31 * MIN);
  register(r, "c9", "claude", claude9);
  register(r, "c11", "claude", claude11);
  register(r, "x29", "openai-codex", codex29);
  register(r, "x31", "openai-codex", codex31);
  await r.renewal.tick();
  assert.equal(upstreams.platform.length, 1);
  assert.equal(await accessOf(claude9), "fake-claude-renewed-access-1");
  assert.equal(await accessOf(claude11), OLD_ACCESS);
  assert.deepEqual(r.portCalls, [
    { file: codex29, minValidityMs: CODEX_MARGIN_MS },
  ]);
  assert.deepEqual(r.reports, []);
  assert.ok(r.lines.includes("renewal c9 claude: renewed"), r.lines.join("\n"));
  assert.ok(
    r.lines.includes("renewal x29 openai-codex: fresh"),
    r.lines.join("\n"),
  );
});

test("AC6: a disabled profile with a live lease is renewed; one without a live lease, a held one or one in backoff is not", async () => {
  const r = rig();
  const disabled = await claudeFile(START + MIN);
  const idle = await claudeFile(START + MIN);
  const idleDisabled = await claudeFile(START + MIN);
  const revoked = await claudeFile(START + MIN);
  const held = await claudeFile(START + MIN);
  const backoff = await codexFile(START + MIN);
  register(r, "disabled", "claude", disabled, { enabled: false });
  register(r, "idle", "claude", idle, { lease: false });
  register(r, "idleDisabled", "claude", idleDisabled, {
    enabled: false,
    lease: false,
  });
  register(r, "revoked", "claude", revoked, { lease: false });
  const { leaseId } = r.leases.grant(
    { profileId: "revoked", provider: "claude", tokenFile: revoked },
    { kind: "engine", owner: { workerId: "local" } },
  );
  r.leases.revoke(leaseId, "session-ended");
  register(r, "held", "claude", held);
  r.holds.add("held", "claude", "hold-1", {
    serverBootId: "boot-1",
    pid: process.pid,
    startTime: null,
  });
  register(r, "backoff", "openai-codex", backoff);
  r.port.next = { ok: false, kind: "failed", code: "503" };
  assert.deepEqual(await r.renewal.renew("backoff"), {
    kind: "failed",
    code: "503",
  });
  r.portCalls.length = 0;

  await r.renewal.tick();
  assert.equal(upstreams.platform.length, 1);
  assert.equal(await accessOf(disabled), "fake-claude-renewed-access-1");
  for (const file of [idle, idleDisabled, revoked, held])
    assert.equal(await accessOf(file), OLD_ACCESS);
  assert.deepEqual(r.portCalls, []);
  assert.deepEqual(await r.renewal.renew("held"), { kind: "held" });
  assert.deepEqual(r.reports, []);
});

test("AC5: a file renewed by another writer while the lock was taken is fresh, with no POST", async () => {
  const r = rig();
  const file = await claudeFile(START + MIN);
  register(r, "p", "claude", file);
  const primary = join(file, "..", ".oauth_refresh.lock");
  await mkdir(primary);
  r.lockSleep.hook = async () => {
    await writeClaude(
      file,
      START + 60 * MIN,
      "fake-other-writer-access",
      "fake-other-refresh",
    );
    await rm(primary, { recursive: true });
  };
  assert.deepEqual(await r.renewal.renew("p"), { kind: "fresh" });
  assert.equal(upstreams.platform.length, 0);
  assert.equal(await accessOf(file), "fake-other-writer-access");
});

test("AC10: failures write nothing, never mark a login dead, and back off 30 s doubling to 10 min", async () => {
  const r = rig();
  const file = await codexFile(START + MIN);
  register(r, "x", "openai-codex", file);
  const bytes = await readFile(file);
  const codes = [
    "timeout",
    "ECONNREFUSED",
    "503",
    "bad_response",
    "conflict",
    "lock_lost",
  ];
  for (const code of codes) {
    r.port.next = { ok: false, kind: "failed", code };
    assert.deepEqual(await r.renewal.renew("x"), { kind: "failed", code });
  }
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(r.reports, []);
  assert.deepEqual(r.renewal.needsLogin(), []);

  // A fresh start: success resets the backoff.
  r.port.next = { ok: true };
  assert.deepEqual(await r.renewal.renew("x"), { kind: "fresh" });
  r.port.next = { ok: false, kind: "failed", code: "503" };
  await r.renewal.renew("x");
  const waits: number[] = [];
  for (let round = 0; round < 7; round++) {
    const from = r.clock.now;
    let waited = 0;
    for (;;) {
      r.portCalls.length = 0;
      await r.renewal.tick();
      if (r.portCalls.length > 0) break;
      waited += 10_000;
      r.clock.now = from + waited;
    }
    waits.push(waited);
  }
  assert.deepEqual(
    waits,
    [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000],
  );
});

test("AC10: a changed file ends the backoff", async () => {
  const r = rig();
  const file = await claudeFile(START + MIN);
  register(r, "p", "claude", file);
  respond = (_seen, res) => {
    res.writeHead(503).end();
  };
  assert.deepEqual(await r.renewal.renew("p"), { kind: "failed", code: "503" });
  await r.renewal.tick();
  assert.equal(upstreams.platform.length, 1, "in backoff");
  await writeClaude(file, START + 2 * MIN, "fake-claude-rewritten");
  respond = rotatingClaudeTokens();
  await r.renewal.tick();
  assert.equal(upstreams.platform.length, 2);
  assert.equal(await accessOf(file), "fake-claude-renewed-access-1");
});

test("AC10: Claude endpoint failures and an unreachable endpoint write nothing", async () => {
  const r = rig();
  const file = await claudeFile(START + MIN);
  register(r, "p", "claude", file);
  const bytes = await readFile(file);
  for (const [responder, code] of [
    [(_s, res) => res.writeHead(503).end(), "503"],
    [(_s, res) => res.writeHead(200).end("{}"), "bad_response"],
  ] as [UpstreamResponder, string][]) {
    respond = responder;
    assert.deepEqual(await r.renewal.renew("p"), { kind: "failed", code });
  }
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(r.reports, []);
});

test("AC10: a port conflict whose re-read shows a new token is renewed", async () => {
  const r = rig();
  const file = await codexFile(START + MIN);
  register(r, "x", "openai-codex", file);
  r.port.next = { ok: false, kind: "failed", code: "conflict" };
  r.port.write = () =>
    writeCodex(file, START + 600 * MIN, "fake-codex-other-writer");
  assert.deepEqual(await r.renewal.renew("x"), { kind: "renewed" });
});

test("AC9 (unit): a rejection reports needs-login once; a login-style rewrite clears it and renews", async () => {
  const r = rig();
  const file = await claudeFile(START + MIN);
  register(r, "p", "claude", file);
  const bytes = await readFile(file);
  respond = (_seen, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end('{"error":"invalid_grant"}');
  };
  assert.deepEqual(await r.renewal.renew("p"), { kind: "rejected" });
  assert.deepEqual(r.reports, [["p", true]]);
  assert.deepEqual(r.renewal.needsLogin(), ["p"]);
  assert.deepEqual(await readFile(file), bytes, "never written on rejection");
  await r.renewal.tick();
  assert.equal(upstreams.platform.length, 1, "sticky: the tick skips it");

  respond = rotatingClaudeTokens();
  await writeClaude(
    file,
    START + MIN,
    "fake-claude-new-login",
    "fake-claude-new-login-refresh",
  );
  const read = await r.renewal.credentialFor({
    profileId: "p",
    provider: "claude",
    tokenFile: file,
  });
  // The cleared needs-login and the request's 60 s wait share one renewal.
  assert.equal(read.ok, true);
  assert.deepEqual(r.reports, [
    ["p", true],
    ["p", false],
  ]);
  assert.equal(upstreams.platform.length, 2);
  assert.equal(await accessOf(file), "fake-claude-renewed-access-1");
});

test("AC9 (unit): a file changed during the rejected POST is retried once, with no needs-login", async () => {
  const r = rig();
  const file = await claudeFile(START + MIN);
  register(r, "p", "claude", file);
  let calls = 0;
  respond = (_seen, res) => {
    calls += 1;
    if (calls === 1) {
      void writeClaude(
        file,
        START + MIN,
        "fake-claude-cli-access",
        "fake-claude-cli-refresh",
      ).then(() => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end('{"error":"invalid_grant"}');
      });
      return;
    }
    rotatingClaudeTokens()(_seen, res);
  };
  assert.deepEqual(await r.renewal.renew("p"), { kind: "renewed" });
  assert.equal(calls, 2);
  assert.deepEqual(r.reports, []);
  assert.equal(
    JSON.parse(upstreams.platform[1]!.body.toString("utf8")).refresh_token,
    "fake-claude-cli-refresh",
  );
});

test("AC9 (unit): Codex rejected is needs-login; a missing auth.json is no-login without a port call", async () => {
  const r = rig();
  const file = await codexFile(START + MIN);
  register(r, "x", "openai-codex", file);
  r.port.next = { ok: false, kind: "rejected", code: "400" };
  assert.deepEqual(await r.renewal.renew("x"), { kind: "rejected" });
  assert.deepEqual(r.reports, [["x", true]]);
  const gone = join(await mkdtemp(join(tmpdir(), "renewal-")), "auth.json");
  register(r, "y", "openai-codex", gone);
  r.portCalls.length = 0;
  assert.deepEqual(await r.renewal.renew("y"), { kind: "no-login" });
  assert.deepEqual(r.portCalls, []);
  assert.deepEqual(r.reports, [
    ["x", true],
    ["y", true],
  ]);
  for (const code of ["no_credential", "gone"]) {
    r.port.next = { ok: false, kind: "failed", code };
    await writeCodex(file, START + MIN, `fake-codex-${code}`);
    await r.renewal.credentialFor({
      profileId: "x",
      provider: "openai-codex",
      tokenFile: file,
    });
    assert.deepEqual(await r.renewal.renew("x"), { kind: "no-login" });
  }
});

test("AC6: an unregistered profile is skipped, and renewals are single-flight", async () => {
  const r = rig();
  assert.deepEqual(await r.renewal.renew("nobody"), { kind: "skipped" });
  const file = await claudeFile(START + MIN);
  register(r, "p", "claude", file);
  const all = await Promise.all(
    [1, 2, 3, 4, 5].map(() => r.renewal.renew("p")),
  );
  assert.deepEqual(all, Array(5).fill({ kind: "renewed" }));
  assert.equal(upstreams.platform.length, 1);
});

/** A login the way the CLI and pi land one: a new file renamed over the old. */
async function landLogin(file: string, write: (temp: string) => Promise<void>) {
  const temp = `${file}.login`;
  await write(temp);
  await rename(temp, file);
}

const REJECTED_400: UpstreamResponder = (_seen, res) => {
  res.writeHead(400, { "content-type": "application/json" });
  res.end('{"error":"invalid_grant"}');
};

test.each(["claude", "openai-codex"] as const)(
  "F002: a %s login landing as a rejected renewal settles is not condemned by it",
  async (provider) => {
    const r = rig();
    const file =
      provider === "claude"
        ? await claudeFile(START + MIN)
        : await codexFile(START + MIN);
    register(r, "p", provider, file);
    if (provider === "claude") respond = REJECTED_400;
    else r.port.next = { ok: false, kind: "rejected", code: "400" };
    r.afterLane.hook = async () => {
      delete r.afterLane.hook;
      respond = rotatingClaudeTokens();
      r.port.next = { ok: true };
      await landLogin(file, (temp) =>
        provider === "claude"
          ? writeClaude(temp, START + 600 * MIN, "fake-renewal-login-access")
          : writeCodex(temp, START + 600 * MIN, "fake-renewal-login-access"),
      );
    };
    assert.deepEqual(await r.renewal.renew("p"), { kind: "rejected" });
    const read = await r.renewal.credentialFor({
      profileId: "p",
      provider,
      tokenFile: file,
    });
    assert.equal(read.ok, true, "the new login was never refreshed or refused");
    await r.renewal.renew("p");
    assert.deepEqual(r.renewal.needsLogin(), []);
    assert.deepEqual(r.reports.at(-1), ["p", false]);
  },
);

test("F002: a second rejected attempt binds its own file, and a later login clears it", async () => {
  const r = rig();
  const file = await claudeFile(START + MIN);
  register(r, "p", "claude", file);
  let calls = 0;
  respond = (seen, res) => {
    calls += 1;
    if (calls > 1) return REJECTED_400(seen, res);
    void landLogin(file, (temp) =>
      writeClaude(
        temp,
        START + MIN,
        "fake-claude-cli-access",
        "fake-claude-cli-refresh",
      ),
    ).then(() => REJECTED_400(seen, res));
  };
  assert.deepEqual(await r.renewal.renew("p"), { kind: "rejected" });
  assert.equal(calls, 2, "retried once for the changed file, not again");
  const binding = {
    profileId: "p",
    provider: "claude",
    tokenFile: file,
  } as const;
  const refused = await r.renewal.credentialFor(binding);
  assert.deepEqual(
    refused.ok ? undefined : refused.refusal,
    { case: "needs-login", name: "Account p" },
    "the second attempt's file stays refused",
  );
  await r.renewal.tick();
  assert.equal(calls, 2, "sticky: the tick skips it");
  respond = rotatingClaudeTokens();
  await landLogin(file, (temp) =>
    writeClaude(temp, START + 600 * MIN, "fake-renewal-login-access"),
  );
  assert.equal((await r.renewal.credentialFor(binding)).ok, true);
  await r.renewal.renew("p");
  assert.deepEqual(r.renewal.needsLogin(), []);
});

test("F002: a failed renewal's backoff binds the file it examined, so a login landing as it settles ends it", async () => {
  const r = rig();
  const file = await claudeFile(START + MIN);
  register(r, "p", "claude", file);
  respond = (_seen, res) => {
    res.writeHead(503).end();
  };
  r.afterLane.hook = async () => {
    delete r.afterLane.hook;
    respond = rotatingClaudeTokens();
    await landLogin(file, (temp) =>
      writeClaude(temp, START + MIN, "fake-renewal-login-access"),
    );
  };
  assert.deepEqual(await r.renewal.renew("p"), { kind: "failed", code: "503" });
  await r.renewal.tick();
  assert.equal(upstreams.platform.length, 2, "the new login is not in backoff");
  assert.equal(await accessOf(file), "fake-claude-renewed-access-1");
  assert.deepEqual(r.reports, []);
});

test("AC2: a compatible profile with live engine and server leases is never read, laned, logged or renewed", async () => {
  const r = rig();
  const id = "openai-compatible-aaaaaaaaaaaa";
  r.profiles.upsert({
    id,
    provider: "openai-compatible",
    name: "Endpoint",
    enabled: true,
  });
  const binding = { profileId: id, provider: "openai-compatible" } as const;
  r.leases.grant(binding, {
    kind: "engine",
    owner: { workerId: "local", sessionId: "s-compat" },
  });
  r.leases.grant(binding, {
    kind: "server",
    owner: { serverBootId: "boot-compat" },
  });
  assert.ok(r.leases.hasLiveLease(id));
  vi.mocked(readCredential).mockClear();
  await r.renewal.tick();
  r.clock.now += 60 * MIN;
  await r.renewal.tick();
  await r.renewal.recheck(id);
  assert.deepEqual(await r.renewal.renew(id), { kind: "skipped" });
  assert.deepEqual(await r.renewal.renew(id, { force: true }), {
    kind: "skipped",
  });
  assert.equal(vi.mocked(readCredential).mock.calls.length, 0);
  assert.deepEqual(r.laneRuns, []);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.reports, []);
  assert.deepEqual(r.renewal.needsLogin(), []);
  assert.equal(upstreams.platform.length, 0);
  assert.deepEqual(r.portCalls, []);
});

test("Task-1395: a sealing vault's seal-after-write runs in the lane after each renewal, Claude's and Codex's, with the renewed file", async () => {
  const r = rig();
  const claude = await claudeFile(START + 5 * MIN);
  const codex = await codexFile(START + 5 * MIN);
  register(r, "c", "claude", claude);
  register(r, "x", "openai-codex", codex);
  r.port.write = () =>
    writeCodex(codex, START + 60 * MIN, "fake-codex-renewed");
  await r.renewal.tick();
  assert.deepEqual(
    r.written.sort((a, b) => a.file.localeCompare(b.file)),
    [
      { file: claude, access: "fake-claude-renewed-access-1", inLane: true },
      { file: codex, access: "fake-codex-renewed", inLane: true },
    ].sort((a, b) => a.file.localeCompare(b.file)),
  );
});
