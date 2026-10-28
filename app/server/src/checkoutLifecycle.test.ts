/**
 * The lifecycle access: the composed removal ladder against base
 * `removeManagedTree`, and how its errors keep their origin
 * (`docs/workers.md`).
 *
 * The composed side runs through the in-process Worker, its stages answered by
 * a script; the base side runs `removeManagedTree` on a real directory whose
 * scripted `remove` and `uidOf` produce the same stage outcomes. Ownership is
 * synthetic with a nonzero `selfUid`, so the foreign cases are exercised under
 * root too, where the real scan would report nothing foreign.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { checkoutFailureOf } from "./checkoutFileAccess.ts";
import {
  checkoutLifecycleOn,
  removeManagedTreeOn,
} from "./checkoutLifecycle.ts";
import {
  removeManagedTree,
  type TreeReclaimOutcome,
  type TreeResidue,
} from "./managedTreeRemoval.ts";
import {
  MALFORMED_ANSWERS,
  answering,
  scriptWorkerAnswersForTests,
} from "./test/workerAnswers.ts";
import {
  LIFECYCLE_METHODS,
  encodeRemoveTreeResult,
  type RemoveTreeStageResult,
} from "./workerProtocol/lifecycleMethods.ts";
import { isWorkerFailure } from "./workers/fileClient.ts";
import { answerNextInProcessWorkerCallForTests } from "./workers/inProcessWorker.ts";
import { DEFAULT_WORKER_SIDE } from "./workers/placement.ts";

const dir = mkdtempSync(join(tmpdir(), "checkout-lifecycle-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The uid the fixtures believe they run as, and a foreign one; never 0. */
const SELF_UID = 4242;
const FOREIGN_UID = 4343;

let fixtures = 0;
function tree(): string {
  const root = join(dir, `tree-${++fixtures}`);
  mkdirSync(join(root, "store"), { recursive: true });
  return root;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("it resolved");
}

/**
 * One ladder outcome: what the base side's scripted removal and ownership do,
 * and what the Worker's stages answer for the same tree.
 */
interface Outcome {
  name: string;
  /** Which base `remove` calls (1-based) succeed. */
  removesOn: number[];
  /** Foreign directories, relative, in the scans before and after reclaim. */
  foreignBefore?: string;
  foreignAfter?: string;
  reclaim?: TreeReclaimOutcome;
}

const OUTCOMES: Outcome[] = [
  { name: "removed at once", removesOn: [1] },
  { name: "not removed, no foreign", removesOn: [] },
  { name: "foreign, no reclaim", removesOn: [], foreignBefore: "" },
  {
    name: "foreign, reclaim unavailable",
    removesOn: [],
    foreignBefore: "",
    reclaim: { status: "unavailable", reason: "no usable container runtime" },
  },
  {
    name: "reclaimed, then removed",
    removesOn: [3],
    foreignBefore: "",
    reclaim: { status: "reclaimed" },
  },
  {
    name: "reclaimed, still foreign",
    removesOn: [],
    foreignBefore: "",
    foreignAfter: "store",
    reclaim: { status: "reclaimed" },
  },
  {
    name: "reclaimed, not removed, no foreign after",
    removesOn: [],
    foreignBefore: "",
    reclaim: { status: "reclaimed" },
  },
];

const residueAt = (root: string, rel: string | undefined) =>
  rel === undefined
    ? undefined
    : ({
        path: rel ? join(root, rel) : root,
        reason: "foreign-owner",
        uid: FOREIGN_UID,
      } satisfies TreeResidue);

for (const outcome of OUTCOMES)
  test(`the composed ladder matches base: ${outcome.name}`, async () => {
    // Base, on a real directory.
    const baseRoot = tree();
    let removes = 0;
    let reclaimedYet = false;
    const baseReclaims: string[] = [];
    const base = await removeManagedTree(baseRoot, {
      remove: () => outcome.removesOn.includes(++removes),
      scanOptions: {
        selfUid: SELF_UID,
        uidOf: (path) => {
          const foreign = reclaimedYet
            ? outcome.foreignAfter
            : outcome.foreignBefore;
          return foreign !== undefined &&
            path === (foreign ? join(baseRoot, foreign) : baseRoot)
            ? FOREIGN_UID
            : SELF_UID;
        },
      },
      ...(outcome.reclaim
        ? {
            reclaim: async (path: string) => {
              baseReclaims.push(path);
              reclaimedYet = true;
              return outcome.reclaim!;
            },
          }
        : {}),
    });
    const baseReachedAfterReclaim = removes === 3;

    // Composed, through the Worker, on another tree the script stands for.
    const root = tree();
    const stageAnswers: Record<string, RemoveTreeStageResult> = {
      initial: outcome.removesOn.some((n) => n <= 2)
        ? { removed: true }
        : outcome.foreignBefore !== undefined
          ? { removed: false, residue: residueAt(root, outcome.foreignBefore)! }
          : { removed: false },
      afterReclaim: outcome.removesOn.includes(3)
        ? { removed: true }
        : outcome.foreignAfter !== undefined
          ? { removed: false, residue: residueAt(root, outcome.foreignAfter)! }
          : { removed: false },
    };
    const script = scriptWorkerAnswersForTests(
      LIFECYCLE_METHODS.removeTree,
      ["initial", "afterReclaim"].map((stage) => ({
        match: (request) => request.json.stage === stage,
        action: {
          answer: answering(encodeRemoveTreeResult(stageAnswers[stage]!)),
        },
      })),
    );
    const reclaims: string[] = [];
    let composed;
    try {
      composed = await removeManagedTreeOn(DEFAULT_WORKER_SIDE, root, {
        ...(outcome.reclaim
          ? {
              reclaim: async (path: string) => {
                reclaims.push(path);
                return outcome.reclaim!;
              },
            }
          : {}),
      });
    } finally {
      script.disarm();
    }

    // The same result once each side's own path is named the same.
    assert.deepEqual(
      JSON.parse(JSON.stringify(composed).replaceAll(root, "<tree>")),
      JSON.parse(JSON.stringify(base).replaceAll(baseRoot, "<tree>")),
    );
    assert.deepEqual(
      reclaims.map((path) => path.replace(root, "<tree>")),
      baseReclaims.map((path) => path.replace(baseRoot, "<tree>")),
    );
    // afterReclaim is asked exactly when base reaches its post-reclaim step.
    assert.equal(
      baseReachedAfterReclaim,
      outcome.reclaim?.status === "reclaimed",
    );
    assert.deepEqual(
      script.seen.map((request) => [request.json.stage, request.action]),
      baseReachedAfterReclaim
        ? [
            ["initial", "answer"],
            ["afterReclaim", "answer"],
          ]
        : [["initial", "answer"]],
    );
  });

test("a Worker failure after a reclaim rejects, never a result", async () => {
  const root = tree();
  const foreign = residueAt(root, "")!;
  const script = scriptWorkerAnswersForTests(LIFECYCLE_METHODS.removeTree, [
    {
      match: (request) => request.json.stage === "initial",
      action: {
        answer: answering(
          encodeRemoveTreeResult({ removed: false, residue: foreign }),
        ),
      },
    },
    {
      match: (request) => request.json.stage === "afterReclaim",
      action: "fail",
    },
  ]);
  let reclaims = 0;
  try {
    const error = await rejection(
      removeManagedTreeOn(DEFAULT_WORKER_SIDE, root, {
        reclaim: async () => {
          reclaims += 1;
          return { status: "reclaimed" };
        },
      }),
    );
    assert.ok(isWorkerFailure(error), String(error));
    assert.equal(checkoutFailureOf(error), "worker");
  } finally {
    script.disarm();
  }
  assert.equal(reclaims, 1);
  assert.deepEqual(
    script.seen.map((request) => [request.json.stage, request.action]),
    [
      ["initial", "answer"],
      ["afterReclaim", "fail"],
    ],
  );
});

test("a Worker failure at the initial stage rejects before any reclaim", async () => {
  const script = scriptWorkerAnswersForTests(LIFECYCLE_METHODS.removeTree, [
    { match: () => true, action: "fail" },
  ]);
  let reclaims = 0;
  try {
    const error = await rejection(
      removeManagedTreeOn(DEFAULT_WORKER_SIDE, tree(), {
        reclaim: async () => {
          reclaims += 1;
          return { status: "reclaimed" };
        },
      }),
    );
    assert.ok(isWorkerFailure(error), String(error));
  } finally {
    script.disarm();
  }
  assert.equal(reclaims, 0);
});

const CALLS: Record<string, (path: string) => Promise<unknown>> = {
  [LIFECYCLE_METHODS.mkdir]: (path) =>
    checkoutLifecycleOn(DEFAULT_WORKER_SIDE).mkdir(path),
  [LIFECYCLE_METHODS.scanResidue]: (path) =>
    checkoutLifecycleOn(DEFAULT_WORKER_SIDE).scanResidue(path),
  [LIFECYCLE_METHODS.removeTree]: (path) =>
    checkoutLifecycleOn(DEFAULT_WORKER_SIDE).removeTree(path, "initial"),
  [LIFECYCLE_METHODS.discardTree]: (path) =>
    checkoutLifecycleOn(DEFAULT_WORKER_SIDE).discardTree(path),
  [LIFECYCLE_METHODS.removeAll]: (path) =>
    checkoutLifecycleOn(DEFAULT_WORKER_SIDE).removeAll(path),
  [LIFECYCLE_METHODS.stopProcesses]: (path) =>
    checkoutLifecycleOn(DEFAULT_WORKER_SIDE).stopProcesses(path),
};

test("a malformed answer is a Worker failure, per method", async () => {
  for (const method of Object.values(LIFECYCLE_METHODS)) {
    const root = tree();
    answerNextInProcessWorkerCallForTests(
      method,
      answering(MALFORMED_ANSWERS[method]!),
    );
    const error = await rejection(CALLS[method]!(root));
    assert.ok(isWorkerFailure(error), `${method}: ${String(error)}`);
    assert.equal(checkoutFailureOf(error), "worker", method);
  }
});

test("a refused request is a Worker failure, per method", async () => {
  for (const method of Object.values(LIFECYCLE_METHODS)) {
    const script = scriptWorkerAnswersForTests(method, [
      { match: () => true, action: "fail" },
    ]);
    try {
      const error = await rejection(CALLS[method]!(tree()));
      assert.ok(isWorkerFailure(error), `${method}: ${String(error)}`);
    } finally {
      script.disarm();
    }
  }
});

test("an unknown Worker is a Worker failure, before any request", async () => {
  const error = await rejection(
    checkoutLifecycleOn({ workerId: "nowhere" }).removeAll(tree()),
  );
  assert.ok(isWorkerFailure(error), String(error));
});

test("a failure the Worker answered is a filesystem failure, never branded", async () => {
  const file = join(dir, "a-file");
  writeFileSync(file, "x");
  const error = await rejection(
    checkoutLifecycleOn(DEFAULT_WORKER_SIDE).mkdir(join(file, "below")),
  );
  assert.equal(isWorkerFailure(error), false);
  assert.equal(checkoutFailureOf(error), "filesystem");
  assert.equal(typeof (error as NodeJS.ErrnoException).code, "string");
});

test("the Knowledge Base side has no lifecycle", () => {
  assert.throws(
    () => checkoutLifecycleOn("server"),
    /The Knowledge Base has no checkout lifecycle/,
  );
});
