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
import { cloneElement, useCallback, useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
} from "lucide-react";
import type { WorktreeCommitLogEntry, WorktreeRecord } from "@assistant/shared";
import { fetchWorktreeLog } from "../../lib/worktrees.ts";
import { Button } from "../ui/button.tsx";
import { Item, ItemContent, ItemMedia, ItemTitle } from "../ui/item.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { Toggle } from "../ui/toggle.tsx";
import { ListGroupSection } from "../ListGroupSection.tsx";
import { CommitItem } from "./FileHistoryList.tsx";
import { useMobileLayout } from "../shell/useMobileLayout.ts";
import { EdgeSheet } from "../common/EdgeSheet.tsx";
import { ErrorNote, PaneLoading } from "../common/load.tsx";
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
  entries?: readonly WorktreeCommitLogEntry[],
): string {
  if (!from) return "Uncommitted";
  if (from === worktree.baseCommit && !to) return `vs ${worktree.baseBranch}`;
  // One commit is the common case and reads as one thing, not as a range against
  // its own parent.
  if (to && from === `${to}~1`) return `Commit ${shortRev(to)}`;
  // A range reads as how much it holds; the hashes stay in the tooltip. The log
  // is newest-first and `from` is exclusive, so the count is the index gap.
  const fromIndex = entries?.findIndex((entry) => entry.oid === from) ?? -1;
  const toIndex = to
    ? (entries?.findIndex((entry) => entry.oid === to) ?? -1)
    : 0;
  if (fromIndex >= 0 && toIndex >= 0 && fromIndex > toIndex) {
    const count = fromIndex - toIndex;
    const commits = `${count} commit${count === 1 ? "" : "s"}`;
    return to ? commits : `${commits} + uncommitted`;
  }
  return scopeRangeText(from, to);
}

function scopeRangeText(from: string, to?: string): string {
  return `${shortRev(from)} → ${to ? shortRev(to) : "working tree"}`;
}

/**
 * The branch's commit log, shared by the trigger (a range's label counts its
 * commits) and the panel. A new commit (watcher push) refreshes the same log
 * and keeps the commits you were reading on screen (R2). A failure used to be
 * answered with an empty array, which read as "no commits" — a branch with a
 * history looking freshly created.
 */
function useWorktreeLog(worktreeId: string, refreshToken: number) {
  const loadLog = useCallback(
    async () => (await fetchWorktreeLog(worktreeId, 100)).entries,
    [worktreeId],
  );
  const fetch = useFetchState<WorktreeCommitLogEntry[]>(worktreeId, loadLog);
  useReloadOnToken(worktreeId, refreshToken, fetch.reload);
  return fetch;
}

type WorktreeLog = ReturnType<typeof useWorktreeLog>;

export function WorktreeScopePicker({
  worktree,
  narrow,
  refreshToken,
  from,
  to,
  onPick,
  trigger: triggerStyle = "button",
}: {
  /**
   * `subtitle`: the page header's second line under the branch — small muted
   * text and a chevron, the header's own weight — instead of a toolbar button.
   */
  trigger?: "button" | "subtitle";
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
  const [open, setOpen] = useState(false);
  const log = useWorktreeLog(worktree.id, refreshToken);
  const label = worktreeScopeLabel(worktree, from, to, dataOf(log.state));
  const trigger =
    triggerStyle === "subtitle" ? (
      <button
        type="button"
        className="flex min-w-0 max-w-full items-center gap-0.5 rounded-sm text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        title={`Reviewing: ${label}`}
        aria-label={`Reviewing: ${label}. Change what to review`}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0" aria-hidden />
      </button>
    ) : (
      <Button
        variant="secondary"
        size="sm"
        className="min-w-0 shrink"
        title={`Reviewing: ${from && !(to && from === `${to}~1`) && !(from === worktree.baseCommit && !to) ? scopeRangeText(from, to) : label}`}
      >
        {/* The chevron already says "picker", so a phone spends its width on the
          LABEL instead of a second glyph. */}
        {narrow ? null : <GitCompareArrows data-icon="inline-start" />}
        <span className="min-w-0 max-w-48 truncate">{label}</span>
        <ChevronDown data-icon="inline-end" />
      </Button>
    );
  const body = (
    <ScopePanel
      worktree={worktree}
      log={log}
      phone={phone}
      from={from}
      to={to}
      onPick={onPick}
      onClose={() => setOpen(false)}
    />
  );

  if (phone) {
    return (
      <>
        {cloneElement(trigger, { onClick: () => setOpen(true) })}
        <EdgeSheet
          open={open}
          title="What to review"
          flush
          onClose={() => setOpen(false)}
        >
          {body}
        </EdgeSheet>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      {/* ONE scroll: the popover's own, so the bands pin against it. */}
      <PopoverContent
        align="start"
        className="max-h-[min(32rem,var(--available-height))] w-96 overflow-y-auto p-0"
      >
        {body}
      </PopoverContent>
    </Popover>
  );
}

/** The presets and the commit log in ONE surface: every scope this view has. */
function ScopePanel({
  worktree,
  log,
  phone,
  from,
  to,
  onPick,
  onClose,
}: {
  worktree: WorktreeRecord;
  log: WorktreeLog;
  phone: boolean;
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
      <Item
        size="xs"
        variant={active === id ? "muted" : "default"}
        render={<button type="button" />}
        onClick={() => {
          pick();
          onClose();
        }}
        className="flex-nowrap text-left"
      >
        <ItemMedia variant="icon">
          <Icon />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full">
            <span className="truncate">{label}</span>
          </ItemTitle>
        </ItemContent>
        {active === id ? <Check size={13} className="text-primary" /> : null}
      </Item>
    );
  };
  return (
    <div className="flex flex-col">
      <ListGroupSection
        id={`scope-picker:${worktree.id}:scope`}
        title="Scope"
        icon={<GitCompareArrows size={14} aria-hidden className="shrink-0" />}
      >
        <div className="flex flex-col gap-1 p-1">
          {preset("uncommitted", "Uncommitted changes", FileDiff, () =>
            onPick(),
          )}
          {worktree.isMain
            ? null
            : preset(
                "vs-base",
                `Whole branch vs ${worktree.baseBranch}`,
                GitCompareArrows,
                () => onPick(worktree.baseCommit),
              )}
        </div>
      </ListGroupSection>
      <CommitListPanel
        worktree={worktree}
        log={log}
        phone={phone}
        onPick={onPick}
        onClose={onClose}
      />
    </div>
  );
}

function CommitListPanel({
  worktree,
  log,
  phone,
  onPick,
  onClose,
}: {
  worktree: WorktreeRecord;
  log: WorktreeLog;
  phone: boolean;
  onPick: (from: string, to: string) => void;
  onClose: () => void;
}) {
  const [rangeMode, setRangeMode] = useState(false);
  const [rangeStart, setRangeStart] = useState<string | null>(null);

  const { state, reload } = log;
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

  const row = (entry: WorktreeCommitLogEntry) => (
    <CommitItem
      key={entry.oid}
      subject={entry.subject}
      shortOid={entry.shortOid}
      selected={rangeStart === entry.oid}
      dimmed={entry.onBase}
      onClick={(event) => pick(entry, event.shiftKey)}
    >
      {entry.author} · {new Date(entry.authoredAt).toLocaleDateString()}
    </CommitItem>
  );
  // The branch's own commits are what a review is about; the base's history
  // under them is context, folded until asked for.
  const branchCommits = entries?.filter((entry) => !entry.onBase) ?? [];
  const baseCommits = entries?.filter((entry) => entry.onBase) ?? [];
  const band = (
    key: string,
    title: string,
    icon: ReactNode,
    rows: WorktreeCommitLogEntry[],
    defaultOpen: boolean,
  ) =>
    rows.length === 0 ? null : (
      <ListGroupSection
        id={`scope-picker:${worktree.id}:${key}`}
        title={title}
        count={rows.length}
        icon={icon}
        defaultOpen={defaultOpen}
      >
        <div className="flex flex-col gap-1 p-1">{rows.map(row)}</div>
      </ListGroupSection>
    );

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 px-2 py-1.5">
        <p className="min-w-0 text-sm text-muted-foreground">
          {rangeStart
            ? "Pick the other end of the range."
            : phone
              ? "Tap a commit for its diff."
              : "Click a commit for its diff. Shift-click compares a range."}
        </p>
        <Toggle
          variant="outline"
          size="sm"
          pressed={rangeMode}
          onPressedChange={(pressed) => {
            setRangeMode(pressed);
            setRangeStart(null);
          }}
        >
          Range
        </Toggle>
      </div>
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
        <div className="p-4 text-sm text-muted-foreground">No commits.</div>
      ) : (
        <>
          {/* R2: the commits stay pickable while a failed refresh says so. */}
          {error !== undefined ? (
            <ErrorNote
              className="m-1"
              message={`Could not refresh the commits: ${error}`}
              onRetry={reload}
            />
          ) : null}
          {band(
            "branch",
            worktree.isMain ? "Commits" : "On this branch",
            <GitCommitHorizontal size={14} aria-hidden className="shrink-0" />,
            branchCommits,
            true,
          )}
          {band(
            "base",
            `On ${worktree.baseBranch}`,
            <GitBranch size={14} aria-hidden className="shrink-0" />,
            baseCommits,
            // Nothing of the branch's own: the base is all there is to show.
            branchCommits.length === 0,
          )}
        </>
      )}
    </div>
  );
}
