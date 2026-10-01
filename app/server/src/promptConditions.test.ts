/**
 * Task 287: the persona prompt is assembled from evidence available when the
 * session STARTS, and that decision is frozen for the session's whole life.
 *
 *   pnpm --filter @assistant/server test src/promptConditions.test.ts
 *
 * The byte-stability tests are the point of the task, not a nicety: a Claude
 * session resends its system prompt on every resumed query and pi rebuilds it
 * on every active-tool change, so a condition that moved mid-session would bust
 * the provider's cache prefix for the entire conversation.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "vitest";
import { AGENT_TYPES } from "./agentTypes.ts";
import {
  buildClaudeSdkQueryOptions,
  claudeSdkSystemPrompt,
} from "./claudeSdk/options.ts";
import { sessionStore } from "./db/sessionStore.ts";
import { updateGoogleSettings } from "./googleSettings.ts";
import {
  computePromptConditions,
  parsePromptConditions,
  sessionPromptConditions,
  type PromptConditions,
} from "./promptConditions.ts";
import { upsertProject } from "./projectRegistry.ts";
import { buildProjectContext } from "./sessionProjectContext.ts";
import { buildAgentOptions } from "./piSdk/options.ts";
import { updateSlackSettings } from "./slackSettings.ts";
import { updateTempoSettings } from "./tempoSettings.ts";
import { eagerToolNamesFor } from "./tools/catalog.ts";

/** The one assembly both harnesses share, under an explicit condition set. */
function assistantPrompt(conditions: PromptConditions): string {
  return AGENT_TYPES.assistant.systemPrompt({ conditions });
}

function setGates(on: boolean): void {
  updateSlackSettings({ enabled: on });
  updateGoogleSettings({ enabled: on });
  updateTempoSettings({ enabled: on });
}

let seq = 0;
const nextSessionId = (): string => `prompt-conditions-${(seq += 1)}`;

beforeEach(() => setGates(false));

describe("session-start prompt conditions", () => {
  test("are computed once per session and outlive a gate change", () => {
    const id = nextSessionId();
    setGates(true);
    const frozen = sessionPromptConditions(id, "assistant", {
      hasAttachments: true,
    });
    assert.deepEqual(frozen, {
      attachments: true,
      slack: true,
      google: true,
      tempo: true,
      projectRegistryPointer: true,
      memoryWrite: true,
    });

    // Everything the session could observe later changes: the gates go off and
    // the reopen path has no evidence to offer.
    setGates(false);
    assert.deepEqual(sessionPromptConditions(id, "assistant"), frozen);
    assert.deepEqual(
      sessionPromptConditions(id, "assistant", { hasAttachments: false }),
      frozen,
      "later evidence cannot re-decide a frozen session",
    );
    assert.deepEqual(
      parsePromptConditions(sessionStore.getPromptConditions(id)),
      frozen,
      "the record is persisted with the session, not held in memory",
    );
  });

  test("a fresh session started after the change gets the new conditions", () => {
    setGates(true);
    const before = sessionPromptConditions(nextSessionId(), "assistant");
    setGates(false);
    const after = sessionPromptConditions(nextSessionId(), "assistant");
    assert.equal(before.slack, true);
    assert.equal(after.slack, false);
  });

  test("the assembled prompt is byte-stable across resume and activation", () => {
    const id = nextSessionId();
    setGates(true);
    const first = assistantPrompt(sessionPromptConditions(id, "assistant"));
    const firstEager = [
      ...eagerToolNamesFor(
        "assistant",
        sessionPromptConditions(id, "assistant"),
      ),
    ].sort();

    // A resumed Claude query, a pi reopen and a deferred-tool activation all
    // re-enter through the same read — with the world moved on underneath.
    setGates(false);
    for (let resume = 0; resume < 3; resume += 1) {
      const conditions = sessionPromptConditions(id, "assistant");
      assert.equal(
        assistantPrompt(conditions),
        first,
        "the persona prompt must be byte-identical on every rebuild",
      );
      assert.equal(
        claudeSdkSystemPrompt("assistant", undefined, { conditions }),
        claudeSdkSystemPrompt("assistant", undefined, {
          conditions: sessionPromptConditions(id, "assistant"),
        }),
        "the Claude system prompt is resent verbatim on resume",
      );
      assert.deepEqual(
        [...eagerToolNamesFor("assistant", conditions)].sort(),
        firstEager,
        "the eager tool tier cannot move after activation",
      );
    }
  });

  test("integration sections ship only for the gates a session started with", () => {
    setGates(true);
    const withGates = assistantPrompt(
      sessionPromptConditions(nextSessionId(), "assistant"),
    );
    setGates(false);
    const withoutGates = assistantPrompt(
      sessionPromptConditions(nextSessionId(), "assistant"),
    );

    assert.match(withGates, /For Slack questions/);
    assert.match(withGates, /Google Meet minutes/);
    assert.doesNotMatch(withoutGates, /For Slack questions/);
    assert.doesNotMatch(withoutGates, /Google Meet minutes/);
    assert.ok(
      withoutGates.length < withGates.length,
      "dropping a section is what produces the saving",
    );
    // The unconditional persona behavior is untouched by either.
    for (const prompt of [withGates, withoutGates])
      assert.match(prompt, /You are a personal assistant/);
  });

  test("the Tempo section belongs to the Personal Assistant alone", () => {
    updateTempoSettings({ enabled: true });
    const tempoOn = sessionPromptConditions(nextSessionId(), "assistant");
    assert.match(
      AGENT_TYPES["personal-assistant"].systemPrompt({ conditions: tempoOn }),
      /Time logging runs through the Tempo tools/,
    );
    assert.doesNotMatch(
      AGENT_TYPES.assistant.systemPrompt({ conditions: tempoOn }),
      /Time logging runs through the Tempo tools/,
    );
  });

  test("attachment tools are eager only for a session that started with files", () => {
    const withFiles = computePromptConditions("assistant", {
      hasAttachments: true,
    });
    const withoutFiles = computePromptConditions("assistant", {});
    const eagerWith = eagerToolNamesFor("assistant", withFiles);
    const eagerWithout = eagerToolNamesFor("assistant", withoutFiles);

    assert.ok(eagerWith.has("list_attachments"));
    assert.ok(eagerWith.has("read_attachment"));
    assert.ok(!eagerWithout.has("list_attachments"));
    assert.ok(!eagerWithout.has("read_attachment"));
    // Deferred, never dropped: the tools stay in the persona's universe so a
    // later attachment is one tool search away.
    const universe = new Set(
      AGENT_TYPES.assistant.tools().map((tool) => tool.name),
    );
    assert.ok(
      universe.has("list_attachments") && universe.has("read_attachment"),
    );
    // Nothing else moves with the condition.
    for (const name of eagerWith)
      assert.ok(
        eagerWithout.has(name) ||
          name === "list_attachments" ||
          name === "read_attachment",
        `${name} must not depend on the attachments condition`,
      );
  });

  test("a known Project's context replaces the eager registry pointer", () => {
    upsertProject({
      id: "conditions-demo",
      name: "Conditions Demo",
      key: "COND",
    });
    const withProject = computePromptConditions("assistant", {
      projectId: "conditions-demo",
    });
    const withoutProject = computePromptConditions("assistant", {});
    const unknownProject = computePromptConditions("assistant", {
      projectId: "not-in-the-registry",
    });

    assert.equal(withProject.projectRegistryPointer, false);
    assert.equal(withoutProject.projectRegistryPointer, true);
    assert.equal(
      unknownProject.projectRegistryPointer,
      true,
      "an unknown id gets no registry evidence in its attachment, so it keeps the pointer",
    );
    assert.doesNotMatch(assistantPrompt(withProject), /## Project Registry/);
    assert.match(assistantPrompt(withoutProject), /## Project Registry/);

    // Dropping the pointer may not drop tool DISCOVERY: the attachment that
    // replaces it names the two deferred registry tools itself.
    const attached = buildProjectContext("conditions-demo");
    assert.match(attached, /`project_registry_read`/);
    assert.match(attached, /`project_registry_write`/);
  });

  test("a stored record can never contradict the persona's memory rule", () => {
    const id = nextSessionId();
    // A record from an older build, without the key this persona is bound by.
    sessionStore.freezePromptConditions(
      id,
      JSON.stringify({ attachments: false, slack: false }),
    );
    assert.equal(
      sessionPromptConditions(id, "developer").memoryWrite,
      false,
      "a coding session keeps its read-only rules whatever the record says",
    );
    assert.match(
      AGENT_TYPES.developer.systemPrompt({
        conditions: sessionPromptConditions(id, "developer"),
      }),
      /Memory here is READ-ONLY context/,
    );
    assert.equal(sessionPromptConditions(id, "assistant").memoryWrite, true);
  });

  test("memory write rules follow the persona's capability", () => {
    const coding = computePromptConditions("developer", {});
    const assistant = computePromptConditions("assistant", {});
    assert.equal(coding.memoryWrite, false);
    assert.equal(assistant.memoryWrite, true);
    assert.match(
      AGENT_TYPES.developer.systemPrompt({ conditions: coding }),
      /Memory here is READ-ONLY context/,
    );
    assert.doesNotMatch(
      AGENT_TYPES.assistant.systemPrompt({ conditions: assistant }),
      /Memory here is READ-ONLY context/,
    );
  });

  test("an unconditioned caller gets every section, never a lost rule", () => {
    setGates(false);
    const full = AGENT_TYPES.assistant.systemPrompt();
    assert.match(full, /For Slack questions/);
    assert.match(full, /## Project Registry/);
    // …but a coding persona still keeps its read-only memory rules.
    assert.match(
      AGENT_TYPES.developer.systemPrompt(),
      /Memory here is READ-ONLY context/,
    );
  });

  test("both harnesses' option builders assemble from the frozen record", async () => {
    const id = nextSessionId();
    setGates(false);
    const conditions = sessionPromptConditions(id, "assistant", {
      hasAttachments: false,
    });

    const claude = buildClaudeSdkQueryOptions({
      cwd: "/tmp",
      abortController: new AbortController(),
      modelId: "sonnet",
      thinkingLevel: "low",
      agentType: "assistant",
      promptConditions: conditions,
    });
    assert.equal(claude.systemPrompt, assistantPrompt(conditions));
    assert.doesNotMatch(String(claude.systemPrompt), /For Slack questions/);

    const pi = await buildAgentOptions(
      "assistant",
      "/tmp",
      "default",
      conditions,
    );
    assert.ok(!pi.eagerToolNames.has("list_attachments"));
    assert.deepEqual(
      [...pi.eagerToolNames].sort(),
      [...eagerToolNamesFor("assistant", conditions)].sort(),
    );
  });

  test("a malformed or partial record never drops a section", () => {
    assert.equal(parsePromptConditions(undefined), undefined);
    assert.equal(parsePromptConditions("not json"), undefined);
    assert.deepEqual(parsePromptConditions(JSON.stringify({ slack: false })), {
      attachments: true,
      slack: false,
      google: true,
      tempo: true,
      projectRegistryPointer: true,
      memoryWrite: true,
    });
  });
});
