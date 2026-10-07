/**
 * Feature-specific memory hook (Tasks 101/102): drives the bounded memory
 * management + load-audit requests over the shared socket and holds the derived
 * browser state. Kept out of the central `useAssistant` reducer like the other
 * feature hooks (backlog). Server broadcasts (`memoryInvalidated` /
 * `memoryLoadInvalidated`) trigger authoritative refetches so concurrent tabs,
 * agents, and the processor converge.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MemoryLineage,
  MemoryListFilter,
  MemoryLoadBatch,
  MemoryMutateOperation,
  MemoryMutateResult,
  ServerMessage,
  MemoryCard,
} from "@assistant/shared";
import type { AssistantSocket } from "../lib/socket.ts";
import { beginLoad, loading, ready, type LoadState } from "../lib/loadState.ts";

let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return `mem-${Date.now()}-${requestSeq}`;
}

interface MemoryProcessorStatus {
  configured: boolean;
  message?: string;
}

/** One answer to one `memoryList` query. */
export interface MemoryListView {
  cards: MemoryCard[];
  total: number;
  hasMore: boolean;
}

export interface UseMemory {
  /**
   * The current query's answer as one state (`app/web/docs/loading-states.md`):
   * a filter or page change is a DIFFERENT query, so it drops to `loading` and
   * the manager draws placeholder rows (R3); an invalidation broadcast reloads
   * the SAME query and keeps the rows on screen (R2).
   */
  list: LoadState<MemoryListView>;
  filter: MemoryListFilter;
  /**
   * Lineage keyed by memory id (NOT a single global slot): the manager and the
   * Session inspector can each have an independent row expanded at once (and
   * even simultaneously across the two surfaces), so a single shared slot would
   * have row B's fetch clobber row A's and leave A stuck on "Loading…".
   */
  lineageById: Record<string, MemoryLineage>;
  loadsBySession: Record<string, MemoryLoadBatch[]>;
  processorStatus: MemoryProcessorStatus | null;
  setFilter: (filter: MemoryListFilter) => void;
  refresh: () => void;
  mutate: (operation: MemoryMutateOperation) => Promise<MemoryMutateResult>;
  openLineage: (id: string) => void;
  clearLineage: (id: string) => void;
  fetchLoads: (sessionId: string, limit?: number) => void;
  fetchStatus: () => void;
}

export function useMemory(socket: AssistantSocket | undefined): UseMemory {
  const [list, setList] = useState<LoadState<MemoryListView>>(() =>
    loading<MemoryListView>(),
  );
  const [filter, setFilterState] = useState<MemoryListFilter>({
    states: ["active"],
    limit: 50,
  });
  const [lineageById, setLineageById] = useState<Record<string, MemoryLineage>>(
    {},
  );
  const [loadsBySession, setLoadsBySession] = useState<
    Record<string, MemoryLoadBatch[]>
  >({});
  const [processorStatus, setProcessorStatus] =
    useState<MemoryProcessorStatus | null>(null);

  const filterRef = useRef(filter);
  filterRef.current = filter;
  const listRequestId = useRef<string | undefined>(undefined);
  /** requestId -> the memory id it was requested for (so a reply is attributed correctly even if the card was deleted, i.e. `lineage.card` is null). */
  const pendingLineageRequests = useRef<Map<string, string>>(new Map());
  /** Every id ever opened, so a `memoryInvalidated` broadcast refreshes ALL open rows, not just the most recent one. */
  const watchedLineageIds = useRef<Set<string>>(new Set());
  const watchedSessions = useRef<Set<string>>(new Set());
  const pendingMutations = useRef<
    Map<string, (result: MemoryMutateResult) => void>
  >(new Map());

  /** Re-ask the CURRENT query: the rows stay up while it runs (R2). */
  const refresh = useCallback(() => {
    if (!socket) return;
    const requestId = nextRequestId();
    listRequestId.current = requestId;
    setList((current) => beginLoad(current));
    socket.send({ type: "memoryList", requestId, filter: filterRef.current });
  }, [socket]);

  const setFilter = useCallback(
    (next: MemoryListFilter) => {
      setFilterState(next);
      filterRef.current = next;
      if (!socket) return;
      const requestId = nextRequestId();
      listRequestId.current = requestId;
      // A new filter or page is a different query, so the previous answer must
      // not sit under it while this one runs (R3).
      setList(loading<MemoryListView>());
      socket.send({ type: "memoryList", requestId, filter: next });
    },
    [socket],
  );

  const openLineage = useCallback(
    (id: string) => {
      if (!socket) return;
      watchedLineageIds.current.add(id);
      const requestId = nextRequestId();
      pendingLineageRequests.current.set(requestId, id);
      socket.send({ type: "memoryGet", requestId, id });
    },
    [socket],
  );

  const clearLineage = useCallback((id: string) => {
    watchedLineageIds.current.delete(id);
    setLineageById((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const fetchLoads = useCallback(
    (sessionId: string, limit = 20) => {
      if (!socket) return;
      watchedSessions.current.add(sessionId);
      socket.send({
        type: "memoryLoads",
        requestId: nextRequestId(),
        sessionId,
        limit,
      });
    },
    [socket],
  );

  const fetchStatus = useCallback(() => {
    if (!socket) return;
    socket.send({ type: "memoryStatus", requestId: nextRequestId() });
  }, [socket]);

  const mutate = useCallback(
    (operation: MemoryMutateOperation): Promise<MemoryMutateResult> => {
      return new Promise((resolve) => {
        if (!socket) {
          resolve({ ok: false, error: "invalid", message: "not connected" });
          return;
        }
        const requestId = nextRequestId();
        pendingMutations.current.set(requestId, resolve);
        socket.send({ type: "memoryMutate", requestId, operation });
      });
    },
    [socket],
  );

  useEffect(() => {
    if (!socket) return;
    const off = socket.onMessage((msg: ServerMessage) => {
      switch (msg.type) {
        case "memoryListResult":
          if (msg.requestId === listRequestId.current) {
            setList(
              ready({
                cards: msg.result.cards,
                total: msg.result.total,
                hasMore: msg.result.hasMore,
              }),
            );
          }
          break;
        case "memoryGetResult": {
          const id = pendingLineageRequests.current.get(msg.requestId);
          pendingLineageRequests.current.delete(msg.requestId);
          if (id) setLineageById((prev) => ({ ...prev, [id]: msg.lineage }));
          break;
        }
        case "memoryMutateResult": {
          const resolve = pendingMutations.current.get(msg.requestId);
          if (resolve) {
            pendingMutations.current.delete(msg.requestId);
            resolve(msg.result);
          }
          break;
        }
        case "memoryLoadsResult":
          setLoadsBySession((prev) => ({
            ...prev,
            [msg.sessionId]: msg.batches,
          }));
          break;
        case "memoryStatusResult":
          setProcessorStatus(msg.processor);
          break;
        case "memoryInvalidated":
          // A card changed anywhere — refetch the current list + every open lineage row.
          refresh();
          for (const id of watchedLineageIds.current) openLineage(id);
          break;
        case "memoryLoadInvalidated":
          if (watchedSessions.current.has(msg.sessionId))
            fetchLoads(msg.sessionId);
          break;
        default:
          break;
      }
    });
    return off;
  }, [socket, refresh, openLineage, fetchLoads]);

  return useMemo(
    () => ({
      list,
      filter,
      lineageById,
      loadsBySession,
      processorStatus,
      setFilter,
      refresh,
      mutate,
      openLineage,
      clearLineage,
      fetchLoads,
      fetchStatus,
    }),
    [
      list,
      filter,
      lineageById,
      loadsBySession,
      processorStatus,
      setFilter,
      refresh,
      mutate,
      openLineage,
      clearLineage,
      fetchLoads,
      fetchStatus,
    ],
  );
}
