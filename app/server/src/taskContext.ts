/**
 * The Task-context attachment added to a Task-attached session's prompt.
 *
 * It is AUTHORITATIVE: it carries the Task as it stands the moment the Task is
 * attached — including the `todo → doing` nudge, so the caller must build it
 * AFTER `linkTaskStart` — plus the parent chain and the Initiatives holding
 * it, so a Task-attached session needs no Task read before doing real work.
 * The attachment bytes ride the user message and are cached for the session,
 * while a `task_read` reprocesses the whole conversation. The product rule is
 * in `docs/tasks.md`.
 *
 * Harness-neutral — every `connection.ts` path that accepts `attachTaskId` uses
 * it.
 */
import type {
  PromptAttachment,
  TaskInitiativeRef,
  TaskItem,
} from "@assistant/shared";
import { initiativeBrief } from "./initiatives.ts";
import { buildProjectContext } from "./sessionProjectContext.ts";
import { readTask } from "./tasks.ts";
import { clipText } from "./textBudget.ts";

/**
 * The WHOLE attachment is budgeted, spent in priority order: the Task's own
 * description, then the parent's title + a clipped description, then the
 * grandparent title, then each Initiative's clipped description. An
 * Initiative's header — its id, title, state and how the Task belongs — is a
 * fact like the ancestor titles and is never budgeted away. Injecting a
 * parent's full body was rejected because parents are epics and epics are the
 * long bodies (the live sub-epics are ~7.4 KB and ~8.2 KB, against a
 * 1,254-char median Task description) — a parent's full body stays one
 * `task_read` away.
 *
 * The Task's own description is never clipped: it is the point of the
 * attachment, so a very long one may carry the total past the budget, and what
 * it displaces is the lower-priority material below it.
 */
const BUDGET_BYTES = 8_000;
const PARENT_DESCRIPTION_MAX_CHARS = 2_000;
const INITIATIVE_DESCRIPTION_MAX_CHARS = 800;

const FOOTER = [
  "This Task was attached because this session was started to work on it. Everything above is current as of the moment the Task was attached, and the status shown is the stored status — attaching the Task already recorded that work started, so there is nothing to write back.",
  "",
  "Treat this as the Task: do NOT re-read it before starting work. Read it again only for a parent's full description, subtasks, or if you have reason to think it changed since.",
].join("\n");

export function buildTaskContextAttachment(task: TaskItem): PromptAttachment {
  const body = buildTaskContextBody(task);
  return {
    id: `taskctx-${task.id}`,
    name: task.title || "Task",
    mimeType: "text/markdown",
    size: Buffer.byteLength(body, "utf8"),
    data: Buffer.from(body, "utf8").toString("base64"),
    role: "task-context",
  };
}

/** An optional block, plus the one line that replaces it when it does not fit. */
interface BudgetedSection {
  block: string[];
  omittedNote: string;
}

/** A block between the header and the footer that is always kept. */
interface FixedSection {
  block: string[];
  omittedNote?: never;
}

function buildTaskContextBody(task: TaskItem): string {
  const parent = task.parentId ? readTask(task.parentId) : null;
  const grandparent = parent?.parentId ? readTask(parent.parentId) : null;
  const projectText = task.projectId ? buildProjectContext(task.projectId) : "";

  // Ancestor TITLES ride in the header rather than competing for the budget:
  // they are the breadcrumb that says where this Task sits, they cost a line
  // each, and dropping one would save nothing worth reading.
  const head = [
    "# Working on a Backlog Task",
    "",
    `- Task id: ${task.id}`,
    ...(task.ticket
      ? [
          `- ${task.ticket.source === "jira" ? "Jira" : "GitHub"} ticket: ${task.ticket.ref}`,
        ]
      : []),
    `- Title: ${task.title}`,
    `- Status: ${task.status}`,
    ...(parent ? [`- Parent: Task ${parent.id} — ${parent.title}`] : []),
    ...(grandparent
      ? [`- Grandparent: Task ${grandparent.id} — ${grandparent.title}`]
      : []),
    "",
    "## Description",
    "",
    task.description?.trim() || "_(no description provided)_",
  ];
  const tail = [
    ...(projectText ? ["", "---", "", projectText] : []),
    "",
    "---",
    "",
    FOOTER,
  ];

  const sections = [
    parentSection(parent),
    ...initiativeSections(task.initiatives ?? []),
  ].filter(
    (section): section is BudgetedSection | FixedSection => section !== null,
  );

  // A dropped block's replacement note is not itself charged: it is always far
  // smaller than what it replaces, and saying nothing about missing content to
  // save ~100 bytes would be the wrong trade against an already-soft budget.
  // The fixed blocks AFTER a budgeted one are: they are kept whatever it
  // costs, so a block before them may only spend what they leave.
  const middle: string[] = [];
  sections.forEach((section, index) => {
    if (section.omittedNote === undefined) {
      middle.push("", ...section.block);
      return;
    }
    const laterFixed = sections
      .slice(index + 1)
      .flatMap((later) =>
        later.omittedNote === undefined ? ["", ...later.block] : [],
      );
    const candidate = [...middle, "", ...section.block, ...laterFixed];
    const fits =
      Buffer.byteLength([...head, ...candidate, ...tail].join("\n"), "utf8") <=
      BUDGET_BYTES;
    middle.push("", ...(fits ? section.block : [section.omittedNote]));
  });
  return [...head, ...middle, ...tail].join("\n");
}

/** The parent's description, clipped to a head — the shape of the epic, not all of it. */
function parentSection(parent: TaskItem | null): BudgetedSection | null {
  const description = parent?.description?.trim();
  if (!parent || !description) return null;
  const clipped = clipText(description, PARENT_DESCRIPTION_MAX_CHARS);
  return {
    block: [
      `## Parent Task ${parent.id} — description`,
      "",
      clipped.text,
      ...(clipped.truncated
        ? [
            "",
            `_Read the full parent body with \`task_read\` (id ${parent.id})._`,
          ]
        : []),
    ],
    omittedNote: `_Parent Task ${parent.id}'s description is omitted here for size; \`task_read\` (id ${parent.id}) has it._`,
  };
}

/**
 * The Initiatives holding the Task: per Initiative, a header that is always
 * kept, then its description's head as a budgeted block. Read now, so the
 * session starts from the next open milestone as it stands; the membership
 * itself came with the Task's own read.
 */
function initiativeSections(
  initiatives: readonly TaskInitiativeRef[],
): Array<BudgetedSection | FixedSection> {
  const sections: Array<BudgetedSection | FixedSection> = [];
  for (const initiative of initiatives) {
    const brief = initiativeBrief(initiative.id);
    if (!brief) continue;
    const name = `Initiative-${initiative.id}`;
    sections.push({
      block: [
        ...(sections.length ? [] : ["## Initiatives", ""]),
        `### [${name}](pa://initiative/${initiative.id}) — ${initiative.title}`,
        "",
        `- State: ${initiative.state}`,
        `- Membership: ${
          initiative.through
            ? `through ancestor Task ${initiative.through.id} — ${initiative.through.title}`
            : "direct member"
        }`,
        `- Next open milestone: ${
          brief.nextMilestone
            ? `Task ${brief.nextMilestone.id} — ${brief.nextMilestone.title}`
            : "none"
        }`,
        `- Members, dependencies and milestones: \`initiative_read\` (id ${initiative.id})`,
      ],
    });
    const description = brief.description.trim();
    if (!description) continue;
    const clipped = clipText(description, INITIATIVE_DESCRIPTION_MAX_CHARS);
    sections.push({
      block: [
        clipped.text,
        ...(clipped.truncated
          ? [
              "",
              `_Read the full description with \`initiative_read\` (id ${initiative.id})._`,
            ]
          : []),
      ],
      omittedNote: `_${name}'s description is omitted here for size; \`initiative_read\` (id ${initiative.id}) has it._`,
    });
  }
  return sections;
}
