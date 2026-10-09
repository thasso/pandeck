/**
 * "Loaded memory" for the session inspector (Task 102): the memories the model
 * has in its context NOW — the latest effective load, read from the persisted
 * audit (never recomputed client-side). Each memory reads as a note, its own
 * words with a glyph for its kind; a note opens in place to say where it comes
 * from and to pin, correct or archive it, driven by the CURRENT live card
 * (fetched on demand) so an action is never guessed from a stale snapshot.
 * Older loads, character counts and delivery bookkeeping stay out of the
 * panel; a status line appears only when the memory is not simply there.
 */
import { useEffect, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Heart,
  Pencil,
  Pin,
  PinOff,
  ShieldAlert,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  MemoryKind,
  MemoryLoadItem,
  MemoryScope,
  MemorySettings,
} from "@assistant/shared";
import { InspectorSection } from "./shell/Inspector.tsx";
import { ErrorNote, Skeleton } from "./common/load.tsx";
import { IconButton } from "./common/IconButton.tsx";
import {
  PropertyLabel,
  PropertyList,
  PropertyText,
} from "./common/PropertyList.tsx";
import type { UseMemory } from "../hooks/useMemory.ts";
import { sessionPath } from "../lib/sessionRoutes.ts";
import { Button } from "@/components/ui/button";
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

/** A memory's kind as its glyph: what sort of note it is, at a glance. */
const KIND: Record<MemoryKind, { Icon: LucideIcon; label: string }> = {
  preference: { Icon: Heart, label: "Preference" },
  fact: { Icon: BookOpen, label: "Fact" },
  constraint: { Icon: ShieldAlert, label: "Constraint" },
  working: { Icon: Clock, label: "Working state" },
};

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
  /** Opens the full Memory settings/management surface. */
  onOpenManager?: () => void;
  /**
   * Initial expansion when nothing is persisted for this session. Collapsed by
   * default: the header counter answers the usual question ("how much memory is
   * in this turn"), and the notes are the follow-up.
   */
  defaultOpen?: boolean;
}) {
  // The METHOD, not the whole controller: `memory`'s identity changes with every
  // reply it stores, so depending on it here would re-issue the request its own
  // answer just caused. `fetchLoads` is stable per socket. Only the latest load
  // is asked for: it is what the model has in context now.
  const { fetchLoads } = memory;
  useEffect(() => {
    // A draft session has no durable turn yet, so there is nothing to audit —
    // never issue a load-audit request for a staged/optimistic session id.
    if (sessionId && hasAcceptedUserTurn) fetchLoads(sessionId, 1);
  }, [sessionId, hasAcceptedUserTurn, fetchLoads]);

  if (!sessionId) return null;

  const manage = onOpenManager ? (
    <div className="mt-2 flex justify-end">
      <Button
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        onClick={onOpenManager}
      >
        <ExternalLink />
        Manage memory
      </Button>
    </div>
  ) : null;

  if (!hasAcceptedUserTurn) {
    const project = stagedScope?.projectId
      ? stagedScope.projectId
      : stagedScope?.projectIsGlobal
        ? "global"
        : stagedScope?.projectUnresolved
          ? "from the attached Task"
          : undefined;
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
          Memory loads with the first message
          {stagedScope?.persona || project
            ? `, for ${[
                stagedScope?.persona,
                project ? `project ${project}` : undefined,
              ]
                .filter(Boolean)
                .join(" and ")}`
            : ""}
          .
        </p>
        {manage}
      </InspectorSection>
    );
  }

  const latest = memory.loadsBySession[sessionId]?.[0];
  const notYetLoaded = memory.loadsBySession[sessionId] === undefined;
  // What is in context now: nothing after a clearing marker or a failed load.
  const items =
    latest &&
    latest.deliveryState !== "cleared" &&
    latest.deliveryState !== "failed"
      ? latest.items
      : [];
  const summary = !loadingEnabled
    ? "Off"
    : notYetLoaded
      ? undefined
      : maxCards
        ? `${items.length} of ${maxCards}`
        : String(items.length);
  // Said only when the memory is not simply there.
  const status = !loadingEnabled
    ? "Memory loading is off in Memory settings; nothing is added to the conversation."
    : latest?.deliveryState === "failed"
      ? "Memory could not be loaded for the last turn. The turn itself ran normally; the next one tries again."
      : latest?.deliveryState === "cleared"
        ? "Memory was cleared from the conversation; none applies now."
        : !notYetLoaded && items.length === 0
          ? "No memory applies to this conversation."
          : undefined;

  return (
    <InspectorSection
      id="loaded-memory"
      storageScope={`session:${sessionId}`}
      title="Loaded memory"
      icon={<Sparkles size={13} />}
      summary={summary}
      defaultOpen={defaultOpen}
    >
      {status ? (
        <p className="text-sm text-muted-foreground">{status}</p>
      ) : null}
      {notYetLoaded && loadingEnabled ? (
        <div role="status" aria-label="Loading memory" className="space-y-2">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      ) : null}
      {items.length > 0 ? (
        // Edge to edge and hairline-divided, as the panel's other lists.
        <ul className="-mx-3 divide-y" aria-label="Loaded memory">
          {items.map((item) => (
            <MemoryNote key={item.memoryId} item={item} memory={memory} />
          ))}
        </ul>
      ) : null}
      {manage}
    </InspectorSection>
  );
}

/**
 * One loaded memory as a note: its kind's glyph and its own words, two lines
 * at rest. Opened, the whole text, a quiet line on why it is here and where it
 * came from, and the actions on the live card.
 */
function MemoryNote({
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
  const kind = KIND[item.kind];

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
    <li className="min-w-0">
      <Button
        variant="ghost"
        className="h-auto w-full items-start justify-start gap-2 rounded-none px-4 py-2 text-left font-normal whitespace-normal hover:bg-muted dark:hover:bg-muted/50"
        aria-expanded={open}
        title={open ? "Hide details" : "Show details"}
        onClick={() => setOpen((value) => !value)}
      >
        {/* The panel's disclosure mark, on the first line. */}
        <span className="flex h-5 shrink-0 items-center text-muted-foreground">
          {open ? (
            <ChevronDown className="size-4" aria-hidden />
          ) : (
            <ChevronRight className="size-4" aria-hidden />
          )}
        </span>
        <span
          className={`min-w-0 flex-1 text-sm leading-5 text-foreground ${open ? "wrap-anywhere" : "line-clamp-2"}`}
        >
          {/* The kind as the note's first glyph, inline with its words. */}
          <kind.Icon
            className="mr-1.5 inline size-3.5 -translate-y-px align-middle text-muted-foreground"
            aria-label={kind.label}
          />
          {item.text || "(memory text unavailable)"}
        </span>
        {live?.pinned ? (
          <span className="flex h-5 shrink-0 items-center text-muted-foreground">
            <Pin className="size-3" aria-label="Pinned" />
          </span>
        ) : null}
      </Button>
      {open ? (
        // Under the text, past the chevron column: the facts as the panel's
        // small property list, then the actions on the live card.
        <div className="space-y-1.5 pr-4 pb-2.5 pl-10 text-xs text-muted-foreground">
          <PropertyList size="sm" align="start">
            <PropertyLabel>Kind</PropertyLabel>
            <PropertyText className="flex items-center gap-1 text-foreground">
              <kind.Icon className="size-3 text-muted-foreground" aria-hidden />
              {kind.label}
            </PropertyText>
            <PropertyLabel>Scope</PropertyLabel>
            <PropertyText className="text-foreground">
              {scopeLabel(item.scope)}
            </PropertyText>
            <PropertyLabel>Why</PropertyLabel>
            <PropertyText className="break-words text-foreground">
              {item.reason}
            </PropertyText>
            {item.temporalLabel ? (
              <>
                <PropertyLabel>Valid</PropertyLabel>
                <PropertyText className="text-foreground">
                  {item.temporalLabel}
                </PropertyText>
              </>
            ) : null}
            {item.provenance ? (
              <>
                <PropertyLabel>From</PropertyLabel>
                <PropertyText className="text-foreground">
                  {provenanceLabel(item.provenance.sourceKind)}
                  {item.provenance.sessionId ? (
                    <>
                      {" in "}
                      <a
                        href={sessionPath(item.provenance.sessionId)}
                        className="underline underline-offset-3 hover:text-primary"
                      >
                        this session
                      </a>
                    </>
                  ) : null}
                </PropertyText>
              </>
            ) : null}
          </PropertyList>
          {!lineage ? (
            // Per-row slot (`useMemory`): this note's live card is its own fetch.
            <div role="status" aria-label="Loading current memory state">
              <Skeleton className="h-6 w-1/2" />
            </div>
          ) : !live ? (
            <p>This memory no longer exists.</p>
          ) : editing ? (
            <>
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={3}
                aria-label="Memory text"
                className="text-sm"
              />
              <div className="flex justify-end gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setDraft(live.text);
                  }}
                >
                  <X />
                  Cancel
                </Button>
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
                  Save correction
                </Button>
              </div>
            </>
          ) : (
            // Right-aligned, as the panel's other action rows.
            <div className="flex items-center justify-end gap-0.5">
              {live.state !== "active" ? (
                <span className="mr-auto capitalize">{live.state}</span>
              ) : null}
              <IconButton
                label={live.pinned ? "Unpin" : "Pin"}
                size="icon-xs"
                onClick={() => apply(live.pinned ? "unpin" : "pin")}
              >
                {live.pinned ? <PinOff /> : <Pin />}
              </IconButton>
              <IconButton
                label="Correct"
                size="icon-xs"
                onClick={() => {
                  setDraft(live.text);
                  setEditing(true);
                }}
              >
                <Pencil />
              </IconButton>
              {live.state === "archived" ? (
                <IconButton
                  label="Restore"
                  size="icon-xs"
                  onClick={() => apply("restore")}
                >
                  <ArchiveRestore />
                </IconButton>
              ) : live.state === "active" ? (
                <IconButton
                  label="Archive"
                  size="icon-xs"
                  onClick={() => apply("archive")}
                >
                  <Archive />
                </IconButton>
              ) : null}
            </div>
          )}
          {feedback ? <ErrorNote message={feedback} /> : null}
        </div>
      ) : null}
    </li>
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
