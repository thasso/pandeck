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
 * from a parsed syntax tree (oxc), so comments and strings never count. A
 * CommonJS load — `require(…)`, or a function made by `createRequire(…)` —
 * counts as an import like any other.
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

/**
 * What `worker/` may import besides itself and `workerProtocol/`.
 * `parcelWatcher.ts` loads the native watcher; it imports only
 * `runtimeAssets.ts`, which reads the environment and asset paths, not server
 * state. `managedTreeRemoval.ts` is the removal ladder the lifecycle methods
 * run; it imports only `node:` modules.
 */
const WORKER_ALLOWED = new Set([
  "errors.ts",
  "fileReads.ts",
  "gitProcess.ts",
  "managedTreeRemoval.ts",
  "parcelWatcher.ts",
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
 * prompt builder (`harnessBoundary.test.ts` pins it too) and the file watcher's
 * native addon, by package path. Neither is app code.
 */
const COMPUTED_IMPORTS: Record<string, number> = {
  "piSdk/piPromptMeasure.ts": 1,
  "parcelWatcher.ts": 3,
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
 * Modules that import the checkout family AND `node:fs`: they would read
 * checkouts directly. Empty since W5 moved the checkout lifecycle behind the
 * Worker; a new entry names the slice that moves its reads there.
 */
const CHECKOUT_FS_INVENTORY: Record<string, string> = {};

/**
 * Checkout readers outside the family that still import `node:fs`, each with
 * the slice that moves it. Empty since W5; a new entry needs a plan naming it.
 */
const NAMED_CHECKOUT_READERS: Record<string, string> = {};

/**
 * Modules that read checkouts only through the checkout-file access
 * (`checkoutFileAccess.ts`, itself included): none imports `node:fs`.
 * `gitFamily.ts` reads through what its family is given.
 */
const MIGRATED_CHECKOUT_READERS = [
  "checkoutFileAccess.ts",
  "checkoutLifecycle.ts",
  "commitWorkflow.ts",
  "connection.ts",
  "containerResidue.ts",
  "gitFamily.ts",
  "projectProvision.ts",
  "sessionSpawn.ts",
  "tools/core/projectCreateTool.ts",
  "workflow/operationTriage.ts",
  "workflow/rebaseRepair.ts",
  "worktrees/checkoutPresence.ts",
  "worktrees/idleWorktrees.ts",
  "worktrees/sessionCwd.ts",
  "worktrees/worktreeComments.ts",
  "worktrees/worktreeDiff.ts",
  "worktrees/worktreeFetch.ts",
  "worktrees/worktreeMerge.ts",
  "worktrees/worktreeResolve.ts",
  "worktrees/worktreeStatus.ts",
  "worktrees/worktreeSync.ts",
  "worktrees/worktreeWatcher.ts",
  "worktrees/worktrees.ts",
];

/**
 * Server-written files a Worker's git reads, each with the slice that must
 * settle where it is written. Each imports `node:fs` and nothing of the
 * checkout family, and only its one caller imports it.
 */
const SERVER_WRITTEN_GIT_INPUTS: Record<
  string,
  { settledBy: string; importers: string[] }
> = {
  "commitMessageFile.ts": {
    settledBy: "phase 3 (Task-1154)",
    importers: ["commitWorkflow.ts"],
  },
};

const isCheckoutFamily = (target: string): boolean =>
  [
    "gitExec.ts",
    "gitFamily.ts",
    "checkoutFileAccess.ts",
    "fileReads.ts",
  ].includes(target) || target.startsWith("workers/");

/**
 * The served-file modules (W2): every read they make goes through
 * `servedFileAccess.ts`, which picks the Worker or the server for it.
 */
const SERVED_FILE_MODULES = [
  "directFileGrants.ts",
  "directFileHttp.ts",
  "documentGrantTargets.ts",
  "tools/core/showFilesTool.ts",
];

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

/** Visits every syntax node under `value`. */
function walk(value: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!isNode(value)) return;
  visit(value);
  for (const [key, child] of Object.entries(value))
    if (key !== "type") walk(child, visit);
}

/** Ordinary imported createRequire bindings, direct calls and bound loaders. */
function commonJsLoader(program: unknown): (callee: unknown) => boolean {
  const factories = new Set<string>();
  const modules = new Set<string>();
  walk(program, (node) => {
    if (
      node.type !== "ImportDeclaration" ||
      node.importKind === "type" ||
      !["module", "node:module"].includes(constantString(node.source) ?? "")
    )
      return;
    for (const specifier of node.specifiers as AstNode[]) {
      if (!isNode(specifier.local) || specifier.importKind === "type") continue;
      const local = specifier.local.name as string;
      if (specifier.type === "ImportSpecifier") {
        const imported = specifier.imported;
        if (
          isNode(imported) &&
          (imported.name ?? imported.value) === "createRequire"
        )
          factories.add(local);
      } else modules.add(local);
    }
  });
  const isFactory = (callee: unknown): boolean => {
    if (!isNode(callee)) return false;
    if (callee.type === "Identifier")
      return factories.has(callee.name as string);
    if (
      callee.type !== "MemberExpression" ||
      !isNode(callee.object) ||
      callee.object.type !== "Identifier" ||
      !modules.has(callee.object.name as string)
    )
      return false;
    return (
      (callee.computed
        ? constantString(callee.property)
        : calleeName(callee)) === "createRequire"
    );
  };
  const names = new Set(["require"]);
  walk(program, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      isNode(node.id) &&
      node.id.type === "Identifier" &&
      isNode(node.init) &&
      node.init.type === "CallExpression" &&
      isFactory(node.init.callee)
    )
      names.add(node.id.name as string);
  });
  return (callee) =>
    isNode(callee) &&
    ((callee.type === "Identifier" && names.has(callee.name as string)) ||
      (callee.type === "CallExpression" && isFactory(callee.callee)));
}

function scanModule(file: string): ModuleScan {
  return scanSource(file, readFileSync(file, "utf8"));
}

/** Scans `source` as if it were the module at `file`. */
function scanSource(file: string, source: string): ModuleScan {
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
  const isLoad = commonJsLoader(parsed.program);

  // `verbatimModuleSyntax` erases only a type-only declaration: an
  // `import { type X }` still runs its module, as `import {}`.
  walk(parsed.program, (value) => {
    switch (value.type) {
      case "ImportDeclaration":
        add(value.source, value.importKind === "type");
        break;
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
        if (value.source != null)
          add(value.source, value.exportKind === "type");
        break;
      case "ImportExpression":
        add(value.source, false);
        break;
      case "CallExpression":
      case "NewExpression": {
        const name = calleeName(value.callee);
        const first = (value.arguments as unknown[])[0];
        if (value.type === "CallExpression" && isLoad(value.callee))
          add(first ?? null, false);
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
  });
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

test("served files read only through the served-file access", () => {
  for (const module of SERVED_FILE_MODULES)
    assert.ok(
      ![...scans.get(module)!.imports].some(isFs),
      `${module} reads the filesystem itself`,
    );
  // The file primitives run on the server only for the server's own data and
  // repositories, and the Worker's file methods are reached only through the
  // served-file and checkout-file accesses.
  assert.deepEqual(
    importersOf((target) => target === "fileReads.ts", "valueImports").filter(
      (module) => !module.startsWith("worker/"),
    ),
    ["checkoutFileAccess.ts", "servedFileAccess.ts", "serverRepoGit.ts"],
  );
  assert.deepEqual(
    importersOf((target) => target === "workers/fileClient.ts"),
    [
      "checkoutFileAccess.ts",
      "servedFileAccess.ts",
      "workers/lifecycleClient.ts",
      "workers/watchClient.ts",
    ],
  );
});

test("the removal ladder runs only on the Worker and for agent temp trees", () => {
  // Every other user takes only its types (`import type`).
  assert.deepEqual(
    importersOf((target) => target === "managedTreeRemoval.ts", "valueImports"),
    ["agentTempTree.ts", "worker/lifecycle.ts"],
  );
});

test("native watches are made only through the checkout-watch access", () => {
  // The server side's (the KB row) and the Worker's, each by side.
  assert.deepEqual(
    importersOf((target) => target === "parcelWatcher.ts"),
    ["checkoutWatchAccess.ts", "worker/watch.ts"],
  );
  assert.deepEqual(
    importersOf((target) => target === "workers/watchClient.ts"),
    ["checkoutWatchAccess.ts"],
  );
  assert.deepEqual(
    importersOf((target) => target === "workers/watchDeliveries.ts"),
    ["workers/inProcessWorker.ts", "workers/watchClient.ts"],
  );
});

test("migrated checkout readers read only through the checkout-file access", () => {
  for (const module of MIGRATED_CHECKOUT_READERS) {
    const scan = scans.get(module);
    assert.ok(scan, `${module} is gone: delete it from the list`);
    assert.ok(
      ![...scan.imports].some(isFs),
      `${module} reads the filesystem itself`,
    );
  }
});

test("server-written files a Worker's git reads are pinned to phase 3", () => {
  for (const [module, { importers }] of Object.entries(
    SERVER_WRITTEN_GIT_INPUTS,
  )) {
    const scan = scans.get(module);
    assert.ok(scan, `${module} is gone: delete it from the list`);
    assert.ok(
      [...scan.imports].some(isFs),
      `${module} no longer writes the file itself: delete it from the list`,
    );
    assert.deepEqual(
      [...scan.imports].filter(isCheckoutFamily),
      [],
      `${module} reaches the checkout family`,
    );
    assert.deepEqual(
      importersOf((target) => target === module),
      importers,
    );
  }
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

test("ordinary createRequire aliases count in both directions, bound and direct", () => {
  const factories = [
    [
      'import { createRequire as makeRequire } from "node:module";',
      "makeRequire",
    ],
    ['import { createRequire } from "module";', "createRequire"],
    ['import * as mod from "node:module";', "mod.createRequire"],
    ['import * as mod from "module";', 'mod["createRequire"]'],
    ['import mod from "node:module";', 'mod["createRequire"]'],
    ['import mod from "module";', "mod.createRequire"],
  ] as const;
  for (const [declaration, factory] of factories) {
    for (const [file, specifier, target] of [
      [
        "worker/loadsServerState.ts",
        "../db/sessionStore.ts",
        "db/sessionStore.ts",
      ],
      ["startsWorker.ts", "./worker/worker.ts", "worker/worker.ts"],
    ] as const) {
      for (const call of [
        `const load = ${factory}(import.meta.url); load(${JSON.stringify(specifier)});`,
        `${factory}(import.meta.url)(${JSON.stringify(specifier)});`,
      ]) {
        const scan = scanSource(
          join(SRC_ROOT, file),
          `${declaration}\n${call}`,
        );
        assert.ok(scan.imports.has(target), `${factory}: ${call}`);
        assert.ok(scan.valueImports.has(target));
        assert.equal(scan.computedImports, 0);
      }
      const computed = scanSource(
        join(SRC_ROOT, file),
        `${declaration}\nconst load = ${factory}(import.meta.url); load(path);`,
      );
      assert.equal(computed.computedImports, 1, factory);
    }
  }
  const method = scanSource(
    join(SRC_ROOT, "ordinaryMethods.ts"),
    `
    const service = { createRequire: () => (id: string) => id, require: (id: string) => id };
    const load = service.createRequire();
    load("./worker/worker.ts");
    service.createRequire()("./worker/worker.ts");
    service.require("./worker/worker.ts");
  `,
  );
  assert.equal(method.imports.size, 0);
});

test("literal CommonJS loads count as imports, into and out of the Worker side", () => {
  const fromWorker = scanSource(
    join(SRC_ROOT, "worker/loadsServerState.ts"),
    [
      'import { createRequire } from "node:module";',
      "const load = createRequire(import.meta.url);",
      'load("../db/sessionStore.ts");',
      'createRequire(import.meta.url)("../index.ts");',
    ].join("\n"),
  );
  for (const target of ["db/sessionStore.ts", "index.ts"]) {
    assert.ok(fromWorker.imports.has(target), target);
    assert.ok(fromWorker.valueImports.has(target), target);
  }
  assert.equal(fromWorker.computedImports, 0);

  const intoWorker = scanSource(
    join(SRC_ROOT, "startsWorker.ts"),
    'require("./worker/worker.ts");',
  );
  assert.ok(intoWorker.valueImports.has("worker/worker.ts"));

  // A method that happens to be called `require` loads nothing.
  const method = scanSource(
    join(SRC_ROOT, "method.ts"),
    'export const session = { require: (id: string) => id }.require("worker/worker.ts");',
  );
  assert.equal(method.imports.size, 0);
});

/* ------------------------- the side-bound ratchet (§5) ------------------------ */

/**
 * Every module that can hold the Knowledge Base row and does checkout work with
 * it. Each must run that work on the row's own side, so its value imports are
 * closed: a KB row leaves these modules only through the side-bound allowance,
 * another member, or a reviewed external symbol pinned to its declaration.
 */
const SIDE_BOUND_MODULES = [
  "documentGrantTargets.ts",
  "worktrees/worktreeDiff.ts",
  "worktrees/worktreeFetch.ts",
  "worktrees/worktreeRemote.ts",
  "worktrees/worktreeStatus.ts",
  "worktrees/worktreeWatcher.ts",
  "worktrees/worktreeWrite.ts",
];

/**
 * What a side-bound module may never import: the default Worker's string API
 * (by symbol) and every executor or primitive below the families (`"*"`).
 */
const SIDE_BOUND_FORBIDDEN: Record<string, readonly string[] | "*"> = {
  "gitExec.ts": [
    "git",
    "gitBoundedStdout",
    "gitWithInputOptional",
    "gitRawStdout",
    "gitOptional",
    "gitReadOnlyOptional",
    "gitOptionalExit",
    "gitReadOnlyOptionalExit",
    "resolveRepoRoot",
    "repoLockKey",
  ],
  "checkoutFileAccess.ts": [
    "checkoutPathExists",
    "inspectCheckoutPath",
    "readCheckoutLink",
    "readCheckoutDir",
    "realpathInCheckout",
    "containedRealPath",
    "readCheckoutFile",
  ],
  "workers/placement.ts": ["DEFAULT_WORKER_ID", "DEFAULT_WORKER_SIDE"],
  "gitProcess.ts": "*",
  "fileReads.ts": "*",
  "workers/fileClient.ts": "*",
  "workers/checkoutClient.ts": "*",
  "serverRepoGit.ts": "*",
  "parcelWatcher.ts": "*",
  "workers/watchClient.ts": "*",
  "workers/watchDeliveries.ts": "*",
};

/** The side-bound and pure allowance: every symbol, or the listed ones. */
const SIDE_BOUND_ALLOWED: Record<string, readonly string[] | "*"> = {
  "gitExec.ts": ["checkoutGitOn", "withRepoLock", "GitCommandError"],
  "checkoutFileAccess.ts": [
    "checkoutFilesOn",
    "checkLexicalPath",
    "checkoutFailureOf",
    "CheckoutPathVerdict",
  ],
  "checkoutWatchAccess.ts": ["checkoutWatchOn"],
  "worktrees/knowledgeCheckout.ts": [
    "checkoutSideOf",
    "resolveReadableWorktreeRow",
  ],
  "@assistant/shared": "*",
  "node:path": "*",
  "node:url": "*",
};

type ExternalKind = "function" | "typed-const" | "scalar";

interface ExternalImport {
  importer: string;
  module: string;
  symbol: string;
  kind: ExternalKind;
  /**
   * `function`: the parameters and return type; `typed-const`: the annotation;
   * `scalar`: the whole statement. Whitespace-normalized.
   */
  pin: string;
}

/**
 * Every other value import of a side-bound module, pinned to its declaration
 * so that a KB row it is handed cannot reach a Worker unseen. The `server-fs`
 * primitives run only on the server's own filesystem, so they cannot drop the
 * KB row's server side; for other rows they are W4's pinned checkout debt.
 */
const SIDE_BOUND_EXTERNAL_IMPORTS: ExternalImport[] = [
  {
    importer: "worktrees/worktreeFetch.ts",
    module: "settings.ts",
    symbol: "getSettings",
    kind: "function",
    pin: "(publicBaseUrl?: string): AppSettings",
  },
  {
    importer: "worktrees/worktreeFetch.ts",
    module: "config.ts",
    symbol: "BACKGROUND_FETCH_ENABLED",
    kind: "scalar",
    pin: 'export const BACKGROUND_FETCH_ENABLED = process.env.ASSISTANT_BACKGROUND_FETCH === "1";',
  },
  {
    importer: "documentGrantTargets.ts",
    module: "config.ts",
    symbol: "DATA_DIR",
    kind: "scalar",
    pin: "export const DATA_DIR = resolvePath(process.env.DATA_DIR ?? file.dataDir ?? DEFAULTS.dataDir);",
  },
  {
    importer: "documentGrantTargets.ts",
    module: "servedFileAccess.ts",
    symbol: "servedSideOf",
    kind: "function",
    pin: "(path: string): ServedSide",
  },
  {
    importer: "documentGrantTargets.ts",
    module: "servedFileAccess.ts",
    symbol: "realpathServedFileOn",
    kind: "function",
    pin: "(path: string, side: ServedSide): Promise<string>",
  },
  {
    importer: "documentGrantTargets.ts",
    module: "directFileGrants.ts",
    symbol: "mintDocumentGrantOn",
    kind: "function",
    pin: "(filePath: string, scope: FileGrantScope, delivery: FileGrantDeliveryMode, authority: { root: string; sourceKey: string; fresh?: boolean; side: ServedSide; }): Promise<MintedDocument>",
  },
  {
    importer: "worktrees/worktreeWatcher.ts",
    module: "db/worktreeStore.ts",
    symbol: "listWorktrees",
    kind: "function",
    pin: "(filter: { projectId?: string; includeRemoved?: boolean } = {}): WorktreeRow[]",
  },
  {
    importer: "worktrees/worktreeWatcher.ts",
    module: "db/worktreeStore.ts",
    symbol: "worktreeIdBySession",
    kind: "typed-const",
    pin: "() => ReadonlyMap<string, string>",
  },
  {
    importer: "worktrees/worktreeWatcher.ts",
    module: "worktrees/worktreeResolve.ts",
    symbol: "canonicalWorktreeId",
    kind: "function",
    pin: "(id: string): string",
  },
  {
    importer: "worktrees/worktreeWatcher.ts",
    module: "worktrees/worktreeResolve.ts",
    symbol: "worktreeExistsSync",
    kind: "function",
    pin: "(id: string): boolean",
  },
  {
    importer: "worktrees/worktreeWatcher.ts",
    module: "worktrees/worktreeEvents.ts",
    symbol: "worktreeBroadcaster",
    kind: "function",
    pin: "(): WorktreeBroadcaster",
  },
];

/** The modules that may hand out the KB row: the gate and three side-bound. */
const KB_ROW_PRODUCERS = [
  "documentGrantTargets.ts",
  "worktrees/worktreeHttp.ts",
  "worktrees/worktreeStatus.ts",
  "worktrees/worktreeWatcher.ts",
];

/**
 * One value binding a module takes from (or re-exports out of) another, or a
 * `side-effect` import or re-export that binds nothing but still runs it.
 */
interface SymbolImport {
  module: string;
  /**
   * `default`, `*` for a namespace, a load or `export *`, the imported name,
   * or empty for a `side-effect` edge.
   */
  symbol: string;
  form: "import" | "re-export" | "side-effect" | "dynamic" | "require";
}

function parseModule(file: string, source: string): AstNode {
  const parsed = parseSync(file, source, { lang: "ts", sourceType: "module" });
  assert.deepEqual(
    parsed.errors.map((error) => error.message),
    [],
    `${file} must parse for the side-bound scan`,
  );
  return parsed.program as unknown as AstNode;
}

/** The module `source` names from `file`, as `scanSource` resolves it. */
function moduleTarget(file: string, source: unknown): string {
  const specifier = constantString(source);
  if (specifier === undefined) return "<computed>";
  return specifier.startsWith(".")
    ? relative(
        SRC_ROOT,
        resolve(dirname(join(SRC_ROOT, file)), specifier),
      ).replace(/\.js$/, ".ts")
    : specifier;
}

const nameOf = (node: unknown): string =>
  isNode(node) ? String(node.name ?? node.value) : "";

/** Every value binding `source` (the module at `file`) imports or re-exports. */
function symbolImports(file: string, source: string): SymbolImport[] {
  const program = parseModule(file, source);
  const found: SymbolImport[] = [];
  const isLoad = commonJsLoader(program);
  walk(program, (node) => {
    switch (node.type) {
      case "ImportDeclaration": {
        if (node.importKind === "type") return;
        const module = moduleTarget(file, node.source);
        const values = (node.specifiers as AstNode[]).filter(
          (specifier) => specifier.importKind !== "type",
        );
        for (const specifier of values) {
          const symbol =
            specifier.type === "ImportDefaultSpecifier"
              ? "default"
              : specifier.type === "ImportNamespaceSpecifier"
                ? "*"
                : nameOf(specifier.imported);
          found.push({ module, symbol, form: "import" });
        }
        if (values.length === 0)
          found.push({ module, symbol: "", form: "side-effect" });
        return;
      }
      case "ExportNamedDeclaration": {
        if (node.source == null || node.exportKind === "type") return;
        const module = moduleTarget(file, node.source);
        const values = (node.specifiers as AstNode[]).filter(
          (specifier) => specifier.exportKind !== "type",
        );
        for (const specifier of values)
          found.push({
            module,
            symbol: nameOf(specifier.local),
            form: "re-export",
          });
        if (values.length === 0)
          found.push({ module, symbol: "", form: "side-effect" });
        return;
      }
      case "ExportAllDeclaration":
        if (node.exportKind === "type") return;
        found.push({
          module: moduleTarget(file, node.source),
          symbol: "*",
          form: "re-export",
        });
        return;
      case "ImportExpression":
        found.push({
          module: moduleTarget(file, node.source),
          symbol: "*",
          form: "dynamic",
        });
        return;
      case "CallExpression":
        if (isLoad(node.callee))
          found.push({
            module: moduleTarget(file, (node.arguments as unknown[])[0]),
            symbol: "*",
            form: "require",
          });
        return;
    }
  });
  return found;
}

const listed = (
  table: Record<string, readonly string[] | "*">,
  { module, symbol }: SymbolImport,
): boolean => {
  const symbols = table[module];
  return symbols === "*" || (symbols?.includes(symbol) ?? false);
};

/**
 * What breaks the side-bound rules in `source`, read as the side-bound module
 * at `file`: a forbidden symbol (a), an import off the closed surface (b), an
 * unsupported import form (c), or a hand-built Worker side (g).
 */
function sideBoundViolations(file: string, source: string): string[] {
  const violations: string[] = [];
  for (const ref of symbolImports(file, source)) {
    const label = `${file}: ${[ref.form, ref.symbol].filter(Boolean).join(" ")} from ${ref.module}`;
    if (ref.form === "dynamic" || ref.form === "require") {
      violations.push(`${label} (unsupported form)`);
      continue;
    }
    if (listed(SIDE_BOUND_FORBIDDEN, ref)) {
      violations.push(`${label} (forbidden)`);
      continue;
    }
    if (SIDE_BOUND_MODULES.includes(ref.module) && ref.symbol !== "*") continue;
    if (listed(SIDE_BOUND_ALLOWED, ref) && ref.symbol !== "*") continue;
    const entry = SIDE_BOUND_EXTERNAL_IMPORTS.find(
      (candidate) =>
        candidate.importer === file &&
        candidate.module === ref.module &&
        candidate.symbol === ref.symbol,
    );
    if (!entry || ref.form !== "import" || ref.symbol === "*") {
      violations.push(`${label} (not on the closed surface)`);
      continue;
    }
  }
  walk(parseModule(file, source), (node) => {
    if (
      node.type === "Property" &&
      isNode(node.key) &&
      nameOf(node.key) === "workerId"
    )
      violations.push(`${file}: an object literal names a workerId`);
  });
  return violations;
}

const normalized = (text: string): string =>
  text.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/,? \)/g, ")").trim();

/**
 * Why `entry` does not hold against `source`, its declaring module's text:
 * the symbol must be declared there, in the entry's kind, with the pinned
 * text. A re-export or an `export *` in the declaring module fails closed.
 */
function externalEntryViolation(
  entry: ExternalImport,
  source: string | undefined,
): string | undefined {
  const label = `${entry.module}#${entry.symbol} (${entry.kind})`;
  if (source === undefined) return `${label}: the declaring module is gone`;
  const program = parseModule(entry.module, source);
  let found: string | undefined;
  for (const node of program.body as AstNode[]) {
    if (node.type === "ExportAllDeclaration")
      return `${label}: the declaring module has an export *`;
    if (node.type !== "ExportNamedDeclaration") continue;
    if (node.source != null || node.declaration == null) {
      for (const specifier of node.specifiers as AstNode[])
        if (nameOf(specifier.exported) === entry.symbol)
          return `${label}: re-exported, not declared`;
      continue;
    }
    const declaration = node.declaration as AstNode;
    if (
      declaration.type === "FunctionDeclaration" &&
      nameOf(declaration.id) === entry.symbol
    ) {
      const id = declaration.id as { end: number };
      const body = declaration.body as { start: number };
      found = `function ${normalized(source.slice(id.end, body.start))}`;
    }
    if (declaration.type === "VariableDeclaration")
      for (const declarator of declaration.declarations as AstNode[]) {
        const id = declarator.id as AstNode & {
          typeAnnotation?: { start: number; end: number } | null;
        };
        if (nameOf(id) !== entry.symbol) continue;
        const init = declarator.init as AstNode | null;
        if (id.typeAnnotation && declaration.kind === "const")
          found = `typed-const ${normalized(
            source
              .slice(id.typeAnnotation.start, id.typeAnnotation.end)
              .replace(/^:/, ""),
          )}`;
        else if (
          declaration.kind === "const" &&
          init &&
          !["ArrowFunctionExpression", "FunctionExpression"].includes(init.type)
        )
          found = `scalar ${normalized(
            source.slice(node.start as number, node.end as number),
          )}`;
        else found = "unsupported declaration";
      }
  }
  const expected = `${entry.kind} ${entry.pin}`;
  if (found === undefined) return `${label}: not declared there`;
  return found === expected ? undefined : `${label}: declared as ${found}`;
}

const sourceOf = (module: string): string | undefined => {
  try {
    return readFileSync(join(SRC_ROOT, module), "utf8");
  } catch {
    return undefined;
  }
};

/** The modules value-importing `resolveReadableWorktreeRow`. */
function kbRowProducers(sources: Map<string, string>): string[] {
  return [...sources]
    .filter(([file, source]) =>
      symbolImports(file, source).some(
        (ref) =>
          ref.module === "worktrees/knowledgeCheckout.ts" &&
          (ref.symbol === "resolveReadableWorktreeRow" || ref.symbol === "*"),
      ),
    )
    .map(([file]) => file)
    .sort();
}

const moduleSources = new Map(
  [...scans.keys()].map((module) => [module, sourceOf(module)!]),
);

test("side-bound modules import only their side-bound surface", () => {
  for (const module of SIDE_BOUND_MODULES) {
    assert.ok(scans.has(module), `${module} is gone: delete it from the list`);
    assert.deepEqual(sideBoundViolations(module, sourceOf(module)!), []);
  }
});

test("every side-bound external import is needed and pinned to its declaration", () => {
  const used = SIDE_BOUND_MODULES.flatMap((module) =>
    symbolImports(module, sourceOf(module)!)
      .filter(
        (ref) =>
          !SIDE_BOUND_MODULES.includes(ref.module) &&
          !listed(SIDE_BOUND_ALLOWED, ref),
      )
      .map((ref) => `${module} ${ref.module}#${ref.symbol}`),
  ).sort();
  assert.deepEqual(
    used,
    SIDE_BOUND_EXTERNAL_IMPORTS.map(
      (entry) => `${entry.importer} ${entry.module}#${entry.symbol}`,
    ).sort(),
    "an entry the code no longer needs, or an import without one",
  );
  for (const entry of SIDE_BOUND_EXTERNAL_IMPORTS)
    assert.equal(
      externalEntryViolation(entry, sourceOf(entry.module)),
      undefined,
    );
});

test("only the gate and three side-bound modules produce the KB row", () => {
  assert.deepEqual(kbRowProducers(moduleSources), KB_ROW_PRODUCERS);
});

test("the side-bound ratchet flags each way around it (S1–S10)", () => {
  const status = "worktrees/worktreeStatus.ts";
  const flags = (file: string, source: string, why: RegExp): void => {
    const violations = sideBoundViolations(file, source);
    assert.ok(
      violations.some((violation) => why.test(violation)),
      `${source} → ${JSON.stringify(violations)}`,
    );
  };
  const entry = (symbol: string): ExternalImport =>
    SIDE_BOUND_EXTERNAL_IMPORTS.find(
      (candidate) => candidate.symbol === symbol,
    )!;

  // S1: the default Worker's string API, imported directly.
  flags(status, 'import { git } from "../gitExec.ts";', /forbidden/);
  // S2: a two-hop wrapper the lists do not know.
  flags(
    status,
    'import { wrap } from "./newHelper.ts";',
    /not on the closed surface/,
  );
  // S3: a pinned function's parameters change.
  assert.match(
    externalEntryViolation(
      entry("canonicalWorktreeId"),
      "export function canonicalWorktreeId(id: string, path: string): string { return id + path; }",
    ) ?? "",
    /declared as function/,
  );
  // S4: a new KB-row producer.
  assert.notDeepEqual(
    kbRowProducers(
      new Map([
        ...moduleSources,
        [
          "connection.ts",
          'import { resolveReadableWorktreeRow } from "./worktrees/knowledgeCheckout.ts";',
        ],
      ]),
    ),
    KB_ROW_PRODUCERS,
  );
  // S5: the default Worker's side, named in a side-bound module.
  flags(
    status,
    'import { DEFAULT_WORKER_SIDE } from "../workers/placement.ts";',
    /forbidden/,
  );
  // S6: the string API, value-re-exported.
  flags(status, 'export { gitOptional } from "../gitExec.ts";', /forbidden/);
  // S7: declaration forms and unsupported import forms.
  assert.match(
    externalEntryViolation(
      entry("worktreeIdBySession"),
      "export const worktreeIdBySession: (path: string) => ReadonlyMap<string, string> = make();",
    ) ?? "",
    /declared as typed-const/,
  );
  assert.match(
    externalEntryViolation(
      entry("BACKGROUND_FETCH_ENABLED"),
      'export const BACKGROUND_FETCH_ENABLED = process.env.ASSISTANT_BACKGROUND_FETCH !== "0";',
    ) ?? "",
    /declared as scalar/,
  );
  flags(
    status,
    'import { existsSync } from "node:fs";',
    /not on the closed surface/,
  );
  flags(
    "worktrees/worktreeFetch.ts",
    'import { existsSync } from "node:fs";',
    /not on the closed surface/,
  );
  // The watcher reads and watches only through its side (W4).
  flags(
    "worktrees/worktreeWatcher.ts",
    'import { existsSync } from "node:fs";',
    /not on the closed surface/,
  );
  flags(
    "worktrees/worktreeWatcher.ts",
    'import watcher from "../parcelWatcher.ts";',
    /forbidden/,
  );
  flags(
    "worktrees/worktreeWatcher.ts",
    'import { subscribeOnWorker } from "../workers/watchClient.ts";',
    /forbidden/,
  );
  flags(
    status,
    'import * as settings from "../settings.ts";',
    /not on the closed surface/,
  );
  flags(
    status,
    'import * as git from "../gitExec.ts";',
    /not on the closed surface/,
  );
  flags(status, 'export * from "./worktreeDiff.ts";', /not on the closed/);
  assert.match(
    externalEntryViolation(
      entry("getSettings"),
      'export * from "./elsewhere.ts";\nexport function getSettings(publicBaseUrl?: string): AppSettings { return load(publicBaseUrl); }',
    ) ?? "",
    /export \*/,
  );
  flags(
    status,
    'const m = await import("../settings.ts");',
    /unsupported form/,
  );
  flags(status, 'require("../gitExec.ts");', /unsupported form/);
  flags(
    status,
    'import settings from "../settings.ts";',
    /not on the closed surface/,
  );
  // S8: a served call that may drop its side. (The adapters' own types make an
  // omitted side a compile error: `documentGrantSides.test.ts`.)
  for (const symbol of ["realpathServedFile", "statServedFile"])
    flags(
      "documentGrantTargets.ts",
      `import { ${symbol} } from "./servedFileAccess.ts";`,
      /not on the closed surface/,
    );
  flags(
    "documentGrantTargets.ts",
    'import { mintDocumentGrant } from "./directFileGrants.ts";',
    /not on the closed surface/,
  );
  // S9: a hand-built Worker side.
  flags(
    status,
    'export const side = { workerId: "local" } as const;',
    /workerId/,
  );
  // S10: the named module re-exports the symbol instead of declaring it.
  assert.match(
    externalEntryViolation(
      entry("getSettings"),
      'export { getSettings } from "./settingsCore.ts";',
    ) ?? "",
    /re-exported, not declared/,
  );
});

test("an import that binds nothing still runs its module (S11)", () => {
  const status = "worktrees/worktreeStatus.ts";
  const closed = (source: string): boolean =>
    sideBoundViolations(status, source).some((violation) =>
      /not on the closed surface|forbidden/.test(violation),
    );
  // `verbatimModuleSyntax` keeps `import { type X }` as `import {}`: only an
  // `import type` or `export type` declaration is erased.
  assert.deepEqual(
    [
      'import "./newHelper.ts";',
      'import {} from "./newHelper.ts";',
      'import { type Wrap } from "./newHelper.ts";',
      'export {} from "./newHelper.ts";',
      'export { type Wrap } from "./newHelper.ts";',
      'import "../settings.ts";',
      'import "../gitExec.ts";',
      'import "../gitProcess.ts";',
    ].filter((source) => !closed(source)),
    [],
    "an unlisted module runs unseen",
  );
  // Erased declarations, and modules already on the closed surface.
  assert.deepEqual(
    [
      'import type { Wrap } from "./newHelper.ts";',
      'import type {} from "./newHelper.ts";',
      'export type { Wrap } from "./newHelper.ts";',
      'import "./worktreeDiff.ts";',
      'import "node:path";',
    ].filter((source) => sideBoundViolations(status, source).length > 0),
    [],
  );

  const runs = (source: string): boolean =>
    scanSource(join(SRC_ROOT, "newModule.ts"), source).valueImports.has(
      "gitProcess.ts",
    );
  assert.deepEqual(
    [
      runs('import { type GitResult } from "./gitProcess.ts";'),
      runs('export { type GitResult } from "./gitProcess.ts";'),
      runs('import type { GitResult } from "./gitProcess.ts";'),
      runs('export type { GitResult } from "./gitProcess.ts";'),
    ],
    [true, true, false, false],
  );
});

test("the KB-row producer pin sees every load form, from any directory (S12)", () => {
  const produces = (file: string, source: string): boolean =>
    kbRowProducers(new Map([[file, source]])).includes(file);
  const kb = "../worktrees/knowledgeCheckout.ts";
  assert.deepEqual(
    (
      [
        [
          "newKbCaller.ts",
          'const { resolveReadableWorktreeRow } = await import("./worktrees/knowledgeCheckout.ts");',
        ],
        ["tools/newKbCaller.ts", `const m = await import("${kb}");`],
        ["tools/newKbCaller.ts", `const m = await import(\`${kb}\`);`],
        ["worktrees/newKbCaller.ts", 'await import("./knowledgeCheckout.ts");'],
        [
          "newKbCaller.ts",
          'const { resolveReadableWorktreeRow } = require("./worktrees/knowledgeCheckout.ts");',
        ],
        [
          "tools/newKbCaller.ts",
          `import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nload("${kb}");`,
        ],
        [
          "tools/newKbCaller.ts",
          'import { resolveReadableWorktreeRow } from "../worktrees/knowledgeCheckout.js";',
        ],
        ["tools/newKbCaller.ts", `import * as kb from "${kb}";`],
        [
          "tools/newKbCaller.ts",
          `export { resolveReadableWorktreeRow } from "${kb}";`,
        ],
        ["tools/newKbCaller.ts", `export * from "${kb}";`],
      ] as const
    )
      .filter(([file, source]) => !produces(file, source))
      .map(([file, source]) => `${file}: ${source}`),
    [],
    "a KB-row producer escapes the pin",
  );
  // Types and the other symbols hand out no row.
  assert.deepEqual(
    [
      `import type { resolveReadableWorktreeRow } from "${kb}";`,
      `type Kb = typeof import("${kb}");`,
      `import { checkoutSideOf } from "${kb}";`,
      `import "${kb}";`,
    ].filter((source) => produces("tools/newKbCaller.ts", source)),
    [],
  );
});
