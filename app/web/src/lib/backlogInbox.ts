/**
 * Pure shaping for the Backlog's **Inbox** view: what arrived on its own and
 * still needs a decision from you.
 *
 * The Inbox exists because Tasks reach this app without you typing them —
 * meeting-minutes scanning, Slack intake, an agent noticing work mid-run. Those
 * deserve a look. What does NOT deserve one is an agent's own scaffolding: a
 * coding session that decomposes a Task you already accepted into subtasks
 * would otherwise fill the Inbox with implementation detail, which is exactly
 * the noise that makes an inbox get ignored.
 *
 * Hence the one rule worth stating plainly: a SUBTASK is never in the Inbox and
 * a TOP-LEVEL arrival always is. A subtask hangs off a parent you have already
 * seen; a root Task is a new claim on your attention whatever produced it.
 *
 * Membership keys on `triagedAt`, never on who created the Task — see
 * `belongsInInbox`.
 */
import type { Task } from "./backlogTree.ts";

/** Is this Task still waiting for the user to process it? */
function isUntriaged(task: Task): boolean {
  return task.triagedAt === undefined;
}

/**
 * Does this Task belong in the Inbox at all?
 *
 * Membership is `triagedAt` plus two exclusions, and deliberately NOT
 * `source.createdBy`: who WANTED a Task is a different question from whether it
 * was typed into the Backlog. A Slack shortcut import is honestly created "by
 * the user" and is still an arrival they have not processed, so keying on the
 * creator silently kept every Slack Task out of the surface advertised for it.
 * The server decides typed-vs-arrived at creation (`tasks.ts` `createTask`); a
 * Task you typed arrives here already triaged.
 *
 * `done` is excluded for the same reason Focus excludes it: finished work needs
 * no decision. A SUBTASK is excluded because it hangs off a parent you have
 * already seen — which is what keeps an agent decomposing accepted work from
 * filling the queue with implementation detail.
 */
export function belongsInInbox(task: Task): boolean {
  if (!isUntriaged(task)) return false;
  if (task.status === "done") return false;
  return task.parentId === undefined;
}

/**
 * The Inbox list: newest first, because triage is a queue you work from the top
 * of and the thing that just arrived is the one you have the most context for.
 */
export function buildInboxList(tasks: Task[]): Task[] {
  return tasks
    .filter(belongsInInbox)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Anything waiting? Drives the switcher's attention dot — a dot, not a count,
 *  because what matters is whether there is anything to process. */
export function hasInboxWork(tasks: Task[]): boolean {
  return tasks.some(belongsInInbox);
}

/**
 * WHERE a Task came from, as one short phrase.
 *
 * This is the Inbox row's whole reason for a second line: deciding what to do
 * with something you did not write requires knowing what produced it. It reads
 * the persona that created it rather than the raw session id, since "Day
 * scanner" tells you something and a uuid does not.
 */
export function taskOrigin(task: Task): string {
  const source = task.source;
  if (!source) return "Arrived";
  // Note there is no "You" branch: a Task you typed is triaged at creation and
  // never reaches this list, and an ARRIVAL recorded as user-created (the Slack
  // shortcut) came from somewhere the links below name.
  const external = (task.externalLinks ?? []).find(
    (link) =>
      link.source === "slack" ||
      link.source === "jira" ||
      link.source === "github" ||
      link.source === "forgejo",
  );
  if (external?.source === "slack") return "From Slack";
  if (external?.source === "jira") return "From Jira";
  if (external?.source === "github") return "From GitHub";
  if (external?.source === "forgejo") return "From Forgejo";
  return AGENT_ORIGIN[source.agentType ?? ""] ?? "From an agent";
}

/**
 * Personas that create Tasks, in the words the Inbox uses. An unknown persona
 * degrades to the generic phrase rather than printing an internal key.
 */
const AGENT_ORIGIN: Record<string, string> = {
  assistant: "From the assistant",
  "personal-assistant": "From the assistant",
  developer: "From a coding session",
  workshop: "From a coding session",
};
