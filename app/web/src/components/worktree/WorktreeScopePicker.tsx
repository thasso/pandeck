/**
 * @component WorktreeScopePicker
 * @purpose The Review toolbar's ONE "what am I looking at" control: it states the
 *   current diff scope in words and opens every way to change it — uncommitted
 *   changes, the whole branch against its base, or a commit / commit range from the
 *   log. Anchored popover everywhere but a phone, which gets a bottom sheet.
 * @useWhen The worktree Review view's toolbar.
 * @avoidWhen Choosing how the diff is RENDERED (by-file vs changeset, unified vs
 *   split, wrap…). That is the view-options popover; mixing the two is what made
 *   this toolbar unreadable — three scope controls sat beside two rendering
 *   controls and two navigation tabs, all unlabelled icons on a phone.
 * @intent One control, one label, one surface. The presets and the commit log were
 *   separate triggers whose combined state you had to infer from which one looked
 *   active; now the trigger says "Uncommitted", "vs main" or "a1b2c3d → working
 *   tree" at every width, which is also why the object panel no longer needs a
 *   "Viewing" section to spell the same thing out.
 * @intent Range semantics match the old History view: from = the older commit
 *   (exclusive), to = the newer one.
 */
import { useCallback, useState } from "react";
import {
  Check,
  ChevronDown,
  FileDiff,
  GitCommitHorizontal,
  GitCompareArrows,
} from "lucide-react";
import type { WorktreeCommitLogEntry, WorktreeRecord } from "@assistant/shared";
import { fetchWorktreeLog } from "../../lib/worktrees.ts";
import { Popover } from "../Popover.tsx";
import { useMobileLayout } from "../shell/useMobileLayout.ts";
import { Sheet } from "../ui/Sheet.tsx";
import { ErrorNote, PaneLoading } from "../ui/load.tsx";
import { useFetchState, useReloadOnToken } from "../../hooks/useFetchState.ts";
import { dataOf, errorOf, isInitialLoad } from "../../lib/loadState.ts";

/** Abbreviate an oid, keeping any `~n` suffix the range machinery appends. */
function shortRev(ref: string): string {
  const match = /^([0-9a-f]{12,})(~\d+)?$/i.exec(ref);
  return match ? `${match[1]!.slice(0, 7)}${match[2] ?? ""}` : ref;
}

/** What the trigger says: the scope, in the words you would use for it. */
function worktreeScopeLabel(
  worktree: WorktreeRecord,
  from?: string,
  to?: string,
): string {
  if (!from) return "Uncommitted";
  if (from === worktree.baseCommit && !to) return `vs ${worktree.baseBranch}`;
  // One commit is the common case and reads as one thing, not as a range against
  // its own parent.
  if (to && from === `${to}~1`) return `Commit ${shortRev(to)}`;
  return `${shortRev(from)} → ${to ? shortRev(to) : "working tree"}`;
}

export function WorktreeScopePicker({
  worktree,
  narrow,
  refreshToken,
  from,
  to,
  onPick,
}: {
  worktree: WorktreeRecord;
  /**
   * Compact single-column host (a phone, or the right side panel): the label
   * gets the width the glyph would take. It does NOT decide the surface — a
   * viewport-wide sheet dropped over the whole app from a side panel is not a
   * narrow-layout affordance, it is a phone one, so that reads the breakpoint.
   */
  narrow: boolean;
  refreshToken: number;
  from?: string | undefined;
  to?: string | undefined;
  /** Pick a scope: no arguments = uncommitted changes. */
  onPick: (from?: string, to?: string) => void;
}) {
  const phone = useMobileLayout();
  const [sheetOpen, setSheetOpen] = useState(false);
  const label = worktreeScopeLabel(worktree, from, to);
  const trigger = (
    <>
      {/* The chevron already says "picker", so a phone spends its width on the
          LABEL instead of a second glyph. */}
      {narrow ? null : <GitCompareArrows size={13} className="shrink-0" />}
      <span className="min-w-0 max-w-48 truncate">{label}</span>
      <ChevronDown size={12} className="shrink-0 text-faint" />
    </>
  );
  const triggerClass =
    "flex min-w-0 shrink items-center gap-1.5 rounded-md bg-raised px-2 py-1 text-caption font-medium text-fg";

  const body = (close: () => void) => (
    <ScopePanel
      worktree={worktree}
      refreshToken={refreshToken}
      from={from}
      to={to}
      onPick={(pickedFrom, pickedTo) => onPick(pickedFrom, pickedTo)}
      onClose={close}
    />
  );

  if (phone) {
    return (
      <>
        <button
          type="button"
          title={`Reviewing: ${label}`}
          onClick={() => setSheetOpen(true)}
          className={triggerClass}
        >
          {trigger}
        </button>
        <Sheet
          open={sheetOpen}
          title="What to review"
          onClose={() => setSheetOpen(false)}
        >
          {body(() => setSheetOpen(false))}
        </Sheet>
      </>
    );
  }

  return (
    <Popover
      align="left"
      placement="bottom"
      title="What to review"
      className={triggerClass}
      button={trigger}
    >
      {(close) => <div className="w-[380px] max-w-[80vw]">{body(close)}</div>}
    </Popover>
  );
}

/** The presets and the commit log in ONE surface: every scope this view has. */
function ScopePanel({
  worktree,
  refreshToken,
  from,
  to,
  onPick,
  onClose,
}: {
  worktree: WorktreeRecord;
  refreshToken: number;
  from?: string | undefined;
  to?: string | undefined;
  onPick: (from?: string, to?: string) => void;
  onClose: () => void;
}) {
  const active = !from
    ? "uncommitted"
    : from === worktree.baseCommit && !to
      ? "vs-base"
      : "custom";
  const preset = (
    id: string,
    label: string,
    icon: typeof FileDiff,
    pick: () => void,
  ) => {
    const Icon = icon;
    return (
      <button
        type="button"
        onClick={() => {
          pick();
          onClose();
        }}
        className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-caption ${active === id ? "bg-raised text-fg" : "text-muted-foreground hover:bg-raised hover:text-fg"}`}
      >
        <Icon size={13} className="shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {active === id ? (
          <Check size={13} className="shrink-0 text-primary" />
        ) : null}
      </button>
    );
  };
  return (
    <div className="flex max-h-[70vh] flex-col">
      <div className="flex flex-col gap-px border-b border-line p-1">
        {preset("uncommitted", "Uncommitted changes", FileDiff, () => onPick())}
        {worktree.isMain
          ? null
          : preset(
              "vs-base",
              `Whole branch vs ${worktree.baseBranch}`,
              GitCompareArrows,
              () => onPick(worktree.baseCommit),
            )}
      </div>
      <CommitListPanel
        worktree={worktree}
        refreshToken={refreshToken}
        onPick={onPick}
        onClose={onClose}
      />
    </div>
  );
}

function CommitListPanel({
  worktree,
  refreshToken,
  onPick,
  onClose,
}: {
  worktree: WorktreeRecord;
  refreshToken: number;
  onPick: (from: string, to: string) => void;
  onClose: () => void;
}) {
  const [rangeMode, setRangeMode] = useState(false);
  const [rangeStart, setRangeStart] = useState<string | null>(null);

  // The worktree is the key; a new commit (watcher push) refreshes the same log
  // and keeps the commits you were reading on screen (R2). A failure used to be
  // answered with an empty array, which read as "no commits" — a branch with a
  // history looking freshly created.
  const loadLog = useCallback(
    async () => (await fetchWorktreeLog(worktree.id, 100)).entries,
    [worktree.id],
  );
  const { state, reload } = useFetchState<WorktreeCommitLogEntry[]>(
    worktree.id,
    loadLog,
  );
  useReloadOnToken(worktree.id, refreshToken, reload);
  const entries = dataOf(state);
  const error = errorOf(state);

  const pickRange = (a: WorktreeCommitLogEntry, b: WorktreeCommitLogEntry) => {
    if (!entries) return;
    // Entries are newest-first: the larger index is the OLDER commit, which
    // becomes the exclusive `from` side of the range.
    const [older, newer] =
      entries.indexOf(a) > entries.indexOf(b) ? [a, b] : [b, a];
    onPick(older.oid, newer.oid);
    setRangeStart(null);
    onClose();
  };

  const pick = (entry: WorktreeCommitLogEntry, shiftKey: boolean) => {
    if (rangeStart) {
      const start = entries?.find((item) => item.oid === rangeStart);
      if (start && start.oid !== entry.oid) pickRange(start, entry);
      else setRangeStart(null);
      return;
    }
    if (rangeMode || shiftKey) {
      setRangeStart(entry.oid);
      return;
    }
    onPick(`${entry.oid}~1`, entry.oid);
    onClose();
  };

  return (
    <div className="flex max-h-[60vh] flex-col">
      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <p className="text-caption text-faint">
          {rangeStart
            ? "Pick the other end of the range."
            : "Tap a commit for its diff. Shift-click compares a range."}
        </p>
        <button
          type="button"
          onClick={() => {
            setRangeMode((value) => !value);
            setRangeStart(null);
          }}
          aria-pressed={rangeMode}
          className={`shrink-0 rounded-md border px-1.5 py-0.5 text-micro ${rangeMode ? "border-primary/40 bg-accent text-primary" : "border-line text-muted-foreground hover:bg-raised hover:text-fg"}`}
        >
          Range
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries === undefined ? (
          isInitialLoad(state) ? (
            <PaneLoading label="Loading commits…" />
          ) : (
            <ErrorNote
              className="m-2"
              message={`Could not load the commits: ${error ?? "not loaded"}`}
              onRetry={reload}
            />
          )
        ) : entries.length === 0 ? (
          <div className="p-4 text-caption text-muted-foreground">
            No commits.
          </div>
        ) : (
          <div className="flex flex-col gap-px p-1">
            {/* R2: the commits stay pickable while a failed refresh says so. */}
            {error !== undefined ? (
              <ErrorNote
                className="mb-1"
                message={`Could not refresh the commits: ${error}`}
                onRetry={reload}
              />
            ) : null}
            {entries.map((entry) => (
              <button
                key={entry.oid}
                type="button"
                onClick={(event) => pick(entry, event.shiftKey)}
                className={`flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1.5 text-left ${rangeStart === entry.oid ? "bg-accent text-fg" : "text-muted-foreground hover:bg-raised hover:text-fg"} ${entry.onBase ? "opacity-50" : ""}`}
              >
                <GitCommitHorizontal
                  size={13}
                  className="mt-0.5 shrink-0 text-faint"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-caption font-medium">
                    {entry.subject}
                  </span>
                  <span className="block truncate text-micro text-faint">
                    {entry.author} ·{" "}
                    {new Date(entry.authoredAt).toLocaleDateString()}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-micro text-faint">
                  {entry.shortOid}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
