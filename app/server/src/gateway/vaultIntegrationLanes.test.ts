/**
 * The vault's OAuth record lifecycle in process (Task-1411, AC3, AC4a,
 * AC4b): access reads that refresh once per expiry and write the rotation
 * before answering, a caller's abort that loses nothing, rejected and
 * transient refreshes, one writer per record (put, clear, connect, refresh),
 * and a close that refuses queued work and waits for the running item.
 * An injected clock; a loopback Atlassian fake; every value fake.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import {
  FAKE_API_TOKEN_RECORD,
  FAKE_CLIENT,
  FAKE_CLOUD_ID,
  FAKE_CODE,
  FAKE_PLANTED_REFRESH,
  FAKE_REDIRECT,
  FAKE_SITE,
  jsonResponder,
  startAtlassianFake,
  type AtlassianFake,
} from "../test/atlassianFake.ts";
import {
  createSealedStore,
  recipientOf,
  writeRecipients,
} from "./sealedStore.ts";
import {
  createVaultIntegrations,
  type VaultIntegrationOptions,
} from "./vaultIntegrations.ts";
import { INTEGRATION_FILE, integrationDirId } from "./vaultMethods.ts";
import type { IntegrationRecord } from "./vaultPort.ts";

const root = mkdtempSync(join(tmpdir(), "vault-lanes-"));
let fake: AtlassianFake;
let defaultToken: AtlassianFake["token"];

beforeAll(async () => {
  fake = await startAtlassianFake();
  defaultToken = fake.token;
});
afterEach(() => {
  fake.seen.length = 0;
  fake.token = defaultToken;
  fake.expiresInS = 3600;
});
afterAll(async () => {
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

const TOKEN_CREDENTIAL = FAKE_API_TOKEN_RECORD;

function harness(
  dir = mkdtempSync(join(root, "v-")),
  hooks: Pick<VaultIntegrationOptions, "written" | "discarded"> = {},
) {
  const clock = { now: 1_000_000_000 };
  const lines: string[] = [];
  const port = createVaultIntegrations(
    {
      stateDir: dir,
      clients: { atlassian: FAKE_CLIENT },
      atlassianEndpoint: fake.endpoint,
      ...hooks,
    },
    (line) => lines.push(line),
    () => clock.now,
  );
  const file = join(
    dir,
    "accounts",
    integrationDirId("u1", "atlassian"),
    INTEGRATION_FILE,
  );
  return {
    dir,
    clock,
    lines,
    port,
    file,
    stored: (): Record<string, unknown> =>
      JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>,
    connect: () =>
      port.integrationConnect("u1", "atlassian", {
        code: FAKE_CODE,
        redirectUri: FAKE_REDIRECT,
      }),
    get: (signal?: AbortSignal) =>
      port.integrationGet("u1", "atlassian", signal ? { signal } : {}),
  };
}

/** The access view's fields, from a get's answer. */
function view(record: IntegrationRecord): Record<string, unknown> {
  assert.equal(record.ok, true, JSON.stringify(record));
  return JSON.parse((record as { credential: string }).credential) as Record<
    string,
    unknown
  >;
}

const refreshes = (): string[] =>
  fake
    .on("token")
    .map((request) => JSON.parse(request.body) as Record<string, string>)
    .filter((body) => body.grant_type === "refresh_token")
    .map((body) => body.refresh_token!);

test("access reads: none after connect, one refresh per expiry, the rotation stored and used next", async () => {
  const h = harness();
  assert.equal((await h.connect()).ok, true);
  const connected = fake.issuedRefresh.at(-1)!;
  // (a) The connect's access token is cached: no token request.
  const first = view(await h.get());
  assert.deepEqual(Object.keys(first).sort(), [
    "accessToken",
    "cloudId",
    "expiresAt",
    "kind",
    "site",
  ]);
  assert.equal(first.kind, "atlassian-oauth");
  assert.equal(first.site, FAKE_SITE);
  assert.equal(first.cloudId, FAKE_CLOUD_ID);
  assert.equal(first.expiresAt, h.clock.now + 3600_000);
  assert.deepEqual(refreshes(), []);
  // (b) Inside the 5-minute margin: five reads, one refresh, one answer.
  h.clock.now += 3600_000 - 4 * 60_000;
  const answers = await Promise.all([1, 2, 3, 4, 5].map(() => h.get()));
  assert.deepEqual(refreshes(), [connected]);
  const renewed = answers.map((answer) => view(answer).accessToken);
  assert.equal(new Set(renewed).size, 1);
  assert.notEqual(renewed[0], first.accessToken);
  // (c) The record now holds the rotated token; the next refresh sends it.
  const rotated = fake.issuedRefresh.at(-1)!;
  assert.equal(h.stored().refreshToken, rotated);
  assert.notEqual(rotated, connected);
  h.clock.now += 3600_000;
  view(await h.get());
  assert.deepEqual(refreshes(), [connected, rotated]);
  // The view never carries the refresh token; no line carries a token.
  for (const answer of answers)
    assert.doesNotMatch(JSON.stringify(answer), /fake-atl-refresh/);
  for (const line of h.lines) assert.doesNotMatch(line, /fake-atl-/);
  await h.port.close();
});

test("(d) a caller's abort during a held refresh answers at once and loses no rotation", async () => {
  const h = harness();
  fake.expiresInS = 60;
  await h.connect();
  const held = fake.hold("token");
  const controller = new AbortController();
  const read = h.get(controller.signal);
  await held.arrived;
  controller.abort();
  assert.deepEqual(await read, { ok: false, unavailable: true });
  fake.expiresInS = 3600;
  held.release();
  // The vault finishes: the rotation lands on disk and is cached.
  for (
    let i = 0;
    i < 200 && h.stored().refreshToken !== fake.issuedRefresh.at(-1);
    i++
  )
    await delay(10);
  assert.equal(h.stored().refreshToken, fake.issuedRefresh.at(-1));
  const before = refreshes().length;
  view(await h.get());
  assert.equal(refreshes().length, before);
  await h.port.close();
});

test("(e) a rejected refresh answers rejected and keeps the record; (f) a transient one retries the same token", async () => {
  const h = harness();
  fake.expiresInS = 60;
  await h.connect();
  const before = readFileSync(h.file, "utf8");
  const storedToken = h.stored().refreshToken;
  fake.token = jsonResponder(400, { error: "invalid_grant" });
  assert.deepEqual(await h.get(), { ok: false, rejected: true });
  assert.equal(readFileSync(h.file, "utf8"), before);
  for (const status of [404, 405, 408, 409, 410, 422, 429, 500, 503]) {
    fake.token = jsonResponder(status, {});
    assert.deepEqual(
      await h.get(),
      { ok: false, unavailable: true },
      String(status),
    );
    assert.equal(readFileSync(h.file, "utf8"), before);
  }
  fake.token = defaultToken;
  view(await h.get());
  assert.deepEqual(refreshes(), Array(11).fill(storedToken));
  for (const line of h.lines)
    assert.doesNotMatch(line, /fake-atl-|invalid_grant/);
  await h.port.close();
});

/** Fail a stranded lane promptly without leaving a live deadline behind. */
async function within<T>(answer: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      answer,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("lane did not settle")),
          1_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const queued of [false, true]) {
  test(`a real sealed discard failure settles ${queued ? "queued" : "immediate"} clear, continues the lane and drains`, async () => {
    const dir = mkdtempSync(join(root, "discard-"));
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const privateKeyFile = join(dir, "fake-software-key.pem");
    writeFileSync(
      privateKeyFile,
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    writeRecipients(dir, [
      recipientOf(publicKey.export({ type: "spki", format: "pem" }) as string, {
        privateKeyFile,
      }),
    ]);
    const sealed = createSealedStore({ stateDir: dir, log: () => {} })!;
    assert.deepEqual(await sealed.unlock("unused"), {
      ok: true,
      opened: 0,
      unopened: 0,
    });
    const h = harness(dir, {
      written: sealed.written,
      discarded: sealed.discarded,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    const sealedDir = join(dir, "sealed");
    try {
      assert.deepEqual(
        await h.port.integrationPut("u1", "atlassian", TOKEN_CREDENTIAL),
        { ok: true },
      );
      await delay(0);
      const sealedRecordDir = join(
        sealedDir,
        integrationDirId("u1", "atlassian"),
      );
      assert.equal(
        existsSync(join(sealedRecordDir, `${INTEGRATION_FILE}.sealed`)),
        true,
      );
      // Plaintext removal succeeds; the real discarded hook cannot remove
      // the sealed child from its non-writable parent.
      chmodSync(sealedDir, 0o500);
      const occupied = queued
        ? h.port.integrationPut("u1", "atlassian", TOKEN_CREDENTIAL)
        : Promise.resolve({ ok: true });
      const clear = h.port.integrationClear("u1", "atlassian");
      const next = h.port.integrationPut(
        "u1",
        "atlassian",
        "fake-next-api-record",
      );
      assert.deepEqual(await within(Promise.all([occupied, clear, next])), [
        { ok: true },
        { ok: false, unavailable: true },
        { ok: true },
      ]);
      assert.equal(readFileSync(h.file, "utf8"), "fake-next-api-record");
      // Also close while a failing item is still accounted as running.
      const last = h.port.integrationClear("u1", "atlassian");
      const closing = h.port.close();
      assert.deepEqual(await within(last), { ok: false, unavailable: true });
      await within(closing);
      assert.equal(existsSync(h.file), false);
      // rmSync can remove the child files before its final rmdir fails.
      assert.equal(existsSync(sealedRecordDir), true);
      await delay(0);
      assert.deepEqual(unhandled, []);
    } finally {
      chmodSync(sealedDir, 0o700);
      await h.port.close();
      process.off("unhandledRejection", onUnhandled);
    }
  });
}

test("written hook exceptions settle immediate and queued puts without stranding later work", async () => {
  let calls = 0;
  const h = harness(undefined, {
    written: () => {
      if (++calls === 1 || calls === 3)
        throw new Error("fake written hook failure");
    },
  });
  try {
    assert.deepEqual(
      await within(h.port.integrationPut("u1", "atlassian", "fake-first")),
      { ok: false, unavailable: true },
    );
    const occupied = h.port.integrationPut("u1", "atlassian", "fake-second");
    const failed = h.port.integrationPut("u1", "atlassian", "fake-third");
    const next = h.port.integrationPut("u1", "atlassian", "fake-fourth");
    assert.deepEqual(await within(Promise.all([occupied, failed, next])), [
      { ok: true },
      { ok: false, unavailable: true },
      { ok: true },
    ]);
    assert.equal(readFileSync(h.file, "utf8"), "fake-fourth");
  } finally {
    await h.port.close();
  }
});

test("written hook exceptions after awaited connect and refresh settle unavailable and permit retry", async () => {
  let fail = true;
  const h = harness(undefined, {
    written: () => {
      if (fail) throw new Error("fake written hook failure");
    },
  });
  try {
    assert.deepEqual(await within(h.connect()), {
      ok: false,
      unavailable: true,
    });
    fail = false;
    fake.expiresInS = 60;
    assert.equal((await h.connect()).ok, true);
    fail = true;
    assert.deepEqual(await within(h.get()), { ok: false, unavailable: true });
    const rotated = h.stored().refreshToken;
    fail = false;
    view(await h.get());
    assert.equal(refreshes().at(-1), rotated);
  } finally {
    await h.port.close();
  }
});

test("(g) a new vault on the same state refreshes on its first read", async () => {
  const h = harness();
  await h.connect();
  await h.port.close();
  const stored = h.stored().refreshToken;
  const again = harness(h.dir);
  view(await again.get());
  assert.deepEqual(refreshes(), [stored]);
  await again.port.close();
});

test("an API-token record is answered verbatim; a put cannot plant an OAuth record", async () => {
  const h = harness();
  assert.deepEqual(
    await h.port.integrationPut("u1", "atlassian", TOKEN_CREDENTIAL),
    { ok: true },
  );
  assert.deepEqual(await h.get(), { ok: true, credential: TOKEN_CREDENTIAL });
  const planted = JSON.stringify({
    kind: "atlassian-oauth",
    v: 1,
    site: FAKE_SITE,
    cloudId: FAKE_CLOUD_ID,
    refreshToken: FAKE_PLANTED_REFRESH,
    scope: "",
  });
  assert.deepEqual(await h.port.integrationPut("u1", "atlassian", planted), {
    ok: false,
    unavailable: true,
  });
  assert.equal(readFileSync(h.file, "utf8"), TOKEN_CREDENTIAL);
  assert.equal(fake.seen.length, 0);
  await h.port.close();
});

test("one writer per record: a clear or put behind a held refresh wins, a connect lands after it", async () => {
  const h = harness();
  fake.expiresInS = 60;
  await h.connect();
  // Clear behind a refresh: the record stays gone (no resurrection).
  let held = fake.hold("token");
  const refreshed = h.get();
  await held.arrived;
  const cleared = h.port.integrationClear("u1", "atlassian");
  held.release();
  view(await refreshed);
  assert.deepEqual(await cleared, { ok: true });
  assert.equal(existsSync(h.file), false);
  assert.deepEqual(await h.get(), { ok: false, absent: true });

  // Put behind a refresh: the token record wins.
  await h.connect();
  held = fake.hold("token");
  const refreshed2 = h.get();
  await held.arrived;
  const put = h.port.integrationPut("u1", "atlassian", TOKEN_CREDENTIAL);
  held.release();
  view(await refreshed2);
  assert.deepEqual(await put, { ok: true });
  assert.deepEqual(await h.get(), { ok: true, credential: TOKEN_CREDENTIAL });

  // A connect queued behind a held refresh runs after it.
  await h.connect();
  held = fake.hold("token");
  const refreshed3 = h.get();
  await held.arrived;
  const connected = h.connect();
  await delay(50);
  // Only the held refresh has reached the fake.
  assert.equal(fake.on("token").at(-1)!.body.includes("refresh_token"), true);
  held.release();
  view(await refreshed3);
  assert.equal((await connected).ok, true);
  const grants = fake
    .on("token")
    .slice(-2)
    .map(
      (request) =>
        (JSON.parse(request.body) as { grant_type: string }).grant_type,
    );
  assert.deepEqual(grants, ["refresh_token", "authorization_code"]);
  assert.equal(h.stored().refreshToken, fake.issuedRefresh.at(-1));
  await h.port.close();
});

test("close: refuses queued and later work, waits for the running refresh with its write", async () => {
  const h = harness();
  fake.expiresInS = 60;
  await h.connect();
  const held = fake.hold("token");
  const refreshed = h.get();
  await held.arrived;
  const queuedClear = h.port.integrationClear("u1", "atlassian");
  let closed = false;
  const closing = h.port.close().then(() => (closed = true));
  // (4) The queued clear is refused unrun.
  assert.deepEqual(await queuedClear, { ok: false, unavailable: true });
  // (5) Nothing later is admitted or written.
  assert.deepEqual(
    await h.port.integrationPut("u1", "atlassian", TOKEN_CREDENTIAL),
    { ok: false, unavailable: true },
  );
  assert.deepEqual(
    await h.port.integrationConnect("u1", "atlassian", {
      code: FAKE_CODE,
      redirectUri: FAKE_REDIRECT,
    }),
    { ok: false, unavailable: true },
  );
  await delay(50);
  assert.equal(closed, false);
  held.release();
  view(await refreshed);
  await closing;
  // The running refresh finished first: its rotation is on disk.
  assert.equal(h.stored().refreshToken, fake.issuedRefresh.at(-1));
  // A read that needs a refresh is no longer admitted.
  h.clock.now += 3600_000;
  const before = fake.seen.length;
  assert.deepEqual(await h.get(), { ok: false, unavailable: true });
  assert.equal(fake.seen.length, before);
});
