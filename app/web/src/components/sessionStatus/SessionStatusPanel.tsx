import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { SessionStatusCard } from "@assistant/shared";
import { Button } from "../ui/button.tsx";
import { EmptyBox, ErrorNote, PaneLoading } from "../common/load.tsx";
import { Markdown } from "../Markdown.tsx";
import { relativeTime } from "../../lib/sessionRows.ts";
import {
  fetchSessionStatus,
  refreshSessionStatus,
} from "../../lib/sessionStatusApi.ts";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `relativeTime` answers "now", "5m" or a date; say each as a time phrase. */
function writtenAgo(ts: number): string {
  const rel = relativeTime(ts);
  if (rel === "now") return "just now";
  return /^\d/.test(rel) ? `${rel} ago` : `on ${rel}`;
}

interface StatusState {
  /** The session this state belongs to; another session starts over. */
  sessionId: string;
  loaded: boolean;
  card: SessionStatusCard | null;
  refreshing: boolean;
  error: string | null;
}

/**
 * @component SessionStatusPanel
 * @purpose Right-panel tab showing the open session's status card: what it is for, what happened, and what is still open (`docs/session-status.md`).
 * @useWhen The right panel's Status tab, for the session in the main pane.
 * @avoidWhen Anything other than a session: the card is written from a session's transcript.
 * @intent The card is written only on request, so a stale card stays readable with its age next to Refresh; a refresh keeps it on screen until the new one lands (R2).
 */
export function SessionStatusPanel({
  sessionId,
  sessionUpdatedAt,
  initialState,
}: {
  /** The session in the main pane, or undefined when none is open. */
  sessionId: string | undefined;
  /** The session's last activity, to say when the card is behind it. */
  sessionUpdatedAt?: number | undefined;
  /** Previews only: start from this state instead of fetching. */
  initialState?: Omit<StatusState, "sessionId"> | undefined;
}) {
  if (!sessionId)
    return (
      <div className="p-4">
        <EmptyBox>Open a session to see its status.</EmptyBox>
      </div>
    );
  return (
    <SessionStatusBody
      key={sessionId}
      sessionId={sessionId}
      sessionUpdatedAt={sessionUpdatedAt}
      initialState={initialState}
    />
  );
}

function SessionStatusBody({
  sessionId,
  sessionUpdatedAt,
  initialState,
}: {
  sessionId: string;
  sessionUpdatedAt: number | undefined;
  initialState: Omit<StatusState, "sessionId"> | undefined;
}) {
  const [state, setState] = useState<StatusState>(() => ({
    sessionId,
    loaded: false,
    card: null,
    refreshing: false,
    error: null,
    ...initialState,
  }));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    setState((current) => ({ ...current, refreshing: true, error: null }));
    refreshSessionStatus(sessionId).then(
      (response) => {
        if (!mounted.current) return;
        setState((current) => ({
          ...current,
          loaded: true,
          card: response.card,
          refreshing: false,
        }));
      },
      (err: unknown) => {
        if (!mounted.current) return;
        setState((current) => ({
          ...current,
          refreshing: false,
          error: errorText(err),
        }));
      },
    );
  }, [sessionId]);

  useEffect(() => {
    if (initialState) return;
    const abort = new AbortController();
    fetchSessionStatus(sessionId, abort.signal).then(
      (response) => {
        setState((current) => ({
          ...current,
          loaded: true,
          card: response.card,
        }));
        // A refresh another tab started is joined: the server answers both.
        if (response.refreshing) refresh();
      },
      (err: unknown) => {
        if (abort.signal.aborted) return;
        setState((current) => ({
          ...current,
          loaded: true,
          error: errorText(err),
        }));
      },
    );
    return () => abort.abort();
  }, [sessionId, initialState, refresh]);

  if (!state.loaded) return <PaneLoading label="Loading status…" />;

  const { card } = state;
  const refreshButton = (
    <Button
      size="xs"
      variant="outline"
      busy={state.refreshing}
      onClick={refresh}
    >
      <RefreshCw />
      {card ? "Refresh" : "Write status"}
    </Button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      {card ? (
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {state.refreshing
              ? "Reading the session…"
              : `Written ${writtenAgo(card.createdAt)} · ${card.model.modelId}`}
            {!state.refreshing &&
            sessionUpdatedAt !== undefined &&
            sessionUpdatedAt > card.sessionUpdatedAt
              ? " · the session has moved on since"
              : ""}
          </p>
          {refreshButton}
        </div>
      ) : null}
      {state.error ? (
        <ErrorNote
          message={`Could not write the status: ${state.error}`}
          onRetry={refresh}
        />
      ) : null}
      {card ? (
        <Markdown text={card.markdown} density="compact" />
      ) : (
        <EmptyBox action={refreshButton}>
          {state.refreshing
            ? "Reading the session. A long session takes a minute or two."
            : "No status yet. The status agent reads this session and writes what it is for, what happened, and what is still open."}
        </EmptyBox>
      )}
    </div>
  );
}
