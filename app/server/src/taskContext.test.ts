/**
 * The Task-start attachment names the Initiatives holding the Task
 * (docs/tasks.md): per Initiative a header that is never budgeted away, and a
 * clipped description head that ranks below the parent's and gives way to a
 * one-line note when the 8 KB budget is spent.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  archiveInitiative,
  createInitiative,
  setInitiativeMilestones,
} from "./initiatives.ts";
import { createTask, readTask } from "./tasks.ts";
import { buildTaskContextAttachment } from "./taskContext.ts";

const BUDGET_BYTES = 8_000;

function task(title: string, description = "", parentId?: string): string {
  return createTask({
    title,
    description,
    source: { createdBy: "user" },
    ...(parentId ? { parentId } : {}),
  }).id;
}

function contextOf(id: string): string {
  const attachment = buildTaskContextAttachment(readTask(id)!);
  return Buffer.from(attachment.data, "base64").toString("utf8");
}

/** An epic holding `child` in a new Initiative with a milestone and a long description. */
function heldChild(childDescription: string, parentDescription: string) {
  const epic = task("Context epic", parentDescription);
  const milestone = task("Context milestone", "", epic);
  const child = task("Context child", childDescription, epic);
  const id = String(
    createInitiative({
      title: "Context initiative",
      description: `Initiative head. ${"i".repeat(3_000)}`,
      taskIds: [epic],
    }).initiative.id,
  );
  setInitiativeMilestones(id, [milestone], true);
  return { epic, milestone, child, id };
}

function assertHeader(
  body: string,
  { id, epic, milestone }: { id: string; epic: string; milestone: string },
): void {
  assert.match(body, /\n## Initiatives\n/);
  assert.ok(
    body.includes(
      `### [Initiative-${id}](pa://initiative/${id}) — Context initiative`,
    ),
  );
  assert.ok(body.includes("- State: active"));
  assert.ok(
    body.includes(`- Membership: through ancestor Task ${epic} — Context epic`),
  );
  assert.ok(
    body.includes(
      `- Next open milestone: Task ${milestone} — Context milestone`,
    ),
  );
  assert.ok(body.includes(`\`initiative_read\` (id ${id})`));
}

test("a member Task's attachment carries the Initiative with a clipped description head", () => {
  const held = heldChild("Short child body.", "Short epic body.");
  const body = contextOf(held.child);
  assertHeader(body, held);
  assert.ok(body.includes("Initiative head. iii"));
  assert.ok(!body.includes("i".repeat(900)), "the description is clipped");
  assert.ok(
    body.includes(
      `_Read the full description with \`initiative_read\` (id ${held.id})._`,
    ),
  );
  // The parent's description comes before the Initiatives.
  assert.ok(body.indexOf("Short epic body.") < body.indexOf("## Initiatives"));
  assert.ok(Buffer.byteLength(body, "utf8") <= BUDGET_BYTES);

  // A direct member says so.
  const direct = contextOf(held.epic);
  assert.ok(direct.includes("- Membership: direct member"));
});

test("a Task nothing holds, or only an archived Initiative holds, has no section", () => {
  assert.ok(!contextOf(task("Context loner")).includes("## Initiatives"));
  const member = task("Context shelved member");
  const shelved = createInitiative({ title: "Shelved", taskIds: [member] });
  archiveInitiative(String(shelved.initiative.id));
  assert.ok(!contextOf(member).includes("## Initiatives"));
});

test("a large parent and a long Initiative description stay inside the budget, parent first", () => {
  // Room for the parent's clipped head but not for the Initiative's as well.
  const held = heldChild("c".repeat(4_400), "p".repeat(6_000));
  const body = contextOf(held.child);
  assert.ok(Buffer.byteLength(body, "utf8") <= BUDGET_BYTES);
  assert.ok(body.includes(`## Parent Task ${held.epic} — description`));
  assert.ok(!body.includes("Initiative head."));
  assert.ok(
    body.includes(
      `_Initiative-${held.id}'s description is omitted here for size; \`initiative_read\` (id ${held.id}) has it._`,
    ),
  );
  assertHeader(body, held);
});

test("an own description that spends the budget drops both heads but keeps the Initiative's header", () => {
  const held = heldChild("c".repeat(9_000), "p".repeat(6_000));
  const body = contextOf(held.child);
  assert.ok(
    body.includes(`_Parent Task ${held.epic}'s description is omitted`),
  );
  assert.ok(body.includes(`_Initiative-${held.id}'s description is omitted`));
  assertHeader(body, held);
});
