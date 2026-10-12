import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { beforeEach, describe, it, vi } from "vitest";
import { sessionStore } from "../db/sessionStore.ts";
import { sessionStatusCardPath } from "../sessionStorage.ts";

const oneShot = vi.hoisted(() => ({
  runOneShot: vi.fn(),
}));
vi.mock("../harnesses/oneShot.ts", () => oneShot);

const {
  deleteSessionStatusCard,
  joinSessionStatus,
  readSessionStatus,
  refreshSessionStatus,
} = await import("./statusAgent.ts");

let seq = 0;
function session(): string {
  const id = `status-agent-${seq++}`;
  sessionStore.upsert({ id, harness: "pi", agentType: "developer" });
  return id;
}

describe("status agent", () => {
  beforeEach(() => oneShot.runOneShot.mockReset());

  it("writes the card the one-shot returns and reads it back", async () => {
    const id = session();
    oneShot.runOneShot.mockResolvedValue({
      text: "```markdown\n**Deploy to test.**\n\n🟢 **Done**\n```",
      usage: {},
    });

    const card = await refreshSessionStatus(id);

    assert.equal(card.markdown, "**Deploy to test.**\n\n🟢 **Done**");
    const request = oneShot.runOneShot.mock.calls[0]![0];
    assert.match(request.prompt, /^# Session digest:/);
    assert.equal(request.record.parentSessionId, id);
    // The card names its model, so no silent fallback to another one.
    assert.equal(request.modelFallback, "none");
    assert.equal(card.model.modelId, request.model.modelId);
    assert.deepEqual(readSessionStatus(id), { card, refreshing: false });
  });

  it("joins a refresh that is already running", async () => {
    const id = session();
    let finish!: (value: unknown) => void;
    oneShot.runOneShot.mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );

    const first = refreshSessionStatus(id);
    const second = refreshSessionStatus(id);
    assert.equal(readSessionStatus(id).refreshing, true);
    finish({ text: "**Card**", usage: {} });

    assert.equal(await first, await second);
    assert.equal(oneShot.runOneShot.mock.calls.length, 1);
    assert.equal(readSessionStatus(id).refreshing, false);
  });

  it("keeps no card when the run fails part-way", async () => {
    const id = session();
    oneShot.runOneShot.mockResolvedValue({
      text: "**Half a card",
      usage: {},
      failure: "The model stopped with length.",
    });

    await assert.rejects(refreshSessionStatus(id), /stopped with length/);
    assert.equal(existsSync(sessionStatusCardPath(id)), false);
    assert.equal(readSessionStatus(id).card, null);
  });

  it("redacts credentials the model repeats in the card", async () => {
    const id = session();
    oneShot.runOneShot.mockResolvedValue({
      text: "Keep in mind: the test login was password=hunter2.",
      usage: {},
    });

    const card = await refreshSessionStatus(id);

    assert.equal(
      card.markdown,
      "Keep in mind: the test login was password=[redacted].",
    );
  });

  it("writes no card for a session deleted while the agent ran", async () => {
    const id = session();
    let finish!: (value: unknown) => void;
    oneShot.runOneShot.mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );

    const run = refreshSessionStatus(id);
    sessionStore.remove(id);
    finish({ text: "**Card**", usage: {} });

    await assert.rejects(run, /was deleted/);
    assert.equal(existsSync(sessionStatusCardPath(id)), false);
  });

  it("deletes a session's card", async () => {
    const id = session();
    oneShot.runOneShot.mockResolvedValue({ text: "**Card**", usage: {} });
    await refreshSessionStatus(id);
    assert.equal(existsSync(sessionStatusCardPath(id)), true);

    deleteSessionStatusCard(id);

    assert.equal(existsSync(sessionStatusCardPath(id)), false);
  });

  it("joining never starts a run, even when the one it saw has ended", async () => {
    const id = session();
    oneShot.runOneShot.mockResolvedValue({ text: "**First**", usage: {} });
    const first = await refreshSessionStatus(id);

    // The panel saw `refreshing` on load; the run ended before its join came.
    const joined = await joinSessionStatus(id);

    assert.deepEqual(joined, { card: first, refreshing: false });
    assert.equal(oneShot.runOneShot.mock.calls.length, 1);
  });

  it("joining waits for the run in flight", async () => {
    const id = session();
    let finish!: (value: unknown) => void;
    oneShot.runOneShot.mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    const run = refreshSessionStatus(id);

    const joined = joinSessionStatus(id);
    finish({ text: "**Card**", usage: {} });

    assert.deepEqual(await joined, { card: await run, refreshing: false });
    assert.equal(oneShot.runOneShot.mock.calls.length, 1);
  });

  it("refuses an unknown session", () => {
    assert.throws(() => refreshSessionStatus("nope"), /No session nope/);
  });
});
