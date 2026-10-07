import { applyPatch, MEMORY_KINDS } from "@assistant/shared";
/**
 * Memory settings + post-hoc management UI (Task 101). No candidate/approval/
 * pending-review concepts — automatic operations are already applied; the user
 * configures behavior and edits/pins/archives/corrects memories after the fact.
 */
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  History,
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
  Pencil,
  Check,
  X,
} from "lucide-react";
import type {
  AccountModelOption,
  AgentType,
  AppSettings,
  MemoryCard,
  MemoryKind,
  MemoryLearningMode,
  MemoryScope,
  MemoryTemporal,
} from "@assistant/shared";
import type { UseMemory } from "../hooks/useMemory.ts";
import { dataOf, isEmpty, isInitialLoad, isPending } from "../lib/loadState.ts";
import { EmptyBox, RefreshIndicator, Skeleton } from "./common/load.tsx";
import { sessionPath } from "../lib/sessionRoutes.ts";
import {
  isValidTimezone,
  resolveTimezone,
  temporalModeUsesTimezone,
  utcMsToZonedWallTimeValue,
  zonedWallTimeToUtcMs,
} from "../lib/timezone.ts";
import { AgentModelFields } from "./AgentModelFields.tsx";

const PERSONA_OPTIONS: { id: AgentType; label: string }[] = [
  { id: "assistant", label: "Assistant" },
  { id: "personal-assistant", label: "Personal Assistant" },
  { id: "developer", label: "Developer" },
  { id: "workshop", label: "Workshop" },
];

const PAGE_SIZE = 20;

const LEARNING_MODES: {
  id: MemoryLearningMode;
  label: string;
  help: string;
}[] = [
  {
    id: "off",
    label: "Off",
    help: "No automatic model calls. Existing memories are kept and still loaded.",
  },
  {
    id: "adaptive",
    label: "Adaptive",
    help: "High-signal turns are processed promptly; the rest are batched. Recommended.",
  },
  {
    id: "every-turn",
    label: "Every turn — experimental",
    help: "Process every eligible exchange. Still bounded by the global ceilings below.",
  },
];

export function MemorySettingsSection({
  models,
  settings,
  memory,
  onUpdate,
}: {
  models: AccountModelOption[];
  settings: AppSettings;
  memory: UseMemory;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const m = settings.memory;
  const save = (patch: Partial<typeof m>) =>
    onUpdate({ memory: { ...m, ...patch } });

  // Surface an actionable processor-configuration status (re-checked when the
  // processor model changes) so an unconfigured model is visible, not silent.
  // The METHOD, not the whole controller: `memory`'s identity changes with every
  // reply it stores — including this status — so depending on it would re-ask
  // forever. `fetchStatus` is stable per socket.
  const { fetchStatus } = memory;
  useEffect(() => {
    fetchStatus();
  }, [m.processor.provider, m.processor.modelId, m.learningMode, fetchStatus]);
  const status = memory.processorStatus;

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-sm font-semibold">Memory</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A small long-term memory of scoped preferences, facts, constraints, and
        near-term working state. Processing is asynchronous and never blocks a
        reply. Coding personas (Developer/Workshop) load memory but do not
        auto-capture in v1.
      </p>

      <div className="mt-6 space-y-5 rounded-xl border border-border bg-card p-4">
        <Toggle
          label="Use memory (load into turns)"
          checked={m.loadingEnabled}
          onChange={(v) => save({ loadingEnabled: v })}
          help="When off, memories are neither loaded nor injected. Turning this off does not delete anything."
        />

        <div>
          <div className="text-sm font-medium text-foreground">
            Automatic learning
          </div>
          <div className="mt-2 space-y-2">
            {LEARNING_MODES.map((mode) => (
              <label
                key={mode.id}
                className="flex items-start gap-2 text-sm text-foreground"
              >
                <input
                  type="radio"
                  name="learning-mode"
                  checked={m.learningMode === mode.id}
                  onChange={() => save({ learningMode: mode.id })}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span>
                  <span className="font-medium">{mode.label}</span>
                  <span className="block text-sm text-muted-foreground">
                    {mode.help}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <Toggle
          label="Automatic maintenance"
          checked={m.maintenanceEnabled}
          onChange={(v) => save({ maintenanceEnabled: v })}
          help="Deterministic expiry of ended working memories plus periodic consolidation. Expiry needs no model call."
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Max loaded cards"
            value={m.maxCards}
            min={1}
            max={32}
            onChange={(v) => save({ maxCards: v })}
          />
          <NumberField
            label="Max rendered characters"
            value={m.maxRenderedChars}
            min={200}
            max={8000}
            onChange={(v) => save({ maxRenderedChars: v })}
          />
        </div>
      </div>

      <h3 className="mt-8 text-sm font-semibold">Processor</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        A small, cheap model extracts and maintains memories in the background.
      </p>
      <div className="mt-3 space-y-5 rounded-xl border border-border bg-card p-4">
        <AgentModelFields
          models={models}
          provider={m.processor.provider}
          modelId={m.processor.modelId}
          thinkingLevel={m.processor.thinkingLevel}
          credentialProfileId={m.processor.credentialProfileId}
          modelLabel="Processor model"
          // The processor always HAS a level, so the picker never omits one;
          // keeping the current value makes that explicit rather than implied.
          onChange={(next) =>
            save({
              processor: {
                ...next,
                thinkingLevel: next.thinkingLevel ?? m.processor.thinkingLevel,
              },
            })
          }
        />
        {status && !status.configured && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              {status.message ??
                "The memory processor is not configured; automatic learning is paused until a valid model is selected."}
            </span>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Max processor calls / hour"
            value={m.maxCallsPerHour}
            min={0}
            max={240}
            onChange={(v) => save({ maxCallsPerHour: v })}
          />
          <NumberField
            label="Max reported cost / day (USD)"
            value={m.maxCostPerDayUsd}
            min={0}
            max={50}
            step={0.5}
            onChange={(v) => save({ maxCostPerDayUsd: v })}
          />
        </div>
        <p className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
          These global safety ceilings apply across every session and mode —
          including Every turn, high-signal triggers, retries, and maintenance.
          They cannot be bypassed by a learning mode. Set calls/hour to 0 to
          stop all automatic model calls while keeping existing memory.
        </p>
      </div>

      <MemoryManager
        memory={memory}
        timezone={settings.profile.effectiveTimeZone}
      />
    </div>
  );
}

/* ----------------------------- memory manager ---------------------------- */

function MemoryManager({
  memory,
  timezone,
}: {
  memory: UseMemory;
  timezone: string;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"active" | "archived" | "superseded">(
    "active",
  );
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [activeNow, setActiveNow] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [persona, setPersona] = useState<AgentType | "">("");
  const [kinds, setKinds] = useState<MemoryKind[]>([]);
  const [offset, setOffset] = useState(0);

  // Any filter change resets to the first page. `setFilter` is the stable
  // method; the controller object itself changes with every list reply, and
  // depending on that would re-ask the query its own answer just returned.
  const { setFilter } = memory;
  useEffect(() => {
    setFilter({
      states: [state],
      limit: PAGE_SIZE,
      offset,
      ...(text ? { text } : {}),
      ...(pinnedOnly ? { pinned: true } : {}),
      ...(activeNow ? { activeNow: true } : {}),
      ...(projectId.trim() ? { projectId: projectId.trim() } : {}),
      ...(persona ? { persona } : {}),
      ...(kinds.length ? { kinds } : {}),
    });
  }, [
    state,
    text,
    pinnedOnly,
    activeNow,
    projectId,
    persona,
    kinds,
    offset,
    setFilter,
  ]);

  useEffect(() => {
    setOffset(0);
  }, [state, text, pinnedOnly, activeNow, projectId, persona, kinds]);

  const toggleKind = (k: MemoryKind) =>
    setKinds((prev) =>
      prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k],
    );

  const page = dataOf(memory.list);
  const cards = page?.cards ?? [];
  const pageStart = cards.length ? offset + 1 : 0;
  const pageEnd = offset + cards.length;

  return (
    <div className="mt-8">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">Manage memories</h3>
        {/* R2: an invalidation refetch keeps the rows and says so here. */}
        {page && isPending(memory.list) ? (
          <RefreshIndicator label="Refreshing memories" />
        ) : null}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Search, correct, pin, and archive existing memories. There is no review
        inbox — automatic changes are already applied.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search text…"
          className="min-w-40 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary"
        />
        <select
          value={state}
          onChange={(e) => setState(e.target.value as typeof state)}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          aria-label="State"
        >
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="superseded">Superseded</option>
        </select>
        <select
          value={persona}
          onChange={(e) => setPersona(e.target.value as AgentType | "")}
          className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
          aria-label="Persona"
        >
          <option value="">Any persona</option>
          {PERSONA_OPTIONS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <input
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          placeholder="Project id…"
          className="w-32 rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
          aria-label="Project id"
        />
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={pinnedOnly}
            onChange={(e) => setPinnedOnly(e.target.checked)}
            className="size-3.5 accent-primary"
          />
          Pinned
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={activeNow}
            onChange={(e) => setActiveNow(e.target.checked)}
            className="size-3.5 accent-primary"
          />
          Active now
        </label>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {MEMORY_KINDS.map((k) => (
          <label
            key={k}
            className="flex items-center gap-1 text-sm text-muted-foreground"
          >
            <input
              type="checkbox"
              checked={kinds.includes(k)}
              onChange={() => toggleKind(k)}
              className="size-3.5 accent-primary"
            />
            {k}
          </label>
        ))}
      </div>

      <div className="mt-3 space-y-2">
        {/* R4: rows at the height of a memory card, so the page below them
            (and the pager) does not jump when the answer lands. */}
        {isInitialLoad(memory.list) && (
          <div
            role="status"
            aria-label="Loading memories"
            className="space-y-2"
          >
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-[4.5rem]" />
            ))}
          </div>
        )}
        {/* R1: only a query that ANSWERED may say nothing matched. */}
        {isEmpty(memory.list, (view) => view.cards.length === 0) && (
          <EmptyBox>No memories match.</EmptyBox>
        )}
        {cards.map((card) => (
          <MemoryRow
            key={card.id}
            card={card}
            memory={memory}
            timezone={timezone}
          />
        ))}
      </div>

      {((page?.total ?? 0) > 0 || offset > 0) && (
        <div className="mt-2 flex items-center justify-between text-sm text-muted-foreground">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
            className="rounded-md border border-border bg-card px-2 py-1 disabled:opacity-40"
          >
            Prev
          </button>
          <span>
            {pageStart}–{pageEnd} of {page?.total ?? 0}
          </span>
          <button
            type="button"
            disabled={!page?.hasMore}
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
            className="rounded-md border border-border bg-card px-2 py-1 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Reset mode-INCOMPATIBLE fields on a mode change — otherwise, e.g., switching
 * window → persistent keeps `validUntilMs`, and `temporalEligibility` checks
 * from/until BEFORE the mode switch, so a card labeled "persistent" could still
 * silently expire.
 */
function normalizeTemporalForMode(
  mode: MemoryTemporal["mode"],
  prev: MemoryTemporal,
): MemoryTemporal {
  const timezone = prev.timezone;
  if (mode === "persistent" || mode === "until-changed") return { mode };
  if (mode === "window") return { mode, ...(timezone ? { timezone } : {}) };
  // recurring
  const recurrence =
    prev.recurrence?.kind === "weekly" && prev.recurrence.weekdays.length
      ? prev.recurrence
      : { kind: "weekly" as const, weekdays: [1, 2, 3, 4, 5] };
  return { mode, ...(timezone ? { timezone } : {}), recurrence };
}

function MemoryRow({
  card,
  memory,
  timezone,
}: {
  card: MemoryCard;
  memory: UseMemory;
  timezone: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(card.text);
  const [draftProjectId, setDraftProjectId] = useState(
    card.scope.projectId ?? "",
  );
  const [draftPersona, setDraftPersona] = useState<AgentType | "">(
    card.scope.persona ?? "",
  );
  const [draftTemporal, setDraftTemporal] = useState<MemoryTemporal>(
    card.temporal,
  );
  // The raw typed timezone text is tracked separately from `draftTemporal.timezone`
  // so a partially-typed/invalid IANA zone never reaches `Intl.DateTimeFormat`
  // (which throws synchronously, crashing the render) — `draftTemporal.timezone`
  // only ever holds a last-known-valid value or is cleared.
  const [tzText, setTzText] = useState(card.temporal.timezone ?? "");
  const [showLineage, setShowLineage] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);

  // Timezone only matters for window/recurring modes — an invalid/stale tzText
  // must never block Save for persistent/until-changed, where it is irrelevant
  // (and a mode switch normalizes the temporal.timezone field away anyway).
  const usesTimezone = temporalModeUsesTimezone(draftTemporal.mode);
  const tzValid =
    !usesTimezone || tzText.trim() === "" || isValidTimezone(tzText.trim());
  const effectiveTimezone = resolveTimezone(tzText, timezone);
  const setTemporalTimezone = (value: string) => {
    setTzText(value);
    const trimmed = value.trim();
    setDraftTemporal((t) =>
      applyPatch(t, {
        timezone: trimmed && isValidTimezone(trimmed) ? trimmed : undefined,
      }),
    );
  };
  const changeTemporalMode = (mode: MemoryTemporal["mode"]) => {
    if (mode !== "window" && mode !== "recurring") setTzText("");
    setDraftTemporal((t) => normalizeTemporalForMode(mode, t));
  };

  // As above: the two stable methods, never the controller object.
  const { openLineage, clearLineage } = memory;
  useEffect(() => {
    if (showLineage) openLineage(card.id);
    else clearLineage(card.id);
  }, [showLineage, card.id, openLineage, clearLineage]);

  const scopeLabel =
    [card.scope.persona, card.scope.projectId].filter(Boolean).join(" / ") ||
    "global";
  const run = async (op: Parameters<UseMemory["mutate"]>[0]) => {
    setConflict(null);
    const result = await memory.mutate(op);
    if (!result.ok)
      setConflict(
        result.error === "stale-revision"
          ? "Changed elsewhere — reloaded."
          : result.error === "invalid"
            ? result.message
            : result.error,
      );
  };

  const startEdit = () => {
    setDraft(card.text);
    setDraftProjectId(card.scope.projectId ?? "");
    setDraftPersona(card.scope.persona ?? "");
    setDraftTemporal(card.temporal);
    setTzText(card.temporal.timezone ?? "");
    setConflict(null);
    setEditing(true);
  };

  const save = () => {
    if (!tzValid) {
      setConflict("Not a valid IANA timezone.");
      return;
    }
    if (
      draftTemporal.mode === "recurring" &&
      !draftTemporal.recurrence?.weekdays.length
    ) {
      setConflict("Select at least one weekday for a recurring schedule.");
      return;
    }
    const scope: MemoryScope = {
      ...(draftProjectId.trim() ? { projectId: draftProjectId.trim() } : {}),
      ...(draftPersona ? { persona: draftPersona } : {}),
    };
    const textChanged = draft !== card.text;
    if (textChanged) {
      void run({
        op: "correct",
        id: card.id,
        expectedRevision: card.revision,
        text: draft,
        kind: card.kind,
        scope,
        temporal: draftTemporal,
      });
    } else {
      // Scope/time-only changes are a non-semantic edit (no supersession/new id).
      void run({
        op: "edit",
        id: card.id,
        expectedRevision: card.revision,
        kind: card.kind,
        scope,
        temporal: draftTemporal,
      });
    }
    setEditing(false);
  };

  const lineage = memory.lineageById[card.id];

  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        {editing ? (
          <div className="flex-1 space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              className="w-full resize-y rounded-md border border-border bg-card px-2 py-1 text-sm outline-none focus:border-primary"
            />
            <div className="flex flex-wrap gap-2">
              <select
                value={draftPersona}
                onChange={(e) =>
                  setDraftPersona(e.target.value as AgentType | "")
                }
                className="rounded-md border border-border bg-card px-2 py-1 text-sm"
                aria-label="Persona scope"
              >
                <option value="">Any persona</option>
                {PERSONA_OPTIONS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <input
                value={draftProjectId}
                onChange={(e) => setDraftProjectId(e.target.value)}
                placeholder="Project id (any if empty)"
                className="w-40 rounded-md border border-border bg-card px-2 py-1 text-sm outline-none focus:border-primary"
                aria-label="Project scope"
              />
              <select
                value={draftTemporal.mode}
                onChange={(e) =>
                  changeTemporalMode(e.target.value as MemoryTemporal["mode"])
                }
                className="rounded-md border border-border bg-card px-2 py-1 text-sm"
                aria-label="Temporal mode"
              >
                <option value="persistent">Persistent</option>
                <option value="until-changed">Until changed</option>
                <option value="window">Time window</option>
                <option value="recurring">Recurring</option>
              </select>
            </div>
            {draftTemporal.mode === "window" && (
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-sm text-muted-foreground">
                  From
                  <input
                    type="datetime-local"
                    value={
                      draftTemporal.validFromMs
                        ? utcMsToZonedWallTimeValue(
                            draftTemporal.validFromMs,
                            effectiveTimezone,
                          )
                        : ""
                    }
                    onChange={(e) =>
                      setDraftTemporal((t) =>
                        applyPatch(t, {
                          validFromMs: e.target.value
                            ? zonedWallTimeToUtcMs(
                                e.target.value,
                                effectiveTimezone,
                              )
                            : undefined,
                        }),
                      )
                    }
                    className="rounded-md border border-border bg-card px-2 py-1 text-sm"
                    aria-label="Valid from"
                  />
                </label>
                <label className="flex items-center gap-1 text-sm text-muted-foreground">
                  Until
                  <input
                    type="datetime-local"
                    value={
                      draftTemporal.validUntilMs
                        ? utcMsToZonedWallTimeValue(
                            draftTemporal.validUntilMs,
                            effectiveTimezone,
                          )
                        : ""
                    }
                    onChange={(e) =>
                      setDraftTemporal((t) =>
                        applyPatch(t, {
                          validUntilMs: e.target.value
                            ? zonedWallTimeToUtcMs(
                                e.target.value,
                                effectiveTimezone,
                              )
                            : undefined,
                        }),
                      )
                    }
                    className="rounded-md border border-border bg-card px-2 py-1 text-sm"
                    aria-label="Valid until"
                  />
                </label>
                <input
                  value={tzText}
                  onChange={(e) => setTemporalTimezone(e.target.value)}
                  placeholder={`Timezone (default ${timezone})`}
                  className={`w-44 rounded-md border bg-card px-2 py-1 text-sm outline-none focus:border-primary ${tzValid ? "border-border" : "border-red-500"}`}
                  aria-label="Window timezone"
                />
              </div>
            )}
            {!tzValid && usesTimezone && (
              <p className="text-sm text-red-500">
                Not a valid IANA timezone — using {timezone} until corrected.
              </p>
            )}
            {draftTemporal.mode === "recurring" && (
              <div className="flex flex-wrap items-center gap-2">
                {WEEKDAY_LABELS.map((label, day) => (
                  <label
                    key={day}
                    className="flex items-center gap-1 text-sm text-muted-foreground"
                  >
                    <input
                      type="checkbox"
                      checked={
                        draftTemporal.recurrence?.weekdays.includes(day) ??
                        false
                      }
                      onChange={(e) =>
                        setDraftTemporal((t) => {
                          const current =
                            t.recurrence?.kind === "weekly"
                              ? t.recurrence.weekdays
                              : [];
                          const weekdays = e.target.checked
                            ? [...current, day].sort((a, b) => a - b)
                            : current.filter((d) => d !== day);
                          return {
                            ...t,
                            recurrence: { kind: "weekly", weekdays },
                          };
                        })
                      }
                      className="size-3.5 accent-primary"
                    />
                    {label}
                  </label>
                ))}
                <input
                  value={tzText}
                  onChange={(e) => setTemporalTimezone(e.target.value)}
                  placeholder={`Timezone (default ${timezone})`}
                  className={`w-44 rounded-md border bg-card px-2 py-1 text-sm outline-none focus:border-primary ${tzValid ? "border-border" : "border-red-500"}`}
                  aria-label="Recurrence timezone"
                />
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={save}
                disabled={!tzValid}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-sm text-white disabled:opacity-50"
              >
                <Check size={12} />
                Save{draft !== card.text ? " (supersede)" : ""}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm"
              >
                <X size={12} />
                Cancel
              </button>
            </div>
            {conflict && (
              <div className="text-sm text-amber-500">{conflict}</div>
            )}
          </div>
        ) : (
          <div className="flex-1">
            <div className="text-foreground">{card.text}</div>
            <div className="mt-0.5 flex flex-wrap gap-1.5 text-sm text-muted-foreground">
              <span className="rounded bg-card px-1.5 py-0.5">{card.kind}</span>
              <span className="rounded bg-card px-1.5 py-0.5">
                {scopeLabel}
              </span>
              {card.pinned && (
                <span className="rounded bg-card px-1.5 py-0.5 text-primary">
                  pinned
                </span>
              )}
              <span className="rounded bg-card px-1.5 py-0.5">
                {temporalLabel(card.temporal, timezone)}
              </span>
              <span className="rounded bg-card px-1.5 py-0.5">
                {card.state}
              </span>
              <span className="rounded bg-card px-1.5 py-0.5">
                {provenanceLabel(card.provenance.sourceKind)}
              </span>
            </div>
            {conflict && (
              <div className="mt-1 text-sm text-amber-500">{conflict}</div>
            )}
            {showLineage && (
              <div className="mt-1.5 rounded-md border border-border bg-card px-2 py-1.5 text-sm text-muted-foreground">
                {!lineage ? (
                  // The per-id slot is deliberate (`useMemory`): each expanded
                  // row loads on its own, so each draws its own placeholder.
                  <div
                    role="status"
                    aria-label="Loading lineage"
                    className="space-y-1"
                  >
                    <Skeleton className="h-3 w-4/5" />
                    <Skeleton className="h-3 w-3/5" />
                  </div>
                ) : (
                  <div className="space-y-1">
                    {lineage.predecessor && (
                      <div>
                        Superseded:{" "}
                        <span className="text-muted-foreground">
                          {lineage.predecessor.text}
                        </span>
                      </div>
                    )}
                    {lineage.supersededBy.length > 0 && (
                      <div>
                        Replaced by:{" "}
                        <span className="text-muted-foreground">
                          {lineage.supersededBy.map((c) => c.text).join(", ")}
                        </span>
                      </div>
                    )}
                    {!lineage.predecessor &&
                      lineage.supersededBy.length === 0 && (
                        <div>No correction history.</div>
                      )}
                    {card.provenance.sessionId && (
                      <div>
                        Source session:{" "}
                        <a
                          href={sessionPath(card.provenance.sessionId)}
                          className="text-primary underline decoration-dotted"
                        >
                          {card.provenance.sessionId.slice(0, 8)}
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {!editing && (
          <div className="flex shrink-0 gap-1">
            <IconBtn
              title="Lineage / provenance"
              onClick={() => setShowLineage((v) => !v)}
            >
              <History size={13} />
            </IconBtn>
            <IconBtn title="Edit / correct" onClick={startEdit}>
              <Pencil size={13} />
            </IconBtn>
            <IconBtn
              title={card.pinned ? "Unpin" : "Pin"}
              onClick={() =>
                void run({
                  op: card.pinned ? "unpin" : "pin",
                  id: card.id,
                  expectedRevision: card.revision,
                })
              }
            >
              {card.pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </IconBtn>
            {card.state === "archived" ? (
              <IconBtn
                title="Restore"
                onClick={() =>
                  void run({
                    op: "restore",
                    id: card.id,
                    expectedRevision: card.revision,
                  })
                }
              >
                <ArchiveRestore size={13} />
              </IconBtn>
            ) : (
              card.state === "active" && (
                <IconBtn
                  title="Archive"
                  onClick={() =>
                    void run({
                      op: "archive",
                      id: card.id,
                      expectedRevision: card.revision,
                    })
                  }
                >
                  <Archive size={13} />
                </IconBtn>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Format a UTC ms timestamp in `timeZone`'s wall-clock time (never the browser's own timezone). */
function formatInTimezone(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

function temporalLabel(
  temporal: MemoryTemporal,
  defaultTimezone: string,
): string {
  if (temporal.mode === "recurring") {
    const days =
      temporal.recurrence?.weekdays.map((d) => WEEKDAY_LABELS[d]).join("/") ??
      "no days set";
    return `weekly: ${days}`;
  }
  if (
    temporal.mode !== "window" ||
    (!temporal.validFromMs && !temporal.validUntilMs)
  )
    return temporal.mode;
  const tz =
    temporal.timezone && isValidTimezone(temporal.timezone)
      ? temporal.timezone
      : defaultTimezone;
  const now = Date.now();
  // active/expired/upcoming, rendered in the card's (or configured) timezone —
  // never the browser's — and accounting for BOTH bounds, not just validUntilMs.
  if (temporal.validFromMs && now < temporal.validFromMs)
    return `upcoming from ${formatInTimezone(temporal.validFromMs, tz)}`;
  if (temporal.validUntilMs && now > temporal.validUntilMs)
    return `expired ${formatInTimezone(temporal.validUntilMs, tz)}`;
  if (temporal.validUntilMs)
    return `active until ${formatInTimezone(temporal.validUntilMs, tz)}`;
  return `active since ${formatInTimezone(temporal.validFromMs!, tz)}`;
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

/* -------------------------------- widgets -------------------------------- */

function Toggle({
  label,
  checked,
  onChange,
  help,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  help?: string;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="size-4 accent-primary"
        />
        {label}
      </span>
      {help && (
        <span className="mt-1 block pl-6 text-sm text-muted-foreground">
          {help}
        </span>
      )}
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block text-sm font-medium text-foreground">
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
      />
    </label>
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
      className="rounded-md border border-border bg-card p-1.5 text-muted-foreground hover:text-foreground"
    >
      {children}
    </button>
  );
}
