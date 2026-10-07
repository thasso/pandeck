/**
 * "Loaded memory" section for the Session Details inspector (Task 102). Shows the
 * exact effective memory for a turn, read from the persisted effective-load audit
 * (never recomputed client-side), with the delivery state (Injected / Reused /
 * Cleared / none), per-card scope/reason, character totals, bounded navigation
 * among recent load batches, and post-hoc actions (pin/unpin, correct, archive/
 * restore) driven by the CURRENT live card (fetched on demand per row) so an
 * action is never guessed from a stale historical snapshot.
 */
import { useEffect, useState, type ComponentProps } from "react";
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
  TriangleAlert,
  X,
} from "lucide-react";
import type {
  MemoryLoadBatch,
  MemoryLoadDeliveryState,
  MemoryLoadItem,
  MemoryScope,
  MemorySettings,
} from "@assistant/shared";
import { InspectorSection } from "./shell/Inspector.tsx";
import { ErrorNote, Skeleton } from "./common/load.tsx";
import { IconButton } from "./common/IconButton.tsx";
import type { UseMemory } from "../hooks/useMemory.ts";
import { sessionPath } from "../lib/sessionRoutes.ts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Item, ItemActions, ItemContent } from "@/components/ui/item";
import { Textarea } from "@/components/ui/textarea";

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
        <p className="text-sm text-muted-foreground">
          Draft — memory scope is staged but nothing has been loaded yet; it
          applies once the first message is sent.
        </p>
        <ul className="mt-1.5 space-y-0.5 text-sm text-muted-foreground">
          {stagedScope?.persona && <li>persona: {stagedScope.persona}</li>}
          {stagedScope?.projectId && (
            <li>
              project: {stagedScope.projectId}
              {stagedScope.pendingTaskTitle
                ? ` (from Task "${stagedScope.pendingTaskTitle}")`
                : ""}
            </li>
          )}
          {stagedScope?.projectIsGlobal && (
            <li>
              project: global (Task "{stagedScope.pendingTaskTitle}" has no
              project)
            </li>
          )}
          {stagedScope?.projectUnresolved && (
            <li>
              project scope from attached Task "{stagedScope.pendingTaskTitle}"
              (resolves once sent)
            </li>
          )}
        </ul>
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
        <p className="text-sm text-muted-foreground">
          Memory loading is disabled in Memory settings — existing memories are
          kept but nothing is injected.
        </p>
      ) : notYetLoaded ? (
        <p className="text-sm text-muted-foreground">Not yet loaded.</p>
      ) : !batch ? (
        <p className="text-sm text-muted-foreground">
          No memory has been loaded for this session yet.
        </p>
      ) : (
        <div className="space-y-2">
          {batches.length > 1 && (
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <Button
                variant="outline"
                size="xs"
                aria-label="Older turn"
                disabled={clampedIndex >= batches.length - 1}
                onClick={() =>
                  setIndex((i) => Math.min(batches.length - 1, i + 1))
                }
              >
                <ChevronLeft />
                Older
              </Button>
              <span>
                Turn {clampedIndex + 1} of {batches.length}
                {clampedIndex === 0 ? " (latest)" : ""}
              </span>
              <Button
                variant="outline"
                size="xs"
                aria-label="Newer turn"
                disabled={clampedIndex <= 0}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
              >
                Newer
                <ChevronRight />
              </Button>
            </div>
          )}
          <LoadBatch batch={batch} memory={memory} />
        </div>
      )}
      {onOpenManager ? (
        <Button
          variant="ghost"
          size="xs"
          className="mt-2"
          onClick={onOpenManager}
        >
          <ExternalLink />
          Manage memory
        </Button>
      ) : null}
    </InspectorSection>
  );
}

const DELIVERY: Record<
  MemoryLoadDeliveryState,
  { label: string; variant: ComponentProps<typeof Badge>["variant"] }
> = {
  injected: { label: "Injected", variant: "default" },
  reused: { label: "Reused", variant: "secondary" },
  cleared: { label: "Cleared", variant: "warning" },
  failed: { label: "Failed", variant: "destructive" },
  none: { label: "No memory", variant: "secondary" },
};

function LoadBatch({
  batch,
  memory,
}: {
  batch: MemoryLoadBatch;
  memory: UseMemory;
}) {
  const delivery = DELIVERY[batch.deliveryState];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={delivery.variant}>{delivery.label}</Badge>
        <Badge variant="secondary">
          {batch.items.length} card{batch.items.length === 1 ? "" : "s"}
        </Badge>
        <Badge variant="secondary">{batch.renderedChars} chars</Badge>
        <Badge variant="secondary">{batch.injectedChars} injected</Badge>
        <Badge
          variant="secondary"
          title="Cumulative injected characters since the last compaction/rotation reset"
        >
          {batch.cumulativeInjectedChars} cumulative
        </Badge>
      </div>

      {batch.deliveryState === "reused" && (
        <p className="text-sm text-muted-foreground">
          No new memory block was sent — the same snapshot is already in the
          model's session context.
        </p>
      )}
      {batch.deliveryState === "cleared" && (
        <p className="text-sm text-muted-foreground">
          A clearing marker superseded the previous snapshot; no memories
          currently apply.
        </p>
      )}
      {batch.deliveryState === "none" && batch.items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No eligible memory for this turn.
        </p>
      )}
      {batch.deliveryState === "failed" && (
        <Alert variant="warning" role="note">
          <TriangleAlert />
          <AlertDescription>
            Memory selection/delivery failed for this turn — the turn itself
            completed normally, but no memory snapshot could be computed. Not
            advanced; the next turn retries normally.
          </AlertDescription>
        </Alert>
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
  const apply = (op: "pin" | "unpin" | "archive" | "restore") => {
    if (live) void run({ op, id: live.id, expectedRevision: live.revision });
  };

  return (
    <Item variant="outline" size="xs" className="items-start">
      <ItemContent>
        <div>{item.text || "(memory text unavailable)"}</div>
        <div className="flex flex-wrap gap-1">
          <Badge variant="secondary">#{item.rank}</Badge>
          <Badge variant="secondary">{item.kind}</Badge>
          <Badge variant="secondary">{scopeLabel(item.scope)}</Badge>
          <Badge variant="secondary">{item.reason}</Badge>
          {item.provenance && (
            <Badge variant="outline">
              {provenanceLabel(item.provenance.sourceKind)}
            </Badge>
          )}
        </div>
      </ItemContent>
      <ItemActions>
        <IconButton
          label={open ? "Hide details" : "Details / actions"}
          size="icon-xs"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronLeft /> : <ChevronRight />}
        </IconButton>
      </ItemActions>

      {open && (
        <div className="basis-full space-y-1.5 border-t pt-2 text-sm text-muted-foreground">
          {item.provenance?.sessionId && (
            <div>
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
            <p>This memory no longer exists.</p>
          ) : editing ? (
            <>
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                aria-label="Memory text"
              />
              <div className="flex gap-2">
                <Button
                  size="xs"
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
                >
                  <Check />
                  Save (supersede)
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setEditing(false);
                    setDraft(live.text);
                  }}
                >
                  <X />
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              <Badge variant="outline">
                {live.state}
                {live.pinned ? " · pinned" : ""}
              </Badge>
              <IconButton
                label="Edit / correct"
                onClick={() => {
                  setDraft(live.text);
                  setEditing(true);
                }}
              >
                <Pencil />
              </IconButton>
              <IconButton
                label={live.pinned ? "Unpin" : "Pin"}
                onClick={() => apply(live.pinned ? "unpin" : "pin")}
              >
                {live.pinned ? <PinOff /> : <Pin />}
              </IconButton>
              {live.state === "archived" ? (
                <IconButton label="Restore" onClick={() => apply("restore")}>
                  <ArchiveRestore />
                </IconButton>
              ) : (
                live.state === "active" && (
                  <IconButton label="Archive" onClick={() => apply("archive")}>
                    <Archive />
                  </IconButton>
                )
              )}
            </div>
          )}
          {feedback && <ErrorNote message={feedback} />}
        </div>
      )}
    </Item>
  );
}

export function scopeLabel(scope: {
  persona?: string;
  projectId?: string;
}): string {
  return (
    [scope.persona, scope.projectId].filter(Boolean).join(" / ") || "global"
  );
}

const PROVENANCE_LABELS: Record<string, string> = {
  processor: "auto-captured",
  consolidation: "consolidated",
  import: "imported",
};

export function provenanceLabel(sourceKind: string): string {
  return PROVENANCE_LABELS[sourceKind] ?? sourceKind;
}
