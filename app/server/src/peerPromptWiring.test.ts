/**
 * Regression guard for peer-prompt boot wiring (Task 82 review round 3
 * blocker): `sweepPeerPromptRetries`/`sweepExpiredLeases` are the ONLY paths
 * back from `retryable_failed`/an expired dispatch lease, and are meant to run
 * at boot AND on a periodic interval in the real server. `index.ts` runs
 * side-effecting top-level code (binds an HTTP port), so it cannot be
 * `import`ed directly in a unit test; this asserts the wiring statically,
 * mirroring `architecture.test.ts`'s source-text invariant pattern, so a
 * future refactor cannot silently drop the sweep calls again.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const SRC_ROOT = dirname(fileURLToPath(import.meta.url));

test("index.ts wires both peer-prompt sweeps at boot and on a periodic interval", () => {
  const source = readFileSync(join(SRC_ROOT, "index.ts"), "utf8");

  assert.match(
    source,
    /import\s*\{[^}]*\bsweepPeerPromptRetries\b[^}]*\}\s*from\s*"\.\/peerPrompt\.ts"/,
    "sweepPeerPromptRetries must be imported from peerPrompt.ts",
  );
  assert.match(
    source,
    /import\s*\{[^}]*\bsweepExpiredLeases\b[^}]*\}\s*from\s*"\.\/peerPrompt\.ts"/,
    "sweepExpiredLeases must be imported from peerPrompt.ts",
  );
  assert.match(
    source,
    /import\s*\{[^}]*\bRETRY_SWEEP_INTERVAL_MS\b[^}]*\}\s*from\s*"\.\/peerPrompt\.ts"/,
    "RETRY_SWEEP_INTERVAL_MS must be imported from peerPrompt.ts",
  );

  // Both sweeps must be invoked at least twice: once at boot, once inside the interval.
  const retryCalls = source.match(/\bsweepPeerPromptRetries\s*\(/g) ?? [];
  const leaseCalls = source.match(/\bsweepExpiredLeases\s*\(/g) ?? [];
  assert.ok(
    retryCalls.length >= 2,
    `sweepPeerPromptRetries must be called at boot AND on an interval (found ${retryCalls.length} call site(s))`,
  );
  assert.ok(
    leaseCalls.length >= 2,
    `sweepExpiredLeases must be called at boot AND on an interval (found ${leaseCalls.length} call site(s))`,
  );

  // The interval must actually use the configured sweep constant, not a hardcoded duration.
  assert.match(
    source,
    /setInterval\(\s*\(\)\s*=>\s*\{[\s\S]{0,400}?\bsweepPeerPromptRetries\s*\([\s\S]{0,400}?\},\s*RETRY_SWEEP_INTERVAL_MS\s*\)/,
    "the periodic sweep interval must be scheduled with RETRY_SWEEP_INTERVAL_MS",
  );
});

test("background lifecycle and idle delivery stay wired behind peer FIFO", () => {
  const source = readFileSync(join(SRC_ROOT, "index.ts"), "utf8");

  assert.match(
    source,
    /hub\.registerLifecycleDrainParticipant\s*\(\s*\{/,
    "background work must register with the existing hub lifecycle authority",
  );
  assert.match(
    source,
    /new BackgroundCompletionDelivery\s*\(\s*\{[\s\S]{0,300}?drainPeers:\s*\(sessionId\)\s*=>\s*drainRecipient\(sessionId\)/,
    "background completion must drain the durable peer FIFO first",
  );
  assert.match(
    source,
    /setSessionIdleHook\s*\(\s*\(sessionId\)\s*=>\s*\{[\s\S]{0,400}?void backgroundCompletionDelivery\.drain\(sessionId\)/,
    "the idle hook must enter the peer-first background delivery gate",
  );
});

test("graceful shutdown stops peer-prompt delivery so the drain can settle", () => {
  const source = readFileSync(join(SRC_ROOT, "index.ts"), "utf8");

  assert.match(
    source,
    /import\s*\{[^}]*\bstopPeerPromptDelivery\b[^}]*\}\s*from\s*"\.\/peerPrompt\.ts"/,
    "stopPeerPromptDelivery must be imported from peerPrompt.ts",
  );
  // Must be invoked inside the graceful-shutdown handler: otherwise the idle
  // hook keeps re-driving idle sessions from the queue and the drain never
  // settles, so `nixos-rebuild switch` blocks until the force timeout.
  assert.match(
    topLevelFunctionSource(source, "requestGracefulShutdown"),
    /\bstopPeerPromptDelivery\s*\(\s*\)/,
    "requestGracefulShutdown must call stopPeerPromptDelivery()",
  );
});

/**
 * Source text of a top-level function declaration, from its `function` keyword
 * to the column-0 `}` that closes it. Scoping the assertion to the body beats
 * a character-window regex, which silently breaks when the body is reflowed.
 */
function topLevelFunctionSource(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must be declared in index.ts`);
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, `${name} must be a top-level function declaration`);
  return source.slice(start, end);
}
