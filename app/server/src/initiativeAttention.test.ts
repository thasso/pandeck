/**
 * An Initiative's attention cursor and its Settle (docs/initiatives.md, The
 * attention list): a real change to paused or done raises it inside the state
 * write, re-stating a state or becoming active raises nothing, and only the
 * user's Settle — through the revision the clicked card rendered, clamped and
 * forward-only — acknowledges it. An agent's state change never does.
 *   pnpm --filter @assistant/server test src/initiativeAttention.test.ts
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { InitiativeSummary } from "@assistant/shared";
import {
  archiveInitiative,
  createInitiative,
  deleteInitiative,
  initiativeStateItems,
  initiativeSummaryFor,
  readInitiative,
  settleInitiative,
  subscribeInitiativeChanges,
  unarchiveInitiative,
  updateInitiative,
} from "./initiatives.ts";
import { initiativeTools } from "./tools/initiatives/initiativeTools.ts";
import type { ToolCallContext } from "./mcp/tool.ts";

function initiative(state?: "active" | "paused" | "done"): string {
  return String(
    createInitiative({ title: "Attention", ...(state ? { state } : {}) })
      .initiative.id,
  );
}

function summary(id: string): InitiativeSummary {
  const item = initiativeSummaryFor(id);
  assert.ok(item, `Initiative ${id} is not in the live projection`);
  return item;
}

/** Revision and acknowledgement, or `none` before anything was raised. */
function cursor(id: string): string {
  const attention = readInitiative(id)!.attention;
  return attention
    ? `${attention.kind}@${attention.revision}/${attention.settledRevision}`
    : "none";
}

test("creating active raises nothing; creating paused or done arrives raised", () => {
  assert.equal(cursor(initiative()), "none");
  assert.equal(cursor(initiative("active")), "none");
  assert.equal(cursor(initiative("paused")), "paused@1/0");
  assert.equal(cursor(initiative("done")), "done@1/0");
});

test("only a real change to paused or done raises, in the state write itself", () => {
  const id = initiative();
  updateInitiative(id, { title: "Renamed", description: "No state" });
  assert.equal(cursor(id), "none", "an edit without a state raises nothing");
  updateInitiative(id, { state: "active" });
  assert.equal(cursor(id), "none", "re-stating active raises nothing");

  updateInitiative(id, { state: "paused" });
  assert.equal(cursor(id), "paused@1/0");
  const raisedAt = summary(id).attention!.at;
  updateInitiative(id, { state: "paused" });
  updateInitiative(id, { state: "paused", title: "Still paused" });
  assert.equal(cursor(id), "paused@1/0", "re-stating paused raises nothing");
  assert.equal(summary(id).attention!.at, raisedAt);

  updateInitiative(id, { state: "done" });
  assert.equal(cursor(id), "done@2/0", "paused to done is a new outcome");
  updateInitiative(id, { state: "active" });
  assert.equal(cursor(id), "done@2/0", "becoming active raises nothing");
  assert.equal(summary(id).state, "active");
  updateInitiative(id, { state: "paused" });
  assert.equal(cursor(id), "paused@3/0", "paused again raises again");
});

test("Settle acknowledges exactly what the card rendered, clamped and forward-only", () => {
  const id = initiative();
  updateInitiative(id, { state: "paused" });
  updateInitiative(id, { state: "done" });
  assert.equal(cursor(id), "done@2/0");

  // A card rendered at revision 1 is clicked after revision 2 landed: the
  // newer outcome stays unacknowledged.
  settleInitiative(id, 1);
  assert.equal(cursor(id), "done@2/1");

  // A click cannot acknowledge the future.
  settleInitiative(id, 99);
  assert.equal(cursor(id), "done@2/2");

  // An older click arriving late never takes the acknowledgement back.
  settleInitiative(id, 1);
  settleInitiative(id, 0);
  assert.equal(cursor(id), "done@2/2");

  // A newer outcome raised after the Settle stands on its own.
  updateInitiative(id, { state: "paused" });
  assert.equal(cursor(id), "paused@3/2");
});

test("Settle is a write of its own: one event, a new revision, no edit time", () => {
  const id = initiative("done");
  const before = readInitiative(id)!;
  const heard: string[] = [];
  const stop = subscribeInitiativeChanges((ids) => heard.push(...ids));
  try {
    settleInitiative(id, 1);
  } finally {
    stop();
  }
  assert.deepEqual(heard, [id]);
  const [event] = initiativeStateItems([id]);
  assert.equal(event?.kind, "upsert");
  assert.ok(event!.revision > 0);
  assert.equal(
    event?.kind === "upsert" && event.item.attention?.settledRevision,
    1,
  );
  assert.equal(summary(id).updatedAt, before.updatedAt);
});

test("Settle names what it cannot find, and an archived Initiative leaves the live list", () => {
  assert.throws(() => settleInitiative("999999", 1), /Initiative not found/);
  assert.throws(() => settleInitiative("not-an-id", 1), /Initiative not found/);

  const archived = initiative("paused");
  archiveInitiative(archived);
  assert.equal(initiativeSummaryFor(archived), null);
  assert.equal(initiativeStateItems([archived])[0]?.kind, "delete");
  unarchiveInitiative(archived);
  assert.equal(cursor(archived), "paused@1/0", "unarchiving raises nothing");

  const deleted = initiative("done");
  deleteInitiative(deleted);
  assert.equal(initiativeStateItems([deleted])[0]?.kind, "delete");
  assert.throws(() => settleInitiative(deleted, 1), /Initiative not found/);
});

test("agents change the state but never settle it", async () => {
  const manage = initiativeTools().find(
    (tool) => tool.name === "initiative_manage",
  )!;
  const operationEnum = JSON.stringify(manage.parameters);
  assert.doesNotMatch(operationEnum, /settle/i, "no agent operation settles");

  const ctx: ToolCallContext = {
    toolCallId: "initiative-attention-test",
    session: {
      sessionId: "initiative-attention-session",
      harness: "pi",
      agentType: "developer",
    },
  };
  const id = initiative();
  await manage.execute(
    { operations: [{ operation: "update", id, state: "done" }] },
    ctx,
  );
  assert.equal(cursor(id), "done@1/0", "an agent's done raises for the user");
  await manage.execute(
    { operations: [{ operation: "update", id, state: "done" }] },
    ctx,
  );
  assert.equal(cursor(id), "done@1/0", "and re-stating it does not");
});
