import { useState } from "react";
import { ChevronDownIcon, Shrink } from "lucide-react";
import { Markdown } from "./Markdown.tsx";
import {
  HARNESSES,
  compactionWindowUserRefusal,
  type Harness,
  type SessionCompactionWindow,
} from "@assistant/shared";
import type { CompactionWindowEdit } from "../hooks/useAssistant.ts";
import {
  PropertyLabel,
  PropertyList,
  PropertyText,
  PROPERTY_TRIGGER,
} from "./common/PropertyList.tsx";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { InspectorSection } from "./shell/Inspector.tsx";
import { ErrorNote } from "./common/load.tsx";

/**
 * @component CompactionWindowSection
 * @purpose The session inspector's compaction window: the stored value, the
 * range the current model allows, when the value takes effect, and where the
 * provider says it compacts; the user sets or clears it here
 * (`docs/compaction-window.md`).
 * @useWhen Rendered by `SessionContextSections` when the session's state
 * carries `compactionWindow` (its harness has the capability).
 * @intent Says when a value applies, never that a running Claude process took
 * it: the CLI fixes its window when a query starts.
 */
export function CompactionWindowSection({
  sessionId,
  harness,
  window,
  edit,
  onSave,
}: {
  sessionId: string;
  harness: Harness;
  window: SessionCompactionWindow;
  edit?: CompactionWindowEdit | undefined;
  onSave?: ((tokens: number | null) => string | void) | undefined;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const capability = HARNESSES[harness].compactionWindow;
  const available = window.range
    ? { range: window.range }
    : { unavailable: window.unavailable ?? "No range is known." };
  const error = refusal ?? edit?.error;

  const save = (tokens: number | null) => {
    if (!onSave) return;
    const reason =
      tokens === null
        ? undefined
        : compactionWindowUserRefusal(available, tokens);
    setRefusal(reason ?? null);
    if (!reason) onSave(tokens);
  };

  return (
    <InspectorSection
      id="compaction-window"
      storageScope={`session:${sessionId}`}
      title="Compaction window"
      icon={<Shrink size={13} />}
      summary={
        window.tokens !== undefined
          ? `${format(window.tokens)} tokens`
          : "Provider default"
      }
    >
      <PropertyList>
        <PropertyLabel>Window</PropertyLabel>
        {onSave && window.range ? (
          <WindowEditor
            key={sessionId}
            range={window.range}
            tokens={window.tokens}
            busy={edit?.busy === true}
            onSave={save}
          />
        ) : onSave && window.tokens !== undefined ? (
          // No range to pick within, but a saved window can still be cleared.
          <div className="flex min-w-0 items-center gap-2">
            <PropertyText>{format(window.tokens)} tokens</PropertyText>
            <Button
              variant="ghost"
              size="xs"
              disabled={edit?.busy === true}
              onClick={() => save(null)}
            >
              Use provider default
            </Button>
          </div>
        ) : (
          <PropertyText>
            {window.tokens === undefined
              ? "Provider default"
              : `${format(window.tokens)} tokens`}
          </PropertyText>
        )}
        {window.tokens !== undefined &&
        window.effectiveTokens !== undefined &&
        window.effectiveTokens !== window.tokens ? (
          <>
            <PropertyLabel>Effective</PropertyLabel>
            <PropertyText>
              {format(window.effectiveTokens)} tokens for this model
            </PropertyText>
          </>
        ) : null}
        {window.range ? null : (
          <>
            <PropertyLabel>Range</PropertyLabel>
            <PropertyText className="text-muted-foreground">
              {window.unavailable}
            </PropertyText>
          </>
        )}
        {window.disabled || window.applied !== "confirmed" ? (
          <>
            <PropertyLabel>Status</PropertyLabel>
            <PropertyText>{statusText(window)}</PropertyText>
          </>
        ) : null}
        {window.providerTrigger !== undefined ? (
          <>
            <PropertyLabel>Compacts</PropertyLabel>
            <PropertyText>
              at about {compact(window.providerTrigger)} tokens
            </PropertyText>
          </>
        ) : null}
      </PropertyList>
      {error ? <ErrorNote className="mt-2" message={error} /> : null}
      {window.note ? <Markdown text={window.note} inline /> : null}
      {window.applyError ? <ErrorNote message={window.applyError} /> : null}
      {capability?.mapping === "reserve" && capability.summaryCostNote ? (
        <p className="mt-2 text-xs text-muted-foreground">
          A lower window leaves pi a larger reserve, which also sizes its
          compaction summaries: each compaction writes a longer summary and
          costs more.
        </p>
      ) : null}
    </InspectorSection>
  );
}

/**
 * The window as a property-list trigger that opens an editor: a slider over
 * the model's range to drag freely, Apply to save the value it rests on, and
 * Provider default to clear a set window.
 */
function WindowEditor({
  range,
  tokens,
  busy,
  onSave,
}: {
  range: { min: number; max: number };
  tokens: number | undefined;
  busy: boolean;
  onSave: (tokens: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(tokens ?? range.max);
  const label =
    tokens === undefined ? "Provider default" : `${compact(tokens)} tokens`;
  const apply = (next: number | null) => {
    setOpen(false);
    if ((next ?? undefined) !== tokens) onSave(next);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) setDraft(tokens ?? range.max);
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Compaction window: ${label}`}
            busy={busy}
            className={`${PROPERTY_TRIGGER} justify-start [&_svg]:text-muted-foreground`}
          />
        }
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon className="pointer-events-none ml-auto size-4" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-2">
        <div className="text-sm font-medium">{compact(draft)} tokens</div>
        <div>
          <Slider
            min={range.min}
            max={range.max}
            step={sliderStep(range)}
            value={[draft]}
            onValueChange={(values) => {
              const next = Array.isArray(values) ? values[0] : values;
              if (next !== undefined) setDraft(next);
            }}
            thumbProps={{
              "aria-label": "Compaction window",
              "aria-valuetext": `${compact(draft)} tokens`,
            }}
            className="flex h-8 items-center *:h-full"
          />
          <div
            aria-hidden
            className="-mt-1.5 flex justify-between text-xs text-muted-foreground"
          >
            <span>{compact(range.min)}</span>
            <span>{compact(range.max)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {tokens !== undefined ? (
            <Button variant="ghost" size="xs" onClick={() => apply(null)}>
              Provider default
            </Button>
          ) : null}
          <Button
            size="xs"
            className="ml-auto"
            disabled={draft === tokens}
            onClick={() => apply(draft)}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** A round step that cuts the range into a few dozen positions. */
function sliderStep(range: { min: number; max: number }): number {
  const rough = (range.max - range.min) / 36;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 1)));
  const nice = [1, 2, 2.5, 5, 10].find((f) => f * magnitude >= rough) ?? 10;
  return nice * magnitude;
}

function statusText(window: SessionCompactionWindow): string {
  if (window.disabled)
    return "Compaction is turned off in the provider's settings";
  if (window.applied === "confirmed") return "Applied";
  if (window.applied === "unknown") return "Unknown after a failed change";
  return window.pendingReason === "process-restart"
    ? "Applies once the session is idle"
    : "Applies on the next turn";
}

function format(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

/** 967,000 as "967k", 1,200,000 as "1.2M": a figure read at a glance. */
function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens);
}
