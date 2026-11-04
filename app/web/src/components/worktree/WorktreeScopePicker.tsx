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
import {
  cloneElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
import { Item } from "../ui/item.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { ListGroupSection } from "../ListGroupSection.tsx";
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

/**
 * The log indexes a scope covers, `[newest, oldest]` inclusive, or null when
 * the log does not reach an end. The log is newest-first; `from` is the
 * EXCLUSIVE older end (a commit, or `oid~1` — that commit's parent, so the
 * commit itself is in), `to` the newer end or the working tree.
 */
function scopeIndexes(
  entries: readonly WorktreeCommitLogEntry[] | undefined,
  from: string | undefined,
  to: string | undefined,
): [number, number] | null {
  if (!entries || !from) return null;
  const indexOf = (oid: string) =>
    entries.findIndex((entry) => entry.oid === oid);
  const parentOf = /^(.+)~1$/.exec(from)?.[1];
  const oldest = parentOf ? indexOf(parentOf) : indexOf(from) - 1;
  const newest = to ? indexOf(to) : 0;
  if (newest < 0 || oldest < newest || (parentOf && oldest < 0)) return null;
  return [newest, oldest];
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
  // A range reads as how much it holds; the hashes stay in the tooltip.
  const span = scopeIndexes(entries, from, to);
  if (span) {
    const count = span[1] - span[0] + 1;
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
      // Quiet as the subtitle it stands in: text, not a button face.
      <Button
        variant="ghost"
        size="xs"
        className="h-auto min-w-0 max-w-full shrink justify-start gap-0.5 rounded-sm border-0 px-0 text-left font-normal text-muted-foreground hover:bg-transparent hover:text-foreground aria-expanded:bg-transparent dark:hover:bg-transparent"
        title={`Reviewing: ${label}`}
        aria-label={`Reviewing: ${label}. Change what to review`}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0" aria-hidden />
      </Button>
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
      {/* ONE scroll, the body's, so the bands pin against it; the popover
          only keeps it inside the room the viewport leaves. */}
      <PopoverContent
        align="start"
        className="max-h-(--available-height) w-96 overflow-hidden p-0"
      >
        <div className="max-h-128 min-h-0 overflow-y-auto">{body}</div>
      </PopoverContent>
    </Popover>
  );
}

/** Which of the three scopes is current. */
type ScopeKind = "uncommitted" | "branch" | "commits";

function scopeKind(
  worktree: WorktreeRecord,
  from: string | undefined,
  to: string | undefined,
): ScopeKind {
  if (!from) return "uncommitted";
  if (from === worktree.baseCommit && !to) return "branch";
  return "commits";
}

/**
 * One option row, drawn the way the app's menus draw a checkable item: icon,
 * label, and a plain check at the end when it is the current one — no tint.
 */
function OptionRow({
  icon,
  label,
  checked,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <Item
      size="xs"
      render={<button type="button" />}
      aria-current={checked || undefined}
      onClick={onSelect}
      className="min-w-0 flex-nowrap rounded-md border-0 px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:ring-0 [&_svg]:size-4 [&_svg]:shrink-0"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked ? <Check aria-hidden /> : null}
    </Item>
  );
}

/**
 * Three scopes, one list: uncommitted changes, the whole branch against its
 * base, or commits. The first two apply at once. Commits unfolds the log, where
 * a tap picks one commit and a second tap makes it a range — both ends
 * included — and the button at the bottom applies it.
 */
function ScopePanel({
  worktree,
  log,
  from,
  to,
  onPick,
  onClose,
}: {
  worktree: WorktreeRecord;
  log: WorktreeLog;
  from?: string | undefined;
  to?: string | undefined;
  onPick: (from?: string, to?: string) => void;
  onClose: () => void;
}) {
  const current = scopeKind(worktree, from, to);
  const [commitsOpen, setCommitsOpen] = useState(current === "commits");
  return (
    <div className="flex flex-col">
      <div
        role="group"
        aria-label="What to review"
        className="flex flex-col gap-0.5 p-1"
      >
        <OptionRow
          icon={<FileDiff />}
          label="Uncommitted changes"
          checked={current === "uncommitted" && !commitsOpen}
          onSelect={() => {
            onPick();
            onClose();
          }}
        />
        {worktree.isMain ? null : (
          <OptionRow
            icon={<GitCompareArrows />}
            label={`Whole branch vs ${worktree.baseBranch}`}
            checked={current === "branch" && !commitsOpen}
            onSelect={() => {
              onPick(worktree.baseCommit);
              onClose();
            }}
          />
        )}
        <OptionRow
          icon={<GitCommitHorizontal />}
          label="Commits…"
          checked={commitsOpen}
          onSelect={() => setCommitsOpen(true)}
        />
      </div>
      {commitsOpen ? (
        <CommitPicker
          worktree={worktree}
          log={log}
          from={current === "commits" ? from : undefined}
          to={current === "commits" ? to : undefined}
          onPick={onPick}
          onClose={onClose}
        />
      ) : null}
    </div>
  );
}

function CommitPicker({
  worktree,
  log,
  from,
  to,
  onPick,
  onClose,
}: {
  worktree: WorktreeRecord;
  log: WorktreeLog;
  from?: string | undefined;
  to?: string | undefined;
  onPick: (from?: string, to?: string) => void;
  onClose: () => void;
}) {
  const { state, reload } = log;
  const entries = dataOf(state);
  const error = errorOf(state);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The selection, as its two ends by oid (`b` null: one commit). It starts
  // as the scope on screen, so reopening the picker shows what is compared.
  const [ends, setEnds] = useState<{ a: string; b: string | null } | null>(
    null,
  );
  const initial = useMemo(() => {
    const span = scopeIndexes(entries, from, to);
    if (!span || !entries) return null;
    const newest = entries[span[0]]!.oid;
    const oldest = entries[span[1]]!.oid;
    return { a: oldest, b: newest === oldest ? null : newest };
  }, [entries, from, to]);
  const selection = ends ?? initial;

  const span = useMemo(() => {
    if (!selection || !entries) return null;
    const ia = entries.findIndex((entry) => entry.oid === selection.a);
    const ib = selection.b
      ? entries.findIndex((entry) => entry.oid === selection.b)
      : ia;
    if (ia < 0 || ib < 0) return null;
    return [Math.min(ia, ib), Math.max(ia, ib)] as const;
  }, [selection, entries]);
  const picked = useMemo(
    () =>
      new Set(
        span && entries
          ? entries.slice(span[0], span[1] + 1).map((entry) => entry.oid)
          : [],
      ),
    [span, entries],
  );

  // Bring the current selection into view as the picker opens — once, so a
  // later tap never scrolls the list under the finger.
  const scrolled = useRef(false);
  const hasPicked = picked.size > 0;
  useEffect(() => {
    if (scrolled.current || !hasPicked) return;
    scrolled.current = true;
    rootRef.current
      ?.querySelector("[data-picked]")
      ?.scrollIntoView({ block: "nearest" });
  }, [hasPicked]);

  const tap = (oid: string) =>
    setEnds(() => {
      // First tap: one commit. Second, on another: the range between them.
      // A third starts over from the commit tapped.
      if (!selection || selection.b !== null || selection.a === oid)
        return { a: oid, b: null };
      return { a: selection.a, b: oid };
    });

  const apply = () => {
    if (!span || !entries) return;
    const newest = entries[span[0]]!.oid;
    const oldest = entries[span[1]]!.oid;
    // `oldest~1` is its parent, so the range includes the oldest commit.
    onPick(`${oldest}~1`, newest);
    onClose();
  };

  const count = span ? span[1] - span[0] + 1 : 0;
  const applyLabel = !span
    ? "Pick a commit"
    : count === 1
      ? `Review commit ${entries![span[0]]!.shortOid}`
      : `Review ${count} commits`;

  const row = (entry: WorktreeCommitLogEntry) => (
    <Item
      key={entry.oid}
      size="xs"
      render={<button type="button" />}
      aria-pressed={picked.has(entry.oid)}
      data-picked={picked.has(entry.oid) || undefined}
      onClick={() => tap(entry.oid)}
      className={`min-w-0 flex-nowrap rounded-md border-0 px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:ring-0 ${entry.onBase && !picked.has(entry.oid) ? "opacity-60" : ""}`}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{entry.subject}</span>
        <span className="truncate text-xs text-muted-foreground">
          <span className="font-mono">{entry.shortOid}</span> · {entry.author} ·{" "}
          {new Date(entry.authoredAt).toLocaleDateString()}
        </span>
      </span>
      {picked.has(entry.oid) ? (
        <Check aria-hidden className="size-4 shrink-0" />
      ) : (
        <span className="size-4 shrink-0" />
      )}
    </Item>
  );

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
        containsSelected={rows.some((entry) => picked.has(entry.oid))}
      >
        <div
          role="group"
          aria-label={title}
          className="flex flex-col gap-0.5 p-1"
        >
          {rows.map(row)}
        </div>
      </ListGroupSection>
    );

  return (
    <div ref={rootRef} className="flex flex-col border-t border-border">
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
      <div className="sticky bottom-0 border-t border-border bg-popover p-2">
        <Button className="w-full" size="sm" disabled={!span} onClick={apply}>
          {applyLabel}
        </Button>
      </div>
    </div>
  );
}
