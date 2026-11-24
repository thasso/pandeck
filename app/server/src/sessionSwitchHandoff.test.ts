/**
 * The handoff a switched session owes its new engine
 * (`docs/session-runtime-switching.md` "Handoff"): none on a first binding,
 * the whole log after a fresh switch until the new engine replies, and only
 * what a resumed engine missed on a return.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, test, vi } from "vitest";
import type { ModelOption, SessionPendingRuntime } from "@assistant/shared";
import { sessionStore } from "./db/sessionStore.ts";
import { logPathFor } from "./session/log/persistence.ts";
import { pickerModels } from "./harnesses/models.ts";
import { owedSwitchContext } from "./sessionSwitchHandoff.ts";
import { seedLegacyDefaultAccounts } from "./test/legacyDefaultAccounts.ts";

// The return target's window, which the budget subtracts from.
vi.mock("./harnesses/models.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./harnesses/models.ts")>();
  return {
    ...original,
    pickerModels: (): ModelOption[] => [
      ...original.pickerModels(),
      {
        provider: "claude",
        id: "opus",
        name: "Claude Opus",
        contextWindow: 200_000,
      } as ModelOption,
    ],
  };
});

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
    nativeUsage: null,
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

  toPi(id, 1, 3);
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
  toPi(id, 1, 3);
  append(id, [
    message(3, "user", "asked on pi"),
    message(4, "assistant", "pi answered"),
  ]);
  sessionStore.switchEngineBinding(id, {
    nativeUsage: null,
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
    startedSeq: 5,
    resumedSeq: 1,
    pending: { ...PENDING, model: { provider: "claude", id: "opus" } },
  });
  const owed = owedSwitchContext(id) ?? "";
  assert.match(owed, /You ran this session before/);
  assert.match(owed, /asked on pi/);
  assert.match(owed, /pi answered/);
  assert.doesNotMatch(owed, /asked on claude/);
});

/** A Claude → pi → Claude session whose pi binding answered `piRows`. */
function backOnClaude(
  id: string,
  native: string,
  piRows: unknown[],
  resumedSeq?: number,
): void {
  onClaude(id, native);
  append(id, [
    message(1, "user", "asked on claude"),
    message(2, "assistant", "claude answered"),
  ]);
  toPi(id, 1, 3);
  append(id, piRows);
  sessionStore.switchEngineBinding(id, {
    nativeUsage: null,
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
    startedSeq: 5,
    ...(resumedSeq !== undefined ? { resumedSeq } : {}),
    pending: { ...PENDING, model: { provider: "claude", id: "opus" } },
  });
}

test("a native session the switch's open did not reopen gets the whole log, even with the same native id (F018)", () => {
  const id = `switch-handoff-${Date.now()}-fresh-same-id`;
  // Equal native ids, but the commit recorded no resume: the transcript was
  // gone and the engine started over.
  backOnClaude(id, `native-${id}`, [
    message(3, "user", "asked on pi"),
    message(4, "assistant", "pi answered"),
  ]);
  const owed = owedSwitchContext(id) ?? "";
  assert.match(owed, /asked on claude/, "its own earlier history is carried");
  assert.match(owed, /asked on pi/);
  assert.doesNotMatch(owed, /You ran this session before/);
});

test("a full handoff keeps a legacy log's seq-zero entries, and a return the first entry of the binding it missed (F019)", () => {
  const legacy = `switch-handoff-${Date.now()}-seq-zero`;
  onClaude(legacy, `native-${legacy}`);
  append(legacy, [
    message(0, "user", "ORIGINAL GOAL at seq zero"),
    message(1, "assistant", "on it"),
  ]);
  toPi(legacy, 1, 2);
  const owed = owedSwitchContext(legacy) ?? "";
  assert.match(owed, /ORIGINAL GOAL at seq zero/);
  assert.doesNotMatch(owed, /omitted/i, "nothing was dropped to make room");

  // A return: the entry at the missed binding's own started_seq is its first.
  const back = `switch-handoff-${Date.now()}-boundary`;
  backOnClaude(
    back,
    `native-${back}`,
    [message(3, "user", "FIRST on pi"), message(4, "assistant", "pi answered")],
    1,
  );
  assert.match(owedSwitchContext(back) ?? "", /FIRST on pi/);
});

test("a return's budget leaves room for what the resumed native session already holds (F020)", () => {
  const window = pickerModels().find(
    (option) => option.provider === "claude" && option.id === "opus",
  )?.contextWindow;
  assert.ok(window, "the target model has a known window");
  const usage = (contextTokens: number) => ({
    type: "message",
    role: "assistant",
    seq: 2,
    id: "m2",
    content: [{ type: "text", text: "claude answered" }],
    usage: { contextTokens, contextWindowTokens: window },
  });

  // Nearly full: the free window less the reserve fits no history at all.
  const full = `switch-handoff-${Date.now()}-full`;
  onClaude(full, `native-${full}`);
  append(full, [message(1, "user", "asked on claude"), usage(window - 1_000)]);
  toPi(full, 1, 3);
  append(full, [
    message(3, "user", "asked on pi"),
    message(4, "assistant", "pi answered"),
  ]);
  sessionStore.switchEngineBinding(full, {
    nativeUsage: null,
    expectSeq: 2,
    fields: {
      harness: "claude-sdk",
      credentialProfileId: "claude-default",
      provider: "claude",
      model: "opus",
      thinkingLevel: "high",
      providerSessionId: `native-${full}`,
    },
    nativeSessionId: `native-${full}`,
    startedSeq: 5,
    resumedSeq: 1,
    pending: { ...PENDING, model: { provider: "claude", id: "opus" } },
  });
  const owed = owedSwitchContext(full) ?? "";
  assert.match(owed, /You ran this session before/);
  assert.doesNotMatch(owed, /pi answered/, "no room once the session is full");

  // Lightly used: the same delta fits.
  const light = `switch-handoff-${Date.now()}-light`;
  onClaude(light, `native-${light}`);
  append(light, [message(1, "user", "asked on claude"), usage(2_000)]);
  toPi(light, 1, 3);
  append(light, [
    message(3, "user", "asked on pi"),
    message(4, "assistant", "pi answered"),
  ]);
  sessionStore.switchEngineBinding(light, {
    nativeUsage: null,
    expectSeq: 2,
    fields: {
      harness: "claude-sdk",
      credentialProfileId: "claude-default",
      provider: "claude",
      model: "opus",
      thinkingLevel: "high",
      providerSessionId: `native-${light}`,
    },
    nativeSessionId: `native-${light}`,
    startedSeq: 5,
    resumedSeq: 1,
    pending: { ...PENDING, model: { provider: "claude", id: "opus" } },
  });
  assert.match(owedSwitchContext(light) ?? "", /pi answered/);

  // Never reported (it never replied): what it could hold is estimated from
  // the log, which here fills the window.
  const unknown = `switch-handoff-${Date.now()}-unknown`;
  onClaude(unknown, `native-${unknown}`);
  append(unknown, [message(1, "user", "x ".repeat(window * 2))]);
  toPi(unknown, 1, 3);
  append(unknown, [
    message(3, "user", "asked on pi"),
    message(4, "assistant", "pi answered"),
  ]);
  sessionStore.switchEngineBinding(unknown, {
    nativeUsage: null,
    expectSeq: 2,
    fields: {
      harness: "claude-sdk",
      credentialProfileId: "claude-default",
      provider: "claude",
      model: "opus",
      thinkingLevel: "high",
      providerSessionId: `native-${unknown}`,
    },
    nativeSessionId: `native-${unknown}`,
    startedSeq: 5,
    resumedSeq: 1,
    pending: { ...PENDING, model: { provider: "claude", id: "opus" } },
  });
  assert.doesNotMatch(owedSwitchContext(unknown) ?? "", /pi answered/);
});

test("a return's budget never takes the size an earlier native session reported once a clear replaced it (F036 sibling)", () => {
  const window = pickerModels().find(
    (option) => option.provider === "claude" && option.id === "opus",
  )?.contextWindow;
  assert.ok(window);
  const id = `switch-handoff-${Date.now()}-cleared`;
  const toClaude = (
    expectSeq: number,
    native: string,
    startedSeq: number,
    resumedSeq: number,
  ) =>
    sessionStore.switchEngineBinding(id, {
      nativeUsage: null,
      expectSeq,
      fields: {
        harness: "claude-sdk",
        credentialProfileId: "claude-default",
        provider: "claude",
        model: "opus",
        thinkingLevel: "high",
        providerSessionId: native,
      },
      nativeSessionId: native,
      startedSeq,
      resumedSeq,
      pending: { ...PENDING, model: { provider: "claude", id: "opus" } },
    });
  // N reported a light context; the first return resumed it, was cleared and
  // started M, whose run reported nothing and whose log fills the window.
  onClaude(id, `native-n-${id}`);
  append(id, [
    message(1, "user", "asked on claude"),
    {
      ...message(2, "assistant", "claude answered"),
      usage: { contextTokens: 2_000, contextWindowTokens: window },
    },
  ]);
  toPi(id, 1, 3);
  append(id, [message(3, "user", "asked on pi")]);
  toClaude(2, `native-m-${id}`, 5, 1);
  append(id, [
    message(5, "user", "x ".repeat(window * 2)),
    message(6, "assistant", "claude answered after the clear"),
  ]);
  toPi(id, 3, 7);
  append(id, [
    message(7, "user", "asked on pi again"),
    message(8, "assistant", "pi answered"),
  ]);
  // The return resumes M: what it holds is unknown, so it is estimated from
  // the log, never taken from N's report.
  toClaude(4, `native-m-${id}`, 9, 3);
  assert.doesNotMatch(owedSwitchContext(id) ?? "", /pi answered/);
});

/**
 * One Claude binding: N reports `before`, a /clear card, then M's run with a
 * window-filling prompt whose answer reported `after` (none: an early failure
 * reports no usage). Then pi, and a return to M.
 */
function clearedInOneBinding(
  id: string,
  window: number,
  after: number | undefined,
): void {
  const m = `native-m-${id}`;
  // The binding names M: the run after the clear started it.
  onClaude(id, m);
  append(id, [
    message(1, "user", "small ask on N"),
    {
      ...message(2, "assistant", "N answered"),
      usage: { contextTokens: 2_000, contextWindowTokens: window },
    },
    {
      type: "command.result",
      commandId: "cmd-clear",
      name: "contextClear",
      card: { kind: "contextClear", id: "clear", contextClear: {} },
      seq: 3,
      id: "e3-command",
    },
    message(4, "user", "x ".repeat(window * 2)),
    after === undefined
      ? { ...message(5, "assistant", "M failed early"), stopReason: "error" }
      : {
          ...message(5, "assistant", "M answered"),
          usage: { contextTokens: after, contextWindowTokens: window },
        },
  ]);
  toPi(id, 1, 6);
  append(id, [
    message(6, "user", "asked on pi"),
    message(7, "assistant", "pi answered"),
  ]);
  sessionStore.switchEngineBinding(id, {
    nativeUsage: null,
    expectSeq: 2,
    fields: {
      harness: "claude-sdk",
      credentialProfileId: "claude-default",
      provider: "claude",
      model: "opus",
      thinkingLevel: "high",
      providerSessionId: m,
    },
    nativeSessionId: m,
    startedSeq: 8,
    resumedSeq: 1,
    pending: { ...PENDING, model: { provider: "claude", id: "opus" } },
  });
}

test("a return's budget never takes a report from before a clear in the same binding when the run after it reported none (F041)", () => {
  const window = pickerModels().find(
    (option) => option.provider === "claude" && option.id === "opus",
  )?.contextWindow;
  assert.ok(window);
  const id = `switch-handoff-${Date.now()}-cleared-in-binding`;
  clearedInOneBinding(id, window, undefined);
  // What M holds is unknown, so it is estimated from the log (which fills the
  // window), never taken from N's 2k.
  const owed = owedSwitchContext(id) ?? "";
  assert.match(owed, /You ran this session before/);
  assert.doesNotMatch(owed, /pi answered/, "no room in M's window");
});

test("a return's budget takes the report of the run after a clear in the same binding (F041)", () => {
  const window = pickerModels().find(
    (option) => option.provider === "claude" && option.id === "opus",
  )?.contextWindow;
  assert.ok(window);
  const light = `switch-handoff-${Date.now()}-cleared-light`;
  clearedInOneBinding(light, window, 3_000);
  assert.match(
    owedSwitchContext(light) ?? "",
    /pi answered/,
    "M reported a light context, so the delta fits",
  );
  const full = `switch-handoff-${Date.now()}-cleared-full`;
  clearedInOneBinding(full, window, window - 1_000);
  assert.doesNotMatch(
    owedSwitchContext(full) ?? "",
    /pi answered/,
    "M reported a full context",
  );
});

test("a kind change within pi owes nothing: its transcript resumed holds the whole session", () => {
  const id = `switch-handoff-${Date.now()}-pi-kind`;
  ids.push(id);
  assert.ok(
    sessionStore.upsert({
      id,
      harness: "pi",
      agentType: "developer",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      credentialProfileId: "default",
    }),
  );
  append(id, [
    message(1, "user", "asked on codex"),
    message(2, "assistant", "ok"),
  ]);
  // Codex → an OpenAI-compatible endpoint: the same pi transcript, resumed
  // from the binding the switch leaves (D1).
  sessionStore.switchEngineBinding(id, {
    nativeUsage: null,
    expectSeq: 1,
    fields: {
      harness: "pi",
      credentialProfileId: "cp_endpoint",
      provider: "cp_endpoint",
      model: "local-model",
      thinkingLevel: "off",
      providerSessionId: null,
    },
    nativeSessionId: id,
    startedSeq: 3,
    resumedSeq: 1,
    pending: {
      ...PENDING,
      model: { provider: "cp_endpoint", id: "local-model" },
    },
  });
  assert.equal(sessionStore.bindings(id).length, 2);
  assert.equal(owedSwitchContext(id), undefined);
});
