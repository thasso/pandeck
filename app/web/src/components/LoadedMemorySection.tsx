/**
 * "Loaded memory" section for the Session Details inspector (Task 102). Shows the
 * exact effective memory for a turn, read from the persisted effective-load audit
 * (never recomputed client-side), with the delivery state (Injected / Reused /
 * Cleared / none), per-card scope/reason, character totals, bounded navigation
 * among recent load batches, and post-hoc actions (pin/unpin, correct, archive/
 * restore) driven by the CURRENT live card (fetched on demand per row) so an
 * action is never guessed from a stale historical snapshot.
 */
import { useEffect, useState } from "react";
import {
  Sparkles,
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Pencil,
  Check,
  X,
} from "lucide-react";
import type {
  MemoryLoadBatch,
  MemoryLoadItem,
  MemoryScope,
  MemorySettings,
} from "@assistant/shared";
import { InspectorSection } from "./shell/Inspector.tsx";
import { Skeleton } from "./common/load.tsx";
import type { UseMemory } from "../hooks/useMemory.ts";
import { sessionPath } from "../lib/sessionRoutes.ts";

export interface StagedMemoryScope {
  persona?: MemoryScope["persona"];
  /** The RESOLVED project id — from a direct staged attach, or looked up from the staged Task. */
  projectId?: string;
  /** Set (with `projectId` absent) when the staged Task is resolved to have NO project — explicitly global, not "unknown". */
  projectIsGlobal?: boolean;
  /** Set only when a Task is staged and its project genuinely could not be resolved client-side (e.g. not in the known task list). */
  projectUnresolved?: boolean;
  /** Context label: the staged Task's title, when scope comes from an attached Task rather than a direct project. */
  pendingTaskTitle?: string;
}

export function LoadedMemorySection({
  sessionId,
  hasAcceptedUserTurn,
  stagedScope,
  memory,
  loadingEnabled = true,
  maxCards,
  onOpenManager,
  defaultOpen = false,
}: {
  sessionId: string | undefined;
  /**
   * Whether the CURRENTLY DISPLAYED session has at least one accepted user
   * turn. A staged/draft session can have a defined `sessionId` too — an
   * optimistic placeholder (e.g. `pending-pi-session`) or a client-generated id
   * — so checking only `sessionId === undefined` is not enough to detect a
   * draft; this flag is the authoritative signal instead.
   */
  hasAcceptedUserTurn: boolean;
  /** The scope that WILL apply once the first message is sent, for the draft state. */
  stagedScope?: StagedMemoryScope;
  memory: UseMemory;
  /** `settings.memory.loadingEnabled`; distinguishes "disabled" from "nothing loaded yet". */
  loadingEnabled?: MemorySettings["loadingEnabled"];
  /** `settings.memory.maxCards`: the ceiling the header counter reads "3 of 20" against. */
  maxCards?: MemorySettings["maxCards"];
  /** Opens the full Memory settings/management surface (Task 102 "open the full … surface" action). */
  onOpenManager?: () => void;
  /**
   * Initial expansion when nothing is persisted for this session. Collapsed by
   * default: the header counter answers the usual question ("how much memory is
   * in this turn"), and the card list is the follow-up.
   */
  defaultOpen?: boolean;
}) {
  const [index, setIndex] = useState(0);

  // The METHOD, not the whole controller: `memory`'s identity changes with every
  // reply it stores, so depending on it here would re-issue the request its own
  // answer just caused. `fetchLoads` is stable per socket.
  const { fetchLoads } = memory;
  useEffect(() => {
    // A draft session has no durable turn yet, so there is nothing to audit —
    // never issue a load-audit request for a staged/optimistic session id.
    if (sessionId && hasAcceptedUserTurn) fetchLoads(sessionId, 20);
    setIndex(0);
  }, [sessionId, hasAcceptedUserTurn, fetchLoads]);

  if (!sessionId) return null;

  if (!hasAcceptedUserTurn) {
    return (
      <InspectorSection
        id="loaded-memory"
        storageScope={`session:${sessionId}`}
        title="Loaded memory"
        icon={<Sparkles size={13} />}
        summary="Draft"
        defaultOpen={defaultOpen}
      >
        <p className="text-caption text-faint">
          Draft — memory scope is staged but nothing has been loaded yet; it
          applies once the first message is sent.
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5 text-caption text-faint">
          {stagedScope?.persona && (
            <span className="rounded bg-panel px-1.5 py-0.5">
              persona: {stagedScope.persona}
            </span>
          )}
          {stagedScope?.projectId && (
            <span className="rounded bg-panel px-1.5 py-0.5">
              project: {stagedScope.projectId}
              {stagedScope.pendingTaskTitle
                ? ` (from Task "${stagedScope.pendingTaskTitle}")`
                : ""}
            </span>
          )}
          {stagedScope?.projectIsGlobal && (
            <span className="rounded bg-panel px-1.5 py-0.5">
              project: global (Task "{stagedScope.pendingTaskTitle}" has no
              project)
            </span>
          )}
          {stagedScope?.projectUnresolved && (
            <span className="rounded bg-panel px-1.5 py-0.5">
              project scope from attached Task "{stagedScope.pendingTaskTitle}"
              (resolves once sent)
            </span>
          )}
        </div>
      </InspectorSection>
    );
  }

  const raw = memory.loadsBySession[sessionId];
  const batches = raw ?? [];
  const notYetLoaded = raw === undefined;
  const clampedIndex = Math.min(index, Math.max(0, batches.length - 1));
  const batch = batches[clampedIndex];

  // Collapsed, the header answers only "how much of the budget is in this
  // turn"; the delivery state and everything else read inside.
  const summary = !loadingEnabled
    ? "Loading disabled"
    : batch
      ? maxCards
        ? `${batch.items.length} of ${maxCards}`
        : `${batch.items.length} card${batch.items.length === 1 ? "" : "s"}`
      : notYetLoaded
        ? undefined
        : "No memory loaded";

  return (
    <InspectorSection
      id="loaded-memory"
      storageScope={`session:${sessionId}`}
      title="Loaded memory"
      icon={<Sparkles size={13} />}
      summary={summary}
      defaultOpen={defaultOpen}
    >
      {!loadingEnabled ? (
        <p className="text-caption text-faint">
          Memory loading is disabled in Memory settings — existing memories are
          kept but nothing is injected.
        </p>
      ) : notYetLoaded ? (
        <p className="text-caption text-faint">Not yet loaded.</p>
      ) : !batch ? (
        <p className="text-caption text-faint">
          No memory has been loaded for this session yet.
        </p>
      ) : (
        <div className="space-y-2">
          {batches.length > 1 && (
            <div className="flex items-center justify-between text-caption text-faint">
              <button
                type="button"
                title="Older turn"
                aria-label="Older turn"
                disabled={clampedIndex >= batches.length - 1}
                onClick={() =>
                  setIndex((i) => Math.min(batches.length - 1, i + 1))
                }
                className="inline-flex items-center gap-0.5 rounded border border-line bg-panel px-1.5 py-0.5 disabled:opacity-40"
              >
                <ChevronLeft size={11} />
                Older
              </button>
              <span>
                Turn {clampedIndex + 1} of {batches.length}
                {clampedIndex === 0 ? " (latest)" : ""}
              </span>
              <button
                type="button"
                title="Newer turn"
                aria-label="Newer turn"
                disabled={clampedIndex <= 0}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                className="inline-flex items-center gap-0.5 rounded border border-line bg-panel px-1.5 py-0.5 disabled:opacity-40"
              >
                Newer
                <ChevronRight size={11} />
              </button>
            </div>
          )}
          <LoadBatch batch={batch} memory={memory} />
        </div>
      )}
      {onOpenManager ? (
        <button
          type="button"
          onClick={onOpenManager}
          title="Open Memory settings"
          className="mt-2 inline-flex items-center gap-1 rounded px-1 py-0.5 text-caption text-muted-foreground transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <ExternalLink size={11} />
          Manage memory
        </button>
      ) : null}
    </InspectorSection>
  );
}

function LoadBatch({
  batch,
  memory,
}: {
  batch: MemoryLoadBatch;
  memory: UseMemory;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-caption text-faint">
        <span
          className={`rounded px-1.5 py-0.5 ${badgeTone(batch.deliveryState)}`}
        >
          {deliveryLabel(batch.deliveryState)}
        </span>
        <span className="rounded bg-panel px-1.5 py-0.5">
          {batch.items.length} card{batch.items.length === 1 ? "" : "s"}
        </span>
        <span className="rounded bg-panel px-1.5 py-0.5">
          {batch.renderedChars} chars
        </span>
        <span className="rounded bg-panel px-1.5 py-0.5">
          {batch.injectedChars} injected
        </span>
        <span
          className="rounded bg-panel px-1.5 py-0.5"
          title="Cumulative injected characters since the last compaction/rotation reset"
        >
          {batch.cumulativeInjectedChars} cumulative
        </span>
      </div>

      {batch.deliveryState === "reused" && (
        <p className="text-caption text-muted-foreground">
          No new memory block was sent — the same snapshot is already in the
          model's session context.
        </p>
      )}
      {batch.deliveryState === "cleared" && (
        <p className="text-caption text-muted-foreground">
          A clearing marker superseded the previous snapshot; no memories
          currently apply.
        </p>
      )}
      {batch.deliveryState === "none" && batch.items.length === 0 && (
        <p className="text-caption text-muted-foreground">
          No eligible memory for this turn.
        </p>
      )}
      {batch.deliveryState === "failed" && (
        <p className="text-caption text-amber-500">
          Memory selection/delivery failed for this turn — the turn itself
          completed normally, but no memory snapshot could be computed. Not
          advanced; the next turn retries normally.
        </p>
      )}

      {/* Rendered from the persisted audit (effective text at delivery), never recomputed. */}
      {batch.items.map((item) => (
        <LoadItemRow key={item.memoryId} item={item} memory={memory} />
      ))}
    </div>
  );
}

function LoadItemRow({
  item,
  memory,
}: {
  item: MemoryLoadItem;
  memory: UseMemory;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [feedback, setFeedback] = useState<string | null>(null);

  // As above: the two stable methods, never the controller object.
  const { openLineage, clearLineage } = memory;
  useEffect(() => {
    if (open) openLineage(item.memoryId);
    else clearLineage(item.memoryId);
  }, [open, item.memoryId, openLineage, clearLineage]);

  const lineage = memory.lineageById[item.memoryId];
  const live = lineage?.card?.id === item.memoryId ? lineage.card : undefined;

  const run = async (op: Parameters<UseMemory["mutate"]>[0]) => {
    setFeedback(null);
    const result = await memory.mutate(op);
    if (!result.ok)
      setFeedback(
        result.error === "stale-revision"
          ? "Changed elsewhere — reopen to see the latest."
          : result.error === "invalid"
            ? result.message
            : result.error,
      );
  };

  return (
    <div className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-caption">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="text-fg">
            {item.text || "(memory text unavailable)"}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-1 text-micro text-faint">
            <span className="rounded bg-panel px-1 py-0.5">#{item.rank}</span>
            <span className="rounded bg-panel px-1 py-0.5">{item.kind}</span>
            <span className="rounded bg-panel px-1 py-0.5">
              {scopeLabel(item.scope)}
            </span>
            <span className="rounded bg-panel px-1 py-0.5">{item.reason}</span>
            {item.provenance && (
              <span className="rounded bg-panel px-1 py-0.5">
                {provenanceLabel(item.provenance.sourceKind)}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            title={open ? "Hide details" : "Details / actions"}
            aria-label={open ? "Hide details" : "Details / actions"}
            onClick={() => setOpen((v) => !v)}
            className="rounded border border-line bg-panel p-1 text-muted-foreground hover:text-fg"
          >
            {open ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-2 border-t border-line pt-2">
          {item.provenance?.sessionId && (
            <div className="mb-1.5 text-caption text-faint">
              Source: {provenanceLabel(item.provenance.sourceKind)} in{" "}
              <a
                href={sessionPath(item.provenance.sessionId)}
                className="text-primary underline decoration-dotted"
              >
                session {item.provenance.sessionId.slice(0, 8)}
              </a>
            </div>
          )}
          {!lineage ? (
            // Per-row slot (`useMemory`): this row's live card is its own fetch.
            <div
              role="status"
              aria-label="Loading current memory state"
              className="space-y-1"
            >
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ) : !live ? (
            <p className="text-caption text-faint">
              This memory no longer exists.
            </p>
          ) : editing ? (
            <div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                className="w-full resize-y rounded-md border border-line bg-panel px-2 py-1 text-caption outline-none focus:border-primary"
              />
              <div className="mt-1 flex gap-2">
                <button
                  onClick={() => {
                    void run({
                      op: "correct",
                      id: live.id,
                      expectedRevision: live.revision,
                      text: draft,
                      kind: live.kind,
                      scope: live.scope,
                    });
                    setEditing(false);
                  }}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-caption text-white"
                >
                  <Check size={11} />
                  Save (supersede)
                </button>
                <button
                  onClick={() => {
                    setEditing(false);
                    setDraft(live.text);
                  }}
                  className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-caption"
                >
                  <X size={11} />
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded bg-panel px-1.5 py-0.5 text-micro text-faint">
                {live.state}
                {live.pinned ? " · pinned" : ""}
              </span>
              <IconBtn
                title="Edit / correct"
                onClick={() => {
                  setDraft(live.text);
                  setEditing(true);
                }}
              >
                <Pencil size={12} />
              </IconBtn>
              <IconBtn
                title={live.pinned ? "Unpin" : "Pin"}
                onClick={() =>
                  void run({
                    op: live.pinned ? "unpin" : "pin",
                    id: live.id,
                    expectedRevision: live.revision,
                  })
                }
              >
                {live.pinned ? <PinOff size={12} /> : <Pin size={12} />}
              </IconBtn>
              {live.state === "archived" ? (
                <IconBtn
                  title="Restore"
                  onClick={() =>
                    void run({
                      op: "restore",
                      id: live.id,
                      expectedRevision: live.revision,
                    })
                  }
                >
                  <ArchiveRestore size={12} />
                </IconBtn>
              ) : (
                live.state === "active" && (
                  <IconBtn
                    title="Archive"
                    onClick={() =>
                      void run({
                        op: "archive",
                        id: live.id,
                        expectedRevision: live.revision,
                      })
                    }
                  >
                    <Archive size={12} />
                  </IconBtn>
                )
              )}
            </div>
          )}
          {feedback && (
            <div className="mt-1 text-caption text-amber-500">{feedback}</div>
          )}
        </div>
      )}
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className="rounded-md border border-line bg-panel p-1.5 text-muted-foreground hover:text-fg"
    >
      {children}
    </button>
  );
}

function deliveryLabel(state: MemoryLoadBatch["deliveryState"]): string {
  return state === "injected"
    ? "Injected"
    : state === "reused"
      ? "Reused"
      : state === "cleared"
        ? "Cleared"
        : state === "failed"
          ? "Failed"
          : "No memory";
}

function badgeTone(state: MemoryLoadBatch["deliveryState"]): string {
  return state === "injected"
    ? "bg-primary/15 text-primary"
    : state === "reused"
      ? "bg-panel text-muted-foreground"
      : state === "cleared"
        ? "bg-amber-500/15 text-amber-500"
        : state === "failed"
          ? "bg-red-500/15 text-red-500"
          : "bg-panel text-faint";
}

function scopeLabel(scope: { persona?: string; projectId?: string }): string {
  return (
    [scope.persona, scope.projectId].filter(Boolean).join(" / ") || "global"
  );
}

function provenanceLabel(sourceKind: string): string {
  return sourceKind === "manual"
    ? "manual"
    : sourceKind === "agent"
      ? "agent"
      : sourceKind === "processor"
        ? "auto-captured"
        : sourceKind === "consolidation"
          ? "consolidated"
          : sourceKind === "import"
            ? "imported"
            : sourceKind;
}
