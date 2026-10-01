/**
 * A Claude record that is present but cannot be read degrades to an error for
 * THAT session, never a broken connection: a deep link to one with no registry
 * row still yields `ready` (and then a session-targeted error the reader sees),
 * `loadSession` reports it the same way, and driving it fails without creating
 * a session over the unreadable files.
 *
 *   pnpm --filter @assistant/server test src/unreadableSessionRecord.test.ts
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";

// Isolate CWD and DATA_DIR BEFORE importing the connection, and enable the
// claude-sdk harness so its deep links are not gated off.
const tmp = mkdtempSync(join(tmpdir(), "unreadable-session-record-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({ claudeSdk: { enabled: true } }),
);

const { Connection } = await import("./connection.ts");
const { hub } = await import("./hub.ts");
const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { ClaudeSdkRecordReadError, writeClaudeSdkRecord } =
  await import("./claudeSdk/claudeSdkRecords.ts");
const { sessionStore } = await import("./db/sessionStore.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const recordDir = join(tmp, "data", "claude-sdk");

function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

type Kind = "malformed" | "unpermitted" | "unreadable-log";

/**
 * An orphan record (no registry row) that cannot be read: metadata that does
 * not parse, metadata the server may not read, or SOUND metadata whose
 * timeline log the server may not read. `path` is the file that is damaged.
 */
function unreadableRecord(
  kind: Kind,
): { id: string; path: string; bytes: string } | undefined {
  const id = `unreadable-${kind}-${Date.now()}`;
  mkdirSync(recordDir, { recursive: true });
  let path = join(recordDir, `${id}.json`);
  if (kind === "malformed") writeFileSync(path, '{"id": "torn');
  else if (kind === "unpermitted")
    writeFileSync(path, JSON.stringify({ id, title: "Locked away" }));
  else {
    writeClaudeSdkRecord(
      recordDir,
      { id, title: "Log locked away", createdAt: 1, updatedAt: 2 },
      [
        {
          id: "u1",
          seq: 0,
          createdAt: "2026-09-29T00:00:00.000Z",
          type: "message",
          role: "user",
          origin: { kind: "human" },
          content: [{ type: "text", text: "remember this" }],
        },
      ],
      undefined,
    );
    path = join(recordDir, `${id}.entries.jsonl`);
  }
  const bytes = readFileSync(path, "utf8");
  if (kind !== "malformed") {
    chmodSync(path, 0o000);
    // Root reads through file modes, so there is nothing to test there.
    try {
      readFileSync(path);
      chmodSync(path, 0o600);
      return undefined;
    } catch {
      // Unreadable, as intended.
    }
  }
  expect(sessionStore.get(id)).toBeUndefined();
  return { id, path, bytes };
}

function errorsFor(sent: ServerMessage[], id: string) {
  return sent.filter(
    (m): m is Extract<ServerMessage, { type: "error" }> =>
      m.type === "error" && m.target?.type === "session" && m.target.id === id,
  );
}

describe.each(["malformed", "unpermitted", "unreadable-log"] as const)(
  "a %s Claude record",
  (kind) => {
    test("a deep link to it still becomes ready and says why it cannot open", async () => {
      const record = unreadableRecord(kind);
      if (!record) return;
      const sent: ServerMessage[] = [];
      const connection = new Connection(fakeSocket(sent), {
        sessionId: record.id,
      });

      await expect(connection.init()).resolves.toBeUndefined();
      const ready = sent.findIndex((m) => m.type === "ready");
      expect(ready).toBeGreaterThanOrEqual(0);
      const [error] = errorsFor(sent, record.id);
      expect(error?.message).toMatch(/cannot be opened/);
      expect(error?.sessionUnavailable).toBe(true);
      expect(sent.indexOf(error!)).toBeGreaterThan(ready);
      expect(sent.some((m) => m.type === "snapshot")).toBe(false);
      expect(claudeSdkStore.get(record.id)).toBeUndefined();
      chmodSync(record.path, 0o600);
      expect(readFileSync(record.path, "utf8")).toBe(record.bytes);
    });

    test("loadSession reports it on that session, and driving it fails without replacing it", async () => {
      const record = unreadableRecord(kind);
      if (!record) return;
      const sent: ServerMessage[] = [];
      const connection = new Connection(fakeSocket(sent));
      void connection.handle({
        type: "loadSession",
        id: record.id,
      } as ClientMessage);
      await settle();
      const errors = errorsFor(sent, record.id);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.sessionUnavailable).toBe(true);
      if (kind !== "malformed") expect(errors[0]?.message).toMatch(/EACCES/);

      expect(claudeSdkStore.exists(record.id)).toBe(true);
      await expect(hub.acquireById(record.id)).rejects.toBeInstanceOf(
        ClaudeSdkRecordReadError,
      );
      expect(claudeSdkStore.get(record.id)).toBeUndefined();
      chmodSync(record.path, 0o600);
      expect(readFileSync(record.path, "utf8")).toBe(record.bytes);
    });
  },
);

test("a present record that reads fine but has nothing to show still says so", async () => {
  // An orphan whose record is sound but that has no registry row to show it
  // from: never a silent spinner.
  const id = `orphan-readable-${Date.now()}`;
  writeClaudeSdkRecord(
    recordDir,
    { id, title: "Orphan", createdAt: 1, updatedAt: 2 },
    [],
    undefined,
  );
  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent), { sessionId: id });
  await expect(connection.init()).resolves.toBeUndefined();
  const ready = sent.findIndex((m) => m.type === "ready");
  const [error] = errorsFor(sent, id);
  expect(ready).toBeGreaterThanOrEqual(0);
  expect(error?.sessionUnavailable).toBe(true);
  expect(sent.indexOf(error!)).toBeGreaterThan(ready);
});

test("an id with no record at all reports nothing", async () => {
  const sent: ServerMessage[] = [];
  const connection = new Connection(fakeSocket(sent), {
    sessionId: `optimistic-${Date.now()}`,
  });
  await connection.init();
  expect(sent.some((m) => m.type === "ready")).toBe(true);
  expect(sent.some((m) => m.type === "error")).toBe(false);
});
