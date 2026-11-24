/**
 * The upgrade to engine bindings (migration 0102, `docs/session-runtime-
 * switching.md` "Engine bindings"): every stored session gets exactly one
 * active binding equal to its row, and still opens and runs afterwards through
 * the normal open path (`harnessRegistry.acquireById`).
 *
 * The database is seeded through 0101 with a raw connection, with the
 * bookkeeping the runner writes, and rows shaped as each earlier build wrote
 * them; the native stores are written beside it. `getDb()` then applies 0102
 * in the runner's own transaction, as a real upgrade does.
 *
 *   pnpm --filter @assistant/server test src/sessionEngineBindingUpgrade.test.ts
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, test, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type { PiEngineHandle } from "./piSdk/piEngine.ts";
import type { PiEngineOpenSpec } from "./piSdk/piEngineHost.ts";
import { databaseBefore } from "./test/schemaBefore.ts";

const tmp = mkdtempSync(join(tmpdir(), "engine-binding-upgrade-"));
const dataDir = join(tmp, "data");
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = dataDir;
mkdirSync(join(dataDir, "settings"), { recursive: true });
writeFileSync(
  join(dataDir, "settings", "app.json"),
  JSON.stringify({ claudeSdk: { enabled: true } }),
);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const BINDING_MIGRATION = "0102_session_engine_binding.sql";
const T0 = 1_760_000_000_000;

/** A session_index row as an earlier build wrote it. */
interface LegacyRow {
  id: string;
  scope?: "user" | "internal";
  purpose?: string;
  harness: "pi" | "claude-sdk";
  agent_type: string;
  provider?: string | null;
  provider_session_id?: string | null;
  model?: string | null;
  thinking_level?: string | null;
  credential_profile_id?: string | null;
  fork_origin_json?: string | null;
  requires_enterprise?: number;
  deleted_at_ms?: number | null;
  message_count?: number;
}

const ROWS: LegacyRow[] = [
  // A pi session from before the native id was recorded at all.
  {
    id: "pi-plain",
    harness: "pi",
    agent_type: "assistant",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinking_level: "medium",
    credential_profile_id: "default",
    message_count: 2,
  },
  // A pi row whose provider_session_id names something else: pi opens the
  // transcript its app id names, so the binding's native id is the app id.
  {
    id: "pi-odd-native",
    harness: "pi",
    agent_type: "developer",
    provider: "openai-codex",
    provider_session_id: "stale-native-id",
    model: "gpt-5.6-sol",
    credential_profile_id: "default",
    message_count: 2,
  },
  // `reconcileMissingPiSessionMetadata`'s row: developer, no account, its own
  // id as provider_session_id.
  {
    id: "pi-recovered",
    harness: "pi",
    agent_type: "developer",
    provider: "openai-codex",
    provider_session_id: "pi-recovered",
    model: "gpt-5.6-sol",
    message_count: 2,
  },
  // A Claude session from before account routing: no account on the row.
  {
    id: "claude-prerouting",
    harness: "claude-sdk",
    agent_type: "assistant",
    provider: "claude",
    provider_session_id: "claude-native-1",
    model: "sonnet",
    thinking_level: "high",
    credential_profile_id: null,
    message_count: 2,
  },
  // A Claude session that never ran: no native id yet.
  {
    id: "claude-unstarted",
    harness: "claude-sdk",
    agent_type: "workshop",
    provider: "claude",
    model: "opus",
    credential_profile_id: "claude-default",
  },
  // A fork, an enterprise-pinned internal session, a tombstone, a NULL model.
  {
    id: "pi-fork",
    harness: "pi",
    agent_type: "assistant",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    credential_profile_id: "default",
    fork_origin_json: JSON.stringify({ sessionId: "pi-plain", title: "x" }),
  },
  {
    id: "claude-internal",
    scope: "internal",
    purpose: "usage",
    harness: "claude-sdk",
    agent_type: "assistant",
    provider: "claude",
    provider_session_id: "claude-native-2",
    model: "haiku",
    credential_profile_id: "claude-enterprise",
    requires_enterprise: 1,
  },
  {
    id: "pi-deleted",
    harness: "pi",
    agent_type: "assistant",
    credential_profile_id: "default",
    deleted_at_ms: T0 + 5,
  },
];

function seedDatabaseThrough0101(): void {
  const raw = databaseBefore(dataDir, BINDING_MIGRATION);
  const insert = raw.prepare(
    `INSERT INTO session_index (
       id, scope, purpose, harness, agent_type, title, created_at_ms,
       updated_at_ms, message_count, provider, provider_session_id, model,
       thinking_level, credential_profile_id, fork_origin_json,
       requires_enterprise, deleted_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  ROWS.forEach((row, index) =>
    insert.run(
      row.id,
      row.scope ?? "user",
      row.purpose ?? "chat",
      row.harness,
      row.agent_type,
      `Title ${row.id}`,
      T0 + index,
      T0 + index,
      row.message_count ?? 0,
      row.provider ?? null,
      row.provider_session_id ?? null,
      row.model ?? null,
      row.thinking_level ?? null,
      row.credential_profile_id ?? null,
      row.fork_origin_json ?? null,
      row.requires_enterprise ?? 0,
      row.deleted_at_ms ?? null,
    ),
  );
  raw.close();
}

/** A pi transcript as pi writes it: header, then one exchange. */
function writePiTranscript(file: string, id: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const lines = [
    {
      type: "session",
      version: 3,
      id,
      timestamp: new Date(T0).toISOString(),
      cwd: tmp,
    },
    {
      type: "model_change",
      id: "c1",
      parentId: null,
      timestamp: new Date(T0).toISOString(),
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
    },
    {
      type: "thinking_level_change",
      id: "c2",
      parentId: "c1",
      timestamp: new Date(T0).toISOString(),
      thinkingLevel: "medium",
    },
    {
      type: "message",
      id: "m1",
      parentId: "c2",
      timestamp: new Date(T0 + 1).toISOString(),
      message: { role: "user", content: "Earlier question", timestamp: T0 + 1 },
    },
    {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: new Date(T0 + 2).toISOString(),
      message: {
        role: "assistant",
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        content: [{ type: "text", text: "Earlier answer" }],
        stopReason: "stop",
        usage,
        timestamp: T0 + 2,
      },
    },
  ];
  writeFileSync(
    file,
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
}

seedDatabaseThrough0101();
for (const id of ["pi-plain", "pi-odd-native", "pi-recovered"])
  writePiTranscript(join(dataDir, "sessions", id, "native.jsonl"), id);

const { seedLegacyDefaultAccounts } =
  await import("./test/legacyDefaultAccounts.ts");
await seedLegacyDefaultAccounts();
const profiles = await import("./credentialProfiles.ts");
writeFileSync(
  join(profiles.piAgentDir("default"), "auth.json"),
  JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access: "test-token",
      refresh: "test-refresh",
      expires: Date.now() + 86400_000,
    },
  }),
);
writeFileSync(
  join(profiles.claudeConfigDir("claude-default"), ".credentials.json"),
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "test-token",
      refreshToken: "test-refresh",
      expiresAt: Date.now() + 86400_000,
    },
  }),
);

const { DATA_DIR } = await import("./config.ts");
const { writeClaudeSdkRecord } =
  await import("./claudeSdk/claudeSdkRecords.ts");
writeClaudeSdkRecord(
  join(DATA_DIR, "claude-sdk"),
  {
    id: "claude-prerouting",
    title: "Title claude-prerouting",
    providerSessionId: "claude-native-1",
    modelId: "sonnet",
    thinkingLevel: "high",
    agentType: "assistant",
    createdAt: T0 + 3,
    updatedAt: T0 + 3,
  },
  [],
  undefined,
);

const { getDb } = await import("./db/index.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { nativePiSessionForTests } = await import("./piSdk/piEngine.ts");
const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { claudeTurnSeam } = await import("./test/claudeTurnSeam.ts");
const { harnessRegistry } = await import("./harnesses/registry.ts");
const { sessionRuntime } = await import("./session/runtimeInstance.ts");
const { ensureRuntimeSessionWithRuntime } =
  await import("./session/runtimePrompt.ts");
const lifecycle = await import("./session/runtime/liveSession.ts");
const { piSessionFile } = await import("./piSessionFile.ts");
const { reconcileMissingPiSessionMetadata } = await import("./sessions.ts");
await import("./hub.ts");
claudeSdkStore.setSeam(() => Promise.resolve(claudeTurnSeam));

/** Every pi engine opened from here answers each request with one reply. */
const piInternals = piStore as unknown as {
  openEngine: (
    spec: PiEngineOpenSpec,
  ) => Promise<{ engine: PiEngineHandle; info: unknown }>;
};
const originalOpen = piInternals.openEngine.bind(piStore);
vi.spyOn(piInternals, "openEngine").mockImplementation(async (spec) => {
  const opened = await originalOpen(spec);
  const session = nativePiSessionForTests(opened.engine);
  session.setAutoRetryEnabled(false);
  session.agent.streamFunction = (model) => {
    const message: AssistantMessage = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "text", text: "Upgraded answer" }],
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
  return opened;
});

/** The row's six binding columns, read raw. */
function projection(id: string): Record<string, unknown> {
  return {
    ...(getDb()
      .prepare(
        `SELECT harness, provider, model, thinking_level, credential_profile_id
           FROM session_index WHERE id = ?`,
      )
      .get(id) as Record<string, unknown>),
  };
}

/** The active binding's matching columns, read raw. */
function activeColumns(id: string): Record<string, unknown> | undefined {
  const row = getDb()
    .prepare(
      `SELECT harness, provider, model, thinking_level, credential_profile_id
         FROM session_engine_binding WHERE session_id = ? AND ended_at_ms IS NULL`,
    )
    .get(id) as Record<string, unknown> | undefined;
  return row ? { ...row } : undefined;
}

test("the upgrade gives every stored session exactly one active binding equal to its row", () => {
  // The first getDb() applies 0102 through the real runner.
  for (const row of ROWS) {
    const all = sessionStore.bindings(row.id);
    assert.equal(all.length, 1, `${row.id} has one binding`);
    assert.equal(all[0]!.seq, 1);
    assert.equal(all[0]!.startedSeq, 0);
    assert.equal(all[0]!.startedRunId, undefined);
    assert.equal(all[0]!.endedAt, undefined, `${row.id}'s binding is active`);
    assert.deepEqual(activeColumns(row.id), projection(row.id), row.id);
  }
  const native = (id: string) =>
    sessionStore.activeBinding(id)?.nativeSessionId;
  assert.equal(native("pi-plain"), "pi-plain");
  assert.equal(native("pi-odd-native"), "pi-odd-native");
  assert.equal(native("pi-recovered"), "pi-recovered");
  assert.equal(native("pi-deleted"), "pi-deleted", "tombstones are bound too");
  assert.equal(native("claude-prerouting"), "claude-native-1");
  assert.equal(native("claude-unstarted"), undefined);
  assert.equal(native("claude-internal"), "claude-native-2");
  assert.equal(
    sessionStore.activeBinding("claude-prerouting")?.credentialProfileId,
    undefined,
    "a pre-routing session keeps its unset account",
  );
  assert.equal(
    sessionStore.activeBinding("claude-internal")?.credentialProfileId,
    "claude-enterprise",
  );
  // Rows are untouched: the pi row's stale provider_session_id stays.
  assert.equal(
    sessionStore.get("pi-odd-native")?.providerSessionId,
    "stale-native-id",
  );
  for (const id of ["pi-plain", "pi-odd-native", "pi-recovered"])
    assert.equal(
      piSessionFile(id),
      join(DATA_DIR, "sessions", id, "native.jsonl"),
    );
});

/** Open through the normal path, run one turn, and return its run stamp. */
async function openAndRun(id: string) {
  const live = await harnessRegistry.acquireById(id);
  assert.ok(live, `${id} opens after the upgrade`);
  ensureRuntimeSessionWithRuntime(sessionRuntime, live);
  const stamps: unknown[] = [];
  const unsubscribe = lifecycle.subscribeSessionRunCompleted(
    (sessionId, stopReason, _origin, engine) => {
      if (sessionId === id) stamps.push({ stopReason, engine });
    },
  );
  try {
    await sessionRuntime.prompt(id, "After the upgrade");
    await vi.waitFor(() => assert.equal(stamps.length, 1));
  } finally {
    unsubscribe();
  }
  const stamp = stamps[0] as { stopReason: string; engine: unknown };
  // The listener's engine is the one the run's `run.started` marker recorded.
  const started = readFileSync(
    join(DATA_DIR, "sessions", id, "log.jsonl"),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; engine?: unknown })
    .filter((entry) => entry.type === "run.started");
  assert.equal(started.length, 1);
  assert.deepEqual(started[0]!.engine, stamp.engine);
  return { live, stamp };
}

test.each(["pi-plain", "pi-odd-native", "pi-recovered"])(
  "an upgraded pi session %s opens through the normal path and runs",
  async (id) => {
    const { live, stamp } = await openAndRun(id);
    assert.equal(live.harness, "pi");
    assert.equal(
      live.sessionFile,
      join(DATA_DIR, "sessions", id, "native.jsonl"),
    );
    assert.equal(stamp.stopReason, "end");
    // The run records the engine it ran on: a row without an account ran on
    // the legacy default, which the stamp names.
    assert.deepEqual(stamp.engine, {
      harness: "pi",
      credentialProfileId: "default",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinkingLevel: "medium",
    });
    const native = readFileSync(live.sessionFile!, "utf8");
    assert.match(native, /Earlier answer/);
    assert.match(native, /Upgraded answer/);
    assert.equal(sessionStore.bindings(id).length, 1);
    assert.deepEqual(activeColumns(id), projection(id));
    assert.equal(sessionStore.activeBinding(id)?.nativeSessionId, id);
  },
);

test("an upgraded pre-routing Claude session opens through the normal path and runs", async () => {
  const { live, stamp } = await openAndRun("claude-prerouting");
  assert.equal(live.harness, "claude-sdk");
  assert.equal(stamp.stopReason, "end");
  assert.equal((stamp.engine as { harness: string }).harness, "claude-sdk");
  assert.equal((stamp.engine as { model?: string }).model, "sonnet");
  // The run's answer re-synced the row, and the binding with it.
  const binding = sessionStore.activeBinding("claude-prerouting");
  assert.equal(sessionStore.bindings("claude-prerouting").length, 1);
  assert.equal(
    binding?.nativeSessionId,
    sessionStore.get("claude-prerouting")?.providerSessionId,
  );
  assert.deepEqual(
    activeColumns("claude-prerouting"),
    projection("claude-prerouting"),
  );
});

test("rowless recovery after the upgrade writes the row and its binding together", () => {
  writePiTranscript(
    join(DATA_DIR, "sessions", "pi-orphan", "native.jsonl"),
    "pi-orphan",
  );
  assert.equal(reconcileMissingPiSessionMetadata(), 1);
  const binding = sessionStore.activeBinding("pi-orphan");
  assert.equal(binding?.seq, 1);
  assert.equal(binding?.harness, "pi");
  assert.equal(binding?.nativeSessionId, "pi-orphan");
  assert.deepEqual(activeColumns("pi-orphan"), projection("pi-orphan"));
});
