/**
 * The Claude SDK record format (`claudeSdkRecords.ts`) and the store that
 * writes it: a persist appends only what changed, a crash leaves the previous
 * record readable, a legacy single-file record keeps loading and migrates on
 * its first persist, and deletion leaves nothing behind.
 *
 * Run through Vitest: `pnpm --filter @assistant/server test src/claudeSdk/claudeSdkRecords.test.ts`
 */
import assert from "node:assert/strict";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  displayMessageCount,
  entriesToDisplayMessages,
} from "@assistant/shared/display";
import type { ClientTimelineEntry } from "@assistant/shared/runtime";
import { DATA_DIR } from "../config.ts";
import { sessionStore } from "../db/sessionStore.ts";
import {
  claudeSdkRecordIds,
  readClaudeSdkRecord,
  ClaudeSdkRecordReadError,
  ClaudeSdkRecordWriteError,
  readClaudeSdkRecordMeta,
  removeClaudeSdkRecord,
  writeClaudeSdkRecord,
  type ClaudeSdkRecord,
  type ClaudeSdkRecordMeta,
} from "./claudeSdkRecords.ts";
import { claudeSdkStore } from "./claudeSdkStore.ts";
import { claudeTurnSeam } from "../test/claudeTurnSeam.ts";

const tmp = mkdtempSync(join(tmpdir(), "claude-sdk-records-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
const at = "2026-09-29T00:00:00.000Z";

function user(id: string, text: string): ClientTimelineEntry {
  return {
    id,
    seq: seq++,
    createdAt: at,
    type: "message",
    role: "user",
    origin: { kind: "human" },
    content: [{ type: "text", text }],
  } as ClientTimelineEntry;
}

function assistant(id: string, toolCallId?: string): ClientTimelineEntry {
  return {
    id,
    seq: seq++,
    createdAt: at,
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: `reply ${id}\nwith a newline` },
      ...(toolCallId
        ? [{ type: "toolCall", toolCallId, name: "Read", input: {} }]
        : []),
    ],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  } as unknown as ClientTimelineEntry;
}

function toolResult(id: string, toolCallId: string): ClientTimelineEntry {
  return {
    id,
    seq: seq++,
    createdAt: at,
    type: "message",
    role: "toolResult",
    toolCallId,
    toolName: "Read",
    content: [{ type: "text", text: "contents" }],
  } as ClientTimelineEntry;
}

function meta(
  id: string,
  patch: Partial<ClaudeSdkRecordMeta> = {},
): ClaudeSdkRecordMeta {
  return {
    id,
    title: "Records",
    providerSessionId: "provider-1",
    modelId: "sonnet",
    usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, cost: 0.5 },
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  };
}

function freshDir(): string {
  return mkdtempSync(join(tmp, "store-"));
}

const logFile = (dir: string, id: string) => join(dir, `${id}.entries.jsonl`);
const metaFile = (dir: string, id: string) => join(dir, `${id}.json`);
const lines = (path: string) =>
  readFileSync(path, "utf8").split("\n").filter(Boolean);

describe("record format", () => {
  test("writes a new record whole, then appends only what a persist adds", () => {
    const dir = freshDir();
    const committed = [user("u1", "hi"), assistant("a1", "t1")];
    committed.push(toolResult("r1", "t1"));
    const first = writeClaudeSdkRecord(dir, meta("s"), committed, undefined);

    const stored = JSON.parse(readFileSync(metaFile(dir, "s"), "utf8"));
    assert.equal("entries" in stored, false, "the metadata holds no timeline");
    assert.deepEqual(stored.entryLog, {
      messages: 2,
      assistantTurns: 1,
      usageTurns: 1,
      count: 3,
      bytes: readFileSync(logFile(dir, "s")).length,
    });
    assert.equal(lines(logFile(dir, "s")).length, 3, "one entry per line");

    const before = readFileSync(logFile(dir, "s"), "utf8");
    committed.push(user("u2", "again"), assistant("a2"));
    const second = writeClaudeSdkRecord(dir, meta("s"), committed, first);
    const after = readFileSync(logFile(dir, "s"), "utf8");
    assert.ok(after.startsWith(before), "the earlier entries stay untouched");
    assert.equal(lines(logFile(dir, "s")).length, 5);

    // A metadata-only persist (a rename) writes no timeline bytes at all.
    writeClaudeSdkRecord(
      dir,
      meta("s", { title: "Renamed" }),
      committed,
      second,
    );
    assert.equal(readFileSync(logFile(dir, "s"), "utf8"), after);

    const loaded = readClaudeSdkRecord(dir, "s");
    assert.deepEqual(loaded?.record.entries, committed);
    assert.equal(loaded?.record.title, "Renamed");
    assert.equal(loaded?.cursor.kind, "append");
    assert.deepEqual(readClaudeSdkRecordMeta(dir, "s")?.figures, {
      messages: entriesToDisplayMessages(committed).length,
      assistantTurns: 2,
      usageTurns: 2,
    });
    assert.equal(
      existsSync(`${metaFile(dir, "s")}.tmp`),
      false,
      "the atomic write leaves no temp file behind",
    );
  });

  test("ignores a tail past the vouched extent, and cuts it off before appending", () => {
    const dir = freshDir();
    const committed = [user("u1", "hi"), assistant("a1")];
    writeClaudeSdkRecord(dir, meta("torn"), committed, undefined);
    // A crash between an append and its metadata rename: one whole line and
    // one torn line the metadata never vouched for.
    appendFileSync(
      logFile(dir, "torn"),
      `${JSON.stringify(user("ghost", "never persisted"))}\n{"id":"to`,
    );

    const loaded = readClaudeSdkRecord(dir, "torn");
    assert.deepEqual(loaded?.record.entries, committed);
    assert.deepEqual(
      loaded?.cursor,
      {
        kind: "append",
        log: readClaudeSdkRecordMetaLog(dir, "torn"),
        tailChecked: false,
      },
      "the log is intact up to its extent, and its tail is not yet checked",
    );

    committed.push(user("u2", "after the crash"));
    writeClaudeSdkRecord(dir, meta("torn"), committed, loaded?.cursor);
    assert.deepEqual(
      lines(logFile(dir, "torn")).map((line) => JSON.parse(line).id),
      ["u1", "a1", "u2"],
      "the stale tail is gone, not buried mid-file",
    );
    assert.deepEqual(
      readClaudeSdkRecord(dir, "torn")?.record.entries,
      committed,
    );
  });

  test("a transcript with multi-byte text reloads intact and appends only its new bytes", () => {
    const dir = freshDir();
    const committed = [
      user("u1", "café — naïve"),
      user("u2", "emoji 🎉 and 𝄞, CJK 日本語"),
      user("u3", "separators \u2028 \u2029 and \n escaped"),
    ];
    const written = writeClaudeSdkRecord(
      dir,
      meta("utf8"),
      committed,
      undefined,
    );
    const loaded = readClaudeSdkRecord(dir, "utf8");
    assert.deepEqual(loaded?.record.entries, committed);
    assert.deepEqual(
      loaded?.cursor,
      written.kind === "append" ? { ...written, tailChecked: false } : written,
      "the byte extent matches, so the log is intact, not queued for a rewrite",
    );

    const before = statSync(logFile(dir, "utf8"));
    const added = user("u4", "más ✓");
    committed.push(added);
    writeClaudeSdkRecord(dir, meta("utf8"), committed, loaded?.cursor);
    const after = statSync(logFile(dir, "utf8"));
    assert.equal(after.ino, before.ino, "appended in place, not replaced");
    assert.equal(
      after.size,
      before.size + Buffer.byteLength(`${JSON.stringify(added)}\n`),
      "exactly the new line's bytes were written",
    );
    assert.deepEqual(
      readClaudeSdkRecord(dir, "utf8")?.record.entries,
      committed,
    );
  });

  test("a line cut inside a multi-byte character is dropped, every complete entry kept", () => {
    const dir = freshDir();
    const committed = [
      user("u1", "one"),
      user("u2", "two"),
      user("u3", "🎉🎉"),
    ];
    writeClaudeSdkRecord(dir, meta("cut"), committed, undefined);
    const text = readFileSync(logFile(dir, "cut"), "utf8");
    const twoLines = Buffer.byteLength(
      text.split("\n").slice(0, 2).join("\n") + "\n",
    );
    const emojiAt = Buffer.from(text).indexOf(Buffer.from("🎉"), twoLines);
    truncateSync(logFile(dir, "cut"), emojiAt + 2); // mid-character

    const loaded = readClaudeSdkRecord(dir, "cut");
    assert.deepEqual(loaded?.record.entries, committed.slice(0, 2));
    assert.equal(loaded?.cursor.kind, "append");
    const resumed = [...committed.slice(0, 2), user("u4", "after")];
    writeClaudeSdkRecord(dir, meta("cut"), resumed, loaded?.cursor);
    assert.deepEqual(readClaudeSdkRecord(dir, "cut")?.record.entries, resumed);
  });

  test("a backup pairing newer metadata with an older log loads every entry the log has", () => {
    const dir = freshDir();
    const early = [user("u1", "hi"), assistant("a1")];
    const first = writeClaudeSdkRecord(dir, meta("backup"), early, undefined);
    const olderLog = join(dir, "older.jsonl");
    copyFileSync(logFile(dir, "backup"), olderLog);
    const later = [...early, user("u2", "more"), assistant("a2")];
    writeClaudeSdkRecord(dir, meta("backup"), later, first);
    // The restore: the log as it was before the append, the metadata after.
    copyFileSync(olderLog, logFile(dir, "backup"));

    assert.deepEqual(
      readClaudeSdkRecordMeta(dir, "backup")?.figures,
      { messages: 2, assistantTurns: 1, usageTurns: 1 },
      "the figures are recounted over what the log holds",
    );
    const loaded = readClaudeSdkRecord(dir, "backup");
    assert.deepEqual(loaded?.record.entries, early);
    assert.equal(loaded?.cursor.kind, "append");

    const before = statSync(logFile(dir, "backup")).ino;
    const resumed = [...early, user("u3", "after the restore")];
    writeClaudeSdkRecord(dir, meta("backup"), resumed, loaded?.cursor);
    assert.equal(statSync(logFile(dir, "backup")).ino, before);
    assert.deepEqual(
      readClaudeSdkRecord(dir, "backup")?.record.entries,
      resumed,
    );
    assert.deepEqual(readClaudeSdkRecordMeta(dir, "backup")?.figures, {
      messages: 3,
      assistantTurns: 1,
      usageTurns: 1,
    });
  });

  test("an unreadable line in the middle is skipped and the log rewritten", () => {
    const dir = freshDir();
    const committed = [user("u1", "hi"), user("u2", "bad"), user("u3", "ok")];
    writeClaudeSdkRecord(dir, meta("mid"), committed, undefined);
    const text = readFileSync(logFile(dir, "mid"), "utf8").split("\n");
    text[1] = "#".repeat(Buffer.byteLength(text[1]!));
    writeFileSync(logFile(dir, "mid"), text.join("\n"));

    const loaded = readClaudeSdkRecord(dir, "mid");
    assert.deepEqual(loaded?.record.entries, [committed[0], committed[2]]);
    assert.deepEqual(loaded?.cursor, { kind: "rewrite" });
    const kept = loaded!.record.entries;
    writeClaudeSdkRecord(dir, meta("mid"), kept, loaded?.cursor);
    assert.deepEqual(readClaudeSdkRecord(dir, "mid")?.record.entries, kept);
  });

  test("a log another writer appended to is never clobbered", () => {
    const dir = freshDir();
    const committed = [user("u1", "hi")];
    const cursor = writeClaudeSdkRecord(
      dir,
      meta("rival"),
      committed,
      undefined,
    );
    appendFileSync(
      logFile(dir, "rival"),
      `${JSON.stringify(user("other", "someone else's turn"))}\n`,
    );
    const log = readFileSync(logFile(dir, "rival"), "utf8");
    const stored = readFileSync(metaFile(dir, "rival"), "utf8");

    committed.push(user("u2", "ours"));
    assert.throws(
      () => writeClaudeSdkRecord(dir, meta("rival"), committed, cursor),
      (err: unknown) =>
        err instanceof ClaudeSdkRecordWriteError &&
        err.conflict &&
        err.next === cursor,
    );
    assert.equal(readFileSync(logFile(dir, "rival"), "utf8"), log);
    assert.equal(readFileSync(metaFile(dir, "rival"), "utf8"), stored);
  });

  test("a first write after a load never cuts off entries another writer published", () => {
    const dir = freshDir();
    const cursor = writeClaudeSdkRecord(
      dir,
      meta("published"),
      [user("u1", "hi")],
      undefined,
    );
    // A second writer holding the same cursor appends its turn and publishes
    // the metadata that vouches for it.
    writeClaudeSdkRecord(
      dir,
      meta("published", { title: "Theirs" }),
      [user("u1", "hi"), user("other", "their turn")],
      cursor,
    );
    const log = readFileSync(logFile(dir, "published"), "utf8");
    const stored = readFileSync(metaFile(dir, "published"), "utf8");

    const stale =
      cursor.kind === "append" ? { ...cursor, tailChecked: false } : cursor;
    assert.throws(
      () =>
        writeClaudeSdkRecord(
          dir,
          meta("published"),
          [user("u1", "hi"), user("u2", "our turn")],
          stale,
        ),
      (err: unknown) =>
        err instanceof ClaudeSdkRecordWriteError && err.conflict,
    );
    assert.equal(readFileSync(logFile(dir, "published"), "utf8"), log);
    assert.equal(readFileSync(metaFile(dir, "published"), "utf8"), stored);
  });

  test("a log that lost entries the session still holds is rewritten from the session", () => {
    const dir = freshDir();
    const committed = [user("u1", "hi"), assistant("a1"), user("u2", "more")];
    const cursor = writeClaudeSdkRecord(
      dir,
      meta("lost"),
      committed,
      undefined,
    );
    const firstLine = lines(logFile(dir, "lost"))[0]!;
    truncateSync(logFile(dir, "lost"), Buffer.byteLength(`${firstLine}\n`));

    committed.push(assistant("a2"));
    writeClaudeSdkRecord(dir, meta("lost"), committed, cursor);
    assert.deepEqual(
      readClaudeSdkRecord(dir, "lost")?.record.entries,
      committed,
    );
  });

  test("a stale append cursor never appends past a shorter file", () => {
    const dir = freshDir();
    const committed = [user("u1", "hi"), assistant("a1")];
    const cursor = writeClaudeSdkRecord(
      dir,
      meta("gone"),
      committed,
      undefined,
    );
    writeFileSync(logFile(dir, "gone"), "");
    committed.push(user("u2", "next"));
    writeClaudeSdkRecord(
      dir,
      meta("gone"),
      committed,
      cursor.kind === "append" ? { ...cursor, tailChecked: false } : cursor,
    );
    assert.deepEqual(
      readClaudeSdkRecord(dir, "gone")?.record.entries,
      committed,
    );
  });

  test("reads a legacy single-file record and migrates it on its first write", () => {
    const dir = freshDir();
    const entries = [user("u1", "legacy"), assistant("a1", "t1")];
    entries.push(toolResult("r1", "t1"));
    const legacy: ClaudeSdkRecord = {
      ...meta("old"),
      mode: "plan",
      entries,
    };
    writeFileSync(metaFile(dir, "old"), JSON.stringify(legacy, null, 2));
    // A migration that crashed after writing the new log but before replacing
    // the metadata: the legacy file is still the record, the stray log is not.
    writeFileSync(logFile(dir, "old"), "not json\n");

    assert.deepEqual(readClaudeSdkRecordMeta(dir, "old"), {
      meta: withoutEntries(legacy),
      figures: { messages: 2, assistantTurns: 1, usageTurns: 1 },
    });
    const loaded = readClaudeSdkRecord(dir, "old");
    assert.deepEqual(loaded?.record, legacy);
    assert.deepEqual(loaded?.cursor, { kind: "rewrite" });

    writeClaudeSdkRecord(dir, withoutEntries(legacy), entries, loaded?.cursor);
    const stored = JSON.parse(readFileSync(metaFile(dir, "old"), "utf8"));
    assert.equal("entries" in stored, false);
    assert.deepEqual(readClaudeSdkRecord(dir, "old")?.record, legacy);
  });

  test("only a missing metadata file is no record; a malformed one refuses to load", () => {
    const dir = freshDir();
    writeFileSync(metaFile(dir, "bad"), JSON.stringify({ id: "bad" }));
    writeFileSync(
      metaFile(dir, "neg"),
      JSON.stringify({
        id: "neg",
        entryLog: {
          count: -1,
          bytes: 0,
          messages: 0,
          assistantTurns: 0,
          usageTurns: 0,
        },
      }),
    );
    writeFileSync(metaFile(dir, "torn"), '{"id": "to');
    assert.equal(readClaudeSdkRecord(dir, "missing"), undefined);
    assert.equal(readClaudeSdkRecordMeta(dir, "missing"), undefined);
    for (const id of ["bad", "neg", "torn"]) {
      assert.throws(
        () => readClaudeSdkRecord(dir, id),
        ClaudeSdkRecordReadError,
        id,
      );
      assert.throws(
        () => readClaudeSdkRecordMeta(dir, id),
        ClaudeSdkRecordReadError,
        id,
      );
    }
  });

  test("removal deletes every file of a record, and listing sees only records", () => {
    const dir = freshDir();
    writeClaudeSdkRecord(dir, meta("x"), [user("u1", "hi")], undefined);
    writeFileSync(`${metaFile(dir, "x")}.tmp`, "{}");
    writeFileSync(`${logFile(dir, "x")}.tmp`, "");
    writeClaudeSdkRecord(dir, meta("y"), [], undefined);
    assert.deepEqual(claudeSdkRecordIds(dir).sort(), ["x", "y"]);

    removeClaudeSdkRecord(dir, "x");
    for (const path of [metaFile(dir, "x"), logFile(dir, "x")])
      for (const file of [path, `${path}.tmp`])
        assert.equal(existsSync(file), false, file);
    assert.deepEqual(claudeSdkRecordIds(dir), ["y"]);
    assert.deepEqual(claudeSdkRecordIds(join(dir, "nope")), []);
  });
});

function withoutEntries(record: ClaudeSdkRecord): ClaudeSdkRecordMeta {
  const { entries: _entries, ...rest } = record;
  return rest;
}

function readClaudeSdkRecordMetaLog(dir: string, id: string): unknown {
  return JSON.parse(readFileSync(metaFile(dir, id), "utf8")).entryLog;
}

/* --------------------------------- store ---------------------------------- */

describe("store persistence", () => {
  const dir = join(DATA_DIR, "claude-sdk");
  beforeAll(() =>
    claudeSdkStore.setSeam(() => Promise.resolve(claudeTurnSeam)),
  );

  test("a live session appends each turn, survives a clear, and is gone after removal", async () => {
    const id = `records-live-${Date.now()}`;
    const session = claudeSdkStore.acquire(id, { modelId: "sonnet" });
    const adapter = session.createRuntimeAdapter();

    await adapter.prompt("first");
    const afterFirst = readFileSync(logFile(dir, id), "utf8");
    assert.equal(
      lines(logFile(dir, id)).length,
      session.timelineEntries().length,
    );

    await adapter.prompt("second");
    assert.ok(
      readFileSync(logFile(dir, id), "utf8").startsWith(afterFirst),
      "the second turn appended to the first turn's log",
    );
    const loaded = readClaudeSdkRecord(dir, id);
    assert.deepEqual(loaded?.record.entries, session.timelineEntries());
    assert.equal(loaded?.record.providerSessionId, "provider-store");
    const committed = session.timelineEntries();
    assert.equal(
      sessionStore.get(id)?.messageCount,
      displayMessageCount(committed),
      "the metadata row counts the whole timeline from the log's figures",
    );
    assert.equal(sessionStore.get(id)?.messageCount, 4);

    // A clear replaces the provider context, never our transcript.
    const outcome = await session.clearContext();
    assert.equal(outcome.kind, "cleared");
    const cleared = readClaudeSdkRecord(dir, id);
    assert.equal(cleared?.record.providerSessionId, undefined);
    assert.deepEqual(cleared?.record.entries, committed);

    claudeSdkStore.remove(id);
    assert.equal(existsSync(metaFile(dir, id)), false);
    assert.equal(existsSync(logFile(dir, id)), false);
    // A late persist from the removed instance must not write it back.
    session.onPersist();
    assert.equal(existsSync(metaFile(dir, id)), false);
    assert.equal(existsSync(logFile(dir, id)), false);
    assert.equal(claudeSdkStore.exists(id), false);
  });

  test("an instance superseded by a later acquire never writes over its successor", () => {
    const id = `records-superseded-${Date.now()}`;
    const first = claudeSdkStore.acquire(id);
    first.setTitle("First");
    claudeSdkStore.remove(id);
    const second = claudeSdkStore.acquire(id);
    second.setTitle("Second");
    const stored = readFileSync(metaFile(dir, id), "utf8");
    const log = readFileSync(logFile(dir, id), "utf8");

    first.setTitle("Stale");
    first.onPersist();
    assert.equal(readFileSync(metaFile(dir, id), "utf8"), stored);
    assert.equal(readFileSync(logFile(dir, id), "utf8"), log);
    assert.equal(readClaudeSdkRecord(dir, id)?.record.title, "Second");
    claudeSdkStore.remove(id);
  });

  test("a legacy record loads through the store and migrates on its first persist", () => {
    const id = `records-legacy-${Date.now()}`;
    const entries = [user("u1", "from before"), assistant("a1", "t1")];
    entries.push(toolResult("r1", "t1"));
    const legacy: ClaudeSdkRecord = {
      ...meta(id, { title: "Legacy" }),
      entries,
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(metaFile(dir, id), `${JSON.stringify(legacy, null, 2)}\n`);

    assert.equal(claudeSdkStore.exists(id), true);
    expect(readClaudeSdkRecordMeta(dir, id)).toMatchObject({
      meta: { title: "Legacy" },
      figures: { messages: 2 },
    });

    const session = claudeSdkStore.acquire(id);
    assert.deepEqual(session.timelineEntries(), entries);
    assert.equal(
      existsSync(logFile(dir, id)),
      false,
      "loading alone rewrites nothing",
    );

    session.setTitle("Migrated");
    const stored = JSON.parse(readFileSync(metaFile(dir, id), "utf8"));
    assert.equal("entries" in stored, false, "the first persist split it");
    const reread = readClaudeSdkRecord(dir, id);
    assert.deepEqual(reread?.record.entries, entries);
    assert.equal(reread?.record.title, "Migrated");
    assert.deepEqual(reread?.record.usage, legacy.usage);
    expect(readClaudeSdkRecordMeta(dir, id)).toMatchObject({
      meta: { title: "Migrated" },
      figures: { messages: 2 },
    });

    claudeSdkStore.remove(id);
  });
});
