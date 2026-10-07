/**
 * Shared @pierre/diffs worker-pool wiring. The React surfaces still build the
 * light diff/file metadata on the main thread, but Shiki tokenization and HAST
 * rendering run in the worker pool and can be cached by each surface's
 * content/patch-derived cacheKey.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  WorkerPoolContextProvider,
  useWorkerPool,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from "@pierre/diffs/react";
import type { WorkerStats } from "@pierre/diffs/worker";
import PierreDiffWorker from "@pierre/diffs/worker/worker.js?worker";
import type { Prefs } from "../../hooks/usePrefs.ts";
import { Spinner } from "../common/load.tsx";

const DIFF_THEMES = {
  light: "catppuccin-latte",
  dark: "catppuccin-mocha",
} as const;

const workerCount = Math.max(
  1,
  Math.min(
    4,
    Math.floor(
      (typeof navigator === "undefined"
        ? 4
        : navigator.hardwareConcurrency || 4) / 2,
    ),
  ),
);

const POOL_OPTIONS: WorkerPoolOptions = {
  workerFactory: () => new PierreDiffWorker(),
  poolSize: workerCount,
  totalASTLRUCacheSize: 100,
};

// Takes the one preference it reads, not the whole `Prefs`: the memo below
// rebuilds on `diffWordLevel` alone, and a wider parameter would only make that
// dependency list look wrong.
function highlighterOptionsFor(
  wordLevel: boolean,
): WorkerInitializationRenderOptions {
  return {
    theme: DIFF_THEMES,
    lineDiffType: wordLevel ? "word" : "none",
    useTokenTransformer: false,
    tokenizeMaxLineLength: 1_000,
    maxLineDiffLength: 1_000,
    preferredHighlighter: "shiki-js",
  };
}

function WorkerRenderOptionsSync({
  options,
}: {
  options: WorkerInitializationRenderOptions;
}) {
  const pool = useWorkerPool();

  useEffect(() => {
    if (!pool) return;
    pool.setRenderOptions(options).catch((err: unknown) => {
      console.warn("Failed to update diff worker render options", err);
    });
  }, [pool, options]);

  return null;
}

interface DiffWorkerStatusContextValue {
  stats: WorkerStats | null;
  completionVersion: number;
}

const DiffWorkerStatusContext =
  createContext<DiffWorkerStatusContextValue | null>(null);

function isWorkerBusy(stats: WorkerStats | null): boolean {
  if (!stats) return false;
  return (
    stats.managerState !== "initialized" ||
    stats.activeTasks > 0 ||
    stats.queuedTasks > 0
  );
}

function DiffWorkerStateProvider({ children }: { children: ReactNode }) {
  const pool = useWorkerPool();
  const [stats, setStats] = useState<WorkerStats | null>(null);
  const [completionVersion, setCompletionVersion] = useState(0);
  const wasBusy = useRef(false);

  useEffect(() => {
    if (!pool) {
      setStats(null);
      wasBusy.current = false;
      return;
    }
    return pool.subscribeToStatChanges((next) => {
      const busy = isWorkerBusy(next);
      setStats(next);
      if (wasBusy.current && !busy)
        setCompletionVersion((version) => version + 1);
      wasBusy.current = busy;
    });
  }, [pool]);

  const value = useMemo(
    () => ({ stats, completionVersion }),
    [stats, completionVersion],
  );

  return (
    <DiffWorkerStatusContext.Provider value={value}>
      {children}
      <DiffWorkerProgressIndicator stats={stats} />
    </DiffWorkerStatusContext.Provider>
  );
}

function DiffWorkerProgressIndicator({ stats }: { stats: WorkerStats | null }) {
  if (!stats || !isWorkerBusy(stats)) return null;
  const active = stats.activeTasks + stats.queuedTasks;
  const label =
    stats.managerState !== "initialized"
      ? "Preparing syntax highlighter…"
      : "Highlighting syntax…";
  return (
    <div
      role="status"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-line bg-panel/95 px-3 py-1.5 text-caption text-muted-foreground shadow-lg backdrop-blur"
    >
      <Spinner size="sm" className="text-primary" />
      <span>{label}</span>
      {active > 0 ? (
        <span className="font-mono text-faint">{active} queued</span>
      ) : null}
    </div>
  );
}

export function useDiffWorkerCompletionVersion(): number {
  return useContext(DiffWorkerStatusContext)?.completionVersion ?? 0;
}

export function DiffWorkerProvider({
  prefs,
  children,
}: {
  prefs: Prefs;
  children: ReactNode;
}) {
  const existingPool = useWorkerPool();
  const existingStatus = useContext(DiffWorkerStatusContext);
  const highlighterOptions = useMemo(
    () => highlighterOptionsFor(prefs.diffWordLevel),
    [prefs.diffWordLevel],
  );

  if (existingPool) {
    return (
      <>
        <WorkerRenderOptionsSync options={highlighterOptions} />
        {existingStatus ? (
          children
        ) : (
          <DiffWorkerStateProvider>{children}</DiffWorkerStateProvider>
        )}
      </>
    );
  }

  return (
    <WorkerPoolContextProvider
      poolOptions={POOL_OPTIONS}
      highlighterOptions={highlighterOptions}
    >
      <WorkerRenderOptionsSync options={highlighterOptions} />
      <DiffWorkerStateProvider>{children}</DiffWorkerStateProvider>
    </WorkerPoolContextProvider>
  );
}
