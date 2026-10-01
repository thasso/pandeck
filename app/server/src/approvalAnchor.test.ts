/**
 * Jumping to an approval card (the composer's pending strip, a
 * `pa://approval/<id>` link). A card is an overlay, not a log entry, so the
 * anchor has to pair the card's own row id with the index of the turn that
 * proposed it — otherwise a windowed transcript either never loads that far
 * back or flashes the wrong row.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approvalMessageId,
  parsePaObjectLink,
} from "@assistant/shared/objectLinks";
import { approvalAnchorFor } from "./approvalAnchor.ts";
import {
  approvalCardReference,
  createApproval,
  setApprovalBroadcastForTests,
} from "./pendingApprovals.ts";
import { resolvePaObjectLinks } from "./objectLinkResolver.ts";
import { canonicalSessionLogPath } from "./sessionStorage.ts";
import { sessionStore } from "./db/sessionStore.ts";

let n = 0;
const created: string[] = [];

/** A session row to hold the card: a card whose session is gone has no row to open. */
function session(): string {
  const id = `anchor-approval-${n++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "assistant",
    title: "Anchor",
    scope: "user",
  });
  created.push(id);
  return id;
}

function writeLog(sessionId: string, entries: Record<string, unknown>[]): void {
  const path = canonicalSessionLogPath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [...entries.map((entry) => JSON.stringify(entry)), ""].join("\n"),
    "utf8",
  );
}

function assistantTurn(id: string, seq: number, toolCallId?: string) {
  return {
    type: "message",
    role: "assistant",
    id,
    seq,
    createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)).toISOString(),
    content: toolCallId
      ? [{ type: "toolCall", toolCallId, name: "tool", input: {} }]
      : [{ type: "text", text: `turn ${id}` }],
  };
}

function commitCard(sessionId: string, sourceToolCallId?: string) {
  return createApproval({
    sessionId,
    kind: "commit",
    title: "Merge #4 into main",
    ...(sourceToolCallId ? { sourceToolCallId } : {}),
    body: { kind: "commit", message: "wip", files: ["a.ts"] },
  });
}

beforeEach(() => setApprovalBroadcastForTests(() => {}));
afterEach(() => {
  setApprovalBroadcastForTests(null);
  for (const id of created.splice(0)) sessionStore.remove(id);
});

describe("approvalAnchorFor", () => {
  it("answers the card's own row at the index of the turn that proposed it", () => {
    const sessionId = session();
    writeLog(sessionId, [
      assistantTurn("a0", 0),
      assistantTurn("a1", 1, "call-propose"),
      assistantTurn("a2", 2),
    ]);
    const card = commitCard(sessionId, "call-propose");

    expect(approvalAnchorFor(card.id)).toEqual({
      sessionId,
      entryId: approvalMessageId(card.id),
      index: 1,
    });
  });

  it("falls back to the first entry written after a card with no proposing call", () => {
    const sessionId = session();
    const card = commitCard(sessionId);
    const after = new Date(card.createdAt + 1_000).toISOString();
    writeLog(sessionId, [
      assistantTurn("a0", 0),
      { ...assistantTurn("a1", 1), createdAt: after },
    ]);

    expect(approvalAnchorFor(card.id)?.index).toBe(1);
  });

  it("anchors a card created after every entry at the transcript's tail", () => {
    const sessionId = session();
    writeLog(sessionId, [
      assistantTurn("a0", 0),
      assistantTurn("a1", 1),
      assistantTurn("a2", 2),
    ]);
    // Created now, long after the 2026-09-01 entries above.
    const card = commitCard(sessionId);

    expect(approvalAnchorFor(card.id)).toEqual({
      sessionId,
      entryId: approvalMessageId(card.id),
      index: 2,
    });
  });

  it("finds the tail of a transcript that holds no assistant turn yet", () => {
    const sessionId = session();
    const userPrompt = (id: string, seq: number) => ({
      type: "message",
      role: "user",
      origin: { kind: "human" },
      id,
      seq,
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)).toISOString(),
      content: [{ type: "text", text: `prompt ${id}` }],
    });
    writeLog(sessionId, [userPrompt("u0", 0), userPrompt("u1", 1)]);
    const card = commitCard(sessionId);

    expect(approvalAnchorFor(card.id)?.index).toBe(1);
  });

  it("answers nothing for an unknown card or one whose session is gone", () => {
    expect(approvalAnchorFor("appr_missing")).toBeUndefined();
    const orphan = commitCard(`anchor-approval-gone-${n++}`);
    expect(approvalAnchorFor(orphan.id)).toBeUndefined();
  });
});

describe("approval card links", () => {
  it("hands the agent a pa:// link to the card it just proposed", () => {
    const card = createApproval({
      sessionId: session(),
      kind: "commit",
      title: "Edit [draft] notes",
      body: { kind: "commit", message: "wip", files: ["a.ts"] },
    });
    const reference = approvalCardReference(card);
    const uri = reference.match(/\((pa:\/\/[^)]+)\)/)?.[1] ?? "";

    expect(parsePaObjectLink(uri)).toMatchObject({
      objectType: "approval",
      knownType: true,
      id: card.id,
    });
    // Brackets in a title must not end the link label early.
    expect(reference).toContain("[Edit \\[draft\\] notes]");
  });

  it("resolves a card link to its title and its row in the proposing session", async () => {
    const sessionId = session();
    const card = commitCard(sessionId);
    const [resolved, missing] = await resolvePaObjectLinks([
      `pa://approval/${card.id}`,
      "pa://approval/appr_missing",
    ]);

    expect(resolved).toMatchObject({
      title: "Merge #4 into main",
      typeLabel: "Approval",
      existence: "exists",
      href: `/sessions/${sessionId}#m-${approvalMessageId(card.id)}`,
    });
    expect(missing?.existence).toBe("missing");
  });
});
