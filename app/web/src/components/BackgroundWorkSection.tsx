import { useMemo } from "react";
import { Activity } from "lucide-react";
import type {
  BackgroundWorkItemSummary,
  SessionArtifact,
  SessionBackgroundActivity,
} from "@assistant/shared";
import { backgroundWorkBlockedReason } from "@assistant/shared";
import {
  backgroundActivityText,
  backgroundWorkListView,
  BACKGROUND_WORK_INSPECTOR_LIMIT,
} from "../lib/backgroundWork.ts";
import { artifactHttpUrl } from "../lib/serverOrigin.ts";
import { BackgroundWorkRow } from "./BackgroundWorkRow.tsx";
import { useElapsedNow } from "./useElapsedNow.ts";
import { InspectorSection } from "./shell/Inspector.tsx";
import { EmptyBox } from "./common/load.tsx";

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
  /** Open the full registry, where every session's recent work lives. */
  onOpenRegistry: () => void;
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
        <p className="mb-2 text-caption text-muted-foreground">
          {backgroundActivityText(activity)}
        </p>
      ) : null}
      {/* The SHARED reason, so the sentence the disabled Settle shows and the
          one a refused delete answers with are the same one — said here where
          there is room to say what to do about it. */}
      {blocked ? (
        <p className="mb-2 text-caption text-faint">
          Settling and deleting this session are blocked while {blocked} Stop it
          first, here or in the registry.
        </p>
      ) : null}
      {protectedTurnWait ? (
        <p className="mb-2 rounded-lg bg-warning-soft px-2 py-1.5 text-caption text-warning">
          Stop-all is waiting: this session&rsquo;s retained background host
          closes once your own prompted turn finishes. Your turn is never
          interrupted.
        </p>
      ) : null}
      {active && active.total > 0 ? (
        <ul className="flex flex-col gap-2">
          {active.rows.map((item) => (
            <BackgroundWorkRow
              key={item.id}
              item={item}
              now={now}
              stopPending={stopPending.has(item.id)}
              evidenceUrl={evidenceUrls(item.evidence?.artifactId)}
              onStop={onStop}
            />
          ))}
        </ul>
      ) : (
        <EmptyBox variant="inline">Nothing is running right now.</EmptyBox>
      )}
      {active && active.total > 0 ? (
        <button
          type="button"
          onClick={() => onStopAll(sessionId)}
          className="mt-2 h-9 w-full rounded-lg border border-line text-caption text-muted-foreground transition-colors hover:border-line-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          Stop all background work in this session
        </button>
      ) : null}
      {recent && recent.total > 0 ? (
        <>
          <p className="mt-3 text-caption font-medium text-faint">Recent</p>
          <ul className="mt-1 flex flex-col gap-2">
            {recent.rows.map((item) => (
              <BackgroundWorkRow
                key={item.id}
                item={item}
                now={now}
                stopPending={stopPending.has(item.id)}
                evidenceUrl={evidenceUrls(item.evidence?.artifactId)}
                onStop={onStop}
              />
            ))}
          </ul>
        </>
      ) : null}
      <button
        type="button"
        onClick={onOpenRegistry}
        className="mt-2 text-caption text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        Open the background registry
      </button>
    </InspectorSection>
  );
}
