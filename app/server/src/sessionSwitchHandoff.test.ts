/**
 * The handoff a switched session owes its new engine
 * (`docs/session-runtime-switching.md` "Handoff"): none on a first binding,
 * the whole log after a fresh switch until the new engine replies, and only
 * what a resumed engine missed on a return.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, test } from "vitest";
import type { SessionPendingRuntime } from "@assistant/shared";
import { sessionStore } from "./db/sessionStore.ts";
import { logPathFor } from "./session/log/persistence.ts";
import { owedSwitchContext } from "./sessionSwitchHandoff.ts";
import { seedLegacyDefaultAccounts } from "./test/legacyDefaultAccounts.ts";

await seedLegacyDefaultAccounts();

const ids: string[] = [];
afterEach(() => {
  for (const id of ids.splice(0)) sessionStore.remove(id);
});

const PENDING: SessionPendingRuntime = {
  model: { provider: "openai-codex", id: "gpt-5.6-sol" },
  thinkingLevel: "high",
  account: { kind: "automatic" },
  setBy: "user",
};

function append(id: string, rows: unknown[]): void {
  const path = logPathFor(id);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

function message(seq: number, role: "user" | "assistant", text: string) {
  return {
    type: "message",
    role,
    seq,
    id: `m${seq}`,
    content: [{ type: "text", text }],
  };
}

function onClaude(id: string, native: string): void {
  ids.push(id);
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "claude-sdk",
      agentType: "developer",
      provider: "claude",
      providerSessionId: native,
      model: "sonnet",
      credentialProfileId: "claude-default",
    }),
  );
}

function toPi(id: string, expectSeq: number, startedSeq: number): void {
  sessionStore.switchEngineBinding(id, {
    expectSeq,
    fields: {
      harness: "pi",
      credentialProfileId: "cp_pi",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinkingLevel: "high",
      providerSessionId: null,
    },
    nativeSessionId: id,
    startedSeq,
    pending: PENDING,
  });
}

test("a fresh switch owes the whole log until the new engine replies", () => {
  const id = `switch-handoff-${Date.now()}-fresh`;
  onClaude(id, `native-${id}`);
  append(id, [message(1, "user", "first ask"), message(2, "assistant", "ok")]);
  assert.equal(owedSwitchContext(id), undefined, "a first binding owes none");

  toPi(id, 1, 2);
  const owed = owedSwitchContext(id);
  assert.match(owed ?? "", /^<session-switch>\nSession switch: this session/);
  assert.match(owed ?? "", /first ask/);
  assert.match(owed ?? "", /\nok\n|\nok$/m);
  assert.doesNotMatch(owed ?? "", /You ran this session before/);

  // A turn that failed before any reply still owes it.
  append(id, [message(3, "user", "next ask")]);
  assert.match(owedSwitchContext(id) ?? "", /next ask/);

  append(id, [message(4, "assistant", "on pi now")]);
  assert.equal(owedSwitchContext(id), undefined);
});

test("a return owes only what the resumed engine missed", () => {
  const id = `switch-handoff-${Date.now()}-return`;
  const native = `native-${id}`;
  onClaude(id, native);
  append(id, [
    message(1, "user", "asked on claude"),
    message(2, "assistant", "claude answered"),
  ]);
  toPi(id, 1, 2);
  append(id, [
    message(3, "user", "asked on pi"),
    message(4, "assistant", "pi answered"),
  ]);
  sessionStore.switchEngineBinding(id, {
    expectSeq: 2,
    fields: {
      harness: "claude-sdk",
      credentialProfileId: "claude-default",
      provider: "claude",
      model: "opus",
      thinkingLevel: "high",
      providerSessionId: native,
    },
    nativeSessionId: native,
    startedSeq: 4,
    pending: { ...PENDING, model: { provider: "claude", id: "opus" } },
  });
  const owed = owedSwitchContext(id) ?? "";
  assert.match(owed, /You ran this session before/);
  assert.match(owed, /asked on pi/);
  assert.match(owed, /pi answered/);
  assert.doesNotMatch(owed, /asked on claude/);
});
