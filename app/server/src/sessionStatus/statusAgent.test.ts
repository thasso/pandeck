import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { beforeEach, describe, it, vi } from "vitest";
import { sessionStore } from "../db/sessionStore.ts";
import { sessionStatusCardPath } from "../sessionStorage.ts";

const oneShot = vi.hoisted(() => ({
  runOneShot: vi.fn(),
}));
vi.mock("../harnesses/oneShot.ts", () => oneShot);

const { readSessionStatus, refreshSessionStatus } =
  await import("./statusAgent.ts");

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

  it("refuses an unknown session", () => {
    assert.throws(() => refreshSessionStatus("nope"), /No session nope/);
  });
});
