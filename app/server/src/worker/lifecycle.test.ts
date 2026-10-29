/**
 * The Worker's lifecycle methods over the real codec, as raw requests: what any
 * server, not just this one's client, gets from them.
 *
 * The `/` refusals are tested against the real handlers. Should a refusal ever
 * break, its effect would run on `/`, so every deleting and repairing
 * primitive the handlers reach is guarded here first: a guarded path throws
 * instead of being touched. The guard is proven to reach the handlers on a
 * probe directory before any `/` request is sent.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { removeManagedTree, scanTreeResidue } from "../managedTreeRemoval.ts";
import {
  INVALID_PARAMS,
  WRONG_WORKER,
} from "../workerProtocol/checkoutMethods.ts";
import type { Payload } from "../workerProtocol/codec.ts";
import { WorkerRequestError } from "../workerProtocol/connection.ts";
import {
  LIFECYCLE_METHODS,
  decodeCreateDirResult,
  decodeDiscardTreeResult,
  decodeProcessStop,
  decodeRemoveTreeResult,
  decodeResidueScan,
} from "../workerProtocol/lifecycleMethods.ts";
import { ensureInProcessWorker } from "../workers/inProcessWorker.ts";
import { DEFAULT_WORKER_ID } from "../workers/placement.ts";

const guard = vi.hoisted(() => ({
  probe: undefined as string | undefined,
  hits: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const { resolve } = await import("node:path");
  const check = (call: string, path: unknown): void => {
    const at = resolve(String(path));
    if (at !== "/" && at !== guard.probe) return;
    guard.hits.push(`${call} ${at}`);
    throw Object.assign(new Error(`test guard: ${call} ${at}`), {
      code: "EGUARD",
    });
  };
  const guarded = {
    ...fs,
    rmSync: ((path, options) => {
      check("rmSync", path);
      return fs.rmSync(path, options);
    }) as typeof fs.rmSync,
    openSync: ((path, ...rest: unknown[]) => {
      check("openSync", path);
      return (fs.openSync as (...args: unknown[]) => number)(path, ...rest);
    }) as typeof fs.openSync,
    chmodSync: ((path, mode) => {
      check("chmodSync", path);
      return fs.chmodSync(path, mode);
    }) as typeof fs.chmodSync,
  };
  return { ...guarded, default: guarded };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const { resolve } = await import("node:path");
  const rm: typeof fs.rm = async (path, options) => {
    const at = resolve(String(path));
    if (at === "/" || at === guard.probe) {
      guard.hits.push(`rm ${at}`);
      throw Object.assign(new Error(`test guard: rm ${at}`), {
        code: "EGUARD",
      });
    }
    return fs.rm(path, options);
  };
  return { ...fs, rm, default: { ...fs, rm } };
});

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "worker-lifecycle-"));
});

afterAll(() => {
  chmodAll(dir);
  rmSync(dir, { recursive: true, force: true });
});

/** Owner `rwx` on every directory, so a fixture can always be cleaned up. */
function chmodAll(root: string): void {
  if (!existsSync(root)) return;
  const pending = [root];
  while (pending.length > 0) {
    const at = pending.pop()!;
    try {
      chmodSync(at, 0o700);
      for (const entry of readdirSync(at, { withFileTypes: true }))
        if (entry.isDirectory()) pending.push(join(at, entry.name));
    } catch {
      // Gone already.
    }
  }
}

const ask = (method: string, json: unknown): Promise<Payload> =>
  ensureInProcessWorker().request(method, { json });

const here = (path: string) => ({ workerId: DEFAULT_WORKER_ID, path });

const requestOf = (
  method: string,
  path: string,
  workerId = DEFAULT_WORKER_ID,
) =>
  method === LIFECYCLE_METHODS.removeTree
    ? { location: { workerId, path }, stage: "initial" }
    : { location: { workerId, path } };

async function refusal(promise: Promise<unknown>): Promise<WorkerRequestError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof WorkerRequestError, String(error));
    return error;
  }
  assert.fail("the request was served");
}

/** A tree with a file in a subdirectory: what every refusal must leave. */
function fixtureTree(name: string): string {
  const root = join(dir, name);
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "sub", "kept.txt"), "kept\n");
  return root;
}

/** A shell whose background `sleep` is a grandchild of this process, in `cwd`. */
async function grandchildIn(
  cwd: string,
): Promise<{ shell: ChildProcess; pid: number }> {
  const shell = spawn("sh", ["-c", "sleep 600 & echo $!; wait"], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const pid = await new Promise<number>((resolve) =>
    shell.stdout!.once("data", (data: Buffer) =>
      resolve(Number(String(data).trim())),
    ),
  );
  return { shell, pid };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const DESTRUCTIVE = [
  LIFECYCLE_METHODS.removeTree,
  LIFECYCLE_METHODS.discardTree,
  LIFECYCLE_METHODS.removeAll,
  LIFECYCLE_METHODS.stopProcesses,
];

describe("refusals, before any effect", () => {
  let tree: string;
  let canary: { shell: ChildProcess; pid: number };
  let proven = false;

  beforeAll(async () => {
    tree = fixtureTree("refused");
    canary = await grandchildIn(tree);
  });

  afterAll(() => {
    guard.probe = undefined;
    for (const pid of [canary.pid, canary.shell.pid!])
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone already.
      }
  });

  /** Nothing happened: the tree and its file are there, the grandchild lives. */
  function assertNoEffect(): void {
    assert.equal(readFileSync(join(tree, "sub", "kept.txt"), "utf8"), "kept\n");
    assert.ok(alive(canary.pid), "the grandchild was signalled");
  }

  test("the guard reaches the handlers' primitives", async () => {
    const probe = fixtureTree("guard-probe");
    guard.probe = probe;
    try {
      assert.deepEqual(await removeManagedTree(probe), { removed: false });
      const removal = decodeRemoveTreeResult(
        await ask(
          LIFECYCLE_METHODS.removeTree,
          requestOf(LIFECYCLE_METHODS.removeTree, probe),
        ),
      );
      assert.deepEqual(removal, { removed: false });
      assert.match(
        decodeDiscardTreeResult(
          await ask(LIFECYCLE_METHODS.discardTree, { location: here(probe) }),
        ).failed ?? "",
        /test guard: rmSync/,
      );
      const removeAll = await ask(LIFECYCLE_METHODS.removeAll, {
        location: here(probe),
      });
      assert.deepEqual(removeAll.json, { error: { code: "EGUARD" } });
      assert.ok(existsSync(join(probe, "sub", "kept.txt")));
      for (const call of ["rmSync", "openSync", "rm"])
        assert.ok(
          guard.hits.some((hit) => hit.startsWith(`${call} `)),
          `${call} is guarded`,
        );
      proven = true;
    } finally {
      guard.probe = undefined;
      guard.hits.length = 0;
    }
  });

  test("another Worker's id is refused by every method", async () => {
    for (const method of Object.values(LIFECYCLE_METHODS)) {
      const target =
        method === LIFECYCLE_METHODS.mkdir ||
        method === LIFECYCLE_METHODS.createDir
          ? join(tree, "new")
          : tree;
      const error = await refusal(
        ask(method, requestOf(method, target, "elsewhere")),
      );
      assert.equal(error.code, WRONG_WORKER, method);
      assert.match(
        error.message,
        /is placed on Worker "elsewhere", not "local"/,
      );
      assertNoEffect();
    }
    assert.equal(existsSync(join(tree, "new")), false);
  });

  test("a path resolving to / is refused by the four destructive methods", async () => {
    assert.ok(proven, "the guard must be proven before / is ever sent");
    for (const method of DESTRUCTIVE)
      for (const path of [
        "/",
        "/tmp/..",
        relative(process.cwd(), "/") || "/",
      ]) {
        const error = await refusal(ask(method, requestOf(method, path)));
        assert.equal(error.code, INVALID_PARAMS, `${method} ${path}`);
        assertNoEffect();
      }
    assert.deepEqual(guard.hits, [], "no primitive was reached for /");
  });

  test("a / refusal does not precede the Worker id check", async () => {
    assert.ok(proven);
    for (const method of DESTRUCTIVE) {
      const error = await refusal(
        ask(method, requestOf(method, "/", "elsewhere")),
      );
      assert.equal(error.code, WRONG_WORKER, method);
    }
    assert.deepEqual(guard.hits, []);
  });

  test("malformed requests are invalid params", async () => {
    for (const method of Object.values(LIFECYCLE_METHODS))
      for (const json of [
        {},
        { location: { workerId: DEFAULT_WORKER_ID } },
        { location: { workerId: DEFAULT_WORKER_ID, path: "" } },
      ]) {
        const error = await refusal(ask(method, json));
        assert.equal(error.code, INVALID_PARAMS, method);
      }
    const error = await refusal(
      ask(LIFECYCLE_METHODS.removeTree, { location: here(tree), stage: "all" }),
    );
    assert.equal(error.code, INVALID_PARAMS);
    assertNoEffect();
  });
});

test("mkdir and removeAll resolve a relative path against the Worker's cwd", async () => {
  const target = join(dir, "relative", "a", "b");
  const rel = relative(process.cwd(), target);
  assert.ok(!rel.startsWith("/"));
  assert.deepEqual(
    (await ask(LIFECYCLE_METHODS.mkdir, { location: here(rel) })).json,
    {},
  );
  assert.ok(statSync(target).isDirectory());
  assert.deepEqual(
    (await ask(LIFECYCLE_METHODS.removeAll, { location: here(rel) })).json,
    {},
  );
  assert.equal(existsSync(target), false);
  assert.ok(existsSync(join(dir, "relative", "a")));
});

test("mkdir answers the failure native mkdirSync throws, code and message", async () => {
  const file = join(dir, "a-file");
  writeFileSync(file, "x");
  let native: NodeJS.ErrnoException | undefined;
  try {
    mkdirSync(join(file, "below"), { recursive: true });
  } catch (error) {
    native = error as NodeJS.ErrnoException;
  }
  assert.ok(native);
  const answer = await ask(LIFECYCLE_METHODS.mkdir, {
    location: here(join(file, "below")),
  });
  assert.deepEqual(answer.json, { error: { code: native.code } });
  assert.deepEqual(answer.text, { message: native.message });
});

describe("createDir creates exclusively", () => {
  const create = async (path: string) =>
    decodeCreateDirResult(
      await ask(LIFECYCLE_METHODS.createDir, { location: here(path) }),
    );

  test("a new path is created with its leading directories", async () => {
    const target = join(dir, "create", "lead", "new");
    assert.equal(await create(target), "created");
    assert.ok(statSync(target).isDirectory());
    assert.deepEqual(readdirSync(target), []);
  });

  test("any entry already there answers exists and is left untouched", async () => {
    const at = join(dir, "create-taken");
    const directory = fixtureTree("create-taken-dir");
    const file = join(at, "file");
    const dangling = join(at, "dangling");
    mkdirSync(at, { recursive: true });
    writeFileSync(file, "mine\n");
    symlinkSync(join(at, "nowhere"), dangling);
    for (const path of [directory, file, dangling])
      assert.equal(await create(path), "exists", path);
    assert.equal(
      readFileSync(join(directory, "sub", "kept.txt"), "utf8"),
      "kept\n",
    );
    assert.equal(readFileSync(file, "utf8"), "mine\n");
    assert.ok(lstatSync(dangling).isSymbolicLink());
    assert.equal(existsSync(join(at, "nowhere")), false);
  });

  test("a leading path that is a file is a failure, never exists", async () => {
    const file = join(dir, "create-lead-file");
    writeFileSync(file, "x");
    for (const target of [join(file, "below"), join(file, "a", "below")]) {
      let native: NodeJS.ErrnoException | undefined;
      try {
        mkdirSync(join(target, ".."), { recursive: true });
      } catch (error) {
        native = error as NodeJS.ErrnoException;
      }
      assert.ok(native, target);
      const answer = await ask(LIFECYCLE_METHODS.createDir, {
        location: here(target),
      });
      assert.deepEqual(answer.json, { error: { code: native.code } }, target);
      assert.deepEqual(answer.text, { message: native.message });
    }
    assert.equal(readFileSync(file, "utf8"), "x");
  });

  test("a relative path resolves against the Worker's cwd", async () => {
    const target = join(dir, "create-relative", "a");
    const rel = relative(process.cwd(), target);
    assert.ok(!rel.startsWith("/"));
    assert.equal(await create(rel), "created");
    assert.ok(statSync(target).isDirectory());
    assert.equal(await create(rel), "exists");
  });
});

test("scanResidue answers the scan the Worker's own uid makes", async () => {
  const tree = fixtureTree("scanned");
  const scan = decodeResidueScan(
    await ask(LIFECYCLE_METHODS.scanResidue, { location: here(tree) }),
  );
  assert.deepEqual(scan, scanTreeResidue(tree));
});

test("stopProcesses stops a grandchild in the checkout, not one beside it", async () => {
  const checkout = fixtureTree("running");
  const sibling = fixtureTree("running-sibling");
  const inside = await grandchildIn(join(checkout, "sub"));
  const beside = await grandchildIn(sibling);
  try {
    const stop = decodeProcessStop(
      await ask(LIFECYCLE_METHODS.stopProcesses, { location: here(checkout) }),
    );
    assert.deepEqual(stop, { terminated: [inside.pid], killed: [] });
    assert.ok(alive(beside.pid));
  } finally {
    for (const pid of [inside.pid, beside.pid, beside.shell.pid!])
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone already.
      }
  }
});

/** Every entry under `root`, relative, with its kind; empty when it is gone. */
function entries(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const pending = [""];
  while (pending.length > 0) {
    const at = pending.pop()!;
    let names: string[];
    try {
      names = readdirSync(join(root, at));
    } catch {
      found.push(`${at}/?`);
      continue;
    }
    for (const name of names) {
      const rel = join(at, name);
      const stat = lstatSync(join(root, rel));
      found.push(
        `${rel}:${stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "dir" : "file"}`,
      );
      if (stat.isDirectory()) pending.push(rel);
    }
  }
  return found.sort();
}

describe("the initial stage is base removeManagedTree", () => {
  const fixtures: Record<string, (root: string, outside: string) => void> = {
    plain: () => {},
    "owner-locked": (root) => {
      const locked = join(root, "locked");
      mkdirSync(locked);
      writeFileSync(join(locked, "out.png"), "x");
      chmodSync(locked, 0o500);
      const closed = join(root, "closed");
      mkdirSync(closed);
      writeFileSync(join(closed, "secret"), "y");
      chmodSync(closed, 0o000);
    },
    "link out": (root, outside) => {
      symlinkSync(outside, join(root, "out-link"));
    },
  };

  for (const [name, build] of Object.entries(fixtures))
    test(name, async () => {
      const sides = ["base", "worker"].map((side) => {
        const outside = join(dir, `outside-${name}-${side}`);
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, "precious"), "precious\n");
        chmodSync(join(outside, "precious"), 0o640);
        const root = fixtureTree(`stage-${name}-${side}`);
        build(root, outside);
        return { root, outside };
      });
      const [base, worker] = sides as [
        (typeof sides)[number],
        (typeof sides)[number],
      ];
      const baseResult = await removeManagedTree(base.root);
      const workerResult = decodeRemoveTreeResult(
        await ask(LIFECYCLE_METHODS.removeTree, {
          location: here(worker.root),
          stage: "initial",
        }),
      );
      assert.deepEqual(workerResult, baseResult);
      assert.deepEqual(entries(worker.root), entries(base.root));
      for (const side of sides) {
        assert.equal(
          readFileSync(join(side.outside, "precious"), "utf8"),
          "precious\n",
        );
        assert.equal(
          statSync(join(side.outside, "precious")).mode & 0o777,
          0o640,
        );
      }
    });
});

test("discardTree removes a tree and answers nothing, then nothing again", async () => {
  const tree = fixtureTree("discarded");
  const locked = join(tree, "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "f"), "x");
  chmodSync(locked, 0o500);
  const first = decodeDiscardTreeResult(
    await ask(LIFECYCLE_METHODS.discardTree, { location: here(tree) }),
  );
  if (first.failed !== undefined) {
    // Non-root: EACCES is not retried by `maxRetries`; the repair made the
    // next attempt possible, as base's settle loop relies on.
    assert.match(first.failed, /EACCES|EPERM/);
    assert.equal(statSync(locked).mode & 0o777, 0o700);
  }
  assert.deepEqual(
    decodeDiscardTreeResult(
      await ask(LIFECYCLE_METHODS.discardTree, { location: here(tree) }),
    ),
    {},
  );
  assert.equal(existsSync(tree), false);
});
