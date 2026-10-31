/**
 * Session hooks across the worker protocol (`docs/workers.md`): an engine's
 * permission and hook callbacks leave from the in-process Worker as
 * `sessionHooks.*`, and the server validates the session id, checks the
 * session's placement, and then applies the session's binding or writes its
 * artifact. Everything runs over the real codec; the placement refusal uses a
 * second, real Worker admitted under another id.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { claudeOutputPolicyHooks } from "../claudeSdk/outputPolicyHooks.ts";
import { DATA_DIR } from "../config.ts";
import { deleteToolGroupSessionData } from "../mcp/toolGroups/registry.ts";
import { listSessionArtifacts } from "../mcp/toolGroups/packRuntime.ts";
import { startWorker } from "../worker/worker.ts";
import { INVALID_PARAMS } from "../workerProtocol/checkoutMethods.ts";
import { WorkerRequestError } from "../workerProtocol/connection.ts";
import { FILE_METHODS } from "../workerProtocol/fileMethods.ts";
import { createInProcessTransport } from "../workerProtocol/inProcessTransport.ts";
import { SESSION_HOOK_METHODS } from "../workerProtocol/sessionHookMethods.ts";
import {
  inProcessWorkerServedMethodForTests,
  sessionHooksFor,
} from "./inProcessWorker.ts";
import {
  registerSessionHooks,
  sessionHookCallsServedForTests,
  sessionHookHandlers,
  type SessionHookBinding,
} from "./sessionHookHost.ts";
import { WorkerRegistry } from "./workerRegistry.ts";

const LONE = "a\uD800b";

/** A binding that records every call it receives; it answers as told. */
function probe(name = "probe") {
  const calls: unknown[][] = [];
  const binding: SessionHookBinding = {
    canUseTool: (toolName) => {
      calls.push(["canUseTool", toolName]);
      return toolName === "Edit"
        ? { behavior: "deny", message: `${name} denies ${LONE}` }
        : { behavior: "allow" };
    },
    preToolUse: async (epoch, input) => {
      calls.push(["preToolUse", epoch, input]);
      return input.toolName === "Monitor"
        ? { allowed: false, reason: `${name} is full` }
        : { allowed: true, context: `${name} admitted` };
    },
    stop: (epoch, tasks) => {
      calls.push(["stop", epoch, tasks]);
    },
    postCompact: (epoch, summary) => {
      calls.push(["postCompact", epoch, summary]);
    },
  };
  return { binding, calls };
}

const served = () =>
  Object.fromEntries(
    Object.values(SESSION_HOOK_METHODS).map((method) => [
      method,
      sessionHookCallsServedForTests(method),
    ]),
  );

/** Every Claude method, through the engine-side calls for `sessionId`. */
function claudeCalls(sessionId: string) {
  const hooks = sessionHooksFor(sessionId);
  return [
    () => hooks.canUseTool("Read"),
    () =>
      hooks.preToolUse("e", {
        toolName: "Bash",
        toolInput: {},
        toolUseId: "u",
      }),
    () => hooks.stop("e", []),
    () => hooks.postCompact("e", "summary"),
  ];
}

function entries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

test("each Claude method reaches the session's binding with its epoch and input", async () => {
  const sessionId = "session-hooks-binding";
  const { binding, calls } = probe();
  const dispose = registerSessionHooks(sessionId, binding);
  const hooks = sessionHooksFor(sessionId);
  const before = served();
  try {
    assert.deepEqual(await hooks.canUseTool("Read"), { behavior: "allow" });
    assert.deepEqual(await hooks.canUseTool("Edit"), {
      behavior: "deny",
      message: `probe denies ${LONE}`,
    });
    const input = {
      toolName: "Bash",
      toolInput: { command: LONE, run_in_background: true },
      toolUseId: `u-${LONE}`,
    };
    assert.deepEqual(await hooks.preToolUse(`epoch-${LONE}`, input), {
      allowed: true,
      context: "probe admitted",
    });
    assert.deepEqual(
      await hooks.preToolUse("e2", { ...input, toolName: "Monitor" }),
      { allowed: false, reason: "probe is full" },
    );
    const tasks = [
      { id: "t", type: "local_bash", status: "running", description: LONE },
    ];
    assert.equal(await hooks.stop("e3", tasks), undefined);
    assert.equal(await hooks.postCompact("e4", `summary ${LONE}`), undefined);
    assert.deepEqual(calls, [
      ["canUseTool", "Read"],
      ["canUseTool", "Edit"],
      ["preToolUse", `epoch-${LONE}`, input],
      ["preToolUse", "e2", { ...input, toolName: "Monitor" }],
      ["stop", "e3", tasks],
      ["postCompact", "e4", `summary ${LONE}`],
    ]);
    const after = served();
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(after).map(([method, n]) => [
          method,
          n - before[method]!,
        ]),
      ),
      {
        [SESSION_HOOK_METHODS.canUseTool]: 2,
        [SESSION_HOOK_METHODS.preToolUse]: 2,
        [SESSION_HOOK_METHODS.stop]: 1,
        [SESSION_HOOK_METHODS.postCompact]: 1,
        [SESSION_HOOK_METHODS.persistOutput]: 0,
      },
    );
  } finally {
    dispose();
  }
});

test("a binding's thrown error reaches the hook with its message", async () => {
  const sessionId = "session-hooks-throws";
  const dispose = registerSessionHooks(sessionId, {
    ...probe().binding,
    stop: () => {
      throw new Error(`stop failed ${LONE}`);
    },
  });
  try {
    await assert.rejects(
      sessionHooksFor(sessionId).stop("e", []),
      (err: Error) => err.message === `stop failed ${LONE}`,
    );
  } finally {
    dispose();
  }
});

test("the newest binding serves; a disposer removes only its own", async () => {
  const sessionId = "session-hooks-newest";
  for (const call of claudeCalls(sessionId))
    await assert.rejects(
      call(),
      (err: Error) =>
        err instanceof WorkerRequestError &&
        err.code === "no_session_hooks" &&
        err.message === `Session ${sessionId} has no live session hooks.`,
    );
  const holder = probe("holder");
  const refused = probe("refused");
  const disposeHolder = registerSessionHooks(sessionId, holder.binding);
  const disposeRefused = registerSessionHooks(sessionId, refused.binding);
  const hooks = sessionHooksFor(sessionId);
  assert.deepEqual(await hooks.canUseTool("Edit"), {
    behavior: "deny",
    message: `refused denies ${LONE}`,
  });
  disposeRefused();
  assert.deepEqual(await hooks.canUseTool("Edit"), {
    behavior: "deny",
    message: `holder denies ${LONE}`,
  });
  disposeRefused();
  assert.deepEqual(await hooks.canUseTool("Edit"), {
    behavior: "deny",
    message: `holder denies ${LONE}`,
  });
  disposeHolder();
  await assert.rejects(hooks.canUseTool("Edit"), /has no live session hooks/);
});

test("Stop and PostCompact resolve only once the server has run them", async () => {
  const sessionId = "session-hooks-order";
  const entered: string[] = [];
  const releases: Array<() => void> = [];
  const held = (name: string) => () => {
    entered.push(name);
    return new Promise<void>((resolve) => releases.push(resolve));
  };
  const dispose = registerSessionHooks(sessionId, {
    ...probe().binding,
    stop: held("stop"),
    postCompact: held("postCompact"),
  });
  const hooks = claudeOutputPolicyHooks({
    ...sessionHooksFor(sessionId),
    epoch: "order",
  });
  const signal = new AbortController().signal;
  const base = {
    session_id: "provider-1",
    transcript_path: "/tmp/transcript",
    cwd: "/tmp",
  };
  try {
    for (const [name, run] of [
      [
        "stop",
        () =>
          hooks.Stop![0]!.hooks[0]!(
            {
              ...base,
              hook_event_name: "Stop",
              stop_hook_active: false,
              background_tasks: [],
            } as never,
            undefined,
            { signal },
          ),
      ],
      [
        "postCompact",
        () =>
          hooks.PostCompact![0]!.hooks[0]!(
            {
              ...base,
              hook_event_name: "PostCompact",
              trigger: "manual",
              compact_summary: "held summary",
            } as never,
            undefined,
            { signal },
          ),
      ],
    ] as const) {
      let settled = false;
      const result = run().then((answer) => {
        settled = true;
        return answer;
      });
      while (!entered.includes(name))
        await new Promise((resolve) => setImmediate(resolve));
      // The server holds the binding's promise: the hook must still wait.
      for (let turn = 0; turn < 5; turn++)
        await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false, `${name} waits for the server`);
      releases.shift()!();
      assert.deepEqual(await result, { continue: true });
    }
  } finally {
    dispose();
  }
});

test("an unsafe session id is refused before anything is created", async () => {
  const before = served();
  const dataDir = entries(DATA_DIR);
  const artifacts = entries(join(DATA_DIR, "session-artifacts"));
  for (const sessionId of ["../w8-escape", "a/b", "a\\b", ".", "..", ""]) {
    for (const call of [
      () =>
        sessionHooksFor(sessionId).persistOutput({
          toolName: "Bash",
          raw: "escape",
        }),
      ...claudeCalls(sessionId),
    ])
      await assert.rejects(
        call(),
        (err: Error) =>
          err instanceof WorkerRequestError &&
          err.code === INVALID_PARAMS &&
          err.message === "Invalid session id.",
        JSON.stringify(sessionId),
      );
  }
  assert.deepEqual(served(), before);
  assert.deepEqual(entries(DATA_DIR), dataDir);
  assert.deepEqual(entries(join(DATA_DIR, "session-artifacts")), artifacts);
  assert.equal(existsSync(join(DATA_DIR, "w8-escape")), false);
});

test("a Worker the session is not placed on is refused before any effect", async () => {
  const sessionId = "session-hooks-elsewhere";
  const { binding, calls } = probe();
  const dispose = registerSessionHooks(sessionId, binding);
  const registry = new WorkerRegistry();
  const [serverEnd, workerEnd] = createInProcessTransport();
  const connection = registry.accept(serverEnd, {
    quiescence: () => Promise.resolve(),
    handlers: sessionHookHandlers(() => {
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
  try {
    const hooks = worker.sessionHooks;
    for (const call of [
      () => hooks.canUseTool({ sessionId, toolName: "Read" }),
      () =>
        hooks.preToolUse({
          sessionId,
          epoch: "e",
          toolName: "Bash",
          toolInput: {},
          toolUseId: "u",
        }),
      () => hooks.stop({ sessionId, epoch: "e", tasks: [] }),
      () => hooks.postCompact({ sessionId, epoch: "e", summary: "s" }),
      () => hooks.persistOutput({ sessionId, toolName: "Bash", raw: "x" }),
    ])
      await assert.rejects(
        call(),
        (err: Error) =>
          err instanceof WorkerRequestError &&
          err.code === "not_placed" &&
          err.message === `Session ${sessionId} is not placed on this Worker.`,
      );
    assert.equal(registry.admittedAs(connection), "elsewhere");
    assert.deepEqual(calls, []);
    assert.deepEqual(served(), before);
    assert.equal(
      existsSync(join(DATA_DIR, "session-artifacts", sessionId)),
      false,
    );
  } finally {
    connection.end("test done");
    dispose();
  }
});

test("a vendor full-output file is streamed from the session's Worker", async () => {
  const sessionId = `session-hooks-copy-${Date.now()}`;
  const dir = await mkdtemp(join(tmpdir(), "w8-source-"));
  try {
    const source = join(dir, "full.out");
    const bytes = randomBytes(3 * 1024 * 1024 + 17);
    await writeFile(source, bytes);
    const opens = inProcessWorkerServedMethodForTests(FILE_METHODS.open);
    const persisted = served()[SESSION_HOOK_METHODS.persistOutput]!;
    const copied = await sessionHooksFor(sessionId).persistOutput({
      toolName: "Bash",
      raw: "bounded",
      sourcePath: source,
    });
    assert.ok((await readFile(copied.path)).equals(bytes));
    assert.equal(
      inProcessWorkerServedMethodForTests(FILE_METHODS.open),
      opens + 1,
      "the source is opened on the Worker",
    );
    assert.equal(served()[SESSION_HOOK_METHODS.persistOutput], persisted + 1);
    assert.match(
      copied.url,
      new RegExp(`^/api/session-artifacts/${sessionId}/tool-output/`),
    );

    // Named in the output text instead, as the vendor reports it.
    const parsed = await sessionHooksFor(sessionId).persistOutput({
      toolName: "Bash",
      raw: `bounded\n[Full output saved to: ${source}]`,
    });
    assert.ok((await readFile(parsed.path)).equals(bytes));

    // A source the Worker cannot open leaves the raw output.
    const missing = await sessionHooksFor(sessionId).persistOutput({
      toolName: "Bash",
      raw: `raw only ${LONE}`,
      sourcePath: join(dir, "missing.out"),
    });
    assert.equal(
      inProcessWorkerServedMethodForTests(FILE_METHODS.open),
      opens + 3,
    );
    assert.equal(
      await readFile(missing.path, "utf8"),
      // UTF-8 carries the lone surrogate as a replacement character.
      "raw only a\uFFFDb",
    );
    assert.equal(listSessionArtifacts(sessionId).length, 3);
  } finally {
    deleteToolGroupSessionData(sessionId);
    await rm(dir, { recursive: true, force: true });
  }
});
