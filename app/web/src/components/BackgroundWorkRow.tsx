import { memo, type MutableRefObject } from "react";
import { Square } from "lucide-react";
import type { BackgroundWorkItemSummary } from "@assistant/shared";
import {
  backgroundWorkAgeLabel,
  backgroundWorkBackendLabel,
  backgroundWorkCommandDetail,
  backgroundWorkDeadlineLabel,
  backgroundWorkEvidenceFacts,
  backgroundWorkHostLabel,
  backgroundWorkKindLabel,
  backgroundWorkRowKey,
  backgroundWorkStateBadge,
  backgroundWorkStopDisabledReason,
  type BackgroundWorkTone,
} from "../lib/backgroundWork.ts";
import { Button } from "@/components/ui/button";
import { BackgroundWorkCommand } from "./BackgroundWorkCommand.tsx";
import { BackgroundWorkOutput } from "./BackgroundWorkOutput.tsx";

/** Badge colours, keyed on the projection's semantic tone. */
const TONE_CLASS: Record<BackgroundWorkTone, string> = {
  accent: "bg-accent text-primary",
  warning: "bg-warning-soft text-warning",
  danger: "bg-destructive/10 text-destructive",
  success: "bg-success-soft text-success",
  muted: "bg-card text-muted-foreground",
};

export interface BackgroundWorkRowProps {
  item: BackgroundWorkItemSummary;
  /** Shared ticker value; the row never owns a timer of its own. */
  now: number;
  /** The owning session's title, when the host resolved one. */
  ownerTitle?: string | undefined;
  /** This row is the one the `?task=` anchor addressed. */
  anchored?: boolean;
  /**
   * Handed to the anchored row only, so the page can scroll and focus it once
   * the registry snapshot delivers it. A row that is not the anchor keeps no
   * ref, which is what stops one from being captured for every row in the list.
   */
  rowRef?: MutableRefObject<HTMLElement | null> | undefined;
  /** A Stop this browser has sent and not yet seen an answer for. */
  stopPending?: boolean;
  /**
   * The authenticated artifact-API URL for this item's retained output, when the
   * host could resolve `evidence.artifactId` in the owning session's drawer. The
   * BODY never travels with the row, and the id itself is never rendered — this
   * is a link the browser follows, not content it holds.
   */
  evidenceUrl?: string | undefined;
  /**
   * Every callback takes the id it acts on rather than closing over the row: a
   * per-row arrow is a fresh identity on each parent render and would defeat the
   * memo below unconditionally (`lib/sessionRows.ts` learned this the expensive
   * way).
   */
  onStop: (itemId: string) => void;
  /** Absent where the row is already inside its owning session's inspector. */
  onOpenOwner?: ((sessionId: string) => void) | undefined;
  /** Present where the row is NOT on the registry page, to go there. */
  onOpenRegistry?: ((itemId: string) => void) | undefined;
}

/**
 * @component BackgroundWorkRow
 * @purpose One background-work item, exactly as the server narrowed it: kind and
 * backend, its title and bounded command, age, frozen deadline, state, the
 * retained host epoch when it has one, the durable completion/evidence facts,
 * the captured output on demand, and Stop.
 * @useWhen Rendering the background registry route or the owning session's
 * inspector section.
 * @avoidWhen Showing a delegated agent (that is a subagent thread) or a tool
 * call inside a transcript.
 * @intent The row states only what the registry KNOWS. It never derives a
 * lifecycle transition, never marks itself terminal because Stop was pressed,
 * and shows no vendor or OS id, environment, credential or output path — those
 * stop at the server's narrowing and must not reappear here. The output BODY is
 * fetched from its artifact only when the reader opens it.
 * @related BackgroundTasksPage, BackgroundWorkSection, backgroundWork (lib)
 */
function BackgroundWorkRowImpl({
  item,
  now,
  ownerTitle,
  anchored = false,
  rowRef,
  stopPending = false,
  evidenceUrl,
  onStop,
  onOpenOwner,
  onOpenRegistry,
}: BackgroundWorkRowProps) {
  const badge = backgroundWorkStateBadge(item);
  const host = backgroundWorkHostLabel(item);
  const facts = backgroundWorkEvidenceFacts(item);
  const stopBlocked = backgroundWorkStopDisabledReason(item);
  const command = backgroundWorkCommandDetail(item);
  return (
    <li
      ref={(node) => {
        if (rowRef) rowRef.current = node;
      }}
      // Programmatically focusable only: the anchored row is a scroll target for
      // a deep link, never a tab stop competing with the controls inside it.
      tabIndex={anchored ? -1 : undefined}
      data-list-row-id={item.id}
      data-background-item={item.id}
      data-background-anchored={anchored ? "true" : undefined}
      className={`rounded-xl border bg-card p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
        anchored ? "border-primary/50 ring-1 ring-primary/30" : "border-border"
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-sm font-medium text-foreground"
            title={item.label}
          >
            {item.label}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASS[badge.tone]}`}
            >
              {badge.label}
            </span>
            <span>{backgroundWorkKindLabel(item)}</span>
            <span aria-hidden="true">·</span>
            <span>{backgroundWorkBackendLabel(item)}</span>
            <span aria-hidden="true">·</span>
            <span>{backgroundWorkAgeLabel(item, now)}</span>
            <span aria-hidden="true">·</span>
            <span>{backgroundWorkDeadlineLabel(item, now)}</span>
          </p>
          {command ? (
            <BackgroundWorkCommand
              command={command}
              truncated={item.commandTruncated}
              className="mt-1.5"
            />
          ) : null}
          {host ? (
            <p className="mt-1 text-sm text-muted-foreground">{host}</p>
          ) : null}
          {onOpenOwner ? (
            <button
              type="button"
              onClick={() => onOpenOwner(item.ownerSessionId)}
              className="mt-1 max-w-full truncate text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {ownerTitle || "Open owning session"}
            </button>
          ) : null}
          {onOpenRegistry ? (
            <button
              type="button"
              onClick={() => onOpenRegistry(item.id)}
              className="mt-1 block text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Open in the background registry
            </button>
          ) : null}
          {evidenceUrl ? (
            <BackgroundWorkOutput
              url={evidenceUrl}
              capturedBytes={item.evidence?.capturedBytes}
              truncated={item.evidence?.truncated}
              className="mt-1"
            />
          ) : null}
          {facts.length > 0 ? (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
              {facts.map((fact) => (
                <div key={fact.label} className="contents">
                  <dt className="text-muted-foreground">{fact.label}</dt>
                  <dd className="min-w-0 break-words text-muted-foreground">
                    {fact.value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
        <Button
          variant="outline"
          busy={stopPending}
          disabled={Boolean(stopBlocked)}
          title={stopBlocked ?? "Stop this background work"}
          aria-label={`Stop ${item.label}`}
          onClick={() => onStop(item.id)}
        >
          <Square size={13} aria-hidden="true" />
          Stop
        </Button>
      </div>
    </li>
  );
}

/**
 * The row's memo identity is its CONTENT, not its props: the registry is
 * rebroadcast as state events and the ticker moves every second, so a row that
 * held on object identity would re-render constantly while one that ignored the
 * rendered labels would freeze at whatever it first read.
 */
export const BackgroundWorkRow = memo(
  BackgroundWorkRowImpl,
  (prev, next) =>
    prev.onStop === next.onStop &&
    prev.onOpenOwner === next.onOpenOwner &&
    prev.onOpenRegistry === next.onOpenRegistry &&
    prev.anchored === next.anchored &&
    prev.rowRef === next.rowRef &&
    prev.stopPending === next.stopPending &&
    prev.evidenceUrl === next.evidenceUrl &&
    prev.ownerTitle === next.ownerTitle &&
    backgroundWorkRowKey(prev.item, prev.now) ===
      backgroundWorkRowKey(next.item, next.now),
);
