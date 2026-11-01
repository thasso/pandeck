import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import { backgroundWorkSupervisor } from "../backgroundWork/supervisor.ts";
import { backgroundWorkStore } from "../db/backgroundWorkStore.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { sessionArtifactFile } from "../mcp/toolGroups/packRuntime.ts";
import { updateSettings } from "../settings.ts";
import { startWorker } from "../worker/worker.ts";
import {
  BACKGROUND_WORK_METHODS,
  encodeBackgroundWork,
  type BackgroundWorkMethod,
  type BackgroundWorkOutputReport,
  type BackgroundWorkRunner,
} from "../workerProtocol/backgroundWorkMethods.ts";
import {
  WorkerConnection,
  WorkerRequestError,
} from "../workerProtocol/connection.ts";
import { FILE_METHODS } from "../workerProtocol/fileMethods.ts";
import { createInProcessTransport } from "../workerProtocol/inProcessTransport.ts";
import {
  backgroundWorkCallsServedForTests,
  backgroundWorkHandlers,
} from "./backgroundWorkHost.ts";
import {
  inProcessBackgroundWorkForTests,
  inProcessWorkerServedMethodForTests,
} from "./inProcessWorker.ts";
import { DEFAULT_WORKER_ID } from "./placement.ts";
import { WorkerRegistry } from "./workerRegistry.ts";

/**
 * The server's `backgroundWork.*` handlers: placement refusals before any
 * effect, and an output report's file copied from the Worker into evidence.
 */

const dir = mkdtempSync(join(tmpdir(), "background-host-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let serial = 0;

function owner(): string {
  serial += 1;
  const id = `background-host-owner-${serial}`;
  sessionStore.upsert({
    id,
    scope: "user",
    harness: "pi",
    agentType: "developer",
  });
  updateSettings({
    backgroundWork: {
      enabled: true,
      ownerSessionCap: 20,
      taskLifetimeMinutes: 5,
      claudeEmptyHostGraceSeconds: 30,
    },
  });
  return id;
}

const served = () =>
  Object.fromEntries(
    Object.values(BACKGROUND_WORK_METHODS).map((method) => [
      method,
      backgroundWorkCallsServedForTests(method as BackgroundWorkMethod),
    ]),
  );

/** Waits up to 5 s for `condition`. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A private registry's connection, asking as `workerId`, for raw requests. */
async function rawWorker(workerId: string) {
  const registry = new WorkerRegistry();
  const [serverEnd, workerEnd] = createInProcessTransport();
  const connection = registry.accept(serverEnd, {
    quiescence: () => Promise.resolve(),
    handlers: backgroundWorkHandlers(() => {
      const admitted = registry.admittedAs(connection);
      return admitted === undefined
        ? undefined
        : { connection, workerId: admitted };
    }),
  });
  const worker = new WorkerConnection(workerEnd, {
    handshake: { role: "worker", workerId },
  });
  return { worker, end: () => connection.end("test done") };
}

const notPlaced = (message: string) => (err: Error) =>
  err instanceof WorkerRequestError &&
  err.code === "not_placed" &&
  err.message === message;

test("an admission for a session not placed on the asking Worker is refused before any effect", async () => {
  const sessionId = owner();
  const registry = new WorkerRegistry();
  const [serverEnd, workerEnd] = createInProcessTransport();
  const connection = registry.accept(serverEnd, {
    quiescence: () => Promise.resolve(),
    handlers: backgroundWorkHandlers(() => {
      const workerId = registry.admittedAs(connection);
      return workerId === undefined ? undefined : { connection, workerId };
    }),
  });
  // A real Worker, admitted as one no session is placed on.
  const worker = startWorker({
    workerId: "elsewhere",
    transport: workerEnd,
    childEnv: () => process.env,
  });
  const before = served();
  let launches = 0;
  const runner: BackgroundWorkRunner = {
    ownerSessionId: sessionId,
    kind: "shell",
    launch: () => {
      launches += 1;
      return Promise.resolve({ launched: false });
    },
  };
  try {
    await assert.rejects(
      worker.backgroundWork.admit(
        {
          sessionId,
          kind: "shell",
          label: "probe",
          command: "probe",
          sourceRequestId: `elsewhere-${serial}`,
        },
        runner,
      ),
      notPlaced(`Session ${sessionId} is not placed on this Worker.`),
    );
    assert.equal(launches, 0);
    assert.deepEqual(served(), before);
    assert.deepEqual(
      backgroundWorkStore.listItems({ ownerSessionId: sessionId }),
      [],
    );
  } finally {
    connection.end("test done");
  }
});

test("a report on an item that is not Worker-executed is refused and leaves its row", async () => {
  const sessionId = owner();
  const admission = backgroundWorkSupervisor.admit({
    ownerSessionId: sessionId,
    backend: "server-task",
    kind: "check-watch",
    label: "server task",
    sourceRequestId: `server-task-${serial}`,
  });
  assert.equal(admission.admitted, true);
  if (!admission.admitted) return;
  const itemId = admission.item.id;
  const row = backgroundWorkStore.getItem(itemId);
  // Asking as the Worker the owner IS placed on: the row's backend refuses.
  const { worker, end } = await rawWorker(DEFAULT_WORKER_ID);
  const before = served();
  try {
    const what = `Background item ${itemId} is not placed on this Worker.`;
    for (const [method, report] of [
      [
        BACKGROUND_WORK_METHODS.activity,
        { lines: ["x"], bytes: 1, droppedEventCount: 0, eventId: "a1" },
      ],
      [
        BACKGROUND_WORK_METHODS.rateExceeded,
        { eventId: "r1", notificationCount: 21, windowMs: 60_000 },
      ],
      [BACKGROUND_WORK_METHODS.output, { eventId: "o1", writeFailed: true }],
      [BACKGROUND_WORK_METHODS.completed, { state: "completed" }],
    ] as const)
      await assert.rejects(
        worker.request(method, encodeBackgroundWork({ ...report, itemId })),
        notPlaced(what),
      );
    // An item nobody admitted is refused the same way.
    await assert.rejects(
      worker.request(
        BACKGROUND_WORK_METHODS.completed,
        encodeBackgroundWork({ itemId: "bgw_missing", state: "completed" }),
      ),
      notPlaced("Background item bgw_missing is not placed on this Worker."),
    );
    assert.deepEqual(served(), before);
    assert.deepEqual(backgroundWorkStore.getItem(itemId), row);
  } finally {
    end();
  }
});

/**
 * Runs one item through the in-process Worker whose runner reports `output`
 * and completes; answers its row once terminal.
 */
async function reportOutput(
  output: Omit<BackgroundWorkOutputReport, "itemId" | "eventId">,
) {
  const sessionId = owner();
  const runner: BackgroundWorkRunner = {
    ownerSessionId: sessionId,
    kind: "shell",
    launch: (request, reporter) => {
      const itemId = request.target.itemId;
      const done = (async () => {
        await reporter.output({ ...output, itemId, eventId: `${itemId}:o` });
        reporter.completed({
          itemId,
          state: "completed",
          exitCode: 0,
          outcomeSummary: "Exited with code 0",
          eventId: `${itemId}:c`,
        });
      })();
      return Promise.resolve({
        launched: true,
        run: { done, stop: () => done },
      });
    },
  };
  const answer = await inProcessBackgroundWorkForTests().admit(
    {
      sessionId,
      kind: "shell",
      label: "probe",
      command: "probe",
      sourceRequestId: `output-${serial}`,
    },
    runner,
  );
  assert.equal(answer.admitted, true);
  if (!answer.admitted) throw new Error("not admitted");
  await until(
    () => backgroundWorkStore.getItem(answer.itemId)?.state === "completed",
    "the item to complete",
  );
  return { sessionId, item: backgroundWorkStore.getItem(answer.itemId)! };
}

test("an output report's file is copied from the Worker into the item's artifact", async () => {
  const file = join(dir, "text.log");
  writeFileSync(file, "first\nsecond\n");
  const opens = inProcessWorkerServedMethodForTests(FILE_METHODS.open);
  const outputs = backgroundWorkCallsServedForTests(
    BACKGROUND_WORK_METHODS.output,
  );
  const { sessionId, item } = await reportOutput({ file });
  assert.equal(
    inProcessWorkerServedMethodForTests(FILE_METHODS.open),
    opens + 1,
  );
  assert.equal(
    backgroundWorkCallsServedForTests(BACKGROUND_WORK_METHODS.output),
    outputs + 1,
  );
  assert.equal(item.evidence?.text, true);
  const artifact = sessionArtifactFile(sessionId, item.evidence!.artifactId!);
  assert.ok(artifact);
  assert.equal(readFileSync(artifact.path, "utf8"), "first\nsecond\n");
});

test("a binary output file is refused as binary", async () => {
  const file = join(dir, "binary.log");
  writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
  const { item } = await reportOutput({ file });
  assert.equal(item.evidence?.refusalReason, "output-is-binary");
  assert.equal(item.evidence?.artifactId, undefined);
});

test("a writer failure is recorded as a failed output write", async () => {
  const opens = inProcessWorkerServedMethodForTests(FILE_METHODS.open);
  const { item } = await reportOutput({ writeFailed: true });
  assert.equal(item.evidence?.refusalReason, "output-write-failed");
  assert.equal(inProcessWorkerServedMethodForTests(FILE_METHODS.open), opens);
});

test("a file the Worker cannot open is recorded as an unavailable output path", async () => {
  const { item } = await reportOutput({ file: join(dir, "missing.log") });
  assert.equal(item.evidence?.refusalReason, "output-path-unavailable");
});
