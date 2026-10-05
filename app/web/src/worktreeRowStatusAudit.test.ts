import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

/**
 * Remembered-worktree-status source audit.
 *
 * `UIState.cachedWorktreeStatuses` is what git said when this browser last
 * looked, restored from the shell cache so the Projects rows paint at their
 * real height instead of growing one by one as each `watchWorktree` is
 * answered. It is a LAYOUT input and nothing else: `worktreeStatuses` remains
 * what this socket episode observed, and `lib/worktreeAxes.ts`'s contract —
 * an absent projection is unknown, never clean — only holds for a decision if
 * the remembered record never reaches one.
 *
 * That is a rule about WHERE a value may be read, which no per-surface test
 * can hold: the failure mode is a new surface, or a new prop on an existing
 * one, quietly handed the fallback because it renders worktree rows too. The
 * Worktrees inbox is the standing example — its cards look like rows, but
 * `worktreeCardActions` decides from a status which of Commit, Push, Pull,
 * Rebase and Fast-forward it offers, and `classifyWorktree` decides what the
 * retire dialog says it is about to remove.
 *
 * Two lists hold it, because reading the slice and PASSING ON what was resolved
 * from it are different moves and the second is the one that would actually
 * leak. Every line naming the remembered record is listed first; then every
 * status COLLECTION handed to a component, so a map that resolved the fallback
 * cannot reach a new destination — nor an existing one it is not sanctioned for
 * — without failing here. A listed line that matches nothing fails too, so
 * neither list can rot into permissions.
 *
 * A sink records the RECEIVER, not just the file and the expression. Without it
 * the list is a multiset that two sanctioned lines can trade values within:
 * swapping what the Projects tree and the Sessions inbox are handed leaves every
 * string in it unchanged, which is precisely the leak.
 *
 * Singular `status={…}` props count as sinks too when their expression names a
 * fallback-capable source — a per-id read out of one of those maps would
 * otherwise walk past both lists. Unrelated `status` props (a Task's, an
 * integration's) are not frozen: the expression filter, not the prop name, is
 * what decides.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

const SCAN_EXTENSIONS = new Set([".ts", ".tsx"]);

/** The state slice, and the one prop that carries it into a component. */
const NAMES = ["cachedWorktreeStatuses", "lastKnownWorktreeStatuses"];

/** One entry per line that may name it, as `<file>: <line>`. */
const SANCTIONED: readonly string[] = [
  // The slice itself: declared, empty, hydrated from the cache, written back.
  "hooks/useAssistant.ts: cachedWorktreeStatuses: Record<string, WorktreeGitStatus>;",
  "hooks/useAssistant.ts: cachedWorktreeStatuses: NO_WORKTREE_STATUSES,",
  "hooks/useAssistant.ts: cachedWorktreeStatuses: cache.worktreeStatuses ?? NO_WORKTREE_STATUSES,",
  "hooks/useAssistant.ts: state.cachedWorktreeStatuses,",
  // Destination 1: the Project page's worktree section rows.
  "App.tsx: state.cachedWorktreeStatuses,",
  // Destination 2: the Projects tree rows, through the sidebar.
  "App.tsx: lastKnownWorktreeStatuses={state.cachedWorktreeStatuses}",
  "components/Sidebar.tsx: lastKnownWorktreeStatuses?: Record<string, WorktreeGitStatus>;",
  "components/Sidebar.tsx: lastKnownWorktreeStatuses = NO_WORKTREE_STATUSES,",
  "components/Sidebar.tsx: rowWorktreeStatus(worktreeStatuses, lastKnownWorktreeStatuses, id);",
];

function shouldScan(path: string): boolean {
  if (path.endsWith(".d.ts")) return false;
  if (/\.test\.[tj]sx?$/.test(path)) return false;
  const dot = path.lastIndexOf(".");
  return dot >= 0 && SCAN_EXTENSIONS.has(path.slice(dot));
}

function sources(): Array<[string, string]> {
  const files: Array<[string, string]> = [];
  for (const entry of readdirSync(HERE, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    if (!shouldScan(full)) continue;
    files.push([relative(HERE, full), readFileSync(full, "utf8")]);
  }
  return files;
}

function reads(): string[] {
  const found: string[] = [];
  for (const [file, source] of sources())
    for (const line of source.split("\n")) {
      const text = line.trim();
      if (NAMES.some((name) => text.includes(name)))
        found.push(`${file}: ${text}`);
    }
  return found.sort();
}

test("only the Projects rows read the remembered worktree statuses", () => {
  expect(reads()).toEqual([...SANCTIONED].sort());
});

/** A `status`/`statuses`/`worktreeStatuses` prop, with its value expression. */
const STATUS_PROP =
  /(worktreeStatuses|statuses|status)=\{([^}]*(?:\}[^}]*)*?)\}/g;

/**
 * Whether this prop carries worktree git status. The prop NAME is decisive only
 * for `worktreeStatuses`; anything else has to name a status source in its
 * expression, which is what keeps the Backlog's Task `statuses` and every
 * integration's `status` out of a list they would only add noise to.
 */
function carriesWorktreeStatus(prop: string, expression: string): boolean {
  return (
    prop === "worktreeStatuses" ||
    /worktreeStatuses|StatusCache|lastKnown/.test(expression)
  );
}

/** The component this prop is being passed to: the innermost open element. */
function receiver(source: string, index: number): string {
  const opens = [...source.slice(0, index).matchAll(/<([A-Z][\w.]*)/g)];
  return opens.at(-1)?.[1] ?? "?";
}

/** One entry per status a component is handed, as `<file>: <Receiver>.<prop>={<expr>}`. */
const SANCTIONED_SINKS: readonly string[] = [
  // MAY carry the fallback: the two Projects row surfaces, and the Project
  // page's pass-through from its own prop down to its worktree section.
  "App.tsx: ProjectDetailPage.worktreeStatuses={projectPageStatusCache.current.value}",
  "components/Sidebar.tsx: ProjectTreePane.worktreeStatuses={projectStatusCache.current.value}",
  "components/ProjectDetailPage.tsx: ProjectDetail.worktreeStatuses={worktreeStatuses}",
  "components/ProjectDetailPage.tsx: ProjectWorktreeRows.statuses={worktreeStatuses}",
  // LIVE ONLY. The Sessions inbox marks a session's worktree dirty and the
  // Pull Requests page states one checkout's dirt and drift; the worktree page
  // and its overlays commit, push and remove. Every one of them would be
  // claiming something about NOW from a record about the past.
  "App.tsx: Sidebar.worktreeStatuses={state.worktreeStatuses}",
  "App.tsx: PullRequestDetailPage.status={pullRequestWorktreeId ? state.worktreeStatuses[pullRequestWorktreeId] : undefined}",
  "App.tsx: WorktreeInspector.status={state.worktreeStatuses[route.id]}",
  "App.tsx: WorktreeDetailPage.status={state.worktreeStatuses[worktree.id]}",
  // The Knowledge Base checkout, read live by its route and the panel tab.
  "App.tsx: WorktreeDetailPage.status={state.worktreeStatuses[KNOWLEDGE_WORKTREE_ID]}",
  "App.tsx: KnowledgePanel.status={state.worktreeStatuses[KNOWLEDGE_WORKTREE_ID]}",
  "App.tsx: KnowledgeInspector.status={state.worktreeStatuses[KNOWLEDGE_WORKTREE_ID]}",
  "components/Sidebar.tsx: SessionInbox.worktreeStatuses={worktreeStatuses}",
  "components/worktree/WorktreeOverlays.tsx: MergeWorktreeDialog.status={state.worktreeStatuses[worktree.id]}",
  "components/worktree/WorktreeOverlays.tsx: RemoveWorktreeDialog.status={state.worktreeStatuses[worktree.id]}",
];

function sinks(): string[] {
  const found: string[] = [];
  for (const [file, source] of sources()) {
    for (const match of source.matchAll(STATUS_PROP)) {
      const [, prop, expression] = match;
      const text = expression!.replace(/\s+/g, " ").trim();
      if (carriesWorktreeStatus(prop!, text))
        found.push(
          `${file}: ${receiver(source, match.index)}.${prop}={${text}}`,
        );
    }
  }
  return found.sort();
}

test("every worktree status reaches an accounted-for surface", () => {
  expect(sinks()).toEqual([...SANCTIONED_SINKS].sort());
});
