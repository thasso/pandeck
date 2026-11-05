/**
 * The gateway's Codex refresher through pi 1.5.0's real `getAuth` (AC13) and
 * its lock-fenced store against pi's own (AC21). `fetch` is stubbed: no
 * request leaves the process, and every token is a fake.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { lock as properLock } from "proper-lockfile";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { renewCodexCredential } from "./codexRenewal.ts";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
// Synthetic fixture values; none is a real credential.
const OLD_REFRESH = "fake-codex-old-refresh";
const NEW_REFRESH = "fake-codex-new-refresh";
const ACCOUNT = "acct-fixture";
const MIN = 60_000;

function fakeJwt(tag: string): string {
  const part = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({
    tag,
    "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT },
  })}.sig`;
}

const OLD_ACCESS = fakeJwt("old");
const NEW_ACCESS = fakeJwt("new");
const SENTINELS = [OLD_ACCESS, NEW_ACCESS, OLD_REFRESH, NEW_REFRESH];

let home: string;
let agentDir: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "codexrenew"));
  home = join(root, "home");
  agentDir = join(root, "agent");
  await mkdir(home);
  await mkdir(agentDir);
  for (const key of ["HOME", "PI_CODING_AGENT_DIR"])
    saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

interface FetchCall {
  url: string;
  body: string;
  contentType: string | null;
}

let calls: FetchCall[];
/** What the stubbed token endpoint does; a fresh token by default. */
let answer: (call: FetchCall) => Promise<Response>;

const renewed = (): Promise<Response> =>
  Promise.resolve(
    Response.json({
      access_token: NEW_ACCESS,
      refresh_token: NEW_REFRESH,
      expires_in: 3600,
    }),
  );

beforeEach(() => {
  calls = [];
  answer = renewed;
  vi.stubGlobal(
    "fetch",
    async (input: string | URL, init: RequestInit = {}) => {
      const call: FetchCall = {
        url: String(input),
        body: String(init.body ?? ""),
        contentType: new Headers(init.headers).get("content-type"),
      };
      calls.push(call);
      return answer(call);
    },
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  // AC13: neither pi's home defaults nor a model catalog were touched.
  assert.equal(existsSync(join(home, ".pi")), false);
  assert.deepEqual(
    (await readdir(agentDir)).filter((name) => name.startsWith("models")),
    [],
  );
});

const ANTHROPIC = { type: "api_key", key: "fake-anthropic-key" };

async function authFile(
  expires: number,
  extra: Record<string, unknown> = { anthropic: ANTHROPIC },
): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), "codexauth")), "pi");
  await mkdir(dir);
  const file = join(dir, "auth.json");
  await writeFile(
    file,
    JSON.stringify(
      {
        ...extra,
        "openai-codex": {
          type: "oauth",
          access: OLD_ACCESS,
          refresh: OLD_REFRESH,
          expires,
          accountId: ACCOUNT,
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return file;
}

function noSentinel(value: unknown): void {
  const text = JSON.stringify(value);
  for (const token of SENTINELS)
    assert.ok(!text.includes(token), "a token leaked");
}

const signal = (): AbortSignal => AbortSignal.timeout(20_000);

/** A `proper-lockfile` lock whose calls are counted. */
function countingLock(): { lock: typeof properLock; calls: number } {
  const counter = {
    calls: 0,
    lock: ((file, options) => {
      counter.calls += 1;
      return properLock(file, options);
    }) as typeof properLock,
  };
  return counter;
}

test("AC13: a fresh login is ok, with no fetch, no lock and no write", async () => {
  const file = await authFile(Date.now() + 60 * MIN);
  const before = await readFile(file);
  const counter = countingLock();
  const result = await renewCodexCredential(file, 30 * MIN, signal(), {
    lock: counter.lock,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, []);
  assert.equal(counter.calls, 0);
  assert.deepEqual(await readFile(file), before);
  assert.equal(existsSync(`${file}.lock`), false);
});

test("AC13: 10 min left inside a 30 min margin renews by one form POST, atomically", async () => {
  const file = await authFile(Date.now() + 10 * MIN);
  const { ino } = await stat(file);
  const result = await renewCodexCredential(file, 30 * MIN, signal());
  assert.deepEqual(result, { ok: true });
  noSentinel(result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, TOKEN_URL);
  assert.equal(calls[0]!.contentType, "application/x-www-form-urlencoded");
  const form = new URLSearchParams(calls[0]!.body);
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), OLD_REFRESH);
  const text = await readFile(file, "utf8");
  const doc = JSON.parse(text);
  assert.equal(text, JSON.stringify(doc, null, 2));
  assert.deepEqual(doc.anthropic, ANTHROPIC);
  const entry = doc["openai-codex"];
  assert.equal(entry.access, NEW_ACCESS);
  assert.equal(entry.refresh, NEW_REFRESH);
  assert.equal(entry.accountId, ACCOUNT);
  assert.ok(entry.expires > Date.now() + 50 * MIN);
  const after = await stat(file);
  assert.notEqual(after.ino, ino);
  assert.equal(after.mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(file, "..")), ["auth.json"]);
});

test("AC13: remaining + 1 forces a renewal of a fresh login", async () => {
  // pi then requires the new token (60 min) to outlive the old one.
  const expires = Date.now() + 40 * MIN;
  const file = await authFile(expires);
  const result = await renewCodexCredential(
    file,
    expires - Date.now() + 1,
    signal(),
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(
    JSON.parse(await readFile(file, "utf8"))["openai-codex"].access,
    NEW_ACCESS,
  );
});

test("AC13: 400 invalid_grant is rejected; a network error and no credential are failed; nothing is written", async () => {
  const file = await authFile(Date.now() + MIN);
  const before = await readFile(file);
  answer = () =>
    Promise.resolve(
      Response.json(
        { error: "invalid_grant", detail: OLD_REFRESH },
        { status: 400 },
      ),
    );
  const rejected = await renewCodexCredential(file, 30 * MIN, signal());
  assert.deepEqual(rejected, { ok: false, kind: "rejected", code: "400" });
  noSentinel(rejected);
  answer = () => Promise.reject(new TypeError("fetch failed"));
  const failed = await renewCodexCredential(file, 30 * MIN, signal());
  assert.equal(failed.ok, false);
  assert.equal(failed.ok === false && failed.kind, "failed");
  noSentinel(failed);
  assert.deepEqual(await readFile(file), before);

  const empty = join(await mkdtemp(join(tmpdir(), "codexauth")), "auth.json");
  await writeFile(empty, "{}");
  assert.deepEqual(await renewCodexCredential(empty, 30 * MIN, signal()), {
    ok: false,
    kind: "failed",
    code: "no_credential",
  });
  assert.equal(await readFile(empty, "utf8"), "{}");
});

test("AC13: a file deleted after the pre-check is gone, and nothing is created", async () => {
  const file = await authFile(Date.now() + MIN);
  const dir = join(file, "..");
  const result = await renewCodexCredential(file, 30 * MIN, signal(), {
    lock: (async (path, options) => {
      await rm(file);
      return properLock(path, options);
    }) as typeof properLock,
  });
  assert.deepEqual(result, { ok: false, kind: "failed", code: "gone" });
  assert.deepEqual(calls, []);
  assert.deepEqual(await readdir(dir), []);
});

/** A fetch answer held until `open()`; `started` resolves when it is asked. */
function gate(): {
  answer: () => Promise<Response>;
  started: Promise<void>;
  open: () => void;
} {
  let open!: () => void;
  let start!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  return {
    answer: async () => {
      start();
      await opened;
      return renewed();
    },
    started,
    open,
  };
}

test("AC21 (1): pi's own store and the renewer race a forced renewal: one fetch, both see the new token", async () => {
  const expires = Date.now() + 10 * MIN;
  const file = await authFile(expires);
  const pi = await ModelRuntime.create({
    authPath: file,
    modelsPath: null,
    refreshOnCreate: false,
  });
  const force = expires - Date.now() + 1;
  const [ours, theirs] = await Promise.all([
    renewCodexCredential(file, force, signal()),
    pi.getAuth("openai-codex", { minOAuthValidityMs: force, signal: signal() }),
  ]);
  assert.deepEqual(ours, { ok: true });
  assert.equal(calls.length, 1);
  assert.ok(theirs);
  assert.ok(JSON.stringify(theirs).includes(NEW_ACCESS));
  assert.equal(
    JSON.parse(await readFile(file, "utf8"))["openai-codex"].access,
    NEW_ACCESS,
  );
});

test("AC21 (1): a fresh pi-style lock delays the renewer; a 31 s stale one is taken", async () => {
  const file = await authFile(Date.now() + MIN);
  const lockDir = `${file}.lock`;
  await mkdir(lockDir);
  const running = renewCodexCredential(file, 30 * MIN, signal());
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls.length, 0, "waits behind the held lock");
  await rm(lockDir, { recursive: true });
  assert.deepEqual(await running, { ok: true });
  assert.equal(calls.length, 1);

  const second = await authFile(Date.now() + MIN);
  await mkdir(`${second}.lock`);
  const old = new Date(Date.now() - 31_000);
  await utimes(`${second}.lock`, old, old);
  const started = Date.now();
  assert.deepEqual(await renewCodexCredential(second, 30 * MIN, signal()), {
    ok: true,
  });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(existsSync(`${second}.lock`), false);
});

test("AC21 (2): a lock lost while refreshing commits nothing and leaves the newer holder's lock", async () => {
  const file = await authFile(Date.now() + MIN);
  const held = gate();
  answer = held.answer;
  let compromise!: (err: Error) => void;
  let lost = false;
  let renames = 0;
  const running = renewCodexCredential(file, 30 * MIN, signal(), {
    lock: (async (path, options) => {
      compromise = options!.onCompromised!;
      const release = await properLock(path, options);
      // proper-lockfile releases nothing once it has reported a compromise.
      return () =>
        lost
          ? Promise.reject(
              Object.assign(new Error("not owned"), { code: "ENOTACQUIRED" }),
            )
          : release();
    }) as typeof properLock,
    rename: () => {
      renames += 1;
    },
  });
  await held.started;
  lost = true;
  compromise(new Error("lock compromised"));
  const newer = JSON.stringify({
    "openai-codex": { type: "oauth", access: "fake-newer" },
  });
  await writeFile(file, newer);
  held.open();
  assert.deepEqual(await running, {
    ok: false,
    kind: "failed",
    code: "lock_lost",
  });
  assert.equal(await readFile(file, "utf8"), newer);
  assert.equal(renames, 0);
  assert.ok(existsSync(`${file}.lock`), "the newer holder's lock is kept");
  await rm(`${file}.lock`, { recursive: true });
});

test("AC21 (3): an entry replaced under an unnoticed loss is a conflict, the file untouched", async () => {
  const file = await authFile(Date.now() + MIN);
  const held = gate();
  answer = held.answer;
  const running = renewCodexCredential(file, 30 * MIN, signal());
  await held.started;
  const other = JSON.stringify({
    "openai-codex": { type: "oauth", access: "fake-other-writer", expires: 1 },
  });
  await writeFile(file, other);
  held.open();
  assert.deepEqual(await running, {
    ok: false,
    kind: "failed",
    code: "conflict",
  });
  assert.equal(await readFile(file, "utf8"), other);
});

test("AC21 (4): another provider's entry added meanwhile is kept by the commit", async () => {
  const file = await authFile(Date.now() + MIN, {});
  const held = gate();
  answer = held.answer;
  const running = renewCodexCredential(file, 30 * MIN, signal());
  await held.started;
  const doc = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ anthropic: ANTHROPIC, ...doc }));
  held.open();
  assert.deepEqual(await running, { ok: true });
  const after = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(after.anthropic, ANTHROPIC);
  assert.equal(after["openai-codex"].access, NEW_ACCESS);
});

test("AC21 (5): a failed rename leaves the old file byte-identical and no temp", async () => {
  const file = await authFile(Date.now() + MIN);
  const before = await readFile(file);
  const result = await renewCodexCredential(file, 30 * MIN, signal(), {
    rename: () => {
      throw Object.assign(new Error("injected"), { code: "EIO" });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.kind, "failed");
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readdir(join(file, "..")), ["auth.json"]);
});
