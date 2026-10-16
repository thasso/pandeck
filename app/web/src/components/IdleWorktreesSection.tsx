import { memo, useCallback, useMemo, useState } from "react";
import { FolderKanban, GitBranch, HardDrive, Moon } from "lucide-react";
import type { IdleWorktree, PullRequestInventoryItem } from "@assistant/shared";
import { ErrorNote, RefreshIndicator, Skeleton } from "./common/load.tsx";
import { ConfirmDialog } from "./common/dialogs.tsx";
import { ListRow } from "./common/ListRow.tsx";
import { ListGroupSection } from "./ListGroupSection.tsx";
import { SessionDeliveryMark } from "./SessionDeliveryMark.tsx";
import { Button } from "./ui/button.tsx";
import {
  dataOf,
  errorOf,
  isPending,
  type LoadState,
} from "../lib/loadState.ts";
import {
  idleForLabel,
  idleWorktreeLabel,
  idleWorktreeMatches,
  idleWorktreeRows,
  retirableIdleWorktrees,
} from "../lib/idleWorktrees.ts";
import { retireWorktree } from "../lib/worktrees.ts";
import { showToast } from "../lib/toast.ts";
import type { RowDensity } from "../lib/rowDensity.ts";

/** The project chip a row states, resolved once by the browser. */
export interface IdleRowProject {
  key: string;
  name: string;
  color: string;
}

/** Branches a confirmation names before it says "and N more". */
const NAMED_IN_DIALOG = 8;

const IdleWorktreeRow = memo(function IdleWorktreeRow({
  item,
  project,
  now,
  density,
  onOpen,
}: {
  item: IdleWorktree;
  project?: IdleRowProject | undefined;
  now: number;
  density: RowDensity;
  onOpen: (id: string) => void;
}) {
  const { worktree } = item;
  const label = idleWorktreeLabel(item);
  const idleFor = idleForLabel(item.lastActivityAt, now);
  return (
    <ListRow
      rowProps={{
        "data-idle-worktree-row": "",
        "data-list-row-id": `idle-worktree:${worktree.id}`,
      }}
      ariaLabel={`Worktree ${worktree.branch} — ${label}, ${idleFor}`}
      density={density}
      onOpen={() => onOpen(worktree.id)}
      // The same three rows as the pull requests above it: where it lives,
      // which checkout, and what retiring it would lose.
      context={
        <>
          {project ? (
            <span
              className="flex max-w-full shrink-0 items-center gap-1"
              title={project.name}
            >
              <FolderKanban
                size={11}
                className="shrink-0"
                style={{ color: project.color }}
                aria-hidden
              />
              <span className="min-w-0 truncate">{project.key}</span>
            </span>
          ) : null}
          <span className="flex shrink-0 items-center gap-1 text-foreground">
            <HardDrive size={11} className="shrink-0" aria-hidden />
            worktree
          </span>
        </>
      }
      age={idleFor}
      leading={
        <GitBranch
          size={13}
          className="shrink-0 text-muted-foreground"
          aria-hidden
        />
      }
      title={worktree.branch}
      signals={
        <>
          <span
            className={`min-w-0 flex-1 basis-0 truncate ${item.kind === "delivered" ? "" : "text-warning"}`}
            title={label}
          >
            {label}
          </span>
          {worktree.pullRequest ? (
            <span className="flex shrink-0 items-center">
              <SessionDeliveryMark
                session={{ pullRequest: worktree.pullRequest }}
                variant="responsive"
                showNumber
              />
            </span>
          ) : null}
        </>
      }
    />
  );
});

/** What one bulk retirement left behind, for the dialog that asked for it. */
/**
 * One bulk retirement, from the click that opened its dialog to the click that
 * dismissed it. It owns the TARGETS it was opened on: the consent was given for
 * those checkouts, and a poll — or the refusal itself, which can move a
 * checkout out of the queue — must neither change what runs nor close the
 * dialog that holds the outcome.
 */
interface BulkState {
  targets: IdleWorktree[];
  busy: boolean;
  error?: string;
}

/**
 * @component IdleWorktreesSection
 * @purpose The worktree half of the Pull Requests browser's cleanup queue:
 *   checkouts nobody is working in and no pull-request row covers, each with
 *   what retiring it would lose (`lib/idleWorktrees.ts`).
 * @useWhen Under the pull-request groups of `PullRequestBrowser`.
 * @intent Nothing is removed without the user. A row opens its worktree, whose
 *   own Retire carries the consent ladder; the one bulk act takes only the
 *   worktrees with nothing unmerged, never forces, and leaves a refusal in its
 *   dialog. Hidden while the source has answered with nothing.
 */
export function IdleWorktreesSection({
  idle,
  fetchedAt,
  pullRequests,
  projects,
  query = "",
  density,
  onReload,
  onOpenWorktree,
  onRetired,
}: {
  idle: LoadState<IdleWorktree[]>;
  /**
   * When the server built that answer — the rows' clock, so "idle N" advances
   * with each poll and the bulk set's age rule reads one consistent instant.
   */
  fetchedAt: number | undefined;
  /** The browser's search box; it filters these rows too. */
  query?: string;
  /** The inventory rows on screen: a checkout one of them covers is theirs. */
  pullRequests: readonly PullRequestInventoryItem[] | undefined;
  projects: ReadonlyMap<string, IdleRowProject>;
  density: RowDensity;
  onReload: () => void;
  onOpenWorktree: (id: string) => void;
  /** Something was retired: refetch what shows it. */
  onRetired: () => void;
}) {
  const data = dataOf(idle);
  const now = fetchedAt ?? 0;
  const rows = useMemo(
    () =>
      idleWorktreeRows(data ?? [], pullRequests).filter((item) => {
        const project = projects.get(item.worktree.projectId);
        return idleWorktreeMatches(
          item,
          query,
          project ? `${project.key} ${project.name}` : undefined,
        );
      }),
    [data, pullRequests, projects, query],
  );
  const retirable = useMemo(
    () => retirableIdleWorktrees(rows, now),
    [rows, now],
  );
  const [bulk, setBulk] = useState<BulkState | null>(null);

  const retireAll = useCallback(
    async (targets: IdleWorktree[]) => {
      setBulk({ targets, busy: true });
      const refused: string[] = [];
      let retired = 0;
      // One at a time: each retirement takes its repository's lock, and a run of
      // them against one repository would only queue behind each other.
      for (const item of targets) {
        try {
          // `requireIdle`: these rows are a snapshot, so the server asks the
          // idle rule again under its removal hold before it settles anyone.
          const result = await retireWorktree(item.worktree.id, {
            deleteBranch: true,
            requireIdle: true,
          });
          if (result.status === "refused")
            refused.push(`${item.worktree.branch}: ${result.refusal}`);
          else retired += 1;
        } catch (err) {
          refused.push(
            `${item.worktree.branch}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      onRetired();
      if (refused.length > 0) {
        // Stays in the dialog that asked, until it is dismissed.
        setBulk({
          targets,
          busy: false,
          error: `${retired} retired; ${refused.length} refused — ${refused.join("; ")}`,
        });
        return;
      }
      setBulk(null);
      // The rows leave the surface with their checkouts, so the outcome is named.
      showToast(`Retired ${retired} worktree${retired === 1 ? "" : "s"}.`, {
        tone: "success",
      });
    },
    [onRetired],
  );

  // Rendered whatever the list now says (see `BulkState`).
  const dialog = bulk ? (
    <BulkRetireDialog
      bulk={bulk}
      onConfirm={() => void retireAll(bulk.targets)}
      onCancel={() => setBulk(null)}
    />
  ) : null;

  const error = errorOf(idle);
  if (data === undefined) {
    if (error)
      return (
        <>
          <ErrorNote message={error} onRetry={onReload} className="m-1" />
          {dialog}
        </>
      );
    if (idle.status === "idle") return dialog;
    return (
      <>
        <div role="status" aria-label="Loading idle worktrees">
          <Skeleton className="h-11" />
        </div>
        {dialog}
      </>
    );
  }
  // An answered empty queue draws nothing — but a failed refresh still says
  // so (R2), even over an empty retained answer.
  if (rows.length === 0)
    return (
      <>
        {error ? (
          <ErrorNote message={error} onRetry={onReload} className="m-1" />
        ) : null}
        {dialog}
      </>
    );
  return (
    <>
      <ListGroupSection
        id="idle-worktrees"
        title="Idle worktrees"
        count={rows.length}
        icon={<Moon size={14} className="shrink-0" aria-hidden />}
        actions={
          // R2: a poll keeps the rows and says so here. A status, not an act:
          // the band itself offers nothing to do.
          isPending(idle) ? (
            <RefreshIndicator label="Refreshing idle worktrees" />
          ) : undefined
        }
      >
        {error ? (
          <ErrorNote message={error} onRetry={onReload} className="m-1" />
        ) : null}
        {rows.map((item) => (
          <IdleWorktreeRow
            key={item.worktree.id}
            item={item}
            project={projects.get(item.worktree.projectId)}
            now={now}
            density={density}
            onOpen={onOpenWorktree}
          />
        ))}
        {/* The one bulk act, under the rows it acts on: quiet and
            right-aligned, as an action row is everywhere else. */}
        {retirable.length > 0 ? (
          <div className="flex justify-end border-b border-border/60 px-1 py-1">
            <Button
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              busy={bulk?.busy ?? false}
              onClick={() => setBulk({ targets: retirable, busy: false })}
            >
              Retire {retirable.length} with nothing unmerged…
            </Button>
          </div>
        ) : null}
      </ListGroupSection>
      {dialog}
    </>
  );
}

/** The bulk act's confirmation, over the targets it was opened on. */
function BulkRetireDialog({
  bulk,
  onConfirm,
  onCancel,
}: {
  bulk: BulkState;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const count = bulk.targets.length;
  const named = bulk.targets.slice(0, NAMED_IN_DIALOG);
  return (
    <ConfirmDialog
      title={`Retire ${count} worktree${count === 1 ? "" : "s"} with nothing unmerged?`}
      body={
        <>
          <p>
            Each checkout and its local branch is removed after its base branch
            is refreshed and verified to contain the branch, and after the
            server confirms nobody started working there since this list was
            read. One that fails either check is refused and stays. No commit is
            lost, but files git ignores — a <code>.env</code>, local databases,
            caches — go with the checkout. Only worktrees untouched for a day
            are included.
          </p>
          <ul className="mt-1 list-disc pl-4 font-mono text-xs">
            {named.map((item) => (
              <li key={item.worktree.id}>{item.worktree.branch}</li>
            ))}
            {count > named.length ? (
              <li>and {count - named.length} more</li>
            ) : null}
          </ul>
        </>
      }
      confirmLabel={`Retire ${count}`}
      danger
      busy={bulk.busy}
      error={bulk.error ?? null}
      // A finished run that refused some is answered: it is dismissed, not
      // re-run over targets the outcome already describes.
      confirmDisabled={count === 0 || bulk.error !== undefined}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
