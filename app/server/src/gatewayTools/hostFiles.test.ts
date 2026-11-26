/**
 * The host's file path (`host.ts`, Task-1441 P7a): the effective limit and
 * its edges (AC1, H3), the answer's size and digest, construction refusals
 * (J3), the refusal without an output seam (P7A-R2), and the one file permit
 * (G7, H1): taken before the credential read, `FILE_BUSY` meanwhile with no
 * credential read, released exactly once when both the execution and the
 * output settled (t2, t7). On `/mcp` (Task-1441 P7b): the `file.mcp`
 * refusals at construction, a file tool without it unlisted and unknown
 * before any permit, and one with it run under its own limits (v09 U1).
 * Every value is fake.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test, vi } from "vitest";
import { encodeAtlassianCredential } from "./atlassian.ts";
import {
  FileResult,
  ToolError,
  type AtlassianToolDescriptor,
  type FileSpec,
  type McpFileSpec,
} from "./descriptor.ts";
import {
  FILE_BUSY,
  NO_SUCH_TOOL,
  createFileBudget,
  createToolHost,
  effectiveFileLimit,
  type FileBudget,
  type ToolCaller,
} from "./host.ts";

const FAKE = { site: "acme.atlassian.net", email: "a@x.test", token: "fake-1" };
const MiB = 1024 * 1024;
const SPEC: FileSpec = {
  limitParam: "maxBytes",
  defaultBytes: 8,
  maxBytes: 16,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fileTool(
  execute: AtlassianToolDescriptor["execute"],
  extra: Partial<AtlassianToolDescriptor> = {},
): AtlassianToolDescriptor {
  return {
    name: "fixture_file",
    description: "A test file tool.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, maxBytes: { type: "number" } },
      additionalProperties: false,
    },
    effect: "read",
    actionKey: "fixture:read",
    integration: "atlassian",
    file: SPEC,
    execute,
    ...extra,
  };
}

/** The same tool without `file`, named `plain`. */
function plainTool(): AtlassianToolDescriptor {
  const { file: _file, ...rest } = fileTool(() => Promise.resolve({}));
  return { ...rest, name: "plain" };
}

const bytesOf = (n: number) => new Uint8Array(n).fill(0x61);
const fileOf = (n: number, json: unknown = { status: "saved" }) =>
  new FileResult(json, { name: "a.bin", mimeType: "x/y", bytes: bytesOf(n) });

/**
 * A caller whose answer's output settles when the test says so; it counts
 * credential reads, which stand for "anything sent upstream".
 */
function fileCaller(signal?: AbortSignal): ToolCaller & {
  reads: number;
  settleOutput(): void;
  registered: number;
} {
  const fns: (() => void)[] = [];
  const caller = {
    clientId: "client-1",
    reads: 0,
    registered: 0,
    credential: () => {
      caller.reads += 1;
      return Promise.resolve({
        ok: true as const,
        credential: encodeAtlassianCredential(FAKE),
      });
    },
    onSettled: (fn: () => void) => {
      caller.registered += 1;
      fns.push(fn);
    },
    settleOutput: () => {
      for (const fn of fns.splice(0)) fn();
    },
    ...(signal ? { signal } : {}),
  };
  return caller;
}

/** A budget that counts its releases. */
function countingBudget(): FileBudget & { releases: number; asked: number[] } {
  const inner = createFileBudget();
  const budget = {
    releases: 0,
    asked: [] as number[],
    reserve(bytes: number) {
      budget.asked.push(bytes);
      const release = inner.reserve(bytes);
      return release
        ? () => {
            budget.releases += 1;
            release();
          }
        : undefined;
    },
    get reserved() {
      return inner.reserved;
    },
  };
  return budget;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the effective limit is the limit argument clamped and truncated, else the default", () => {
  const cases: [unknown, number][] = [
    [undefined, 8],
    [Number.NaN, 8],
    [Number.POSITIVE_INFINITY, 8],
    ["12", 8],
    [0, 1],
    [-5, 1],
    [2.9, 2],
    [16, 16],
    [17, 16],
    [1e12, 16],
  ];
  for (const [value, expected] of cases)
    assert.equal(
      effectiveFileLimit(SPEC, value === undefined ? {} : { maxBytes: value }),
      expected,
      String(value),
    );
});

test("a file answer carries the JSON, the bytes, their size and SHA-256 (AC1)", async () => {
  const seen: (number | undefined)[] = [];
  const host = createToolHost(
    [
      fileTool(async (_params, ctx) => {
        seen.push(ctx.maxFileBytes);
        await ctx.credential();
        return fileOf(5, { status: "saved", n: 1 });
      }),
    ],
    { log: () => {} },
  );
  const answer = await host.call("fixture_file", {}, fileCaller());
  assert.ok(answer.ok && answer.file);
  assert.equal(answer.text, '{"status":"saved","n":1}');
  assert.equal(answer.file.name, "a.bin");
  assert.equal(answer.file.mimeType, "x/y");
  assert.equal(answer.file.size, 5);
  assert.equal(
    answer.file.sha256,
    createHash("sha256").update(bytesOf(5)).digest("hex"),
  );
  assert.deepEqual(answer.file.bytes, bytesOf(5));
  assert.deepEqual(seen, [8], "the tool sees E");
});

test("the limit's edges: E − 1 and E pass, E + 1 is refused with the fixed text (AC1)", async () => {
  for (const [args, size, ok] of [
    [{}, 7, true],
    [{}, 8, true],
    [{}, 9, false],
    [{ maxBytes: 3 }, 3, true],
    [{ maxBytes: 3 }, 4, false],
    [{ maxBytes: 99 }, 16, true],
    [{ maxBytes: 99 }, 17, false],
  ] as const) {
    const host = createToolHost(
      [fileTool(() => Promise.resolve(fileOf(size)))],
      { log: () => {} },
    );
    const caller = fileCaller();
    const answer = await host.call("fixture_file", args, caller);
    assert.equal(answer.ok, ok, `${JSON.stringify(args)} ${size}`);
    if (!answer.ok) {
      const limit = effectiveFileLimit(SPEC, args);
      assert.equal(answer.code, "tool_error");
      assert.equal(
        answer.message,
        `The file is larger than the ${limit}-byte limit; nothing was saved. Raise maxBytes (at most 16) to fetch it.`,
      );
    }
  }
});

test("a plain value from a file tool is a plain answer; its JSON is held to the 60k budget", async () => {
  const host = createToolHost(
    [
      fileTool((params) =>
        Promise.resolve(
          params.id === "big"
            ? fileOf(1, { pad: "x".repeat(60_001) })
            : { status: "no_file" },
        ),
      ),
    ],
    { log: () => {} },
  );
  const first = fileCaller();
  const plain = await host.call("fixture_file", {}, first);
  assert.deepEqual(plain, { ok: true, text: '{"status":"no_file"}' });
  first.settleOutput();
  const big = await host.call("fixture_file", { id: "big" }, fileCaller());
  assert.deepEqual(big, {
    ok: false,
    code: "result_too_large",
    message: "The tool's result is too large.",
  });
});

test("a FileResult from a tool without `file`, or with a bad name, is a failure", async () => {
  const { file: _file, ...plainSpec } = fileTool(() =>
    Promise.resolve(fileOf(1)),
  );
  const host = createToolHost(
    [
      { ...plainSpec, name: "plain_tool" },
      fileTool(() =>
        Promise.resolve(
          new FileResult({}, { name: "", mimeType: "", bytes: bytesOf(1) }),
        ),
      ),
    ],
    { log: () => {} },
  );
  assert.deepEqual(await host.call("plain_tool", {}, fileCaller()), {
    ok: false,
    code: "failed",
    message: "plain_tool failed.",
  });
  assert.deepEqual(await host.call("fixture_file", {}, fileCaller()), {
    ok: false,
    code: "failed",
    message: "fixture_file failed.",
  });
});

test("construction refuses a file tool with phases, a write, or limits the path cannot run (J3)", () => {
  const execute = () => Promise.resolve({});
  const phases = {
    prepare: () => Promise.resolve({ site: "s", items: [], warnings: [] }),
    apply: () => Promise.resolve({ ok: true as const, results: [] }),
  } as unknown as NonNullable<AtlassianToolDescriptor["phases"]>;
  const bad: [Partial<AtlassianToolDescriptor>, RegExp][] = [
    [{ phases }, /no phases/],
    [{ effect: "write" }, /is a read/],
    [{ file: { ...SPEC, maxBytes: 0 } }, /maxBytes/],
    [{ file: { ...SPEC, maxBytes: 1.5 } }, /maxBytes/],
    [{ file: { ...SPEC, defaultBytes: 17 } }, /defaultBytes/],
    [{ file: { ...SPEC, defaultBytes: 0 } }, /defaultBytes/],
    [{ file: { ...SPEC, limitParam: "id" } }, /limitParam/],
    [{ file: { ...SPEC, limitParam: "absent" } }, /limitParam/],
  ];
  for (const [extra, message] of bad)
    assert.throws(
      () => createToolHost([fileTool(execute, extra)], { log: () => {} }),
      message,
    );
  assert.doesNotThrow(() =>
    createToolHost([fileTool(execute)], { log: () => {} }),
  );
});

const MCP: McpFileSpec = {
  description: "The tool on /mcp.",
  limitDescription: "Largest file on /mcp.",
  defaultBytes: 4,
  maxBytes: 12,
  project: (json) => ({ projected: json }),
  uri: () => "pandeck-gateway://fixture/x",
};

test("construction refuses a file.mcp the /mcp path cannot run (P7b)", () => {
  const execute = () => Promise.resolve({});
  const withMcp = (mcp: Partial<Record<keyof McpFileSpec, unknown>>) => ({
    file: { ...SPEC, mcp: { ...MCP, ...mcp } as McpFileSpec },
  });
  const bad: [Partial<AtlassianToolDescriptor>, RegExp][] = [
    [withMcp({ description: "" }), /mcp\.description/],
    [withMcp({ limitDescription: "" }), /mcp\.limitDescription/],
    [withMcp({ maxBytes: 0 }), /mcp\.maxBytes/],
    [withMcp({ maxBytes: 17 }), /mcp\.maxBytes/],
    [withMcp({ maxBytes: 2.5 }), /mcp\.maxBytes/],
    [withMcp({ defaultBytes: 0 }), /mcp\.defaultBytes/],
    [withMcp({ defaultBytes: 13 }), /mcp\.defaultBytes/],
    [withMcp({ project: undefined }), /project and uri/],
    [withMcp({ uri: "x" }), /project and uri/],
  ];
  for (const [extra, message] of bad)
    assert.throws(
      () => createToolHost([fileTool(execute, extra)], { log: () => {} }),
      message,
    );
  assert.doesNotThrow(() =>
    createToolHost([fileTool(execute, withMcp({}))], { log: () => {} }),
  );
});

test("a file tool without file.mcp is off the /mcp listing and unknown to mcpCall before any permit or credential read", async () => {
  const budget = countingBudget();
  const execute = vi.fn(() => Promise.resolve(fileOf(1)));
  const host = createToolHost([fileTool(execute), plainTool()], {
    log: () => {},
    fileBudget: budget,
  });
  assert.deepEqual(
    host.list().map((tool) => tool.name),
    ["fixture_file", "plain"],
  );
  assert.deepEqual(
    host.mcpList().map((tool) => tool.name),
    ["plain"],
  );
  const caller = fileCaller();
  assert.deepEqual(await host.mcpCall("fixture_file", {}, caller), {
    ok: false,
    code: "unknown_tool",
    message: NO_SUCH_TOOL,
  });
  assert.equal(execute.mock.calls.length, 0);
  assert.deepEqual(budget.asked, []);
  assert.equal(caller.reads, 0);
  assert.equal(caller.registered, 0);
});

test("on /mcp a file tool lists its /mcp description and limit text and runs under file.mcp's limits", async () => {
  const budget = countingBudget();
  const seen: unknown[] = [];
  const host = createToolHost(
    [
      fileTool(
        (params, ctx) => {
          seen.push({
            limit: ctx.maxFileBytes,
            cap: ctx.maxFileCap,
            reserved: budget.reserved,
          });
          return Promise.resolve(fileOf(Number(params.id ?? 1)));
        },
        { file: { ...SPEC, mcp: MCP } },
      ),
    ],
    { log: () => {}, fileBudget: budget },
  );
  const [listed] = host.mcpList();
  assert.deepEqual(Object.keys(listed!).sort(), [
    "description",
    "effect",
    "inputSchema",
    "name",
  ]);
  assert.equal(listed!.description, "The tool on /mcp.");
  assert.deepEqual(listed!.inputSchema.properties.maxBytes, {
    type: "number",
    description: "Largest file on /mcp.",
  });
  // The client listing is untouched.
  assert.equal(host.list()[0]!.description, "A test file tool.");
  assert.deepEqual(host.list()[0]!.inputSchema.properties.maxBytes, {
    type: "number",
  });

  const caller = fileCaller();
  const answer = await host.mcpCall("fixture_file", { id: "4" }, caller);
  assert.ok(answer.ok && answer.file);
  assert.equal(answer.text, JSON.stringify({ projected: { status: "saved" } }));
  assert.equal(answer.file.uri, "pandeck-gateway://fixture/x");
  assert.equal(answer.file.size, 4);
  caller.settleOutput();
  await settle();
  // Clamped to file.mcp's cap; the limit's edge E + 1 refused with its text.
  const over = await host.mcpCall(
    "fixture_file",
    { id: "13", maxBytes: 1e9 },
    caller,
  );
  caller.settleOutput();
  await settle();
  assert.deepEqual(over, {
    ok: false,
    code: "tool_error",
    message:
      "The file is larger than the 12-byte limit; nothing was saved. Raise maxBytes (at most 12) to fetch it.",
  });
  assert.deepEqual(seen, [
    { limit: 4, cap: 12, reserved: 2 * 4 + 2 * MiB },
    { limit: 12, cap: 12, reserved: 2 * 12 + 2 * MiB },
  ]);
  assert.equal(budget.releases, 2);
  // On the client route the same tool runs under `file`, unprojected.
  const client = await host.callForClient("fixture_file", { id: "2" }, caller);
  assert.ok(client.ok && client.file);
  assert.equal(client.text, JSON.stringify({ status: "saved" }));
  assert.equal("uri" in client.file, false);
  assert.deepEqual(seen.at(-1), {
    limit: 8,
    cap: 16,
    reserved: 2 * 8 + 2 * MiB,
  });
});

test("the listing carries a file tool's limits", () => {
  const host = createToolHost([fileTool(() => Promise.resolve({}))], {
    log: () => {},
  });
  assert.deepEqual(host.list()[0]!.file, SPEC);
});

test("without the output seam a file call is refused before the permit and the credential (P7A-R2)", async () => {
  const budget = countingBudget();
  const execute = vi.fn(() => Promise.resolve(fileOf(1)));
  const host = createToolHost([fileTool(execute)], {
    log: () => {},
    fileBudget: budget,
  });
  const { onSettled: _seam, ...noSeam } = fileCaller();
  const answer = await host.call("fixture_file", {}, noSeam);
  assert.deepEqual(answer, {
    ok: false,
    code: "failed",
    message: "This tool can only be called over a gateway client connection.",
  });
  assert.equal(execute.mock.calls.length, 0);
  assert.deepEqual(budget.asked, []);
  assert.equal(budget.reserved, 0);
  // The permit is still free for a caller with the seam.
  const caller = fileCaller();
  assert.ok((await host.call("fixture_file", {}, caller)).ok);
});

test("the permit is reserved at 2E + 2 MiB before the credential read and released once both holds settle", async () => {
  const budget = countingBudget();
  const heldAtRead: number[] = [];
  const host = createToolHost(
    [
      fileTool(async (_params, ctx) => {
        heldAtRead.push(budget.reserved);
        await ctx.credential();
        return fileOf(3);
      }),
    ],
    { log: () => {}, fileBudget: budget },
  );
  const first = fileCaller();
  assert.ok((await host.call("fixture_file", { maxBytes: 3 }, first)).ok);
  assert.equal(first.registered, 1);
  await settle();
  assert.equal(budget.reserved, 2 * 3 + 2 * MiB, "output not settled yet");

  // A second call meanwhile is FILE_BUSY and reads no credential.
  const second = fileCaller();
  assert.deepEqual(await host.call("fixture_file", {}, second), {
    ok: false,
    code: "tool_error",
    message: FILE_BUSY,
  });
  assert.equal(second.reads, 0);
  assert.equal(second.registered, 0, "a refused call registers nothing");

  first.settleOutput();
  assert.equal(budget.reserved, 0);
  assert.equal(budget.releases, 1);
  first.settleOutput();
  assert.equal(budget.releases, 1);
  assert.ok((await host.call("fixture_file", {}, fileCaller())).ok);
  assert.deepEqual(heldAtRead, [2 * 3 + 2 * MiB, 2 * 8 + 2 * MiB]);
});

test("a failure keeps the permit until its output settles too, then releases once", async () => {
  const budget = countingBudget();
  const host = createToolHost(
    [fileTool(() => Promise.reject(new ToolError("No such attachment.")))],
    { log: () => {}, fileBudget: budget },
  );
  const caller = fileCaller();
  assert.deepEqual(await host.call("fixture_file", {}, caller), {
    ok: false,
    code: "tool_error",
    message: "No such attachment.",
  });
  await settle();
  assert.equal(budget.releases, 0);
  caller.settleOutput();
  assert.equal(budget.releases, 1);
});

for (const how of ["cancelled", "timeout"] as const)
  test(`a ${how} answers at once; the permit stays until the execution settles (t2)`, async () => {
    const budget = countingBudget();
    let finish = (): void => {};
    const host = createToolHost(
      [
        fileTool(
          async (_params, ctx) => {
            await ctx.credential();
            // Cleanup that takes its time, whatever the signal says.
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
            throw new Error("aborted late");
          },
          how === "timeout" ? { deadlineMs: 20 } : {},
        ),
      ],
      { log: () => {}, fileBudget: budget },
    );
    const controller = new AbortController();
    const caller = fileCaller(controller.signal);
    const pending = host.call("fixture_file", {}, caller);
    await settle();
    if (how === "cancelled") controller.abort();
    const answer = await pending;
    assert.equal(!answer.ok && answer.code, how);
    caller.settleOutput();
    assert.equal(budget.releases, 0, "the execution has not settled");

    const other = fileCaller();
    assert.deepEqual(await host.call("fixture_file", {}, other), {
      ok: false,
      code: "tool_error",
      message: FILE_BUSY,
    });
    assert.equal(other.reads, 0);

    finish();
    await settle();
    assert.equal(budget.releases, 1);
    assert.equal(budget.reserved, 0);
  });

test("an execution that never settles keeps the permit, logs one fixed line after 30 s, and releases nothing on a timer (t7)", async () => {
  vi.useFakeTimers();
  const budget = countingBudget();
  const lines: string[] = [];
  const host = createToolHost(
    [
      fileTool(() => new Promise<never>(() => {}), {
        deadlineMs: 1_000,
      }),
    ],
    { log: (line) => lines.push(line), fileBudget: budget },
  );
  const caller = fileCaller();
  const pending = host.call("fixture_file", { id: "SECRET-id" }, caller);
  await vi.advanceTimersByTimeAsync(1_000);
  const answer = await pending;
  assert.equal(!answer.ok && answer.code, "timeout");
  caller.settleOutput();
  const stuckLine =
    "file call not settled after abort: fixture_file client client-1";
  await vi.advanceTimersByTimeAsync(29_999);
  assert.ok(!lines.includes(stuckLine));
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(lines.filter((line) => line === stuckLine).length, 1);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  assert.equal(lines.filter((line) => line === stuckLine).length, 1);
  assert.equal(budget.releases, 0);
  assert.equal(budget.reserved, 2 * 8 + 2 * MiB);
  assert.ok(lines.every((line) => !line.includes("SECRET")));
});

test("an execution that settles within 30 s of its timeout logs nothing", async () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  let finish = (): void => {};
  const host = createToolHost(
    [
      fileTool(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({});
          }),
        { deadlineMs: 1_000 },
      ),
    ],
    { log: (line) => lines.push(line) },
  );
  const caller = fileCaller();
  const pending = host.call("fixture_file", {}, caller);
  await vi.advanceTimersByTimeAsync(1_000);
  await pending;
  finish();
  await vi.advanceTimersByTimeAsync(60_000);
  assert.ok(lines.every((line) => !line.startsWith("file call not settled")));
});

test("the same file tool reaches the file path through callForClient (J2 placement control)", async () => {
  const host = createToolHost([fileTool(() => Promise.resolve(fileOf(2)))], {
    log: () => {},
  });
  const answer = await host.callForClient("fixture_file", {}, fileCaller());
  assert.ok(answer.ok && answer.file?.size === 2);
});

test("a refusal before the run takes no permit: schema, unknown tool", async () => {
  const budget = countingBudget();
  const host = createToolHost([fileTool(() => Promise.resolve(fileOf(1)))], {
    log: () => {},
    fileBudget: budget,
  });
  const caller = fileCaller();
  assert.equal(
    (await host.call("fixture_file", { maxBytes: "x" }, caller)).ok,
    false,
  );
  assert.equal((await host.call("nope", {}, caller)).ok, false);
  assert.deepEqual(budget.asked, []);
  assert.equal(caller.registered, 0);
});

test("the budget admits one reservation at a time and never one above its capacity", () => {
  const budget = createFileBudget(100);
  assert.equal(budget.reserve(101), undefined);
  const release = budget.reserve(60)!;
  assert.equal(budget.reserve(1), undefined, "one at a time");
  release();
  release();
  assert.equal(budget.reserved, 0);
  assert.ok(budget.reserve(100));
  // A 100 MiB call fits the production budget: 202 MiB of 210.
  assert.ok(createFileBudget().reserve(2 * 100 * MiB + 2 * MiB));
});
