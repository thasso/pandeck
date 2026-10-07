import { applyPatch, MEMORY_KINDS } from "@assistant/shared";
/**
 * Memory settings + post-hoc management UI (Task 101). No candidate/approval/
 * pending-review concepts — automatic operations are already applied; the user
 * configures behavior and edits/pins/archives/corrects memories after the fact.
 */
import { useEffect, useId, useState } from "react";
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
import {
  EmptyBox,
  ErrorNote,
  RefreshIndicator,
  Skeleton,
} from "./common/load.tsx";
import { IconButton } from "./common/IconButton.tsx";
import { sessionPath } from "../lib/sessionRoutes.ts";
import {
  isValidTimezone,
  resolveTimezone,
  temporalModeUsesTimezone,
  utcMsToZonedWallTimeValue,
  zonedWallTimeToUtcMs,
} from "../lib/timezone.ts";
import { AgentModelFields } from "./AgentModelFields.tsx";
import { provenanceLabel, scopeLabel } from "./LoadedMemorySection.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

const PERSONA_OPTIONS = (
  <>
    <NativeSelectOption value="">Any persona</NativeSelectOption>
    <NativeSelectOption value="assistant">Assistant</NativeSelectOption>
    <NativeSelectOption value="personal-assistant">
      Personal Assistant
    </NativeSelectOption>
    <NativeSelectOption value="developer">Developer</NativeSelectOption>
    <NativeSelectOption value="workshop">Workshop</NativeSelectOption>
  </>
);

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

      <Card className="mt-6">
        <CardContent>
          <FieldGroup>
            <SwitchField
              label="Use memory (load into turns)"
              checked={m.loadingEnabled}
              onChange={(v) => save({ loadingEnabled: v })}
              help="When off, memories are neither loaded nor injected. Turning this off does not delete anything."
            />
            <FieldSet>
              <FieldLegend variant="label">Automatic learning</FieldLegend>
              <RadioGroup
                value={m.learningMode}
                onValueChange={(v) =>
                  save({ learningMode: v as MemoryLearningMode })
                }
              >
                {LEARNING_MODES.map((mode) => (
                  <Field key={mode.id} orientation="horizontal">
                    <RadioGroupItem
                      value={mode.id}
                      id={`learning-mode-${mode.id}`}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor={`learning-mode-${mode.id}`}>
                        {mode.label}
                      </FieldLabel>
                      <FieldDescription>{mode.help}</FieldDescription>
                    </FieldContent>
                  </Field>
                ))}
              </RadioGroup>
            </FieldSet>
            <SwitchField
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
          </FieldGroup>
        </CardContent>
      </Card>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>Processor</CardTitle>
          <CardDescription>
            A small, cheap model extracts and maintains memories in the
            background.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
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
                    thinkingLevel:
                      next.thinkingLevel ?? m.processor.thinkingLevel,
                  },
                })
              }
            />
            {status && !status.configured && (
              <Alert variant="warning" role="status">
                <AlertTriangle />
                <AlertDescription>
                  {status.message ??
                    "The memory processor is not configured; automatic learning is paused until a valid model is selected."}
                </AlertDescription>
              </Alert>
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
            <FieldDescription>
              These global safety ceilings apply across every session and mode —
              including Every turn, high-signal triggers, retries, and
              maintenance. They cannot be bypassed by a learning mode. Set
              calls/hour to 0 to stop all automatic model calls while keeping
              existing memory.
            </FieldDescription>
          </FieldGroup>
        </CardContent>
      </Card>

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
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search text…"
          aria-label="Search memories"
          className="min-w-40 flex-1"
        />
        <NativeSelect
          value={state}
          onChange={(e) => setState(e.target.value as typeof state)}
          aria-label="State"
        >
          <NativeSelectOption value="active">Active</NativeSelectOption>
          <NativeSelectOption value="archived">Archived</NativeSelectOption>
          <NativeSelectOption value="superseded">Superseded</NativeSelectOption>
        </NativeSelect>
        <NativeSelect
          value={persona}
          onChange={(e) => setPersona(e.target.value as AgentType | "")}
          aria-label="Persona"
        >
          {PERSONA_OPTIONS}
        </NativeSelect>
        <Input
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          placeholder="Project id…"
          aria-label="Project id"
          className="w-32"
        />
        <CheckField
          label="Pinned"
          checked={pinnedOnly}
          onChange={setPinnedOnly}
        />
        <CheckField
          label="Active now"
          checked={activeNow}
          onChange={setActiveNow}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-3">
        {MEMORY_KINDS.map((k) => (
          <CheckField
            key={k}
            label={k}
            checked={kinds.includes(k)}
            onChange={() => toggleKind(k)}
          />
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
              <Skeleton key={row} className="h-18" />
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
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
          >
            Prev
          </Button>
          <span>
            {pageStart}–{pageEnd} of {page?.total ?? 0}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!page?.hasMore}
            onClick={() => setOffset((o) => o + PAGE_SIZE)}
          >
            Next
          </Button>
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
  const toggleWeekday = (day: number, on: boolean) =>
    setDraftTemporal((t) => {
      const current =
        t.recurrence?.kind === "weekly" ? t.recurrence.weekdays : [];
      const weekdays = on
        ? [...current, day].sort((a, b) => a - b)
        : current.filter((d) => d !== day);
      return { ...t, recurrence: { kind: "weekly", weekdays } };
    });

  // As above: the two stable methods, never the controller object.
  const { openLineage, clearLineage } = memory;
  useEffect(() => {
    if (showLineage) openLineage(card.id);
    else clearLineage(card.id);
  }, [showLineage, card.id, openLineage, clearLineage]);

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
  const apply = (op: "pin" | "unpin" | "archive" | "restore") =>
    void run({ op, id: card.id, expectedRevision: card.revision });

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
    const edit = {
      id: card.id,
      expectedRevision: card.revision,
      kind: card.kind,
      scope,
      temporal: draftTemporal,
    };
    // Scope/time-only changes are a non-semantic edit (no supersession/new id).
    void run(
      draft !== card.text
        ? { op: "correct", ...edit, text: draft }
        : { op: "edit", ...edit },
    );
    setEditing(false);
  };

  const lineage = memory.lineageById[card.id];

  return (
    <Item variant="outline" className="items-start">
      <ItemContent>
        {editing ? (
          <>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              aria-label="Memory text"
            />
            <div className="flex flex-wrap gap-2">
              <NativeSelect
                value={draftPersona}
                onChange={(e) =>
                  setDraftPersona(e.target.value as AgentType | "")
                }
                aria-label="Persona scope"
              >
                {PERSONA_OPTIONS}
              </NativeSelect>
              <Input
                value={draftProjectId}
                onChange={(e) => setDraftProjectId(e.target.value)}
                placeholder="Project id (any if empty)"
                aria-label="Project scope"
                className="w-40"
              />
              <NativeSelect
                value={draftTemporal.mode}
                onChange={(e) =>
                  changeTemporalMode(e.target.value as MemoryTemporal["mode"])
                }
                aria-label="Temporal mode"
              >
                <NativeSelectOption value="persistent">
                  Persistent
                </NativeSelectOption>
                <NativeSelectOption value="until-changed">
                  Until changed
                </NativeSelectOption>
                <NativeSelectOption value="window">
                  Time window
                </NativeSelectOption>
                <NativeSelectOption value="recurring">
                  Recurring
                </NativeSelectOption>
              </NativeSelect>
            </div>
            {usesTimezone && (
              <div className="flex flex-wrap items-center gap-2">
                {draftTemporal.mode === "window" ? (
                  <>
                    <ZonedTimeInput
                      label="From"
                      name="Valid from"
                      ms={draftTemporal.validFromMs}
                      timezone={effectiveTimezone}
                      onChange={(validFromMs) =>
                        setDraftTemporal((t) => applyPatch(t, { validFromMs }))
                      }
                    />
                    <ZonedTimeInput
                      label="Until"
                      name="Valid until"
                      ms={draftTemporal.validUntilMs}
                      timezone={effectiveTimezone}
                      onChange={(validUntilMs) =>
                        setDraftTemporal((t) => applyPatch(t, { validUntilMs }))
                      }
                    />
                  </>
                ) : (
                  WEEKDAY_LABELS.map((label, day) => (
                    <CheckField
                      key={day}
                      label={label}
                      checked={
                        draftTemporal.recurrence?.weekdays.includes(day) ??
                        false
                      }
                      onChange={(on) => toggleWeekday(day, on)}
                    />
                  ))
                )}
                <Input
                  value={tzText}
                  onChange={(e) => setTemporalTimezone(e.target.value)}
                  placeholder={`Timezone (default ${timezone})`}
                  aria-invalid={!tzValid || undefined}
                  aria-label={
                    draftTemporal.mode === "window"
                      ? "Window timezone"
                      : "Recurrence timezone"
                  }
                  className="w-44"
                />
              </div>
            )}
            {!tzValid && usesTimezone && (
              <FieldError>
                Not a valid IANA timezone — using {timezone} until corrected.
              </FieldError>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={!tzValid}>
                <Check />
                Save{draft !== card.text ? " (supersede)" : ""}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing(false)}
              >
                <X />
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <div>{card.text}</div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary">{card.kind}</Badge>
              <Badge variant="secondary">{scopeLabel(card.scope)}</Badge>
              {card.pinned && <Badge>pinned</Badge>}
              <Badge variant="secondary">
                {temporalLabel(card.temporal, timezone)}
              </Badge>
              <Badge variant="secondary">{card.state}</Badge>
              <Badge variant="outline">
                {provenanceLabel(card.provenance.sourceKind)}
              </Badge>
            </div>
          </>
        )}
        {conflict && <ErrorNote message={conflict} />}
        {!editing && showLineage && (
          <div className="rounded-md bg-muted px-2 py-1.5 text-muted-foreground">
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
                  <div>Superseded: {lineage.predecessor.text}</div>
                )}
                {lineage.supersededBy.length > 0 && (
                  <div>
                    Replaced by:{" "}
                    {lineage.supersededBy.map((c) => c.text).join(", ")}
                  </div>
                )}
                {!lineage.predecessor && lineage.supersededBy.length === 0 && (
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
      </ItemContent>
      {!editing && (
        <ItemActions className="gap-1">
          <IconButton
            label="Lineage / provenance"
            onClick={() => setShowLineage((v) => !v)}
          >
            <History />
          </IconButton>
          <IconButton label="Edit / correct" onClick={startEdit}>
            <Pencil />
          </IconButton>
          <IconButton
            label={card.pinned ? "Unpin" : "Pin"}
            onClick={() => apply(card.pinned ? "unpin" : "pin")}
          >
            {card.pinned ? <PinOff /> : <Pin />}
          </IconButton>
          {card.state === "archived" ? (
            <IconButton label="Restore" onClick={() => apply("restore")}>
              <ArchiveRestore />
            </IconButton>
          ) : (
            card.state === "active" && (
              <IconButton label="Archive" onClick={() => apply("archive")}>
                <Archive />
              </IconButton>
            )
          )}
        </ItemActions>
      )}
    </Item>
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

/* -------------------------------- widgets -------------------------------- */

function SwitchField({
  label,
  checked,
  onChange,
  help,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  help: string;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <FieldDescription>{help}</FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </Field>
  );
}

function CheckField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <Field orientation="horizontal" className="w-auto">
      <Checkbox id={id} checked={checked} onCheckedChange={onChange} />
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
    </Field>
  );
}

function NumberField({
  label,
  onChange,
  ...input
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        {...input}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </Field>
  );
}

/** A `datetime-local` bound edited as wall time in the row's timezone. */
function ZonedTimeInput({
  label,
  name,
  ms,
  timezone,
  onChange,
}: {
  label: string;
  name: string;
  ms: number | undefined;
  timezone: string;
  onChange: (ms: number | undefined) => void;
}) {
  return (
    <Label>
      {label}
      <Input
        type="datetime-local"
        aria-label={name}
        className="w-auto"
        value={ms ? utcMsToZonedWallTimeValue(ms, timezone) : ""}
        onChange={(e) =>
          onChange(
            e.target.value
              ? zonedWallTimeToUtcMs(e.target.value, timezone)
              : undefined,
          )
        }
      />
    </Label>
  );
}
