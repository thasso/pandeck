/** The detached driver reads storage and refuses every command that drives it. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "view-session-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { sessionStore } = await import("./db/sessionStore.ts");
const { viewSessionById } = await import("./viewSession.ts");
const { DetachedSessionError } = await import("./session/adapters/detached.ts");
const { closeDb } = await import("./db/index.ts");

afterAll(() => {
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

test("a missing stored session has no view", () => {
  expect(viewSessionById("missing")).toBeUndefined();
});

test("a detached driver broadcasts only to its attached viewers", () => {
  sessionStore.upsert({ id: "view", harness: "pi", agentType: "developer" });
  const view = viewSessionById("view")!;
  const viewer = { send: vi.fn() };
  view.addViewer(viewer);
  view.broadcastState();
  expect(viewer.send).toHaveBeenCalledExactlyOnceWith({
    type: "state",
    state: view.state(),
  });
  view.removeViewer(viewer);
  view.broadcastState();
  expect(viewer.send).toHaveBeenCalledTimes(1);
  expect(view.live).toBe(false);
  expect(view.isRunning).toBe(false);
  expect(view.released).toBe(false);
  expect(view.snapshot()).toEqual([]);
  expect(() => view.beginSyntheticTool()).toThrow(DetachedSessionError);
  expect(() => view.compactContext()).toThrow(DetachedSessionError);
});
