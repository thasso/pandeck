/**
 * The Worker boundary ratchet (`docs/workers.md`).
 *
 * `worker/` is the Worker's side: in phase 2 it runs in a process of its own,
 * so it reaches no server state, and only the in-process Worker starts it.
 * Checkout git runs only through the checkout family (`gitExec.ts`), whose
 * runner crosses the Worker protocol; the server's own repositories use the
 * local family (`serverRepoGit.ts`), and only the modules named below may.
 *
 * The checkout filesystem inventory pins every module that still reads a
 * checkout on the server's own filesystem, with the slice that moves the read
 * behind the Worker. Every list is exact: a new entry fails, and so does an
 * entry the code no longer needs, so the lists only shrink. W6 is done when
 * both inventories are empty.
 *
 * Scope: every non-test `.ts` module under `app/server/src`. Imports are read
 * from a parsed syntax tree (oxc), so comments and strings never count.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { test } from "vitest";

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

/** The modules of the server's own repositories (B6). */
const SERVER_REPO_GIT_USERS = [
  "knowledgeBaseStore.ts",
  "library/libraryStore.ts",
  "promptBudgets.ts",
  "worktrees/knowledgeCheckout.ts",
];

/** What `worker/` may import besides itself and `workerProtocol/`. */
const WORKER_ALLOWED = new Set([
  "errors.ts",
  "gitProcess.ts",
  "spawnBroker.ts",
  "subprocessEnv.ts",
]);

/**
 * The modules that run code from `gitProcess.ts`, besides `worker/`: the two
 * families' runners. `gitFamily.ts` takes only the runner's type.
 */
const GIT_PROCESS_USERS = ["gitExec.ts", "serverRepoGit.ts"];

/**
 * Modules that load something by a path the scan cannot read: pi's installed
 * prompt builder, never app code (`harnessBoundary.test.ts` pins it too, with
 * the `require` loads this scan leaves to it).
 */
const COMPUTED_IMPORTS: Record<string, number> = {
  "piSdk/piPromptMeasure.ts": 1,
};

/**
 * Every module that starts a `git` process, with how many places it does.
 * `buildInfo.ts` reads the app's own source tree once at boot, synchronously,
 * before any Worker exists; it is not a checkout.
 */
const GIT_SPAWNS: Record<string, number> = {
  "gitProcess.ts": 3,
  "buildInfo.ts": 1,
};

/**
 * Modules that import the checkout family AND `node:fs`: they read checkouts
 * directly. Each names the slice that moves those reads behind the Worker.
 */
const CHECKOUT_FS_INVENTORY: Record<string, string> = {
  "commitWorkflow.ts": "W3",
  "workflow/operationTriage.ts": "W3",
  "workflow/rebaseRepair.ts": "W3",
  "worktrees/worktreeComments.ts": "W3",
  "worktrees/worktreeDiff.ts": "W3",
  "worktrees/worktreeResolve.ts": "W3",
  "worktrees/worktreeStatus.ts": "W3",
  // W3 classifies these reads.
  "worktrees/worktreeFetch.ts": "W3",
  "worktrees/worktreeMerge.ts": "W3",
  "worktrees/worktreeSync.ts": "W3",
  "worktrees/worktreeWatcher.ts": "W4",
  "projectProvision.ts": "W5",
  "tools/core/projectCreateTool.ts": "W5",
  "worktrees/worktrees.ts": "W5",
};

/**
 * Checkout readers outside the family, named by the plan: each still imports
 * `node:fs` until its slice lands.
 */
const NAMED_CHECKOUT_READERS: Record<string, string> = {
  "directFileGrants.ts": "W2",
  "directFileHttp.ts": "W2",
  "tools/core/showFilesTool.ts": "W2",
  // `repoLockKey`'s directory identity, for both families.
  "gitFamily.ts": "W3",
  "worktrees/sessionCwd.ts": "W3",
  "worktrees/checkoutProcesses.ts": "W5",
  "worktrees/idleWorktrees.ts": "W5",
};

const CHILD_PROCESS_STARTERS = new Set([
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "spawn",
  "spawnSync",
]);

type AstNode = { type: string; [key: string]: unknown };

function isNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function constantString(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  if (value.type === "Literal")
    return typeof value.value === "string" ? value.value : undefined;
  if (
    value.type === "TemplateLiteral" &&
    Array.isArray(value.expressions) &&
    value.expressions.length === 0
  ) {
    const cooked = (value.quasis as { value?: { cooked?: unknown } }[])[0]
      ?.value?.cooked;
    return typeof cooked === "string" ? cooked : undefined;
  }
  return undefined;
}

function calleeName(callee: unknown): string | undefined {
  if (!isNode(callee)) return undefined;
  if (callee.type === "Identifier") return callee.name as string;
  if (callee.type === "MemberExpression" && isNode(callee.property))
    return callee.property.name as string | undefined;
  return undefined;
}

interface ModuleScan {
  /** Every module imported, as a path under `src/` or a bare specifier. */
  imports: Set<string>;
  /** The imports that can run code: not erased as type-only. */
  valueImports: Set<string>;
  /** Imports whose path the scan cannot read. */
  computedImports: number;
  gitSpawns: number;
}

function scanModule(file: string): ModuleScan {
  const source = readFileSync(file, "utf8");
  const parsed = parseSync(file, source, { lang: "ts", sourceType: "module" });
  assert.deepEqual(
    parsed.errors.map((error) => error.message),
    [],
    `${relative(SRC_ROOT, file)} must parse for the boundary scan`,
  );
  const scan: ModuleScan = {
    imports: new Set(),
    valueImports: new Set(),
    computedImports: 0,
    gitSpawns: 0,
  };
  const add = (value: unknown, typeOnly: boolean): void => {
    const specifier = constantString(value);
    if (specifier === undefined) {
      if (value != null) scan.computedImports++;
      return;
    }
    const target = specifier.startsWith(".")
      ? relative(SRC_ROOT, resolve(dirname(file), specifier)).replace(
          /\.js$/,
          ".ts",
        )
      : specifier;
    scan.imports.add(target);
    if (!typeOnly) scan.valueImports.add(target);
  };
  const isTypeOnly = (node: AstNode, kind: string): boolean =>
    node[kind] === "type" ||
    (Array.isArray(node.specifiers) &&
      node.specifiers.length > 0 &&
      (node.specifiers as AstNode[]).every(
        (specifier) => specifier[kind] === "type",
      ));

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isNode(value)) return;
    switch (value.type) {
      case "ImportDeclaration":
        add(value.source, isTypeOnly(value, "importKind"));
        break;
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (value.source != null)
          add(value.source, isTypeOnly(value, "exportKind"));
        break;
      case "ImportExpression":
        add(value.source, false);
        break;
      case "CallExpression":
      case "NewExpression": {
        const name = calleeName(value.callee);
        const first = (value.arguments as unknown[])[0];
        const command = constantString(first);
        if (
          name &&
          CHILD_PROCESS_STARTERS.has(name) &&
          (command === "git" || command?.startsWith("git "))
        )
          scan.gitSpawns++;
        break;
      }
      case "Property": {
        const key = isNode(value.key)
          ? (value.key.name ?? value.key.value)
          : undefined;
        if (key === "file" && constantString(value.value) === "git")
          scan.gitSpawns++;
        break;
      }
    }
    for (const [key, child] of Object.entries(value))
      if (key !== "type") visit(child);
  };
  visit(parsed.program);
  return scan;
}

function sourceModules(dir = SRC_ROOT): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") files.push(...sourceModules(path));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    )
      files.push(path);
  }
  return files;
}

const scans = new Map(
  sourceModules().map((file) => [relative(SRC_ROOT, file), scanModule(file)]),
);

function importersOf(
  matches: (target: string) => boolean,
  which: "imports" | "valueImports" = "imports",
): string[] {
  return [...scans]
    .filter(([, scan]) => [...scan[which]].some(matches))
    .map(([module]) => module)
    .sort();
}

const isFs = (target: string): boolean =>
  ["node:fs", "node:fs/promises", "fs", "fs/promises"].includes(target);

test("the scan sees every import it judges", () => {
  assert.ok(scans.size > 100, "the scan found the server modules");
  assert.ok(scans.has("gitExec.ts") && scans.has("worker/worker.ts"));
  assert.deepEqual(
    Object.fromEntries(
      [...scans]
        .filter(([, scan]) => scan.computedImports > 0)
        .map(([module, scan]) => [module, scan.computedImports]),
    ),
    COMPUTED_IMPORTS,
    "an import by computed path could cross the boundary unseen",
  );
});

test("only the in-process Worker starts the Worker side", () => {
  assert.deepEqual(
    importersOf((target) => target.startsWith("worker/")).filter(
      (module) => !module.startsWith("worker/"),
    ),
    ["workers/inProcessWorker.ts"],
  );
});

test("the Worker side reaches no server state", () => {
  for (const [module, scan] of scans) {
    if (!module.startsWith("worker/")) continue;
    for (const target of scan.imports)
      assert.ok(
        target.startsWith("node:") ||
          target.startsWith("worker/") ||
          target.startsWith("workerProtocol/") ||
          WORKER_ALLOWED.has(target),
        `${module} imports ${target}`,
      );
  }
});

test("only the executor families and the Worker run git processes", () => {
  assert.deepEqual(
    importersOf((target) => target === "gitProcess.ts", "valueImports").filter(
      (module) => !module.startsWith("worker/"),
    ),
    GIT_PROCESS_USERS,
  );
  assert.deepEqual(
    importersOf((target) => target === "serverRepoGit.ts"),
    SERVER_REPO_GIT_USERS,
  );
  // The family's shared state is reached only through a family.
  assert.deepEqual(
    importersOf((target) => target === "gitFamily.ts", "valueImports"),
    ["gitExec.ts", "serverRepoGit.ts"],
  );
  assert.deepEqual(
    Object.fromEntries(
      [...scans]
        .filter(([, scan]) => scan.gitSpawns > 0)
        .map(([module, scan]) => [module, scan.gitSpawns]),
    ),
    GIT_SPAWNS,
  );
});

test("every module reading checkouts on the server is pinned to its slice", () => {
  const checkoutFamilyUsers = importersOf((target) => target === "gitExec.ts");
  assert.deepEqual(
    checkoutFamilyUsers.filter((module) =>
      [...scans.get(module)!.imports].some(isFs),
    ),
    Object.keys(CHECKOUT_FS_INVENTORY).sort(),
  );
  for (const module of Object.keys(NAMED_CHECKOUT_READERS)) {
    const scan = scans.get(module);
    assert.ok(scan, `${module} is gone: delete its pin`);
    assert.ok(
      [...scan.imports].some(isFs),
      `${module} no longer reads the filesystem: delete its pin`,
    );
  }
});
