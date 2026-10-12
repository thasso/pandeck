import { memo, useCallback, useMemo, useState } from "react";
import { GitBranch } from "lucide-react";
import type { IdleWorktree, PullRequestInventoryItem } from "@assistant/shared";
import { ErrorNote, Skeleton } from "./common/load.tsx";
import { ConfirmDialog } from "./common/dialogs.tsx";
import { SessionDeliveryMark } from "./SessionDeliveryMark.tsx";
import { Button } from "./ui/button.tsx";
import { Item, ItemContent, ItemDescription, ItemTitle } from "./ui/item.tsx";
import { dataOf, errorOf, type LoadState } from "../lib/loadState.ts";
import {
  idleForLabel,
  idleWorktreeLabel,
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
  const open = () => onOpen(worktree.id);
  return (
    <Item
      size="xs"
      data-idle-worktree-row
      data-list-row-id={`idle-worktree:${worktree.id}`}
      role="button"
      tabIndex={0}
      aria-label={`Worktree ${worktree.branch} — ${label}, ${idleFor}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
      className={`cursor-pointer select-none hover:bg-muted ${density === "comfortable" ? "py-2" : "py-1.5"}`}
    >
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="w-full min-w-0 gap-1.5 font-normal">
          <GitBranch
            size={14}
            className="shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {worktree.branch}
          </span>
          {worktree.pullRequest ? (
            <SessionDeliveryMark
              session={{ pullRequest: worktree.pullRequest }}
              variant="glyph"
            />
          ) : null}
        </ItemTitle>
        <ItemDescription className="flex min-w-0 items-center gap-1.5 pl-5">
          {project ? (
            <span
              className="flex shrink-0 items-center gap-1"
              title={project.name}
            >
              <span
                className="size-1.5 rounded-full"
                style={{ backgroundColor: project.color }}
                aria-hidden
              />
              {project.key}
            </span>
          ) : null}
          <span
            className={`min-w-0 flex-1 truncate ${item.kind === "delivered" ? "" : "text-warning"}`}
          >
            {label}
          </span>
          <span className="shrink-0 tabular-nums">{idleFor}</span>
        </ItemDescription>
      </ItemContent>
    </Item>
  );
});

/** What one bulk retirement left behind, for the dialog that asked for it. */
interface BulkState {
  open: boolean;
  busy: boolean;
  error?: string;
}

const CLOSED: BulkState = { open: false, busy: false };

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
  pullRequests,
  projects,
  density,
  onReload,
  onOpenWorktree,
  onRetired,
}: {
  idle: LoadState<IdleWorktree[]>;
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
  const rows = useMemo(
    () => idleWorktreeRows(data ?? [], pullRequests),
    [data, pullRequests],
  );
  const retirable = useMemo(() => retirableIdleWorktrees(rows), [rows]);
  const [bulk, setBulk] = useState<BulkState>(CLOSED);
  const [now] = useState(() => Date.now());

  const retireAll = useCallback(async () => {
    setBulk({ open: true, busy: true });
    const refused: string[] = [];
    let retired = 0;
    // One at a time: each retirement takes its repository's lock, and a run of
    // them against one repository would only queue behind each other.
    for (const item of retirable) {
      try {
        const result = await retireWorktree(item.worktree.id, {
          deleteBranch: true,
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
      // Stays in the dialog that asked: the refused ones are still listed.
      setBulk({
        open: true,
        busy: false,
        error: `${retired} retired; ${refused.length} refused — ${refused.join("; ")}`,
      });
      return;
    }
    setBulk(CLOSED);
    // The rows leave the surface with their checkouts, so the outcome is named.
    showToast(`Retired ${retired} worktree${retired === 1 ? "" : "s"}.`, {
      tone: "success",
    });
  }, [retirable, onRetired]);

  if (data === undefined) {
    const error = errorOf(idle);
    if (error)
      return <ErrorNote message={error} onRetry={onReload} className="m-1" />;
    if (idle.status === "idle") return null;
    return (
      <div role="status" aria-label="Loading idle worktrees">
        <Skeleton className="h-11" />
      </div>
    );
  }
  if (rows.length === 0) return null;
  const error = errorOf(idle);
  const named = retirable.slice(0, NAMED_IN_DIALOG);
  return (
    <section
      aria-labelledby="pull-requests-idle-worktrees"
      className="mb-1 flex flex-col gap-px"
    >
      <div className="flex items-center gap-1 px-2 pb-0.5">
        <h2
          id="pull-requests-idle-worktrees"
          className="min-w-0 flex-1 text-xs font-medium text-muted-foreground"
        >
          Idle worktrees ({rows.length})
        </h2>
        {retirable.length > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            busy={bulk.busy}
            onClick={() => setBulk({ open: true, busy: false })}
          >
            Retire {retirable.length}…
          </Button>
        ) : null}
      </div>
      {error ? (
        <ErrorNote message={error} onRetry={onReload} className="mb-1" />
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
      {bulk.open ? (
        <ConfirmDialog
          title={`Retire ${retirable.length} worktree${retirable.length === 1 ? "" : "s"} with nothing unmerged?`}
          body={
            <>
              <p>
                Each checkout and its local branch is removed after its base
                branch is refreshed and verified to contain the branch. One that
                turns out to hold unmerged work is refused and stays.
              </p>
              <ul className="mt-1 list-disc pl-4 font-mono text-xs">
                {named.map((item) => (
                  <li key={item.worktree.id}>{item.worktree.branch}</li>
                ))}
                {retirable.length > named.length ? (
                  <li>and {retirable.length - named.length} more</li>
                ) : null}
              </ul>
            </>
          }
          confirmLabel={`Retire ${retirable.length}`}
          danger
          busy={bulk.busy}
          error={bulk.error ?? null}
          confirmDisabled={retirable.length === 0}
          onConfirm={() => void retireAll()}
          onCancel={() => setBulk(CLOSED)}
        />
      ) : null}
    </section>
  );
}
