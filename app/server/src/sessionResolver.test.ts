/**
 * Standalone unit test for the metadata-backed id-only resolver
 * `hub.acquireById`.
 *
 * Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/sessionResolver.test.ts
 *
 * It points the data dir at a fresh temp folder (via ASSISTANT_CWD, which
 * config.ts honors over INIT_CWD/cwd), then asserts that `acquireById` — given
 * ONLY our session id (no kind) — looks the id up in the {@link sessionStore}
 * and dispatches to the correct backing per the record's {@link Harness}:
 *
 *   - `claude-sdk` → a {@link ClaudeSdkSession} (acquireClaudeSdk), live + cheap.
 *   - `pi`         → reopen from the canonical log path DERIVED from our id.
 *
 * The pi branch is asserted MECHANICS-ONLY: reopening a real pi file would need a
 * live AgentSession (auth + model registry), so we stub `piStore.acquireExisting`
 * (the seam the resolver's pi branch reopens through) and assert the resolver
 * calls it with the agentType-derived kind, the canonical (id-derived) path, and
 * our id as the `expectedId` guard. No real model calls or dev server are
 * involved anywhere in this test.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

// Root the data dir at an isolated temp dir BEFORE importing the hub/store/config.
const tmp = mkdtempSync(join(tmpdir(), "session-resolver-test-"));
process.env.ASSISTANT_CWD = tmp;

const { hub } = await import("./hub.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { canonicalPiSessionPath } = await import("./sessionStorage.ts");
const { sessionDirFor } = await import("./piSdk/options.ts");

const PI_ID = `pi-${Date.now()}`;
const PI_LEGACY_ID = `pi-legacy-${Date.now()}`;
const PI_NOFILE_ID = `pi-nofile-${Date.now()}`;
const SDK_ID = `sdk-${Date.now()}`;

function seedFor(
  harness: "pi" | "claude-sdk",
  id: string,
  agentType: "assistant" | "workshop" = "workshop",
): void {
  const now = Date.now();
  sessionStore.upsert({
    id,
    harness,
    agentType,
    title: `Title ${id}`,
    createdAt: now,
    updatedAt: now,
    messageCount: 1,
  });
}

function writePiLog(file: string, id: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      JSON.stringify({
        type: "session",
        id,
        timestamp: new Date().toISOString(),
        cwd: tmp,
      }),
      JSON.stringify({
        type: "message",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "hello" },
      }),
      "",
    ].join("\n"),
  );
  return file;
}

function writeCanonicalPiLog(id: string): string {
  return writePiLog(canonicalPiSessionPath(id), id);
}

function writeLegacyPiLog(id: string): string {
  return writePiLog(
    join(sessionDirFor("workshop"), `2026-01-01T00-00-00-000Z_${id}.jsonl`),
    id,
  );
}

async function main(): Promise<void> {
  /* ------------------------------- unknown id ----------------------------- */
  assert.equal(
    await hub.acquireById("does-not-exist"),
    undefined,
    "unknown id resolves undefined",
  );

  /* -------------------------------- claude-sdk ---------------------------- */
  seedFor("claude-sdk", SDK_ID);
  const sdk = await hub.acquireById(SDK_ID);
  assert.ok(sdk, "claude-sdk id resolves a driver");
  assert.equal(
    sdk.kind,
    "workshop",
    "claude-sdk driver kind is the workshop persona",
  );
  assert.equal(
    sdk.harness,
    "claude-sdk",
    "driver reports the claude-sdk harness",
  );
  assert.equal(
    sdk.agentType,
    "workshop",
    "claude-sdk driver agentType=workshop",
  );
  assert.equal(sdk.id, SDK_ID, "driver id equals our id");
  assert.equal(
    hub.getLiveById(SDK_ID),
    sdk,
    "getLiveById returns the same live sdk session",
  );

  /* ---------------------------------- pi ---------------------------------- */
  // Stub acquireExisting so we never need a real AgentSession/auth/model registry.
  // The resolver must reopen from the canonical (id-derived) path + the
  // agentType-derived kind, with our id as the expectedId guard.
  const calls: Array<{ kind: string; file: string; expectedId?: string }> = [];
  const sentinel = {
    id: PI_ID,
    kind: "workshop",
    harness: "pi",
  } as unknown as Awaited<ReturnType<typeof hub.acquireById>>;
  const original = piStore.acquireExisting.bind(piStore);
  (
    piStore as unknown as { acquireExisting: typeof piStore.acquireExisting }
  ).acquireExisting = (async (
    kind: string,
    file: string,
    expectedId?: string,
  ) => {
    calls.push({
      kind,
      file,
      ...(expectedId !== undefined ? { expectedId } : {}),
    });
    return sentinel as never;
  }) as typeof piStore.acquireExisting;

  try {
    // workshop agentType → workshop pi kind; canonical log present → reopened.
    seedFor("pi", PI_ID, "workshop");
    const piFile = writeCanonicalPiLog(PI_ID);
    const pi = await hub.acquireById(PI_ID);
    assert.equal(
      pi,
      sentinel,
      "pi branch returns the (stubbed) reopened session",
    );
    assert.equal(calls.length, 1, "pi branch reopened exactly once");
    assert.deepEqual(
      calls[0],
      { kind: "workshop", file: piFile, expectedId: PI_ID },
      "pi resolver reopens from the canonical id-derived path with the agentType-derived kind and our id as expectedId",
    );

    // assistant agentType → assistant pi kind.
    seedFor("pi", PI_ID, "assistant");
    await hub.acquireById(PI_ID);
    assert.equal(calls.length, 2, "second pi reopen recorded");
    assert.equal(
      calls[1]?.kind,
      "assistant",
      "assistant agentType maps to the assistant pi kind",
    );

    // A fork created before canonicalization can still have its native
    // transcript in the persona directory. Reopen it through acquireExisting,
    // whose legacy-path handling moves it to the canonical location.
    seedFor("pi", PI_LEGACY_ID, "workshop");
    const legacyFile = writeLegacyPiLog(PI_LEGACY_ID);
    await hub.acquireById(PI_LEGACY_ID);
    assert.deepEqual(
      calls[2],
      { kind: "workshop", file: legacyFile, expectedId: PI_LEGACY_ID },
      "pi resolver recovers a valid legacy transcript by id",
    );

    // A pi record with neither canonical nor legacy transcript cannot reopen.
    seedFor("pi", PI_NOFILE_ID, "workshop");
    assert.equal(
      await hub.acquireById(PI_NOFILE_ID),
      undefined,
      "pi record without a transcript resolves undefined",
    );
    assert.equal(calls.length, 3, "no reopen attempted without a transcript");
  } finally {
    (
      piStore as unknown as { acquireExisting: typeof piStore.acquireExisting }
    ).acquireExisting = original;
  }

  console.log("sessionResolver unit test: PASS");
}

test("resolves sessions by metadata-backed id", async () => {
  try {
    await main();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
