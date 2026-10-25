import { useEffect, useRef, useState } from "react";
import { Shrink } from "lucide-react";
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
} from "./common/PropertyList.tsx";
import { InspectorSection } from "./shell/Inspector.tsx";
import { ErrorNote } from "./common/load.tsx";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  const [draft, setDraft] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const generation = useRef(0);
  const viewedSession = useRef(sessionId);
  const attempt = useRef<{
    raw: string;
    requestId: string | undefined;
    sessionId: string;
    generation: number;
  } | null>(null);
  if (viewedSession.current !== sessionId) {
    viewedSession.current = sessionId;
    generation.current++;
    attempt.current = null;
  }
  useEffect(() => {
    const current = attempt.current;
    if (!current?.requestId || !edit) return;
    if (current.requestId !== edit.requestId) {
      attempt.current = null;
      return;
    }
    if (edit.busy) return;
    attempt.current = null;
    if (
      edit.unknown &&
      current.sessionId === sessionId &&
      current.generation === generation.current
    )
      setDraft(current.raw);
  }, [edit, sessionId]);
  const capability = HARNESSES[harness].compactionWindow;
  const busy = edit?.busy === true;
  const available = window.range
    ? { range: window.range }
    : { unavailable: window.unavailable ?? "No range is known." };

  const save = () => {
    const trimmed = draft.trim().replaceAll(",", "").replaceAll("_", "");
    const tokens = trimmed === "" ? Number.NaN : Number(trimmed);
    const reason = compactionWindowUserRefusal(available, tokens);
    setRefusal(reason ?? null);
    if (reason || !onSave) return;
    const current = {
      raw: draft,
      sessionId,
      generation: ++generation.current,
      requestId: undefined as string | undefined,
    };
    attempt.current = current;
    const requestId = onSave(tokens);
    if (typeof requestId === "string") current.requestId = requestId;
    else attempt.current = null;
    setDraft("");
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
      <PropertyList size="sm" align="start">
        <PropertyLabel>Window</PropertyLabel>
        <PropertyText className="text-foreground">
          {window.tokens === undefined
            ? "Provider default"
            : window.effectiveTokens !== undefined &&
                window.effectiveTokens !== window.tokens
              ? `${format(window.tokens)} tokens (${format(window.effectiveTokens)} for this model)`
              : `${format(window.tokens)} tokens`}
        </PropertyText>
        <PropertyLabel>Range</PropertyLabel>
        <PropertyText>
          {window.range
            ? `${format(window.range.min)} – ${format(window.range.max)} tokens`
            : window.unavailable}
        </PropertyText>
        <PropertyLabel>Status</PropertyLabel>
        <PropertyText className="text-foreground">
          {statusText(window)}
        </PropertyText>
        {window.providerTrigger !== undefined ? (
          <>
            <PropertyLabel>Compacts at</PropertyLabel>
            <PropertyText>
              about {format(window.providerTrigger)} tokens
            </PropertyText>
          </>
        ) : null}
      </PropertyList>
      {window.note ? <Markdown text={window.note} inline /> : null}
      {window.applyError ? <ErrorNote message={window.applyError} /> : null}
      {onSave ? (
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Input
            aria-label="Compaction window in tokens"
            inputMode="numeric"
            placeholder={
              window.range
                ? `${format(window.range.min)}–${format(window.range.max)}`
                : "tokens"
            }
            value={draft}
            disabled={busy || !window.range}
            onChange={(event) => {
              generation.current++;
              attempt.current = null;
              setDraft(event.target.value);
              setRefusal(null);
            }}
          />
          <Button
            type="submit"
            size="sm"
            busy={busy}
            disabled={!window.range || draft.trim() === ""}
          >
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || window.tokens === undefined}
            onClick={() => {
              generation.current++;
              attempt.current = null;
              setRefusal(null);
              onSave(null);
            }}
          >
            Clear
          </Button>
        </form>
      ) : null}
      {refusal ? <ErrorNote className="mt-2" message={refusal} /> : null}
      {!refusal && edit?.error ? (
        <ErrorNote className="mt-2" message={edit.error} />
      ) : null}
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

function statusText(window: SessionCompactionWindow): string {
  if (window.disabled)
    return "Compaction is turned off in the provider's settings";
  if (window.applied === "confirmed") return "Applied";
  if (window.applied === "unknown") return "Unknown after a failed change";
  return window.pendingReason === "process-restart"
    ? "Applies when this process restarts"
    : "Applies when the next turn starts";
}

function format(tokens: number): string {
  return tokens.toLocaleString("en-US");
}
