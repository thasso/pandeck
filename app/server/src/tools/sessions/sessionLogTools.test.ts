import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { canonicalSessionLogPath } from "../../sessionStorage.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import { SESSION_READ_MAX_CHARS } from "./sessionInspection.ts";
import { sessionLogTools } from "./sessionLogTools.ts";

let counter = 0;
let SESSION_ID = "copied-claude-session-id";
let logPath = canonicalSessionLogPath(SESSION_ID);

const ctx = {
  toolCallId: "test-call",
  session: {
    sessionId: "caller",
    harness: "pi" as const,
    agentType: "assistant" as const,
  },
};

const readTool = () =>
  sessionLogTools().find((t) => t.name === "session_read")!;
const searchTool = () =>
  sessionLogTools().find((t) => t.name === "session_search")!;

function indexSession(
  id: string,
  overrides: Partial<{ scope: "user" | "internal" }> = {},
): void {
  sessionStore.upsert({
    id,
    harness: "claude-sdk",
    agentType: "assistant",
    title: "Nebula health",
    scope: overrides.scope ?? "user",
  });
}

beforeEach(() => {
  SESSION_ID = `copied-session-${counter++}`;
  logPath = canonicalSessionLogPath(SESSION_ID);
  indexSession(SESSION_ID);
});
afterEach(() => {
  rmSync(dirname(logPath), { recursive: true, force: true });
});

describe("session_read", () => {
  it("returns metadata plus the latest visible records with no kind hint", async () => {
    writeLog();
    const result = await readTool().execute({ sessionId: SESSION_ID }, ctx);
    const d = result.details as any;
    assert.equal(d.sessionId, SESSION_ID);
    assert.equal(d.harness, "claude-sdk");
    assert.equal(d.at, "latest");
    // Only visible user/assistant text by default (no thinking/tool blocks).
    assert.deepEqual(
      d.records.map((r: any) => r.entryId),
      ["user-1", "assistant-1:text:0"],
    );
    assert.equal(d.hasMoreBefore, false);
    assert.equal(d.hasMoreAfter, false);
  });

  it("opts in to tool calls and centers on an explicit entry id", async () => {
    writeLog();
    const result = await readTool().execute(
      {
        sessionId: SESSION_ID,
        at: "assistant-1:tool:1",
        includeToolCalls: true,
      },
      ctx,
    );
    const d = result.details as any;
    assert.equal(d.anchorEntryId, "assistant-1:tool:1");
    assert.equal(d.anchorRetained, true);
    assert.ok(
      d.records.some(
        (r: any) => r.entryId === "assistant-1:tool:1" && r.anchor === true,
      ),
    );
  });

  it("retains an explicitly selected hidden anchor even without its include flag", async () => {
    writeLog();
    const result = await readTool().execute(
      { sessionId: SESSION_ID, at: "assistant-1:tool:1" },
      ctx,
    );
    const d = result.details as any;
    assert.equal(d.anchorRetained, true);
    assert.ok(d.records.some((r: any) => r.entryId === "assistant-1:tool:1"));
  });

  it("clamps limit and honors start", async () => {
    writeManyLog(40);
    const start = await readTool().execute(
      { sessionId: SESSION_ID, at: "start", limit: 100 },
      ctx,
    );
    const d = start.details as any;
    assert.equal(d.records.length, 25); // clamped to max
    assert.equal(d.records[0].entryId, "u-0");
    assert.equal(d.hasMoreBefore, false);
    assert.equal(d.hasMoreAfter, true);
    assert.equal(d.nextEntryId, "u-25");
  });

  it("rejects empty/path-like/unknown/internal ids", async () => {
    await assert.rejects(
      () => readTool().execute({ sessionId: "  " }, ctx),
      /required/,
    );
    await assert.rejects(
      () => readTool().execute({ sessionId: "a/b" }, ctx),
      /not a path/,
    );
    await assert.rejects(
      () => readTool().execute({ sessionId: "no-such-session" }, ctx),
      /No session found/,
    );
    indexSession("internal-x", { scope: "internal" });
    await assert.rejects(
      () => readTool().execute({ sessionId: "internal-x" }, ctx),
      /internal/,
    );
    sessionStore.remove("internal-x");
  });

  it("returns safe metadata when the log is missing", async () => {
    const result = await readTool().execute({ sessionId: SESSION_ID }, ctx);
    const d = result.details as any;
    assert.equal(d.logAvailability, "missing");
    assert.equal(d.records.length, 0);
    assert.ok(Array.isArray(d.warnings));
  });

  it("bounds a huge transcript to a window under the response cap", async () => {
    writeHugeLog();
    const result = await readTool().execute({ sessionId: SESSION_ID }, ctx);
    const block = result.content[0];
    assert.ok(block && block.type === "text");
    assert.ok(
      block.text.length <= SESSION_READ_MAX_CHARS,
      `len=${block.text.length}`,
    );
    const d = result.details as any;
    assert.ok(d.records.length <= 8);
  });

  it("rejects an over-limit at value explicitly rather than silently slicing it", async () => {
    writeLog();
    await assert.rejects(
      () =>
        readTool().execute(
          { sessionId: SESSION_ID, at: "z".repeat(30_000) },
          ctx,
        ),
      /at must be at most/,
    );
  });

  it("does a bounded tail read of a very large log", async () => {
    writeOversizedLog();
    const result = await readTool().execute({ sessionId: SESSION_ID }, ctx);
    const d = result.details as any;
    // The oldest records were not read; more-before is reported.
    assert.equal(d.hasMoreBefore, true);
    assert.ok(d.records.length <= 8);
  });

  it("inspects the sanitized peer prompt, not the delivery envelope", async () => {
    mkdirSync(dirname(logPath), { recursive: true });
    const envelope =
      "Peer message from Planner:\n\ndo the thing\n\nReply with session_send_prompt if a response is needed.";
    writeFileSync(
      logPath,
      `${JSON.stringify({ type: "message", role: "user", id: "u1", peerPrompt: { direction: "received", senderTitle: "Planner", message: "do the thing", responseRequested: false, state: "delivered" }, content: [{ type: "text", text: envelope }] })}\n`,
      "utf8",
    );
    const r = await readTool().execute(
      { sessionId: SESSION_ID, at: "latest" },
      ctx,
    );
    const text = (r.details as any).records[0].text as string;
    assert.ok(text.includes("do the thing"));
    assert.equal(text.includes("Reply with session_send_prompt"), false);
    assert.equal(text.includes("Peer message from"), false);
    const s = await searchTool().execute(
      { sessionId: SESSION_ID, query: "session_send_prompt" },
      ctx,
    );
    assert.equal((s.details as any).resultCount, 0);
  });

  it("reports malformed lines as an actionable warning", async () => {
    mkdirSync(dirname(logPath), { recursive: true });
    const rows = [
      "{ not valid json",
      JSON.stringify({
        type: "message",
        role: "user",
        id: "u1",
        content: [{ type: "text", text: "hello" }],
      }),
      "also broken }",
    ].join("\n");
    writeFileSync(logPath, `${rows}\n`, "utf8");
    const s = await searchTool().execute(
      { sessionId: SESSION_ID, query: "hello" },
      ctx,
    );
    assert.ok(
      ((s.details as any).warnings ?? []).some((w: string) =>
        /malformed/i.test(w),
      ),
    );
  });
});

describe("session_search", () => {
  it("searches the canonical app log for a copied session id (no kind, no schema kind)", async () => {
    writeLog();
    const tool = searchTool();
    assert.equal((tool.parameters as any).properties.kind, undefined);
    const result = await tool.execute(
      { sessionId: SESSION_ID, query: "Nebula", includeToolCalls: true },
      ctx,
    );
    const d = result.details as any;
    assert.equal(d.resultCount, 2);
    assert.deepEqual(
      d.results.map((r: any) => r.entryId),
      ["user-1", "assistant-1:tool:1"],
    );
  });

  it("validates empty id and query before store access, and searches archived sessions", async () => {
    await assert.rejects(
      () => searchTool().execute({ sessionId: "  ", query: "x" }, ctx),
      /required/,
    );
    await assert.rejects(
      () => searchTool().execute({ sessionId: SESSION_ID, query: "  " }, ctx),
      /query is required/,
    );
    writeLog();
    sessionStore.setArchived(SESSION_ID, true);
    const result = await searchTool().execute(
      { sessionId: SESSION_ID, query: "Nebula" },
      ctx,
    );
    assert.equal((result.details as any).archived, true);
    assert.ok((result.details as any).resultCount >= 1);
  });

  it("strips the attachment manifest and tolerates malformed lines", async () => {
    mkdirSync(dirname(logPath), { recursive: true });
    const encoded = Buffer.from(
      JSON.stringify([{ id: "a1", name: "secret.txt" }]),
    ).toString("base64");
    const text = `hello world\n\n<!--pa:attachments:${encoded}-->`;
    const rows = [
      JSON.stringify({ v: 1, sessionId: SESSION_ID }),
      "{ this is not valid json",
      JSON.stringify({
        type: "message",
        role: "user",
        id: "u-1",
        content: [{ type: "text", text }],
      }),
    ].join("\n");
    writeFileSync(logPath, `${rows}\n`, "utf8");
    const manifest = await searchTool().execute(
      { sessionId: SESSION_ID, query: "pa:attachments" },
      ctx,
    );
    assert.equal((manifest.details as any).resultCount, 0);
    const visible = await searchTool().execute(
      { sessionId: SESSION_ID, query: "hello world" },
      ctx,
    );
    assert.equal((visible.details as any).resultCount, 1);
  });

  it("hands a result entry id to session_read", async () => {
    writeLog();
    const s = await searchTool().execute(
      { sessionId: SESSION_ID, query: "Nebula" },
      ctx,
    );
    const entryId = (s.details as any).results[0].entryId;
    const r = await readTool().execute(
      { sessionId: SESSION_ID, at: entryId },
      ctx,
    );
    assert.equal((r.details as any).anchorEntryId, entryId);
  });

  it("rejects an over-limit query explicitly rather than silently slicing it", async () => {
    writeLog();
    await assert.rejects(
      () =>
        searchTool().execute(
          { sessionId: SESSION_ID, query: "z".repeat(1000) },
          ctx,
        ),
      /query must be at most/,
    );
  });
});

describe("session_read bounded scanning edge cases", () => {
  it("never drops a single JSONL record larger than the tail heuristic window", async () => {
    mkdirSync(dirname(logPath), { recursive: true });
    const huge = "y".repeat(500_000); // exceeds the 256 KiB heuristic tail window
    const rows = [
      JSON.stringify({ v: 1, sessionId: SESSION_ID }),
      JSON.stringify({
        type: "message",
        role: "user",
        id: "u-1",
        content: [{ type: "text", text: huge }],
      }),
    ];
    writeFileSync(logPath, `${rows.join("\n")}\n`, "utf8");
    const result = await readTool().execute(
      { sessionId: SESSION_ID, at: "latest" },
      ctx,
    );
    const d = result.details as any;
    assert.equal(
      d.records.length,
      1,
      "the oversized record must still be returned, not dropped",
    );
    assert.equal(d.records[0].entryId, "u-1");
  });

  it("balances a centered window toward the far side when the anchor is near an edge", async () => {
    mkdirSync(dirname(logPath), { recursive: true });
    const rows: unknown[] = [{ v: 1, sessionId: SESSION_ID }];
    for (let i = 0; i < 10; i++)
      rows.push({
        type: "message",
        role: "user",
        id: `u-${i}`,
        content: [{ type: "text", text: `m${i}` }],
      });
    writeFileSync(
      logPath,
      `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
      "utf8",
    );
    // Anchor at the very first record with limit=5 (would normally split 2 before/2 after);
    // since nothing exists before it, all spare capacity should go to the after side.
    const result = await readTool().execute(
      { sessionId: SESSION_ID, at: "u-0", limit: 5 },
      ctx,
    );
    const d = result.details as any;
    assert.deepEqual(
      d.records.map((r: any) => r.entryId),
      ["u-0", "u-1", "u-2", "u-3", "u-4"],
    );
    assert.equal(d.hasMoreBefore, false);
    assert.equal(d.hasMoreAfter, true);
    assert.equal(d.nextEntryId, "u-5");
  });

  it("populates previousEntryId for a limit:1 centered read (round-3 review fix)", async () => {
    mkdirSync(dirname(logPath), { recursive: true });
    const rows: unknown[] = [{ v: 1, sessionId: SESSION_ID }];
    for (let i = 0; i < 5; i++)
      rows.push({
        type: "message",
        role: "user",
        id: `u-${i}`,
        content: [{ type: "text", text: `m${i}` }],
      });
    writeFileSync(
      logPath,
      `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
      "utf8",
    );
    // A limit:1 window discards everything before/after the anchor from an
    // empty before-buffer, so previousEntryId must still be captured from the
    // last matching record seen prior to the anchor (nothing is ever shifted
    // out of a zero-capacity ring buffer to record it otherwise).
    const result = await readTool().execute(
      { sessionId: SESSION_ID, at: "u-3", limit: 1 },
      ctx,
    );
    const d = result.details as any;
    assert.deepEqual(
      d.records.map((r: any) => r.entryId),
      ["u-3"],
    );
    assert.equal(d.hasMoreBefore, true);
    assert.equal(d.previousEntryId, "u-2");
    assert.equal(d.hasMoreAfter, true);
    assert.equal(d.nextEntryId, "u-4");
  });
});

function writeLog(): void {
  writeRows([
    { v: 1, sessionId: SESSION_ID, createdAt: "2026-07-13T20:00:00.000Z" },
    {
      type: "message",
      role: "user",
      id: "user-1",
      createdAt: "2026-07-13T20:00:01.000Z",
      content: [{ type: "text", text: "Check Nebula health endpoints" }],
    },
    {
      type: "message",
      role: "assistant",
      id: "assistant-1",
      createdAt: "2026-07-13T20:00:02.000Z",
      content: [
        { type: "text", text: "I found a health endpoint." },
        { type: "toolCall", name: "bash", input: { command: "rg Nebula" } },
      ],
    },
  ]);
}

function writeManyLog(n: number): void {
  const rows: unknown[] = [{ v: 1, sessionId: SESSION_ID }];
  for (let i = 0; i < n; i++) {
    rows.push({
      type: "message",
      role: "user",
      id: `u-${i}`,
      content: [{ type: "text", text: `message ${i}` }],
    });
  }
  writeRows(rows);
}

function writeHugeLog(): void {
  const rows: unknown[] = [{ v: 1, sessionId: SESSION_ID }];
  const big = "x".repeat(5000);
  for (let i = 0; i < 50; i++) {
    rows.push({
      type: "message",
      role: "user",
      id: `u-${i}`,
      content: [{ type: "text", text: `${big} ${i}` }],
    });
  }
  writeRows(rows);
}

function writeOversizedLog(): void {
  // Exceed the 256 KiB bounded edge-read threshold so latest triggers a tail read.
  const rows: unknown[] = [{ v: 1, sessionId: SESSION_ID }];
  const big = "x".repeat(4000);
  for (let i = 0; i < 120; i++) {
    rows.push({
      type: "message",
      role: "user",
      id: `u-${i}`,
      content: [{ type: "text", text: `${big} ${i}` }],
    });
  }
  writeRows(rows);
}

function writeRows(rows: unknown[]): void {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(
    logPath,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}
