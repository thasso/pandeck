/**
 * The layout worker (`initiativeLayoutRunner.ts`): ELK runs in a thread of its
 * own, answers in order, fails a job alone (an ELK error, the time limit, a
 * stop) and starts afresh for the next one.
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import {
  runElkLayout,
  stopInitiativeLayoutWorker,
} from "./initiativeLayoutRunner.ts";

afterAll(() => stopInitiativeLayoutWorker());

function chain(length: number): ElkNode {
  const ids = Array.from({ length }, (_, i) => `n${i}`);
  return {
    id: "root",
    layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT" },
    children: ids.map((id) => ({ id, width: 100, height: 40 })),
    edges: ids.slice(1).map((id, i) => ({
      id: `e${i}`,
      sources: [ids[i]!],
      targets: [id],
    })),
  };
}

test("lays out in the worker, one answer per job in order", async () => {
  const results = await Promise.all(
    [chain(2), chain(3), chain(4)].map((graph) => runElkLayout(graph)),
  );
  assert.deepEqual(
    results.map((graph) => graph.children?.length),
    [2, 3, 4],
  );
  const [two] = results;
  assert.ok(two!.children![1]!.x! > two!.children![0]!.x!, "left to right");
});

test("an ELK error fails its job alone", async () => {
  const broken: ElkNode = {
    id: "root",
    children: [{ id: "a", width: 10, height: 10 }],
    edges: [{ id: "e", sources: ["a"], targets: ["missing"] }],
  };
  const [failed, fine] = await Promise.allSettled([
    runElkLayout(broken),
    runElkLayout(chain(2)),
  ]);
  assert.equal(failed!.status, "rejected");
  assert.equal(fine!.status, "fulfilled");
});

test("a job past its time limit ends the worker, and the next one starts afresh", async () => {
  await assert.rejects(
    runElkLayout(chain(40), { timeoutMs: 1 }),
    /took longer than/,
  );
  const graph = await runElkLayout(chain(3));
  assert.equal(graph.children?.length, 3);
});

test("stopping fails the job in flight, and a queued one still runs", async () => {
  const inFlight = runElkLayout(chain(30));
  const queued = runElkLayout(chain(2));
  stopInitiativeLayoutWorker();
  await assert.rejects(inFlight, /stopped/);
  assert.equal((await queued).children?.length, 2);
});
