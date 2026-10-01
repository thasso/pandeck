import type { SessionScope } from "@assistant/shared";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, it } from "vitest";
import { canonicalSessionLogPath } from "../../sessionStorage.ts";
import { sessionStore } from "../../db/sessionStore.ts";
import { linkSessionToObject } from "../../db/sessionObjectStore.ts";
import { taskStore } from "../../db/taskStore.ts";
import { projectStore } from "../../db/projectStore.ts";
import { linkSessionToWorktree } from "../../db/worktreeStore.ts";
import { sessionLookupTools } from "./sessionLookupTools.ts";

let n = 0;
const created: string[] = [];
const tool = () => sessionLookupTools()[0]!;
const ctx = (sessionId = "caller") => ({
  toolCallId: "t",
  session: {
    sessionId,
    harness: "pi" as const,
    agentType: "assistant" as const,
  },
});

function seed(
  title: string,
  opts: Partial<{
    harness: "pi" | "claude-sdk";
    scope: SessionScope;
    archived: boolean;
  }> = {},
): string {
  const id = `sess-${n++}`;
  sessionStore.upsert({
    id,
    harness: opts.harness ?? "pi",
    agentType: "assistant",
    title,
    scope: opts.scope ?? "user",
  });
  if (opts.archived) sessionStore.setArchived(id, true);
  created.push(id);
  return id;
}

afterEach(() => {
  for (const id of created.splice(0)) {
    rmSync(dirname(canonicalSessionLogPath(id)), {
      recursive: true,
      force: true,
    });
    sessionStore.remove(id);
  }
});

describe("session_lookup", () => {
  it("rejects an empty query before store access", async () => {
    await assert.rejects(
      () => tool().execute({ query: "   " }, ctx()),
      /query is required/,
    );
  });

  it("returns a single exact-id match regardless of limit", async () => {
    const id = seed("Some session");
    const r = await tool().execute({ query: id, limit: 25 }, ctx());
    const d = r.details as any;
    assert.equal(d.exactId, true);
    assert.equal(d.candidates.length, 1);
    assert.equal(d.candidates[0].sessionId, id);
  });

  it("throws on exact self lookup", async () => {
    const id = seed("Mine");
    await assert.rejects(
      () => tool().execute({ query: id }, ctx(id)),
      /current session/,
    );
  });

  it("reports archived exact matches with a retry hint, and includes them on opt-in", async () => {
    const id = seed("Archived one", { archived: true });
    const hidden = await tool().execute({ query: id }, ctx());
    assert.equal((hidden.details as any).archived, true);
    assert.equal((hidden.details as any).sessionId, id);
    const shown = await tool().execute(
      { query: id, includeArchived: true },
      ctx(),
    );
    assert.equal((shown.details as any).candidates[0].sessionId, id);
  });

  it("never returns out-of-scope or deleted sessions by exact id", async () => {
    const internal = seed("Internal", { scope: "internal" });
    assert.equal(
      ((await tool().execute({ query: internal }, ctx())).details as any)
        .notFound,
      true,
    );
    const subagent = seed("Subagent", { scope: "subagent" });
    assert.equal(
      ((await tool().execute({ query: subagent }, ctx())).details as any)
        .notFound,
      true,
    );
    const deleted = seed("Deleted");
    sessionStore.remove(deleted);
    assert.equal(
      ((await tool().execute({ query: deleted }, ctx())).details as any)
        .notFound,
      true,
    );
  });

  it("ranks exact title over prefix over token match, and excludes the current session", async () => {
    const exact = seed("Nebula health check");
    const prefix = seed("Nebula health check dashboard");
    const tokens = seed("Check the Nebula health now");
    const current = seed("Nebula");
    const r = await tool().execute(
      { query: "Nebula health check" },
      ctx(current),
    );
    const ids = (r.details as any).candidates.map((c: any) => c.sessionId);
    assert.equal(ids[0], exact);
    assert.equal(ids.indexOf(prefix) < ids.indexOf(tokens), true);
    assert.equal(ids.includes(current), false);
  });

  it("normalizes case/whitespace/unicode deterministically", async () => {
    const id = seed("Café Réport");
    const r = await tool().execute({ query: "  café   réport " }, ctx());
    assert.equal((r.details as any).candidates[0].sessionId, id);
  });

  it("matches a linked task title (class 6) and exact task id (class 5)", async () => {
    const row = taskStore.create({
      title: "Fix the widget pipeline",
      createdBy: "agent",
    });
    const linked = seed("Untitled work");
    linkSessionToObject(linked, "task", String(row.id), "manual");
    const byTitle = await tool().execute({ query: "widget pipeline" }, ctx());
    assert.equal(
      (byTitle.details as any).candidates.some(
        (c: any) => c.sessionId === linked,
      ),
      true,
    );
    const byId = await tool().execute({ query: String(row.id) }, ctx());
    assert.equal(
      (byId.details as any).candidates.some((c: any) => c.sessionId === linked),
      true,
    );
  });

  it("matches standalone in_project and in_worktree edges by exact id", async () => {
    const projectId = `proj-${n}`;
    const worktreeId = `wt-${n}`;
    const linked = seed("Coding session");
    projectStore.setSessionProject(linked, projectId);
    linkSessionToWorktree(linked, worktreeId);
    const byProject = await tool().execute({ query: projectId }, ctx());
    assert.equal(
      (byProject.details as any).candidates.some(
        (c: any) => c.sessionId === linked,
      ),
      true,
    );
    const byWorktree = await tool().execute({ query: worktreeId }, ctx());
    assert.equal(
      (byWorktree.details as any).candidates.some(
        (c: any) => c.sessionId === linked,
      ),
      true,
    );
  });

  it("returns an actionable not-found result", async () => {
    const r = await tool().execute(
      { query: "zzz-nonexistent-query-xyz" },
      ctx(),
    );
    const d = r.details as any;
    assert.equal(d.notFound, true);
    assert.match(d.guidance, /session_read|session_send_prompt/);
  });

  it("never leaks transcript content from a session's log", async () => {
    const id = seed("Loggy session");
    const logPath = canonicalSessionLogPath(id);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(
      logPath,
      `${JSON.stringify({ type: "message", role: "user", id: "u1", content: [{ type: "text", text: "SECRET-TRANSCRIPT-MARKER" }] })}\n`,
      "utf8",
    );
    const r = await tool().execute({ query: "Loggy" }, ctx());
    const block = r.content[0];
    assert.ok(block && block.type === "text");
    assert.equal(block.text.includes("SECRET-TRANSCRIPT-MARKER"), false);
    assert.equal((r.details as any).candidates[0].logAvailability, "available");
  });

  it("clamps broad results to at most 25", async () => {
    for (let i = 0; i < 30; i++) seed(`Batch item alpha ${i}`);
    const r = await tool().execute(
      { query: "batch item alpha", limit: 100 },
      ctx(),
    );
    assert.ok((r.details as any).candidates.length <= 25);
  });
});
