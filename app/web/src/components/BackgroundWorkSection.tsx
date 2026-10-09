import { Fragment, useMemo } from "react";
import { Activity, ArrowUpRight, Square, TriangleAlert } from "lucide-react";
import type {
  BackgroundWorkItemSummary,
  SessionArtifact,
  SessionBackgroundActivity,
} from "@assistant/shared";
import {
  BACKGROUND_WORK_COMMAND_MAX_CHARS,
  backgroundWorkBlockedReason,
} from "@assistant/shared";
import {
  backgroundActivityText,
  backgroundWorkAgeLabel,
  backgroundWorkOutcomeDetail,
  backgroundWorkDeadlineLabel,
  backgroundWorkEvidenceFacts,
  backgroundWorkKindLabel,
  backgroundWorkListView,
  backgroundWorkStateBadge,
  backgroundWorkStopDisabledReason,
  BACKGROUND_WORK_INSPECTOR_LIMIT,
  isActiveBackgroundWork,
} from "../lib/backgroundWork.ts";
import { artifactHttpUrl } from "../lib/serverOrigin.ts";
import { CodeBlock } from "./common/CodeBlock.tsx";
import { BackgroundWorkOutput } from "./BackgroundWorkOutput.tsx";
import { DisclosureRow } from "./common/DisclosureRow.tsx";
import { IconButton } from "./common/IconButton.tsx";
import {
  PropertyLabel,
  PropertyList,
  PropertyText,
} from "./common/PropertyList.tsx";
import { useElapsedNow } from "./useElapsedNow.ts";
import { InspectorSection } from "./shell/Inspector.tsx";
import { Spinner } from "./common/load.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export interface BackgroundWorkSectionProps {
  sessionId: string | undefined;
  /** The registry rows this browser holds while the section is subscribed. */
  items: BackgroundWorkItemSummary[];
  /** The session-list projection; present whenever this session owns work. */
  activity?: SessionBackgroundActivity | undefined;
  /**
   * The owning session's artifact drawer. It is the only place an evidence
   * artifact id can be RESOLVED to a URL — the registry row carries the id's
   * facts, never a path — so the "open captured output" link exists here and
   * the registry sends you to the owner for it.
   */
  artifacts?: SessionArtifact[];
  stopPending: ReadonlySet<string>;
  onStop: (itemId: string) => void;
  onStopAll: (ownerSessionId: string) => void;
  /**
   * Open the full registry, where every session's recent work lives — at one
   * item when given its id.
   */
  onOpenRegistry: (itemId?: string) => void;
  /**
   * Set while Stop-all reserved a retained host it could not close yet, because
   * an ordinary prompted turn is still inside its safe boundary.
   */
  protectedTurnWait?: boolean;
}

/**
 * @component BackgroundWorkSection
 * @purpose The owning session's background work in its inspector: what this
 * session started that outlives its turns, with Stop, Stop-all, and a link to
 * the full registry.
 * @useWhen The session inspector is open for a session that owns background
 * work (or held rows for it).
 * @avoidWhen Nothing is running and nothing was held — the section simply does
 * not render, rather than claiming an empty history.
 * @intent Background work is NOT a provider turn: this section is deliberately
 * separate from the session's run state, and nothing in it sets or reads
 * streaming, unread or provider run state. It shows a bounded page and points at
 * the registry for the rest.
 * @related SessionInspector, BackgroundTasksPage, BackgroundWorkRow
 */
export function BackgroundWorkSection({
  sessionId,
  items,
  activity,
  artifacts,
  stopPending,
  onStop,
  onStopAll,
  onOpenRegistry,
  protectedTurnWait = false,
}: BackgroundWorkSectionProps) {
  const now = useElapsedNow(Boolean(activity?.activeCount));
  const evidenceUrls = useMemo(() => {
    const byId = new Map((artifacts ?? []).map((row) => [row.id, row.url]));
    return (id: string | undefined) => {
      const url = id ? byId.get(id) : undefined;
      return url ? artifactHttpUrl(url) : undefined;
    };
  }, [artifacts]);
  const blocked = backgroundWorkBlockedReason(activity);
  const active = useMemo(
    () =>
      sessionId
        ? backgroundWorkListView(items, {
            filter: "active",
            ownerSessionId: sessionId,
            limit: BACKGROUND_WORK_INSPECTOR_LIMIT,
          })
        : undefined,
    [items, sessionId],
  );
  const recent = useMemo(
    () =>
      sessionId
        ? backgroundWorkListView(items, {
            filter: "recent",
            ownerSessionId: sessionId,
            limit: BACKGROUND_WORK_INSPECTOR_LIMIT,
          })
        : undefined,
    [items, sessionId],
  );
  if (!sessionId) return null;
  const hasRows = (active?.total ?? 0) + (recent?.total ?? 0) > 0;
  // A retained host with no children left still counts: the epoch outlives its
  // last item by design, and going silent in that window would hide a live
  // provider query the user can still stop.
  if (!hasRows && !activity) return null;

  const list = (rows: BackgroundWorkItemSummary[]) => (
    // The panel's object rows (`DisclosureRow`), edge to edge like the
    // session list above: one line per item, its details unfolded below.
    <ul className="-mx-3 divide-y">
      {rows.map((item) => (
        <BackgroundWorkLine
          key={item.id}
          item={item}
          now={now}
          stopPending={stopPending.has(item.id)}
          evidenceUrl={evidenceUrls(item.evidence?.artifactId)}
          onStop={onStop}
          onOpenRegistry={onOpenRegistry}
        />
      ))}
    </ul>
  );
  const summary = activity
    ? String(Math.max(activity.activeCount, active?.activeTotal ?? 0))
    : String(active?.activeTotal ?? 0);

  return (
    <InspectorSection
      id="background-work"
      storageScope={`session:${sessionId}`}
      title="Background work"
      icon={<Activity size={13} />}
      summary={summary}
      // The section exists only when there IS background work, so it opens by
      // default: hiding it behind a chevron is how running work goes unnoticed.
      defaultOpen
    >
      {activity ? (
        <p className="mb-2 text-sm text-muted-foreground">
          {backgroundActivityText(activity)}
        </p>
      ) : null}
      {/* The SHARED reason, so the sentence the disabled Settle shows and the
          one a refused delete answers with are the same one — said here where
          there is room to say what to do about it. */}
      {blocked ? (
        <p className="mb-2 text-sm text-muted-foreground">
          Settling and deleting this session are blocked while {blocked} Stop it
          first, here or in the registry.
        </p>
      ) : null}
      {protectedTurnWait ? (
        <Alert role="note" className="mb-2">
          <TriangleAlert />
          <AlertDescription>
            Stop-all is waiting: this session&rsquo;s retained background host
            closes once your own prompted turn finishes. Your turn is never
            interrupted.
          </AlertDescription>
        </Alert>
      ) : null}
      {active && active.total > 0 ? list(active.rows) : null}
      {recent && recent.total > 0 ? (
        <>
          {/* On the rows' chevron line (the property list's 0.25rem inset). */}
          <p className="mt-3 mb-1 px-1 text-xs font-medium text-muted-foreground">
            Recent
          </p>
          {list(recent.rows)}
        </>
      ) : null}
      {/* No hairline: the list's own last divider already closes it. */}
      <div className="mt-2 flex items-center justify-end gap-2">
        {active && active.total > 0 ? (
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onStopAll(sessionId)}
          >
            <Square />
            Stop all
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          onClick={() => onOpenRegistry()}
        >
          <ArrowUpRight />
          Open registry
        </Button>
      </div>
    </InspectorSection>
  );
}

/**
 * One background item in the session inspector, as the panel's other object
 * rows: its state as the leading mark (a spinner while it runs, else a dot in
 * the state's tone), its title and how long it ran, Stop while it can be
 * stopped, and ↗ to it in the registry. Unfolded: the facts the registry
 * holds, the command, and the captured output on demand.
 */
function BackgroundWorkLine({
  item,
  now,
  stopPending,
  evidenceUrl,
  onStop,
  onOpenRegistry,
}: {
  item: BackgroundWorkItemSummary;
  now: number;
  stopPending: boolean;
  evidenceUrl: string | undefined;
  onStop: (itemId: string) => void;
  onOpenRegistry: (itemId?: string) => void;
}) {
  const badge = backgroundWorkStateBadge(item);
  const running = isActiveBackgroundWork(item);
  const stopBlocked = backgroundWorkStopDisabledReason(item);
  // The whole command, always: the title may be its first line, but the
  // details are where it is read (and copied) in full.
  const command = item.command?.trim();
  // The outcome only where it says more than the title (the server's summary
  // for agent work opens with the job's own description).
  const outcome = backgroundWorkOutcomeDetail({
    label: item.label,
    status: item.state,
    outcomeSummary: item.outcomeSummary,
  });
  const facts = backgroundWorkEvidenceFacts(item).filter(
    (fact) => fact.label !== "Outcome",
  );
  return (
    <DisclosureRow
      rowId={item.id}
      inset={0.3125}
      head={
        <>
          <span
            className="flex size-4 shrink-0 items-center justify-center"
            title={badge.label}
            aria-label={badge.label}
          >
            {running && item.stopState === "none" ? (
              <Spinner size="xs" />
            ) : (
              <span
                aria-hidden
                className={`size-2 rounded-full ${BACKGROUND_TONE_DOT[badge.tone]}`}
              />
            )}
          </span>
          <span
            className={`min-w-0 flex-1 truncate text-left text-sm ${running ? "text-foreground" : "text-muted-foreground"}`}
          >
            {item.label}
          </span>
        </>
      }
      age={backgroundWorkAgeLabel(item, now)}
      ageTitle="How long it has run"
      openLabel={`Open ${item.label} in the background registry`}
      onOpen={() => onOpenRegistry(item.id)}
      action={
        running ? (
          <IconButton
            label={stopBlocked ?? `Stop ${item.label}`}
            size="icon-xs"
            busy={stopPending}
            disabled={Boolean(stopBlocked)}
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onStop(item.id)}
          >
            <Square />
          </IconButton>
        ) : undefined
      }
    >
      <PropertyList size="sm">
        <PropertyLabel>State</PropertyLabel>
        <PropertyText className="text-foreground">{badge.label}</PropertyText>
        <PropertyLabel>Kind</PropertyLabel>
        <PropertyText className="text-foreground">
          {backgroundWorkKindLabel(item)}
        </PropertyText>
        <PropertyLabel>Deadline</PropertyLabel>
        <PropertyText className="text-foreground">
          {backgroundWorkDeadlineLabel(item, now)}
        </PropertyText>
        {outcome ? (
          <>
            <PropertyLabel>Outcome</PropertyLabel>
            <PropertyText className="break-words text-foreground">
              {outcome}
            </PropertyText>
          </>
        ) : null}
        {facts.map((fact) => (
          <Fragment key={fact.label}>
            <PropertyLabel>{fact.label}</PropertyLabel>
            <PropertyText className="break-words text-foreground">
              {fact.value}
            </PropertyText>
          </Fragment>
        ))}
      </PropertyList>
      {command ? (
        // Highlighted, wrapped, folded past a dozen lines, with Copy: a long
        // script stays readable here without pushing the panel off screen.
        <div className="mt-1.5">
          <CodeBlock
            code={command}
            language="bash"
            wrap
            collapsedLines={12}
            copyable
            // Panel density: a framed block at the detail list's 12px size,
            // not the transcript's 14px fences. `!` because `.shiki`'s size and
            // padding are unlayered in index.css and beat any layered utility.
            className="[&_.shiki]:border [&_.shiki]:px-2! [&_.shiki]:py-1.5! [&_.shiki]:text-xs! [&_.shiki]:leading-4!"
          />
          {item.commandTruncated ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Stored cut at {BACKGROUND_WORK_COMMAND_MAX_CHARS.toLocaleString()}{" "}
              characters; the copy is the same cut.
            </p>
          ) : null}
        </div>
      ) : null}
      {evidenceUrl ? (
        <BackgroundWorkOutput
          url={evidenceUrl}
          capturedBytes={item.evidence?.capturedBytes}
          truncated={item.evidence?.truncated}
          className="mt-1.5 w-full"
        />
      ) : null}
    </DisclosureRow>
  );
}

/** A finished (or stopping) item's state as its dot, in the badge's tone. */
const BACKGROUND_TONE_DOT: Record<string, string> = {
  accent: "bg-primary",
  success: "bg-success",
  danger: "bg-destructive",
  warning: "bg-warning",
  muted: "border border-muted-foreground",
};
