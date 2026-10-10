/**
 * Architecture guardrails for the normalized session runtime prompt path and
 * the harness/tool import boundaries.
 *
 * The app-level prompt path should converge on:
 *   app code -> runtime prompt facade/view -> SessionRuntime -> LiveRuntimeSession -> adapter -> raw engine prompt
 *
 * Direct engine prompts are forbidden outside adapter bridges. Adapter
 * construction stays hidden behind factory functions, and app code reaches
 * SessionRuntime.prompt only through the runtime prompt facade.
 *
 * Import boundaries: the pi SDK is owned by `piSdk/` and the Claude Agent SDK
 * by `claudeSdk/`; the harness-neutral tool layer (`mcp/`, `tools/`) must
 * import neither — pi runs tools through its direct adapter, Claude by mounting
 * the session tool server.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

const ENGINE_PROMPT_BRIDGE_FILES = new Set([
  "session/adapters/claudeSdk.ts",
  "session/adapters/pi.ts",
]);

const ADAPTER_CONSTRUCTION_FILES = new Set([
  "session/adapters/claudeSdk.ts",
  "session/adapters/pi.ts",
]);

const RUNTIME_PROMPT_BRIDGE_FILES = new Set(["session/runtimePrompt.ts"]);

/** A path INTO one of the two provider folders, at any depth. */
const PROVIDER_FOLDER_SPECIFIER = /(?:^|\/)(?:claudeSdk|piSdk)\//;

/**
 * Every module specifier in `source`, whatever import form carries it: a
 * static or type-only import and a re-export all read `from "x"`, a dynamic
 * one reads `import("x")`, and a side-effect one is a bare `import "x"`.
 *
 * Extraction and detection live together deliberately. Splitting them is what
 * let a gap hide: a test that starts from an already-extracted specifier
 * cannot see an import form the extractor never matched.
 */
const IMPORT_SPECIFIER_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
];

function providerFolderImports(source: string): string[] {
  const found: string[] = [];
  for (const pattern of IMPORT_SPECIFIER_PATTERNS)
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] ?? "";
      if (PROVIDER_FOLDER_SPECIFIER.test(specifier)) found.push(specifier);
    }
  return found;
}

const ADAPTER_FACTORY_FILES = new Set([
  "claudeSdk/ClaudeSdkSession.ts",
  "piSdk/PiLiveSession.ts",
  "session/adapters/claudeSdk.ts",
  "session/adapters/pi.ts",
]);

test("harness SDK imports stay inside their harness folders", () => {
  const piViolations: string[] = [];
  const claudeViolations: string[] = [];
  const toolLayerViolations: string[] = [];
  const providerFolderViolations: string[] = [];

  for (const file of sourceFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file);
    const source = readFileSync(file, "utf8");

    // The pi SDK is only imported under piSdk/ (session lifecycle, options,
    // models, one-shot runs, and the AgentTool→pi adapter live there).
    if (!rel.startsWith("piSdk/") && /from\s+"@earendil-works\//.test(source)) {
      piViolations.push(`${rel}: import the pi SDK only under piSdk/`);
    }

    // The Claude Agent SDK is only imported under claudeSdk/.
    if (
      !rel.startsWith("claudeSdk/") &&
      /from\s+"@anthropic-ai\/claude-agent-sdk"/.test(source)
    ) {
      claudeViolations.push(
        `${rel}: import the Claude Agent SDK only under claudeSdk/`,
      );
    }

    // The harness-neutral tool layer must not depend on either agent SDK.
    // `backgroundWork/` is the same kind of boundary: it governs background work
    // for BOTH harnesses through narrow backend ports, so it may not learn what
    // a Claude Query or a pi AgentSession is.
    if (
      (rel.startsWith("mcp/") ||
        rel.startsWith("tools/") ||
        rel.startsWith("backgroundWork/")) &&
      /from\s+"(?:@earendil-works\/|@anthropic-ai\/claude-agent-sdk)/.test(
        source,
      )
    ) {
      toolLayerViolations.push(
        `${rel}: mcp/, tools/ and backgroundWork/ are harness-neutral — no pi or Claude SDK imports`,
      );
    }

    // Neutrality is about the provider FOLDERS too, not just the two SDK
    // packages: `backgroundWork/` reaches a backend through the ports in
    // `backends.ts`, so importing `claudeSdk/` or `piSdk/` would defeat the
    // boundary while importing neither package. Without this the SDK check
    // above is a no-op here, since the global rules already forbid those two
    // packages everywhere outside their own folders.
    if (rel.startsWith("backgroundWork/"))
      for (const specifier of providerFolderImports(source))
        providerFolderViolations.push(
          `${rel}: backgroundWork/ must not import ${specifier} — go through backends.ts`,
        );
  }

  assert.deepEqual(piViolations, [], "pi SDK imports must stay inside piSdk/");
  assert.deepEqual(
    claudeViolations,
    [],
    "Claude Agent SDK imports must stay inside claudeSdk/",
  );
  assert.deepEqual(
    toolLayerViolations,
    [],
    "the tool and background-work layers must stay harness-neutral",
  );
  assert.deepEqual(
    providerFolderViolations,
    [],
    "backgroundWork/ must not reach into claudeSdk/ or piSdk/",
  );
});

test("the background-work provider-folder guard rejects every import form", () => {
  // The scan above is a regression check that passes while nothing violates
  // it, which is exactly when a broken guard looks healthy — so the helper is
  // exercised on real SOURCE here, not on an already-extracted specifier. That
  // distinction matters: an EXTRACTOR gap (a dynamic or bare import the regex
  // never sees) is invisible to a test that starts from a specifier.
  for (const source of [
    `import { ClaudeSdkSession } from "../claudeSdk/ClaudeSdkSession.ts";`,
    `import type { PiSession } from "../piSdk/PiLiveSession.ts";`,
    `export { runQuery } from "../claudeSdk/query.ts";`,
    `export * from "../piSdk/index.ts";`,
    `const mod = await import("../piSdk/oneShot.ts");`,
    `void import("../claudeSdk/oneShot.ts");`,
    `import "../piSdk/register.ts";`,
    `import x from "../../server/src/claudeSdk/query.ts";`,
  ])
    assert.notDeepEqual(
      providerFolderImports(source),
      [],
      `must be rejected: ${source}`,
    );

  for (const source of [
    `import { backgroundWorkStore } from "../db/backgroundWorkStore.ts";`,
    `import type { Harness } from "@assistant/shared";`,
    `const mod = await import("./backends.ts");`,
    `import "node:crypto";`,
    // A folder NAMED in prose is not an import of it; this file's own doc
    // comments and the reference docs mention both folders constantly.
    `// see claudeSdk/ClaudeSdkSession.ts and piSdk/PiLiveSession.ts`,
    // A different folder that merely ends in the same letters.
    `import { thing } from "../notClaudeSdkish/thing.ts";`,
  ])
    assert.deepEqual(
      providerFolderImports(source),
      [],
      `must be allowed: ${source}`,
    );
});

test("pi provider-native background tools use the shared coding capability predicate", () => {
  const source = readFileSync(join(SRC_ROOT, "piSdk/piStore.ts"), "utf8");
  assert.match(
    source,
    /isCodingAgentType\(kind\)[\s\S]{0,120}createPiBackgroundTools/,
  );
  assert.doesNotMatch(
    source,
    /kind\s*===\s*["'](?:workshop|developer)["'][\s\S]{0,120}createPiBackgroundTools/,
  );
});

test("runtime prompt architecture boundaries do not gain new bypasses", () => {
  const directEnginePromptCalls: string[] = [];
  const adapterConstructionViolations: string[] = [];
  const runtimePromptViolations: string[] = [];
  const adapterFactoryViolations: string[] = [];

  for (const file of sourceFiles(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);

    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      if (
        !ENGINE_PROMPT_BRIDGE_FILES.has(rel) &&
        /\b(?:live|sdk|driver)\.prompt\s*\(/.test(line)
      ) {
        directEnginePromptCalls.push(`${rel}:${trimmed}`);
      }

      if (
        !ADAPTER_CONSTRUCTION_FILES.has(rel) &&
        /\bnew\s+(?:PiAdapter|ClaudeSdkAdapter)\s*\(/.test(line)
      ) {
        adapterConstructionViolations.push(
          `${rel}:${index + 1}: construct adapters only in the runtime attachment layer`,
        );
      }

      if (
        !RUNTIME_PROMPT_BRIDGE_FILES.has(rel) &&
        /\b(?:sessionRuntime|runtime)\.prompt\s*\(/.test(line)
      ) {
        runtimePromptViolations.push(
          `${rel}:${index + 1}: call runtime prompts through the runtime prompt facade/view`,
        );
      }

      if (
        !ADAPTER_FACTORY_FILES.has(rel) &&
        /\b(?:createPiAdapter|createClaudeSdkAdapter)\b/.test(line)
      ) {
        adapterFactoryViolations.push(
          `${rel}:${index + 1}: adapter factories are only for engine-owned createRuntimeAdapter methods`,
        );
      }
    });
  }

  assert.deepEqual(
    directEnginePromptCalls.sort(),
    [],
    "direct engine prompts must stay behind adapter bridges",
  );
  assert.deepEqual(
    adapterConstructionViolations,
    [],
    "adapter constructors must stay hidden behind runtime attachment/factory code",
  );
  assert.deepEqual(
    runtimePromptViolations,
    [],
    "app code should not call SessionRuntime.prompt directly",
  );
  assert.deepEqual(
    adapterFactoryViolations,
    [],
    "adapter factories must stay hidden behind engine-owned createRuntimeAdapter methods",
  );
});

/** Every module and package `entry` reaches through value imports. */
function staticReach(entry: string): { modules: string[]; packages: string[] } {
  const VALUE_IMPORT =
    /^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gms;
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [join(SRC_ROOT, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(VALUE_IMPORT)) {
      const specifier = match[1] ?? "";
      if (specifier.startsWith(".")) queue.push(join(dirname(file), specifier));
      else packages.add(specifier);
    }
  }
  return {
    modules: [...seen].map((file) => relative(SRC_ROOT, file)),
    packages: [...packages],
  };
}

function engineLoads(reach: { modules: string[]; packages: string[] }) {
  return [
    // piSdk/models.ts loads the pi SDK at import time.
    ...reach.modules.filter((rel) => rel === "piSdk/models.ts"),
    ...reach.packages.filter(
      (name) =>
        name.startsWith("@earendil-works/") ||
        name === "@anthropic-ai/claude-agent-sdk",
    ),
  ];
}

/**
 * Helper runs are reached from tool modules and most of the server, so the
 * entry point must not load the pi SDK (~0.75s) before a pi run needs it:
 * `piSdk/oneShot.ts` loads it on first use (`docs/agent-harnesses.md`).
 */
test("runOneShot loads no engine SDK until a run needs it", () => {
  const reach = staticReach("harnesses/oneShot.ts");
  assert.ok(
    reach.modules.includes("piSdk/oneShot.ts"),
    "the walk reaches the runner",
  );
  assert.deepEqual(engineLoads(reach), []);
});

/**
 * Session-list rows name a Claude model through the curated list, which must
 * stay cheap: `harnesses/models.ts` reaches pi's registry, this module may not.
 */
test("curated model options load no engine SDK", () => {
  assert.deepEqual(engineLoads(staticReach("harnesses/curatedModels.ts")), []);
});

/**
 * Session creation sits below app code (`docs/agent-harnesses.md`): it reaches
 * the hub's behaviour only through what the hub hands the registry, never by
 * importing `hub.ts` or the connection.
 */
test("session creation, the first send and forks import neither the hub nor the connection", () => {
  for (const entry of [
    "harnesses/create.ts",
    "harnesses/firstSend.ts",
    "harnesses/fork.ts",
  ]) {
    const { modules } = staticReach(entry);
    // The walk must see the engines, or a miss below would prove nothing.
    assert.ok(
      modules.includes("claudeSdk/claudeSdkStore.ts"),
      `${entry} walk never reached the Claude store`,
    );
    assert.ok(!modules.includes("hub.ts"), `${entry} reaches hub.ts`);
    assert.ok(
      !modules.includes("connection.ts"),
      `${entry} reaches connection.ts`,
    );
  }
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Agent-spawned peer sessions ([Task-553](pa://task/553),
 * [Task-595](pa://task/595)) are ORDINARY user sessions. The lighter
 * experimentation lane must not quietly acquire governed-subagent semantics —
 * an ownership registry, a terminal result contract, a watchdog — and the way
 * that would happen first is an import.
 */
test("the peer-spawn lane never reaches into the subagent domain", () => {
  for (const file of [
    "sessionSpawn.ts",
    "peerSpawnRuntimes.ts",
    "tools/sessions/sessionSpawnTool.ts",
  ]) {
    const source = readFileSync(join(SRC_ROOT, file), "utf8");
    assert.equal(
      /from\s+"[^"]*subagent/i.test(source),
      false,
      `${file} must not import the subagent registry or store`,
    );
  }
});

test("peer-prompt delivery never steers/interrupts a target or emits an info notice", () => {
  const engine = readFileSync(join(SRC_ROOT, "peerPrompt.ts"), "utf8");
  // Task 88: peer prompts are delivered as fresh turns; never steer/abort a busy
  // target. The one steer is the recipient's USER asking for it from the
  // composer queue (Task 759): `steerPeerPrompt`, reached only from that command.
  const steerStart = engine.indexOf("async function steerPeerPrompt(");
  assert.ok(steerStart >= 0, "steerPeerPrompt exists");
  const steerEnd = engine.indexOf("\n}\n", steerStart);
  const outsideSteer =
    engine.slice(0, steerStart) + engine.slice(steerEnd + "\n}\n".length);
  assert.equal(
    /steer\s*:/.test(outsideSteer),
    false,
    "automatic peer-prompt delivery must not pass steer",
  );
  const callers = engine.match(/\bsteerPeerPrompt\(/g) ?? [];
  assert.equal(
    callers.length,
    2,
    "steerPeerPrompt is declared once and called only by sendQueuedPeerPromptNow",
  );
  const sendNow = engine.slice(
    engine.indexOf("export async function sendQueuedPeerPromptNow("),
    steerStart,
  );
  assert.match(sendNow, /steerPeerPrompt\(/);
  assert.equal(
    /\.abort\s*\(/.test(engine),
    false,
    "peer-prompt delivery must not abort/interrupt a target",
  );
  // Task 104: the engine emits no global notices; state lives on the durable card/thread.
  assert.equal(
    /type\s*:\s*"notice"/.test(engine),
    false,
    "peer-prompt engine must not emit notices",
  );

  // Task 104: the drain-on-open path emits no informational notice either.
  const connection = readFileSync(join(SRC_ROOT, "connection.ts"), "utf8");
  const start = connection.indexOf("private async deliverPendingAgentRelays(");
  assert.ok(start >= 0, "deliverPendingAgentRelays method exists");
  const body = connection.slice(
    start,
    connection.indexOf("\n  private ", start + 1),
  );
  assert.equal(
    /type\s*:\s*"notice"/.test(body),
    false,
    "peer-prompt delivery on session open must not emit a notice",
  );
});

/**
 * State-sync (docs/state-sync.md): for a MIGRATED domain, a mutation travels on
 * the wire only as state events. Tasks is the pilot, so no Task mutation reply
 * and no Task broadcast may carry a full collection — the whole point of the
 * model is that a status toggle stops pushing ~140 KB of list to every browser,
 * and a single well-meaning `list:` rider puts it straight back.
 */
test("Task mutations carry no full-collection payload", () => {
  const connection = readFileSync(join(SRC_ROOT, "connection.ts"), "utf8");
  const hub = readFileSync(join(SRC_ROOT, "hub.ts"), "utf8");

  // The snapshot survives in exactly one place: the subscribe/read answer.
  const snapshotSends = [...connection.matchAll(/type:\s*"taskList"/g)].length;
  assert.equal(
    snapshotSends,
    1,
    "`taskList` is the subscribe/read answer only; mutations answer with events",
  );
  const listAnswer = connection.indexOf("private onListTasks(");
  assert.ok(listAnswer >= 0, "onListTasks exists");
  assert.ok(
    connection.slice(listAnswer).indexOf('type: "taskList"') <
      connection.slice(listAnswer).indexOf("private onSaveTask("),
    "the one `taskList` send belongs to onListTasks",
  );
  assert.equal(
    /type:\s*"taskList"/.test(hub),
    false,
    "the hub broadcasts Task changes as `stateEvents`, never as a list",
  );

  // The mutator's direct reply carries the full item and nothing collective.
  const protocolPath = join(SRC_ROOT, "..", "..", "shared", "protocol.ts");
  const protocol = readFileSync(protocolPath, "utf8");
  for (const message of ["taskSaved", "taskProjectsAssigned"]) {
    const declaration = protocol.slice(
      protocol.indexOf(`type: "${message}"`),
      protocol.indexOf(`type: "${message}"`) + 200,
    );
    const shape = declaration.slice(0, declaration.indexOf("}"));
    assert.equal(
      /\blist\b/.test(shape),
      false,
      `${message} must not carry a list; the rows are state events`,
    );
  }
});

/**
 * Settings writes go through `settingsService.saveSettings`
 * ([Task-729](pa://task/729)), which runs each section's side effects and
 * pushes the result to every client. A direct call to a section writer skips
 * both: the change lands on disk while open Settings pages and live sessions
 * keep the old values. Tests may still seed settings directly: `sourceFiles`
 * skips `*.test.ts`.
 */
test("settings are written only through the settings service", () => {
  const writer = /\bupdate(?:[A-Z][A-Za-z0-9]*)?Settings\s*\(/g;
  const offenders: string[] = [];
  for (const path of sourceFiles(SRC_ROOT)) {
    const file = relative(SRC_ROOT, path);
    if (file === "settingsService.ts") continue;
    // Comments may name a writer; only code calls one.
    const source = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const match of source.matchAll(writer)) {
      // A writer's own definition is not a call.
      const before = source.slice(Math.max(0, match.index - 16), match.index);
      if (/function\s+$/.test(before)) continue;
      offenders.push(`${file}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, []);
});
