/**
 * The Worker boundary ratchet (`docs/workers.md`).
 *
 * `worker/` is the Worker's side: in phase 2 it runs in a process of its own,
 * so it reaches no server state, and only the in-process Worker starts it. The
 * credential gateway (`gateway/`) is held to the same rule.
 * Checkout git runs only through the checkout family (`gitExec.ts`), whose
 * runner crosses the Worker protocol; the server's own repositories use the
 * local family (`serverRepoGit.ts`), and only the modules named below may.
 *
 * No checkout is read on the server's own filesystem: a module of the checkout
 * family imports no `node:fs`, and the checkout readers read only through the
 * checkout-file access. Checkout git and reads take a typed side, and the
 * default Worker is named only where a side is derived. Every list is exact: a
 * new entry fails, and so does an entry the code no longer needs.
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
 * run; it imports only `node:` modules. The environment the Worker's children
 * inherit is the isolation boundary's (`workers/isolationBoundary.ts`), passed
 * in when the Worker starts, never the server's child-env overlay.
 */
const WORKER_ALLOWED = new Set([
  "errors.ts",
  "fileReads.ts",
  "gitProcess.ts",
  "managedTreeRemoval.ts",
  "parcelWatcher.ts",
  "spawnBroker.ts",
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
  "pullRequestHosting.ts",
  "sessionSpawn.ts",
  "tools/core/lsTool.ts",
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
  [
    ...sourceModules(),
    resolve(SRC_ROOT, "../../shared/openAiCompatibleValidation.ts"),
  ].map((file) => [relative(SRC_ROOT, file), scanModule(file)]),
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

test("the Worker's endpoint and children's environment come from the isolation boundary", () => {
  // Only the boundary makes a Worker's stream pair; `workerProtocol/` names
  // its type. The gateway link makes the control pair, which stays on the
  // server's side of the isolation boundary until the gateway's own socket.
  assert.deepEqual(
    importersOf(
      (target) => target === "workerProtocol/inProcessTransport.ts",
      "valueImports",
    ).filter((module) => !module.startsWith("workerProtocol/")),
    ["gatewayLink.ts", "workers/isolationBoundary.ts"],
  );
  // Neither the in-process Worker nor the Worker side reads the overlay.
  assert.deepEqual(
    importersOf((target) => target === "subprocessEnv.ts").filter(
      (module) =>
        module === "workers/inProcessWorker.ts" || module.startsWith("worker/"),
    ),
    [],
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

/**
 * What `gateway/` (the credential gateway) may import besides `node:` and
 * itself: the private atomic writer for its state, the worker protocol's codec
 * and connection for its control channel (gateway control 1.0), the socket
 * transport for its client port (gateway client 1.0), and what those import. No package either, and each of these imports only `node:` or this
 * list, including the dependency-free shared endpoint rules, so the closure
 * ends here and the gateway can run as its own process (ADR-0005).
 */
const GATEWAY_ALLOWED = new Set([
  "../../shared/openAiCompatibleValidation.ts",
  "errors.ts",
  "privateJsonFile.ts",
  "workerProtocol/codec.ts",
  "workerProtocol/connection.ts",
  "workerProtocol/inProcessTransport.ts",
  "workerProtocol/unixSocketTransport.ts",
  "workerProtocol/version.ts",
]);

test("the gateway reaches no server state", () => {
  const modules = [...scans].filter(([module]) =>
    module.startsWith("gateway/"),
  );
  assert.ok(modules.length > 0, "the scan found the gateway modules");
  for (const [module, scan] of modules)
    for (const target of scan.imports)
      assert.ok(
        target.startsWith("node:") ||
          target.startsWith("gateway/") ||
          GATEWAY_ALLOWED.has(target),
        `${module} imports ${target}`,
      );
  // The allowlist is closed: what it names reaches nothing outside it.
  for (const module of GATEWAY_ALLOWED) {
    const scan = scans.get(module);
    assert.ok(scan, `the scan found ${module}`);
    for (const target of scan.imports)
      assert.ok(
        target.startsWith("node:") || GATEWAY_ALLOWED.has(target),
        `${module}, which the gateway may import, imports ${target}`,
      );
  }
  // And exact: the gateway's closure reaches every entry.
  const reached = new Set<string>();
  const pending = modules.flatMap(([, scan]) => [...scan.imports]);
  for (let target = pending.pop(); target; target = pending.pop()) {
    if (target.startsWith("node:") || target.startsWith("gateway/")) continue;
    if (reached.has(target)) continue;
    reached.add(target);
    pending.push(...(scans.get(target)?.imports ?? []));
  }
  assert.deepEqual([...reached].sort(), [...GATEWAY_ALLOWED].sort());
});

/**
 * The gateway's two tiers (ADR-0005), by module under `gateway/`. The vault
 * holds credentials, renewal, the writer lane and the login holds; the edge
 * everything exposed. Shared modules serve both and run neither; the root
 * composes them and persists both tiers' state. Only value imports count: a
 * type-only one is erased and joins no closure.
 */
const GATEWAY_VAULT = [
  "claudeRenewal",
  // The standalone process's Codex renewal child, behind the renewal port.
  "codexChild",
  "holds",
  // The login children's port (Task-1387), one child per login.
  "loginChild",
  // The YubiKey helper's port (Task-1395), the third spawn exception.
  "pivChild",
  "processIdentity",
  "profileCredential",
  "refreshLock",
  "renewal",
  // The sealed store: its record format, the store and its control socket.
  "sealedRecord",
  "sealedStore",
  "vault",
  "vaultControl",
  // Users' integration credentials (Task-1397), sealed like token files.
  "vaultIntegrations",
  "vaultLogins",
  // The vault in its own process, serving gateway-vault/1.0.
  "vaultServer",
];
const GATEWAY_EDGE = [
  // The client listener's enrollment, CA and protocol.
  "clientListener",
  "clientMethods",
  "clientRegistry",
  "compatUpstream",
  "control",
  "controlMethods",
  "forward",
  "leases",
  "logins",
  // The edge's VaultPort over gateway-vault/1.0.
  "remoteVault",
  "upstreams",
  "x509",
];
const GATEWAY_SHARED = [
  // What the edge takes from its injected tools (Task-1397): types only.
  "edgeTools",
  "profiles",
  "refusals",
  "vaultMethods",
  "vaultPort",
];
/**
 * The composition, and the standalone process and its entries around it. The
 * admin CLI edits both tiers' files: the edge's clients, the vault's pairing
 * and its sealed store.
 */
const GATEWAY_ROOT = [
  "adminMain",
  // Where the entries find their children, source or bundle.
  "childEntries",
  "gateway",
  "main",
  "process",
  "processFixture",
  "state",
  // The vault's own entry (Task-1387), `vault.js`.
  "vaultMain",
];
/**
 * gateway control 1.4's wire validators (`isHoldId`, `isPid`, `isStartTime`):
 * the one edge-to-vault crossing, gone with that protocol.
 */
const GATEWAY_EDGE_TO_VAULT = [
  "gateway/controlMethods.ts -> gateway/holds.ts",
  "gateway/controlMethods.ts -> gateway/processIdentity.ts",
];

test("the gateway's edge reaches the vault only through its port", () => {
  const path = (name: string): string => `gateway/${name}.ts`;
  const vault = new Set(GATEWAY_VAULT.map(path));
  const edge = new Set(GATEWAY_EDGE.map(path));
  const shared = new Set(GATEWAY_SHARED.map(path));
  const classified = [vault, edge, shared, new Set(GATEWAY_ROOT.map(path))];
  const modules = [...scans.keys()].filter((module) =>
    module.startsWith("gateway/"),
  );
  for (const module of modules)
    assert.equal(
      classified.filter((tier) => tier.has(module)).length,
      1,
      `${module} belongs to exactly one gateway tier list`,
    );
  for (const tier of classified)
    for (const module of tier)
      assert.ok(modules.includes(module), `the scan found ${module}`);
  const crossings: string[] = [];
  for (const module of modules)
    for (const target of scans.get(module)!.valueImports) {
      const crosses =
        (edge.has(module) && vault.has(target)) ||
        (vault.has(module) && edge.has(target)) ||
        (shared.has(module) && (vault.has(target) || edge.has(target)));
      if (crosses) crossings.push(`${module} -> ${target}`);
    }
  assert.deepEqual(crossings.sort(), GATEWAY_EDGE_TO_VAULT);
  assert.deepEqual(
    [...scans.get(path("vaultPort"))!.valueImports],
    [],
    "the port holds types only",
  );
  assert.deepEqual(
    [...scans.get(path("edgeTools"))!.valueImports],
    [],
    "the edge's tool port holds types only",
  );
});

/**
 * The edge's tools (Task-1397): beyond `node:`, themselves and the MCP SDK,
 * only the shared Jira client and its helpers, a closed set. They import
 * nothing from `gateway/`, which reaches them only through `EdgeTools`, and
 * only the edge's entry loads them, so the vault process never does.
 */
const GATEWAY_TOOLS_ALLOWED = new Set([
  "atlassian/adfToMarkdown.ts",
  "atlassian/atlassianFetch.ts",
  "httpRetry.ts",
  "jiraClient.ts",
]);

test("only the edge's entry loads its tools, and they reach no server state", () => {
  assert.deepEqual(
    importersOf((target) => target.startsWith("gatewayTools/")).filter(
      (module) => !module.startsWith("gatewayTools/"),
    ),
    ["gatewayDevMain.ts"],
  );
  const modules = [...scans].filter(([module]) =>
    module.startsWith("gatewayTools/"),
  );
  assert.ok(modules.length > 0, "the scan found the tool modules");
  for (const [module, scan] of modules)
    for (const target of scan.imports)
      assert.ok(
        target.startsWith("node:") ||
          target.startsWith("gatewayTools/") ||
          target.startsWith("@modelcontextprotocol/sdk/") ||
          GATEWAY_TOOLS_ALLOWED.has(target),
        `${module} imports ${target}`,
      );
  for (const module of GATEWAY_TOOLS_ALLOWED) {
    const scan = scans.get(module);
    assert.ok(scan, `the scan found ${module}`);
    for (const target of scan.imports)
      assert.ok(
        target.startsWith("node:") || GATEWAY_TOOLS_ALLOWED.has(target),
        `${module}, which the edge's tools may import, imports ${target}`,
      );
  }
});

/**
 * The gateway's own sign-in and page (Task-1402): beyond `node:` and
 * themselves, only the OIDC library, the shared wire model and the static
 * content types. Only the edge's entry loads them, and the OIDC library is
 * theirs alone, so neither `gateway/` nor the vault process ever loads it.
 */
const GATEWAY_WEB_ALLOWED = new Set([
  "oauth4webapi",
  "@assistant/shared/gatewayUi",
  "webStatic.ts",
]);

test("only the edge's entry loads its sign-in, which alone uses the OIDC library", () => {
  assert.deepEqual(
    importersOf((target) => target.startsWith("gatewayWeb/")).filter(
      (module) => !module.startsWith("gatewayWeb/"),
    ),
    ["gatewayDevMain.ts"],
  );
  const modules = [...scans].filter(([module]) =>
    module.startsWith("gatewayWeb/"),
  );
  assert.ok(modules.length > 0, "the scan found the sign-in modules");
  for (const [module, scan] of modules)
    for (const target of scan.imports)
      assert.ok(
        target.startsWith("node:") ||
          target.startsWith("gatewayWeb/") ||
          GATEWAY_WEB_ALLOWED.has(target),
        `${module} imports ${target}`,
      );
  assert.deepEqual(
    importersOf(
      (target) =>
        target === "oauth4webapi" || target.startsWith("oauth4webapi/"),
    ).filter((module) => !module.startsWith("gatewayWeb/")),
    [],
  );
  // What they may import beyond the library reaches nothing further.
  for (const target of scans.get("webStatic.ts")!.imports)
    assert.ok(target.startsWith("node:"), `webStatic.ts imports ${target}`);
  const shared = scanModule(resolve(SRC_ROOT, "../../shared/gatewayUi.ts"));
  assert.deepEqual([...shared.imports], [], "the shared leaf imports nothing");
});

test("only the server links and the error classifier import the gateway", () => {
  // The link starts it and speaks control, the client-mode link speaks
  // gateway client 1.0; engine modules reach it only through a link. The
  // classifier reads the local-refusal marker. The dev entry runs the edge;
  // the vault's entry is `gateway/vaultMain.ts`.
  assert.deepEqual(
    importersOf((target) => target.startsWith("gateway/")).filter(
      (module) => !module.startsWith("gateway/"),
    ),
    [
      "gatewayClientLink.ts",
      "gatewayDevMain.ts",
      "gatewayLink.ts",
      "providerErrors.ts",
    ],
  );
});

test("the relay imports only node and itself, and nothing imports it", () => {
  // It holds the client key in its own process (Task-1384, M14).
  const modules = [...scans].filter(([module]) => module.startsWith("relay/"));
  assert.ok(modules.length > 0, "the scan found the relay modules");
  for (const [module, scan] of modules)
    for (const target of scan.imports)
      assert.ok(
        target.startsWith("node:") || target.startsWith("relay/"),
        `${module} imports ${target}`,
      );
  assert.deepEqual(
    importersOf((target) => target.startsWith("relay/")).filter(
      (module) => !module.startsWith("relay/"),
    ),
    [],
  );
});

test("no pi module reaches the gateway link", () => {
  // A leased pi run takes its access as an argument: `harnesses/` asks the
  // link, so the engine half stays free of server state.
  assert.deepEqual(
    importersOf((target) => target === "gatewayLink.ts").filter((module) =>
      module.startsWith("piSdk/"),
    ),
    [],
  );
});

test("the gateway's Codex refresher imports only node, pi and proper-lockfile", () => {
  // It is injected into the gateway as a port; the gateway never imports it.
  const scan = scans.get("piSdk/codexRenewal.ts");
  assert.ok(scan, "the scan found the Codex refresher");
  for (const target of scan.imports)
    assert.ok(
      target.startsWith("node:") ||
        target.startsWith("@earendil-works/") ||
        target === "proper-lockfile",
      `piSdk/codexRenewal.ts imports ${target}`,
    );
  assert.deepEqual(
    importersOf((target) => target === "piSdk/codexRenewal.ts"),
    ["harnesses/gatewayPorts.ts"],
  );
});

test("the process fixture is not imported by production modules", () => {
  assert.deepEqual(
    importersOf((target) => target === "gateway/processFixture.ts"),
    [],
  );
});

test("the Codex renewal child imports only the refresher and node, and only the gateway's three child ports spawn", () => {
  // The child is the only gateway-shipped module that loads pi (ADR-0005, M5).
  const scan = scans.get("codexRenewMain.ts");
  assert.ok(scan, "the scan found the Codex renewal child");
  for (const target of scan.imports)
    assert.ok(
      target.startsWith("node:") || target === "harnesses/gatewayPorts.ts",
      `codexRenewMain.ts imports ${target}`,
    );
  assert.deepEqual(
    importersOf((target) => target === "node:child_process").filter((module) =>
      module.startsWith("gateway/"),
    ),
    // Codex's renewal child, the login children (Task-1387) and the
    // YubiKey helper (Task-1395).
    ["gateway/codexChild.ts", "gateway/loginChild.ts", "gateway/pivChild.ts"],
  );
});

/** Every module `entry` reaches, itself included. */
function closureOf(entry: string): Set<string> {
  const reached = new Set<string>();
  const pending = [entry];
  for (let module = pending.pop(); module; module = pending.pop()) {
    if (reached.has(module)) continue;
    reached.add(module);
    pending.push(...(scans.get(module)?.imports ?? []));
  }
  return reached;
}

test("the login children: only the Codex one loads pi, through the gateway port", () => {
  // The child side's protocol imports only node, so each entry adds only its
  // own driver (ADR-0005 "The login children").
  for (const target of scans.get("loginChildEntry.ts")!.imports)
    assert.ok(
      target.startsWith("node:"),
      `loginChildEntry.ts imports ${target}`,
    );
  for (const target of scans.get("codexLoginMain.ts")!.imports)
    assert.ok(
      target.startsWith("node:") ||
        target === "harnesses/gatewayPorts.ts" ||
        target === "loginChildEntry.ts",
      `codexLoginMain.ts imports ${target}`,
    );
  const claude = closureOf("claudeLoginMain.ts");
  assert.ok(claude.has("claudeLoginDriver.ts"), "the scan found the driver");
  assert.deepEqual(
    [...claude].filter((module) => module.startsWith("@earendil-works/")),
    [],
    "the Claude login child loads no pi",
  );
  assert.ok(
    ![...claude].some((module) => module.startsWith("piSdk/")),
    "the Claude login child reaches no pi module",
  );
});

test("the session-hook protocol runs no server module", () => {
  // The Worker side imports it, and the direct rule above stops at
  // `workerProtocol/`: a server module it ran would reach the Worker unseen.
  const scan = scans.get("workerProtocol/sessionHookMethods.ts");
  assert.ok(scan);
  for (const target of scan.valueImports)
    assert.ok(
      target.startsWith("workerProtocol/"),
      `workerProtocol/sessionHookMethods.ts runs ${target}`,
    );
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

test("no module of the checkout family reads the server's filesystem", () => {
  assert.deepEqual(
    importersOf((target) => target === "gitExec.ts").filter((module) =>
      [...scans.get(module)!.imports].some(isFs),
    ),
    [],
  );
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
 * What a side-bound module may never import: the default Worker's side (by
 * symbol) and every executor or primitive below the families (`"*"`).
 */
const SIDE_BOUND_FORBIDDEN: Record<string, readonly string[] | "*"> = {
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

/* ------------------------- typed checkout sides (W6) ------------------------- */

/**
 * The modules that may name the default Worker: the side derivations
 * (`checkoutSideOf`, the main checkout's side) and the Worker's own clients.
 * Every other module takes its side from a row, a session or a card.
 */
const DEFAULT_WORKER_NAMERS = [
  "workers/checkoutClient.ts",
  "workers/inProcessWorker.ts",
  "worktrees/knowledgeCheckout.ts",
  "worktrees/worktreeResolve.ts",
];

/**
 * What the checkout-file access exports: no read that takes only a root, so
 * every checkout read names its side (`checkoutFilesOn`).
 */
const CHECKOUT_FILE_ACCESS_EXPORTS = [
  "CheckoutPathVerdict",
  "carryCheckoutFailure",
  "checkLexicalPath",
  "checkoutFailureOf",
  "checkoutFilesOn",
  "markFilesystemFailure",
  "readLocally",
  "throwInCheckoutReadForTests",
];

/** Modules binding the default Worker's id or side, or all of `placement.ts`. */
function defaultWorkerNamers(sources: Map<string, string>): string[] {
  return [...sources]
    .filter(([file, source]) =>
      symbolImports(file, source).some(
        (ref) =>
          ref.module === "workers/placement.ts" &&
          ["DEFAULT_WORKER_ID", "DEFAULT_WORKER_SIDE", "*"].includes(
            ref.symbol,
          ),
      ),
    )
    .map(([file]) => file)
    .sort();
}

/** The names a module exports as values; `*` for an `export *`. */
function valueExports(file: string, source: string): string[] {
  const names: string[] = [];
  for (const node of parseModule(file, source).body as AstNode[]) {
    if (node.type === "ExportAllDeclaration" && node.exportKind !== "type")
      names.push("*");
    if (node.type === "ExportDefaultDeclaration") names.push("default");
    if (node.type !== "ExportNamedDeclaration" || node.exportKind === "type")
      continue;
    const declaration = node.declaration as AstNode | null;
    if (declaration?.type === "VariableDeclaration")
      for (const declarator of declaration.declarations as AstNode[])
        names.push(nameOf(declarator.id));
    else if (
      declaration?.type === "FunctionDeclaration" ||
      declaration?.type === "ClassDeclaration"
    )
      names.push(nameOf(declaration.id));
    for (const specifier of node.specifiers as AstNode[])
      if (specifier.exportKind !== "type")
        names.push(nameOf(specifier.exported));
  }
  return names.sort();
}

test("the default Worker is named only where a side is derived", () => {
  assert.deepEqual(defaultWorkerNamers(moduleSources), DEFAULT_WORKER_NAMERS);
  // A synthetic extra importer, in each form that binds the side.
  for (const source of [
    'import { DEFAULT_WORKER_SIDE } from "./workers/placement.ts";',
    'import { DEFAULT_WORKER_ID } from "./workers/placement.ts";',
    'import * as placement from "./workers/placement.ts";',
    'export { DEFAULT_WORKER_SIDE } from "./workers/placement.ts";',
    'const placement = await import("./workers/placement.ts");',
  ])
    assert.deepEqual(
      defaultWorkerNamers(
        new Map([...moduleSources, ["commitWorkflow.ts", source]]),
      ),
      [...DEFAULT_WORKER_NAMERS, "commitWorkflow.ts"].sort(),
      source,
    );
});

test("checkout git and reads are reached only by a side", () => {
  assert.deepEqual(valueExports("gitExec.ts", sourceOf("gitExec.ts")!), [
    "GitCommandError",
    "checkoutGitOn",
    "clearRepoLockKeysForTests",
    "countGitExecutionsForTests",
    "withRepoLock",
  ]);
  assert.deepEqual(
    valueExports("checkoutFileAccess.ts", sourceOf("checkoutFileAccess.ts")!),
    CHECKOUT_FILE_ACCESS_EXPORTS,
  );
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

  // S1: a primitive below the families, imported directly.
  flags(
    status,
    'import { workerGitRunner } from "../workers/checkoutClient.ts";',
    /forbidden/,
  );
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
  // S6: the default Worker's side, value-re-exported.
  flags(
    status,
    'export { DEFAULT_WORKER_SIDE } from "../workers/placement.ts";',
    /forbidden/,
  );
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
    'import * as client from "../workers/checkoutClient.ts";',
    /forbidden/,
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
  flags(status, 'require("../workers/checkoutClient.ts");', /unsupported form/);
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
      'import "../workers/checkoutClient.ts";',
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
