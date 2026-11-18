/**
 * The request log's ring, reads and seen set (Task-1430 PR1, C3 and C6).
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
import { afterEach, test } from "vitest";
import {
  createRequestLog,
  PAGE_LIMIT,
  PATH_CHARS,
  RING_CAPACITY,
  SEEN_CAPACITY,
  type RequestEntry,
} from "./requestLog.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const stateDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "request-log-"));
  dirs.push(dir);
  return dir;
};

function entry(overrides: Partial<RequestEntry> = {}): RequestEntry {
  return {
    userId: "u1",
    client: { id: "c1", label: "devbox" },
    via: "gateway",
    at: 1_000,
    host: "api.anthropic.com",
    method: "POST",
    path: "/v1/messages",
    status: 200,
    outcome: "forwarded",
    clientCredential: "placeholder",
    clientCookie: false,
    requestBytes: 10,
    responseBytes: 20,
    durationMs: 5,
    ...overrides,
  };
}

test("record numbers from 1, keeps no user id and writes exactly one line", () => {
  const lines: string[] = [];
  const log = createRequestLog({ log: (line) => lines.push(line) });
  assert.match(log.epoch, /^[0-9a-f]{32}$/);
  const record = log.record(entry());
  assert.equal(record.seq, 1);
  assert.equal(record.epoch, log.epoch);
  assert.equal(record.pathKey, "/v1/messages");
  assert.equal(record.firstSeen, true);
  assert.ok(!("userId" in record));
  assert.ok(Object.isFrozen(record));
  assert.deepEqual(lines, [
    'request via=gateway client=c1 POST "/v1/messages" 200 outcome=forwarded 5ms',
  ]);
  // A writer's own line replaces the standard one; still exactly one.
  log.record(entry({ outcome: "refused", reason: "forbidden" }), "own line");
  assert.deepEqual(lines.slice(1), ["own line"]);
  log.record(
    entry({ via: "relay", rid: "a".repeat(32) + ":1", status: null, count: 2 }),
  );
  assert.equal(
    lines[2],
    `request via=relay client=c1 POST "/v1/messages" - outcome=forwarded count=2 rid=${"a".repeat(32)}:1 5ms`,
  );
});

test("a record holds only the contract's fields, whatever a writer adds", () => {
  const log = createRequestLog({ log: () => {} });
  const sneaky = {
    ...entry({ session: "0123456789ab", account: "Account a" }),
    headers: { authorization: "Bearer SECRET" },
    query: "q=SECRET",
  } as RequestEntry;
  const record = log.record(sneaky);
  assert.ok(!JSON.stringify(record).includes("SECRET"));
  assert.deepEqual(Object.keys(record).sort(), [
    "account",
    "at",
    "client",
    "clientCookie",
    "clientCredential",
    "durationMs",
    "epoch",
    "firstSeen",
    "host",
    "method",
    "outcome",
    "path",
    "pathKey",
    "requestBytes",
    "responseBytes",
    "seq",
    "session",
    "status",
    "via",
  ]);
});

test("the path is cut to 200 characters; first-seen keys on the cut path", () => {
  const log = createRequestLog({ log: () => {} });
  const long = `/${"p".repeat(300)}`;
  const record = log.record(entry({ path: long }));
  assert.equal(record.path.length, PATH_CHARS);
  assert.equal(record.pathKey, record.path);
  assert.equal(log.record(entry({ path: `${long}x` })).firstSeen, false);
});

test("since: only the user's records after the cursor, oldest first, at most 500", () => {
  const log = createRequestLog({ log: () => {} });
  // u1 gets the 600 odd seqs, u2 the 600 even ones.
  for (let i = 0; i < 1_200; i += 1)
    log.record(entry({ userId: i % 2 === 0 ? "u1" : "u2", path: `/p${i}` }));
  const all = log.since("u1", log.epoch, 0, 10_000);
  assert.equal(all.epoch, log.epoch);
  assert.equal(all.records.length, PAGE_LIMIT);
  assert.deepEqual(
    all.records.slice(0, 3).map((r) => r.seq),
    [1, 3, 5],
  );
  const rest = log.since("u1", log.epoch, all.records.at(-1)!.seq, 500);
  assert.equal(rest.records.length, 600 - PAGE_LIMIT);
  assert.ok(rest.records.every((r) => r.seq > all.records.at(-1)!.seq));
  assert.equal(log.since("u2", log.epoch, 0, 5).records.length, 5);
  assert.equal(log.since("u2", log.epoch, 0, 5).records[0]!.seq, 2);
  assert.deepEqual(log.since("u3", undefined, 0, 500).records, []);
  // A stale or absent epoch reads from the start, whatever its cursor.
  assert.equal(log.since("u1", "f".repeat(32), 1_199, 1).records[0]!.seq, 1);
  assert.equal(log.since("u1", undefined, 1_199, 1).records[0]!.seq, 1);
  // Nonsense limits and cursors answer nothing unbounded.
  assert.equal(log.since("u1", log.epoch, 0, Number.NaN).records.length, 0);
  assert.equal(log.since("u1", log.epoch, 0, -3).records.length, 0);
  assert.equal(log.since("u1", log.epoch, Number.NaN, 1).records[0]!.seq, 1);
});

test("the ring keeps the newest 5000", () => {
  const log = createRequestLog({ log: () => {} });
  for (let i = 0; i < RING_CAPACITY + 7; i += 1) log.record(entry());
  const first = log.since("u1", log.epoch, 0, 1).records[0]!;
  assert.equal(first.seq, 8);
  assert.equal(
    log.since("u1", log.epoch, RING_CAPACITY + 6, 500).records[0]!.seq,
    RING_CAPACITY + 7,
  );
});

test("the seen set persists privately, host, method and path key only", () => {
  const dir = stateDir();
  const first = createRequestLog({ stateDir: dir, log: () => {} });
  assert.equal(first.record(entry()).firstSeen, true);
  assert.equal(first.record(entry()).firstSeen, false);
  assert.equal(first.record(entry({ method: "GET" })).firstSeen, true);
  assert.equal(first.record(entry({ host: "chatgpt.com" })).firstSeen, true);
  const file = join(dir, "seenRequests.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    seen: [
      { host: "api.anthropic.com", method: "POST", pathKey: "/v1/messages" },
      { host: "api.anthropic.com", method: "GET", pathKey: "/v1/messages" },
      { host: "chatgpt.com", method: "POST", pathKey: "/v1/messages" },
    ],
  });
  const second = createRequestLog({ stateDir: dir, log: () => {} });
  assert.notEqual(second.epoch, first.epoch);
  assert.equal(second.record(entry()).firstSeen, false);
  assert.equal(second.record(entry()).seq, 2);
});

test("past 4096 a new path is flagged once per start, not stored, with one line", () => {
  const dir = stateDir();
  const file = join(dir, "seenRequests.json");
  const seen = Array.from({ length: SEEN_CAPACITY }, (_, i) => ({
    host: "api.anthropic.com",
    method: "POST",
    pathKey: `/p${i}`,
  }));
  writeFileSync(file, JSON.stringify({ seen }), { mode: 0o600 });
  const lines: string[] = [];
  const log = createRequestLog({ stateDir: dir, log: (l) => lines.push(l) });
  assert.equal(log.record(entry({ path: "/p1" }), "-").firstSeen, false);
  assert.equal(log.record(entry({ path: "/new" }), "-").firstSeen, true);
  assert.equal(log.record(entry({ path: "/new" }), "-").firstSeen, false);
  assert.equal(log.record(entry({ path: "/new2" }), "-").firstSeen, true);
  assert.deepEqual(
    lines.filter((line) => line !== "-"),
    [
      `request log: seen set full (${SEEN_CAPACITY}); new paths are flagged, not stored`,
    ],
  );
  assert.equal(
    (JSON.parse(readFileSync(file, "utf8")) as { seen: unknown[] }).seen.length,
    SEEN_CAPACITY,
  );
  // Another start flags it again: it was never stored.
  const again = createRequestLog({ stateDir: dir, log: () => {} });
  assert.equal(again.record(entry({ path: "/new" })).firstSeen, true);
});

test("an unreadable seen set starts empty without echoing it, and is replaced", () => {
  const dir = stateDir();
  const file = join(dir, "seenRequests.json");
  writeFileSync(file, '{"seen": [SECRET-BROKEN', { mode: 0o600 });
  const lines: string[] = [];
  const log = createRequestLog({ stateDir: dir, log: (l) => lines.push(l) });
  assert.deepEqual(lines, ["request log: seen set unreadable; starting empty"]);
  assert.equal(log.record(entry(), "-").firstSeen, true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    seen: [
      { host: "api.anthropic.com", method: "POST", pathKey: "/v1/messages" },
    ],
  });
  // Malformed entries are dropped, the rest kept.
  writeFileSync(
    file,
    JSON.stringify({
      seen: [
        { host: "h", method: "GET", pathKey: "/ok" },
        { host: 5, method: "GET", pathKey: "/bad" },
        "junk",
        { host: "h", method: "", pathKey: "/bad" },
      ],
    }),
  );
  const next = createRequestLog({ stateDir: dir, log: () => {} });
  assert.equal(
    next.record(entry({ host: "h", method: "GET", path: "/ok" })).firstSeen,
    false,
  );
});

test("a failed save keeps memory and logs one fixed line until a save works", () => {
  const dir = stateDir();
  const lines: string[] = [];
  const log = createRequestLog({ stateDir: dir, log: (l) => lines.push(l) });
  // A directory where the temp file goes makes every write fail.
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(dir, "not a directory");
  dirs.push(dir);
  assert.equal(log.record(entry({ path: "/a" }), "-").firstSeen, true);
  assert.equal(log.record(entry({ path: "/a" }), "-").firstSeen, false);
  assert.equal(log.record(entry({ path: "/b" }), "-").firstSeen, true);
  const failures = lines.filter((line) => line !== "-");
  assert.equal(failures.length, 1);
  assert.match(
    failures[0]!,
    /^request log: seen set not saved \([A-Z_a-z]+\)$/,
  );
});
