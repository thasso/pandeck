/**
 * Task 285: what is left of the eager tools' guidance after the trim, and why.
 *
 *   pnpm --filter @assistant/server test src/tools/eagerToolGuidance.test.ts
 *
 * Every eager tool description and schema string reaches the model on EVERY
 * first request, so the trim kept only two kinds of prose:
 *
 *  - a rule the runtime cannot state afterwards, because the call would
 *    otherwise succeed with the wrong argument (`dueDate` vs `scheduledFor`,
 *    `task_read.id` vs `query`, a status the user never asked for, a field an
 *    operation silently IGNORES rather than refuses);
 *  - a rule that lives on no other model-visible surface at all.
 *
 * What the trim deleted is narrower than "everything else": only prose whose
 * rule a precise throw states at the moment it matters. The second test pins
 * those throws, so dropping one is a test failure rather than silent guidance
 * loss — it does not claim every deleted line had an error behind it.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { agentToolsFor, eagerToolNamesFor } from "./catalog.ts";
import type { AgentTool, ToolCallContext } from "../mcp/tool.ts";
import { createTask, deleteTask } from "../tasks.ts";
import { memoryTools } from "./knowledge/memoryTools.ts";
import { taskToolsForKind } from "./tasks/taskTools.ts";
import { assertPromptRules } from "../test/promptRules.ts";

const ctx: ToolCallContext = {
  toolCallId: "eager-guidance-test",
  session: {
    sessionId: "eager-guidance-test-session",
    harness: "pi",
    agentType: "developer",
  },
};

function eagerTool(name: string): AgentTool {
  const eager = eagerToolNamesFor("developer");
  const tool = agentToolsFor("developer").find(
    (candidate) => candidate.name === name,
  );
  assert.ok(tool, `${name} is not a developer tool`);
  assert.ok(eager.has(name), `${name} is no longer eager`);
  return tool;
}

/** The description of one schema property, addressed by its property path. */
function propertyText(tool: AgentTool, path: string): string {
  let node: Record<string, unknown> = tool.parameters;
  for (const key of path.split(".")) {
    const properties = node.properties as
      Record<string, Record<string, unknown>> | undefined;
    const items = node.items as Record<string, unknown> | undefined;
    const next = properties?.[key] ?? (items?.properties as never)?.[key];
    assert.ok(next, `${path}: no schema property "${key}"`);
    node = next;
  }
  return typeof node.description === "string" ? node.description : "";
}

/** One eager tool's description, or one of its schema properties' (`tool.path`). */
function surface(address: string): { text: string } {
  const [name, ...path] = address.split(".");
  const tool = eagerTool(name!);
  return {
    text: path.length ? propertyText(tool, path.join(".")) : tool.description,
  };
}

test("the eager tools keep the guidance that no other surface carries", () => {
  // Each row is a rule that was ONLY ever carried by this string. Shortening
  // the wording is fine; losing the distinction is what the patterns catch.
  // The Task descriptions' own rules are pinned by `taskTools.test.ts`.
  assertPromptRules({
    // A deadline written into scheduledFor is a valid call with the wrong meaning.
    "task_manage.operations.dueDate": {
      ...surface("task_manage.operations.dueDate"),
      rules: {
        "is-a-deadline": /DEADLINE/,
        "not-scheduledFor": /scheduledFor/,
      },
    },
    // Planning a day must not land on dueDate.
    "task_manage.operations.scheduledFor": {
      ...surface("task_manage.operations.scheduledFor"),
      rules: { "is-when-work-happens": /WORK/, "set-when-planning": /plan/i },
    },
    // The flag turns a suggestion into an applied status; nothing else says when.
    "task_manage.operations.userRequestedStatus": {
      ...surface("task_manage.operations.userRequestedStatus"),
      rules: {
        "only-on-user-request": /only when the user (asked|requested|asks)/i,
      },
    },
    // The trace stays readable only if narration never reaches it.
    "task_manage.operations.comment": {
      ...surface("task_manage.operations.comment"),
      rules: { "no-progress-narration": /(never|not|no)[^.\n]*narration/i },
    },
    // 'source' is what Slack intake and minutes processing deduplicate on, and
    // both values validate.
    "task_manage.operations.externalLinks.type": {
      ...surface("task_manage.operations.externalLinks.type"),
      rules: {
        "source-is-origin": /source[^;\n]*(came from|origin)/i,
        "related-is-context": /related/,
      },
    },
    // A bounded trace returns the LATEST page; read as the oldest N it hides
    // current decisions.
    "task_read.comments": {
      ...surface("task_read.comments"),
      rules: { "is-the-latest-page": /most recent|latest|newest/i },
    },
    // A Task-32 lookup passed as query silently returns text hits instead.
    "task_read.id": {
      ...surface("task_read.id"),
      rules: {
        "query-never-matches-id":
          /query[^.\n]*(never|does not|doesn't)[^.\n]*match[^.\n]*\bid/i,
      },
    },
    // scheduled and due are both date filters, otherwise picked by coin toss.
    "task_read.scheduled": {
      ...surface("task_read.scheduled"),
      rules: {
        "is-the-plan": /PLANNED/,
        "not-the-deadline": /not the (deadline|due date)/i,
      },
    },
    // A write without the observed revision is refused; the caller must carry it.
    "memory_manage.operations.expectedRevision": {
      ...surface("memory_manage.operations.expectedRevision"),
      rules: { "carries-revision": /revision/i, "stale-does-nothing": /stale/ },
    },
    // reinforce/archive/pin IGNORE text and kind instead of refusing them, so
    // the write silently does nothing.
    "memory_manage.operations.text": {
      ...surface("memory_manage.operations.text"),
      rules: { "create-correct-only": /create\/correct/ },
    },
    "memory_manage.operations.kind": {
      ...surface("memory_manage.operations.kind"),
      rules: { "create-correct-only": /create\/correct/ },
    },
    // pin on a later op is ignored, and there is a pin OPERATION next to it.
    "memory_manage.operations.pin": {
      ...surface("memory_manage.operations.pin"),
      rules: { "create-only": /(on|at|with) create|create only/i },
    },
    // A semantic paraphrase silently returns nothing.
    "memory_search.query": {
      ...surface("memory_search.query"),
      rules: { "is-lexical": /[Ll]exical/ },
    },
    // Without it a choice question forces the user into a wrong answer.
    "ask_questions.questions.allowTypedAnswer": {
      ...surface("ask_questions.questions.allowTypedAnswer"),
      rules: { "when-no-option-fits": /none of the options|no option/i },
    },
    // A discuss disposition read as an answer is answered instead of discussed.
    ask_questions: {
      ...surface("ask_questions"),
      rules: { "discuss-is-not-an-answer": /disposition=discuss/ },
    },
  });
});

test("the prose the trim dropped is carried by the error the call fails with", async () => {
  const manage = taskToolsForKind("developer").find(
    (tool) => tool.name === "task_manage",
  )!;
  const failure = async (operations: unknown): Promise<string> => {
    try {
      await manage.execute({ operations } as never, ctx);
    } catch (error) {
      return (error as Error).message;
    }
    return assert.fail("expected the operation to be refused");
  };

  // task_manage.id / .title: which operation needs which is stated per failure.
  assert.match(await failure([{ operation: "update" }]), /requires id/);
  assert.match(await failure([{ operation: "create" }]), /requires a title/);

  // task_manage.description: "create only" is the refusal's own wording.
  const task = createTask({
    title: "Guidance surface probe",
    description: "body",
    source: { createdBy: "user" },
  });
  try {
    assert.match(
      await failure([
        { operation: "update", id: task.id, description: "replaced" },
      ]),
      /read it and pass targeted descriptionEdits instead/,
    );
    assert.match(
      await failure([
        {
          operation: "update",
          id: task.id,
          descriptionEdits: [{ oldText: "absent", newText: "x" }],
        },
      ]),
      /oldText not found/,
    );
  } finally {
    deleteTask(task.id);
  }

  // memory_manage: the id/expectedRevision pairing comes back per operation.
  const memoryManage = memoryTools.find(
    (tool) => tool.name === "memory_manage",
  )!;
  const result = await memoryManage.execute(
    { operations: [{ op: "archive", id: "mem_missing" }] } as never,
    ctx,
  );
  const outputs = (result.details as { results: { error?: string }[] }).results;
  assert.match(
    outputs[0]?.error ?? "",
    /expectedRevision is required for operations on an existing memory/,
  );
});
