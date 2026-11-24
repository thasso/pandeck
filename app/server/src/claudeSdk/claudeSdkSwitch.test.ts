/**
 * The Claude store's half of a harness switch
 * (`docs/session-runtime-switching.md`): releasing a session for another
 * engine keeps its record and its runtime session (detached, for the next
 * engine), and opening a session on a chosen binding takes the binding's
 * values over anything an earlier Claude binding left in the record, without
 * rewriting the row the engine it replaces still projects.
 */
import assert from "node:assert/strict";
import { afterEach, beforeAll, describe, test } from "vitest";
import type { ServerMessage, SessionState } from "@assistant/shared";
import { attachRuntimeView } from "../session/attach.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";
import { ensureRuntimeSessionWithRuntime } from "../session/runtimePrompt.ts";
import { claudeTurnSeam } from "../test/claudeTurnSeam.ts";
import { claudeSdkStore, type ClaudeSwitchBinding } from "./claudeSdkStore.ts";
import { installClaudeStateBuilder } from "../test/claudeSdkSession.ts";
import { readClaudeSdkRecord } from "./claudeSdkRecords.ts";
import { CLAUDE_SDK_STORE_DIR } from "../sessionStorage.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { getDb } from "../db/index.ts";
import { seedLegacyDefaultAccounts } from "../test/legacyDefaultAccounts.ts";
installClaudeStateBuilder(claudeSdkStore);

let counter = 0;
const ids: string[] = [];
function freshId(): string {
  const id = `claude-switch-${Date.now()}-${counter++}`;
  ids.push(id);
  return id;
}

await seedLegacyDefaultAccounts();
beforeAll(() => claudeSdkStore.setSeam(() => Promise.resolve(claudeTurnSeam)));
afterEach(() => {
  for (const id of ids.splice(0)) claudeSdkStore.remove(id);
});

/** A Claude session with one committed turn, bound into the runtime. */
async function ranOnce(id: string) {
  const session = claudeSdkStore.acquire(id, { modelId: "sonnet" });
  session.setTitle("switch fixture");
  ensureRuntimeSessionWithRuntime(sessionRuntime, session);
  await sessionRuntime.prompt(id, "first");
  return session;
}

/** Make the row project a pi binding, as it does while pi is the active engine. */
function projectPi(id: string): void {
  getDb()
    .prepare(
      `UPDATE session_index
          SET harness = 'pi', provider = 'openai-codex', model = 'gpt-5.6-sol',
              thinking_level = 'medium', provider_session_id = NULL,
              credential_profile_id = 'cp_pi', title = 'Row title',
              message_count = 12
        WHERE id = ?`,
    )
    .run(id);
  getDb()
    .prepare(
      `UPDATE session_engine_binding
          SET harness = 'pi', provider = 'openai-codex', model = 'gpt-5.6-sol',
              thinking_level = 'medium', native_session_id = ?,
              credential_profile_id = 'cp_pi'
        WHERE session_id = ? AND ended_at_ms IS NULL`,
    )
    .run(id, id);
}

function binding(
  overrides: Partial<ClaudeSwitchBinding> = {},
): ClaudeSwitchBinding {
  return {
    model: "claude-opus-5-5",
    thinkingLevel: "high",
    credentialProfileId: "cp_switch_target",
    providerSessionId: undefined,
    agentType: "developer",
    mode: "plan",
    title: "Row title",
    createdAt: 1_234,
    ...overrides,
  };
}

describe("releasing a Claude session for another engine", () => {
  test("persists it, drops it and leaves its runtime session detached for its viewers", async () => {
    const id = freshId();
    const session = await ranOnce(id);
    const live = sessionRuntime.get(id);
    const sent: ServerMessage[] = [];
    const view = attachRuntimeView(
      sessionRuntime,
      id,
      session,
      { send: (message) => sent.push(message) },
      { buildState: () => ({ sessionId: id }) as SessionState },
    );
    // The switching turn's own admission does not keep it from going.
    const releaseAdmission = sessionRuntime.admitPrompt(id);
    try {
      await claudeSdkStore.releaseForSwitch(id, () => {});
    } finally {
      releaseAdmission();
    }
    assert.equal(claudeSdkStore.get(id), undefined);
    assert.equal(session.released, true);
    assert.equal(sessionRuntime.get(id), live, "the runtime session stays");
    assert.equal(live?.isDetached, true);
    const record = readClaudeSdkRecord(CLAUDE_SDK_STORE_DIR, id)?.record;
    assert.equal(record?.entries?.length, 2, "its timeline is on disk");
    view.detach();
    // Nothing resident: nothing to release.
    await claudeSdkStore.releaseForSwitch(id, () => {});
  });

  test("refuses while the switching turn's admission check fails, and keeps the session", async () => {
    const id = freshId();
    const session = await ranOnce(id);
    await assert.rejects(
      claudeSdkStore.releaseForSwitch(id, () => {
        throw new Error("no longer admissible");
      }),
      /no longer admissible/,
    );
    assert.equal(claudeSdkStore.get(id), session);
    assert.equal(session.released, false);
    assert.equal(sessionRuntime.get(id)?.isDetached, false);
  });
});

describe("opening a Claude session on a switch's binding", () => {
  test("a fresh binding starts a new native session whatever the old record names", async () => {
    const id = freshId();
    await ranOnce(id);
    await claudeSdkStore.releaseForSwitch(id, () => {});
    projectPi(id);

    const opened = claudeSdkStore.openForBinding(id, binding());
    const meta = opened.toRecordMeta();
    assert.equal(meta.providerSessionId, undefined);
    // The binding beats the record's "sonnet" (curated as the opus alias).
    assert.equal(meta.modelId, "opus");
    assert.equal(meta.thinkingLevel, "high");
    assert.equal(meta.credentialProfileId, "cp_switch_target");
    assert.equal(meta.mode, "plan");
    assert.equal(meta.title, "Row title");
    assert.equal(meta.createdAt, 1_234);
    // Its record timeline is kept for forks and returns.
    assert.equal(opened.timelineEntries().length, 2);

    // Until the switch commits, the row still projects pi, with its figures.
    const row = sessionStore.get(id);
    assert.equal(row?.harness, "pi");
    assert.equal(row?.model, "gpt-5.6-sol");
    assert.equal(row?.credentialProfileId, "cp_pi");
    assert.equal(row?.title, "Row title");
    assert.equal(row?.messageCount, 12);
  });

  test("a return resumes the native session the binding names", async () => {
    const id = freshId();
    await ranOnce(id);
    await claudeSdkStore.releaseForSwitch(id, () => {});
    projectPi(id);
    const opened = claudeSdkStore.openForBinding(
      id,
      binding({ providerSessionId: "native-earlier", mode: "build" }),
    );
    assert.equal(opened.toRecordMeta().providerSessionId, "native-earlier");
    assert.equal(opened.sessionMode, "build");
  });

  test("a session with no Claude record opens fresh on the binding", () => {
    const id = freshId();
    assert.ok(
      sessionStore.upsert({
        id,
        harness: "pi",
        agentType: "developer",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        credentialProfileId: "cp_pi",
        title: "Row title",
        messageCount: 12,
      }),
    );
    const opened = claudeSdkStore.openForBinding(id, binding());
    assert.equal(opened.timelineEntries().length, 0);
    assert.equal(opened.toRecordMeta().modelId, "opus");
    assert.equal(sessionStore.get(id)?.messageCount, 12);
    assert.equal(sessionStore.get(id)?.harness, "pi");
  });

  test("an internal session keeps its scope", () => {
    const id = freshId();
    assert.ok(
      sessionStore.upsert({
        id,
        harness: "pi",
        agentType: "developer",
        scope: "internal",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        credentialProfileId: "cp_pi",
      }),
    );
    claudeSdkStore.openForBinding(id, binding());
    assert.equal(sessionStore.get(id)?.scope, "internal");
  });

  test("never reuses a resident session", async () => {
    const id = freshId();
    await ranOnce(id);
    assert.throws(
      () => claudeSdkStore.openForBinding(id, binding()),
      /already open on Claude/,
    );
  });
});
