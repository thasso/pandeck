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

/**
 * Each case is a rule that was ONLY ever carried by this string. Shortening the
 * wording is fine; losing the distinction is what these patterns catch.
 */
const KEPT_DISAMBIGUATION: {
  tool: string;
  path?: string;
  patterns: RegExp[];
  why: string;
}[] = [
  {
    tool: "task_manage",
    path: "operations.dueDate",
    patterns: [/DEADLINE/, /scheduledFor/],
    why: "a deadline written into scheduledFor is a valid call with the wrong meaning",
  },
  {
    tool: "task_manage",
    path: "operations.scheduledFor",
    patterns: [/WORK/, /plan/i],
    why: "planning a day must not land on dueDate",
  },
  {
    tool: "task_manage",
    path: "operations.userRequestedStatus",
    patterns: [/ONLY when the user asked/],
    why: "the flag turns a suggestion into an applied status; nothing else says when it is allowed",
  },
  {
    tool: "task_manage",
    path: "operations.comment",
    patterns: [/never progress narration/],
    why: "the trace stays readable only if narration never reaches it",
  },
  {
    tool: "task_manage",
    path: "operations.externalLinks.type",
    patterns: [/source = where the Task came from/, /related/],
    why: "'source' is what Slack intake and minutes processing deduplicate on, and both values validate",
  },
  {
    tool: "task_read",
    path: "comments",
    patterns: [/most recent/],
    why: "a bounded trace returns the LATEST page; read as the oldest N it hides current decisions",
  },
  {
    tool: "task_read",
    path: "id",
    patterns: [/id/, /query never matches an id/],
    why: "a Task-32 lookup passed as query silently returns text hits instead",
  },
  {
    tool: "task_read",
    path: "scheduled",
    patterns: [/PLANNED/, /not the deadline/],
    why: "scheduled and due are both date filters and would otherwise be picked by coin toss",
  },
  {
    tool: "memory_manage",
    path: "operations.expectedRevision",
    patterns: [/revision/i, /stale/],
    why: "a memory write without the observed revision is refused; the caller has to know to carry it",
  },
  {
    tool: "memory_manage",
    path: "operations.text",
    patterns: [/create\/correct/],
    why: "reinforce/archive/pin ignore text instead of refusing it, so the write silently does nothing",
  },
  {
    tool: "memory_manage",
    path: "operations.kind",
    patterns: [/create\/correct/],
    why: "same silent ignore as text",
  },
  {
    tool: "memory_manage",
    path: "operations.pin",
    patterns: [/on create/],
    why: "pin on a later op is ignored, and there is a pin OPERATION next to it",
  },
  {
    tool: "memory_search",
    path: "query",
    patterns: [/[Ll]exical/],
    why: "a semantic paraphrase silently returns nothing",
  },
  {
    tool: "ask_questions",
    path: "questions.allowTypedAnswer",
    patterns: [/none of the options/],
    why: "without it a choice question forces the user into a wrong answer",
  },
  // The Task descriptions' own rules are pinned by `taskTools.test.ts`.
  {
    tool: "ask_questions",
    patterns: [/disposition=discuss/],
    why: "a discuss disposition read as an answer is answered instead of discussed",
  },
];

test("the eager tools keep the guidance that no other surface carries", () => {
  for (const { tool: name, path, patterns, why } of KEPT_DISAMBIGUATION) {
    const tool = eagerTool(name);
    const text = path ? propertyText(tool, path) : tool.description;
    const where = path ? `${name}.${path}` : `${name} description`;
    assert.ok(text.length > 0, `${where} lost its prose entirely: ${why}`);
    for (const pattern of patterns)
      assert.match(text, pattern, `${where} no longer says it: ${why}`);
  }
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
