import assert from "node:assert/strict";
import { test } from "vitest";
import {
  type MessageFieldSpecs,
  validateClientMessage,
} from "./validateClientMessage.ts";

const stringSpec = {
  check: (value: unknown) => typeof value === "string",
  kind: "a string",
};
const optionalString = { ...stringSpec, optional: true } as const;

test("field specs require optional wire fields and reject extra keys", () => {
  const prompt = {
    text: stringSpec,
    attachments: optionalString,
    attachTaskId: optionalString,
    projectId: optionalString,
    fileContext: optionalString,
    clientRequestId: optionalString,
    skill: optionalString,
  } satisfies MessageFieldSpecs<"prompt">;
  const { skill, ...withoutSkill } = prompt;
  assert.equal(skill.optional, true);

  // @ts-expect-error Optional wire fields still require a validator spec.
  const missing: MessageFieldSpecs<"prompt"> = withoutSkill;
  assert.equal("skill" in missing, false);

  const extra: MessageFieldSpecs<"prompt"> = {
    ...prompt,
    // @ts-expect-error A spec may not invent a field absent from this variant.
    unknownField: stringSpec,
  };
  assert.equal("unknownField" in extra, true);

  const unmarked: MessageFieldSpecs<"prompt"> = {
    ...prompt,
    // @ts-expect-error Optional wire fields must be explicitly marked optional.
    skill: stringSpec,
  };
  assert.equal(unmarked.skill, stringSpec);

  const required: MessageFieldSpecs<"prompt"> = {
    ...prompt,
    // @ts-expect-error A required wire field may not use an optional check.
    text: optionalString,
  };
  assert.equal(required.text, optionalString);

  const empty: MessageFieldSpecs<"abort"> = {
    // @ts-expect-error Zero-payload variants may not invent spec fields either.
    text: stringSpec,
  };
  assert.equal("text" in empty, true);
});

test("prompt skill is optional but must be a string when supplied", () => {
  for (const extra of [{}, { skill: undefined }, { skill: "review" }]) {
    assert.equal(
      validateClientMessage({ type: "prompt", text: "/review", ...extra }).ok,
      true,
    );
  }
  for (const skill of [42, null, true, [], {}]) {
    const result = validateClientMessage({ type: "prompt", text: "x", skill });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "skill must be a string");
  }
});

test("harness account pins must be strings when supplied", () => {
  const message = {
    type: "harnessSend",
    id: "draft-1",
    harness: "pi",
    agentType: "developer",
    text: "hello",
  };
  for (const extra of [{}, { credentialProfileId: "work" }]) {
    assert.equal(validateClientMessage({ ...message, ...extra }).ok, true);
  }
  const result = validateClientMessage({ ...message, credentialProfileId: 42 });
  assert.equal(result.ok, false);
  if (!result.ok)
    assert.equal(result.reason, "credentialProfileId must be a string");
});

const correlatedMessages = [
  { type: "deleteSession", id: "s" },
  { type: "archiveSession", id: "s" },
  { type: "settleSession", id: "s", throughRevision: 0 },
  { type: "dismissSessionFailure", id: "s", outcomeRevision: 0 },
  { type: "settleWorkflowRun", runId: "r", throughRevision: 0 },
  { type: "renameSession", id: "s", title: "title" },
  { type: "setCompactionWindow", sessionId: "s", tokens: null },
  { type: "setSpawnOwnership", id: "s", ownership: "coordinator" },
  { type: "updateSettings", patch: {} },
  { type: "saveTask", request: { title: "title" } },
  { type: "assignTaskProjects", updates: [] },
  { type: "attachComments", threadIds: ["t"], sessionId: "s" },
];

test.each(correlatedMessages)(
  "$type checks its optional correlation id",
  (msg) => {
    for (const extra of [
      {},
      { requestId: undefined },
      { requestId: "req-1" },
    ]) {
      assert.equal(validateClientMessage({ ...msg, ...extra }).ok, true);
    }
    const result = validateClientMessage({ ...msg, requestId: 42 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "requestId must be a string");
  },
);

test("optional objects are checked even when their refinement ignores them", () => {
  assert.equal(
    validateClientMessage({
      type: "attachComments",
      threadIds: ["t"],
      sessionId: "s",
      session: 42,
    }).ok,
    false,
  );
  assert.equal(
    validateClientMessage({
      type: "answerWorkflowCeiling",
      runId: "r",
      choice: "cancel",
      raise: 42,
    }).ok,
    false,
  );
  assert.equal(
    validateClientMessage({
      type: "answerWorkflowCeiling",
      runId: "r",
      choice: "cancel",
    }).ok,
    true,
  );
});

test("dispatch never resolves prototype keys and ignores unknown payload fields", () => {
  for (const type of [
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
  ]) {
    assert.deepEqual(validateClientMessage({ type }), {
      ok: false,
      type,
      reason: "unknown message type",
    });
  }
  assert.equal(validateClientMessage({ type: "abort", extra: 42 }).ok, true);
  assert.equal(
    validateClientMessage({ type: "setThinkingLevel", level: "future-level" })
      .ok,
    true,
  );
});
